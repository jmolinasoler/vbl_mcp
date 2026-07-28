/**
 * HTTP mode: MCP Streamable HTTP endpoint (/mcp), a status dashboard (/)
 * showing who is using the server and what each API key consumes, admin
 * endpoints to manage API keys, and a health endpoint (/health).
 *
 * Auth model:
 *  - Clients call /mcp with an X-API-Key header. Keys come from the
 *    MCP_API_KEYS env var and/or are created at runtime via the admin API.
 *  - Dashboard accounts have a role. An admin manages users and every key; a
 *    plain user only sees and revokes their own keys, capped at
 *    MAX_KEYS_PER_NON_ADMIN. Only admins can create accounts (/admin/users).
 *  - Admin endpoints also accept the X-Admin-Token header matching the
 *    ADMIN_TOKEN env var, which acts with admin privileges for scripts.
 *  - Usage (requests + estimated tokens in/out, per key and per tool) is
 *    persisted to DATA_DIR/store.json as the metering basis for billing.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, baseUrl, VERSION } from "./vbl.js";
import {
  KeyQuotaExceededError,
  MAX_KEYS_PER_NON_ADMIN,
  Store,
  type ApiKeyPublic,
  type Role,
  type User,
} from "./store.js";
import { hashPassword, parseCookies, safeNextPath, verifyPassword } from "./auth.js";

interface SessionInfo {
  id: string;
  client: string;
  clientVersion: string;
  keyId: string | null;
  keyLabel: string;
  ip: string;
  userAgent: string;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt?: Date;
  totalCalls: number;
  tokensIn: number;
  tokensOut: number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  info: SessionInfo;
}

interface CallLogEntry {
  time: Date;
  client: string;
  keyLabel: string;
  tool: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  isError: boolean;
}

/**
 * Per-app runtime state. Kept out of module scope so several instances can
 * coexist (tests spin up isolated apps; production creates exactly one).
 */
interface AppState {
  startedAt: Date;
  sessions: Map<string, SessionEntry>;
  endedSessions: SessionInfo[]; // most recent first, capped
  toolTotals: Record<string, { requests: number; tokensIn: number; tokensOut: number }>;
  recentCalls: CallLogEntry[]; // most recent first, capped
  totalSessions: number;
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  upstream: { status: "ok" | "error"; detail: string; checkedAt: Date } | null;
}

const createState = (): AppState => ({
  startedAt: new Date(),
  sessions: new Map(),
  endedSessions: [],
  toolTotals: {},
  recentCalls: [],
  totalSessions: 0,
  totalCalls: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  upstream: null,
});

const MAX_ENDED = 25;
const MAX_RECENT = 50;
const UPSTREAM_CACHE_MS = 60_000;

/**
 * MCP_API_KEYS: comma-separated API keys, each optionally labeled as
 * "label:key" (e.g. "hermes:abc123,claude:def456"). They are imported into
 * the persistent store at startup so all keys are metered uniformly.
 */
function parseApiKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>(); // key -> label
  if (!raw) return keys;
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entry, i) => {
      const sep = entry.indexOf(":");
      if (sep > 0) keys.set(entry.slice(sep + 1).trim(), entry.slice(0, sep).trim());
      else keys.set(entry, `key-${i + 1}`);
    });
  return keys;
}

type UpstreamStatus = NonNullable<AppState["upstream"]>;

/** Cached upstream (VBL API) reachability check for /health and the dashboard. */
async function checkUpstream(state: AppState): Promise<UpstreamStatus> {
  const cached = state.upstream;
  if (cached && Date.now() - cached.checkedAt.getTime() < UPSTREAM_CACHE_MS) return cached;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${baseUrl()}/TeamDetailByGuid?teamguid=HEALTHCHECK`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    state.upstream = {
      status: res.ok ? "ok" : "error",
      detail: `HTTP ${res.status}`,
      checkedAt: new Date(),
    };
  } catch (e) {
    state.upstream = {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
      checkedAt: new Date(),
    };
  }
  return state.upstream;
}

function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) ?? "unknown";
}

function endSession(state: AppState, id: string) {
  const entry = state.sessions.get(id);
  if (!entry) return;
  state.sessions.delete(id);
  entry.info.endedAt = new Date();
  state.endedSessions.unshift(entry.info);
  if (state.endedSessions.length > MAX_ENDED) state.endedSessions.pop();
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const fmtNum = (n: number) => n.toLocaleString("en-US");

function fmtAgo(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtUptime(startedAt: Date): string {
  const s = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** Shared page chrome, so the login page matches the dashboard. */
const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f5f5f4; color: #1c1917; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } .card, .panel { background: #292524 !important; } th { color: #a8a29e !important; } input { background:#1c1917; color:#e7e5e4; border-color:#57534e; } }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h1 .v { font-weight: normal; color: #ea580c; }
  .sub { color: #78716c; margin-bottom: 1.5rem; }
  input { padding: .4rem .6rem; border: 1px solid #d6d3d1; border-radius: .375rem; font: inherit; }
  button { padding: .4rem .85rem; border: 0; border-radius: .375rem; background: #ea580c; color: #fff; font-weight: 600; cursor: pointer; font: inherit; font-weight: 600; }
  button.secondary { background: #57534e; }
  button.revoke { background: #dc2626; padding: .2rem .5rem; font-size: .75rem; }
  .error { background: #fee2e2; color: #991b1b; padding: .5rem .75rem; border-radius: .375rem; margin-bottom: 1rem; font-size: .875rem; }
  .warn { background: #fef3c7; color: #92400e; padding: .6rem .85rem; border-radius: .375rem; margin-bottom: 1.5rem; font-size: .875rem; }
  code { font-size: .9em; }
`;

function loginHtml(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · vbl-mcp</title>
<style>
${PAGE_STYLE}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
  .panel { background: #fff; border-radius: .5rem; padding: 2rem; box-shadow: 0 1px 3px rgba(0,0,0,.1); width: min(22rem, 100%); }
  label { display: block; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #78716c; margin-bottom: .25rem; }
  .field { margin-bottom: 1rem; }
  .field input { width: 100%; box-sizing: border-box; }
  button { width: 100%; padding: .55rem; }
</style>
</head>
<body>
<form class="panel" method="post" action="/login">
  <h1>🏀 vbl-mcp</h1>
  <div class="sub">Sign in to the status dashboard</div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <input type="hidden" name="next" value="${esc(next)}">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required>
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
  </div>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

function dashboardHtml(
  store: Store,
  state: AppState,
  up: UpstreamStatus,
  user: User | undefined,
  /** Keys the viewer may see: all of them for an admin, own keys otherwise. */
  visibleKeys: ApiKeyPublic[]
): string {
  const { startedAt, sessions, endedSessions, toolTotals, recentCalls } = state;
  const sessionRows = [...sessions.values()]
    .sort((a, b) => b.info.lastSeenAt.getTime() - a.info.lastSeenAt.getTime())
    .map(
      (e) => `<tr>
        <td><code>${esc(e.info.id.slice(0, 8))}…</code></td>
        <td>${esc(e.info.client)} <span class="dim">${esc(e.info.clientVersion)}</span></td>
        <td>${esc(e.info.keyLabel)}</td>
        <td>${esc(e.info.ip)}</td>
        <td>${esc(fmtAgo(e.info.startedAt))}</td>
        <td>${esc(fmtAgo(e.info.lastSeenAt))}</td>
        <td class="num">${e.info.totalCalls}</td>
        <td class="num">${fmtNum(e.info.tokensIn)} / ${fmtNum(e.info.tokensOut)}</td>
      </tr>`
    )
    .join("");
  const endedRows = endedSessions
    .map(
      (i) => `<tr>
        <td><code>${esc(i.id.slice(0, 8))}…</code></td>
        <td>${esc(i.client)} <span class="dim">${esc(i.clientVersion)}</span></td>
        <td>${esc(i.keyLabel)}</td>
        <td>${esc(i.ip)}</td>
        <td>${esc(fmtAgo(i.startedAt))}</td>
        <td>${i.endedAt ? esc(fmtAgo(i.endedAt)) : "-"}</td>
        <td class="num">${i.totalCalls}</td>
        <td class="num">${fmtNum(i.tokensIn)} / ${fmtNum(i.tokensOut)}</td>
      </tr>`
    )
    .join("");
  const isAdmin = user?.role === "admin";
  /**
   * Sessions, IPs and the call log are operator data. A plain user must not see
   * other clients' activity; when no account exists at all the dashboard keeps
   * its historical public behaviour.
   */
  const showOperational = isAdmin || !store.hasUsers();
  const ownerName = (ownerId: string | undefined) =>
    ownerId ? store.findUserById(ownerId)?.username ?? "(deleted user)" : "—";
  const keyRows = visibleKeys
    .map(
      (k) => `<tr${k.revokedAt ? ' class="revoked"' : ""}>
        <td><code>${esc(k.id)}</code></td>
        <td>${esc(k.label)} <span class="dim">${k.source === "env" ? "env" : ""}</span></td>
        ${isAdmin ? `<td>${esc(ownerName(k.ownerId))}</td>` : ""}
        <td><code>${esc(k.keyPreview)}</code></td>
        <td>${esc(fmtAgo(k.createdAt))}</td>
        <td>${k.revokedAt ? `revoked ${esc(fmtAgo(k.revokedAt))}` : k.usage.lastUsedAt ? esc(fmtAgo(k.usage.lastUsedAt)) : "never used"}</td>
        <td class="num">${fmtNum(k.usage.requests)}</td>
        <td class="num">${fmtNum(k.usage.errors)}</td>
        <td class="num">${fmtNum(k.usage.tokensIn)}</td>
        <td class="num">${fmtNum(k.usage.tokensOut)}</td>
        <td>${k.revokedAt ? "" : `<button class="revoke" data-id="${esc(k.id)}">revoke</button>`}</td>
      </tr>`
    )
    .join("");
  const toolRows = Object.entries(toolTotals)
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(
      ([t, u]) =>
        `<tr><td><code>${esc(t)}</code></td><td class="num">${fmtNum(u.requests)}</td><td class="num">${fmtNum(u.tokensIn)}</td><td class="num">${fmtNum(u.tokensOut)}</td></tr>`
    )
    .join("");
  const callRows = recentCalls
    .map(
      (c) => `<tr${c.isError ? ' class="errrow"' : ""}>
        <td>${esc(c.time.toISOString().replace("T", " ").slice(0, 19))} UTC</td>
        <td>${esc(c.client)}</td>
        <td>${esc(c.keyLabel)}</td>
        <td><code>${esc(c.tool)}</code></td>
        <td class="num">${fmtNum(c.tokensIn)}</td>
        <td class="num">${fmtNum(c.tokensOut)}</td>
        <td class="num">${c.durationMs} ms</td>
      </tr>`
    )
    .join("");
  const upBadge =
    up.status === "ok"
      ? `<span class="badge ok">reachable</span>`
      : `<span class="badge err">unreachable</span>`;
  const signedIn = Boolean(user);
  const activeOwned = user ? visibleKeys.filter((k) => k.ownerId === user.id && !k.revokedAt).length : 0;
  const quotaReached = signedIn && !isAdmin && activeOwned >= MAX_KEYS_PER_NON_ADMIN;
  const quotaNote = isAdmin
    ? `<span class="dim">Unlimited keys (administrator)</span>`
    : `<span class="dim">${activeOwned} of ${MAX_KEYS_PER_NON_ADMIN} keys used</span>`;
  const adminSection = signedIn
    ? `<div class="adminbar">
        <label>New key label <input id="lbl" placeholder="e.g. hermes"></label>
        <button id="mk"${quotaReached ? " disabled" : ""}>Create API key</button>
        ${quotaNote}
        <span id="keymsg"></span>
      </div>
      ${
        quotaReached
          ? `<div class="warn">You have reached the limit of ${MAX_KEYS_PER_NON_ADMIN} active keys. Revoke one to create another.</div>`
          : ""
      }`
    : `<div class="dim">Sign in to create or revoke API keys.</div>`;
  const userRows = isAdmin
    ? store
        .listUsers()
        .map(
          (u) => `<tr>
        <td>${esc(u.username)}</td>
        <td>${u.role === "admin" ? '<span class="badge ok">admin</span>' : "user"}</td>
        <td>${esc(u.source)}</td>
        <td>${esc(fmtAgo(u.createdAt))}</td>
        <td>${u.lastLoginAt ? esc(fmtAgo(u.lastLoginAt)) : "never"}</td>
        <td>${
          u.id === user?.id
            ? '<span class="dim">you</span>'
            : `<button class="revoke deluser" data-id="${esc(u.id)}" data-name="${esc(u.username)}">delete</button>`
        }</td>
      </tr>`
        )
        .join("")
    : "";
  const usersSection = isAdmin
    ? `<section>
  <h2>Users</h2>
  <div class="adminbar">
    <label>Username <input id="nu" placeholder="e.g. player"></label>
    <label>Password <input id="np" type="password" placeholder="at least ${MIN_PASSWORD_LENGTH} characters"></label>
    <label>Role
      <select id="nr">
        <option value="user">user (max ${MAX_KEYS_PER_NON_ADMIN} keys)</option>
        <option value="admin">admin (unlimited)</option>
      </select>
    </label>
    <button id="cu">Create user</button>
    <span id="usermsg"></span>
  </div>
  <table style="max-width:60rem"><thead><tr><th>Username</th><th>Role</th><th>Source</th><th>Created</th><th>Last login</th><th></th></tr></thead><tbody>${userRows}</tbody></table>
</section>`
    : "";
  const userBar = user
    ? `<div class="userbar">
        Signed in as <strong>${esc(user.username)}</strong>
        <span class="badge ${user.role === "admin" ? "ok" : "err"}">${esc(user.role)}</span>
        <button id="pw" class="secondary">Change password</button>
        <form method="post" action="/logout" style="display:inline"><button class="secondary" type="submit">Log out</button></form>
      </div>`
    : "";
  const noUserWarning = store.hasUsers()
    ? ""
    : `<div class="warn"><strong>This dashboard is public.</strong> It exposes client IPs and usage.
        Set <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> and restart to require a login.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vbl-mcp status</title>
<style>
${PAGE_STYLE}
  .userbar { display: flex; align-items: center; gap: .5rem; justify-content: flex-end; font-size: .875rem; margin-bottom: .5rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
  .card { background: #fff; border-radius: .5rem; padding: 1rem 1.25rem; min-width: 10rem; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .card .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: #78716c; }
  .card .value { font-size: 1.5rem; font-weight: 600; margin-top: .25rem; }
  .badge { padding: .15rem .5rem; border-radius: 999px; font-size: .8rem; font-weight: 600; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.err { background: #fee2e2; color: #991b1b; }
  section { margin-bottom: 2rem; }
  h2 { font-size: 1.05rem; margin-bottom: .5rem; }
  table { border-collapse: collapse; width: 100%; max-width: 80rem; font-size: .875rem; }
  th, td { text-align: left; padding: .4rem .75rem; border-bottom: 1px solid rgba(120,113,108,.25); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #78716c; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.revoked td { color: #a8a29e; text-decoration: line-through; }
  tr.revoked td:last-child, tr.revoked td:nth-child(5) { text-decoration: none; }
  tr.errrow td { color: #b91c1c; }
  .dim { color: #a8a29e; font-size: .8em; }
  .empty { color: #a8a29e; font-style: italic; }
  .adminbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-bottom: .75rem; font-size: .875rem; }
  #keymsg { font-size: .875rem; }
  #keymsg code { background: rgba(234,88,12,.12); padding: .15rem .4rem; border-radius: .25rem; user-select: all; }
  footer { color: #a8a29e; font-size: .8rem; margin-top: 2rem; }
</style>
</head>
<body>
${userBar}
<h1>🏀 vbl-mcp <span class="v">v${esc(VERSION)}</span></h1>
<div class="sub">MCP server for the Basketball Vlaanderen API — endpoint <code>/mcp</code>, health <code>/health</code></div>
${noUserWarning}
<div class="cards">
  <div class="card"><div class="label">Uptime</div><div class="value">${esc(fmtUptime(startedAt))}</div></div>
  <div class="card"><div class="label">Active sessions</div><div class="value">${sessions.size}</div></div>
  <div class="card"><div class="label">Total sessions</div><div class="value">${state.totalSessions}</div></div>
  <div class="card"><div class="label">Tool calls</div><div class="value">${fmtNum(state.totalCalls)}</div></div>
  <div class="card"><div class="label">Tokens in / out</div><div class="value">${fmtNum(state.totalTokensIn)} / ${fmtNum(state.totalTokensOut)}</div><div class="dim">since start, ≈ chars ÷ 4</div></div>
  <div class="card"><div class="label">VBL API</div><div class="value">${upBadge}</div><div class="dim">${esc(up.detail)} · ${esc(fmtAgo(up.checkedAt))}</div></div>
</div>
<section>
  <h2>API keys &amp; usage (persisted)${isAdmin ? "" : signedIn ? " — yours" : ""}</h2>
  ${adminSection}
  ${keyRows
    ? `<table><thead><tr><th>ID</th><th>Label</th>${isAdmin ? "<th>Owner</th>" : ""}<th>Key</th><th>Created</th><th>Status / last used</th><th>Requests</th><th>Errors</th><th>Tokens in</th><th>Tokens out</th><th></th></tr></thead><tbody>${keyRows}</tbody></table>`
    : `<div class="empty">No API keys yet${signedIn ? " — create one above" : ""}.${isAdmin || !signedIn ? " Without keys, /mcp is open." : ""}</div>`}
</section>
${usersSection}
${
  showOperational
    ? `<section>
  <h2>Active sessions (who is connected now)</h2>
  ${
    sessionRows
      ? `<table><thead><tr><th>Session</th><th>Client</th><th>API key</th><th>IP</th><th>Connected</th><th>Last activity</th><th>Calls</th><th>Tokens in/out</th></tr></thead><tbody>${sessionRows}</tbody></table>`
      : `<div class="empty">No active sessions.</div>`
  }
</section>
<section>
  <h2>Tool usage (since start)</h2>
  ${
    toolRows
      ? `<table style="max-width:45rem"><thead><tr><th>Tool</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th></tr></thead><tbody>${toolRows}</tbody></table>`
      : `<div class="empty">No tool calls yet.</div>`
  }
</section>
<section>
  <h2>Recent tool calls (consumption per request)</h2>
  ${
    callRows
      ? `<table><thead><tr><th>Time</th><th>Client</th><th>API key</th><th>Tool</th><th>Tokens in</th><th>Tokens out</th><th>Duration</th></tr></thead><tbody>${callRows}</tbody></table>`
      : `<div class="empty">No tool calls yet.</div>`
  }
</section>
<section>
  <h2>Recently ended sessions</h2>
  ${
    endedRows
      ? `<table><thead><tr><th>Session</th><th>Client</th><th>API key</th><th>IP</th><th>Connected</th><th>Ended</th><th>Calls</th><th>Tokens in/out</th></tr></thead><tbody>${endedRows}</tbody></table>`
      : `<div class="empty">None yet.</div>`
  }
</section>`
    : ""
}
<footer>Started ${esc(startedAt.toISOString())} · session/tool tables reset on restart, key usage is persisted · auto-refreshes every 15s (paused while a new key is shown)</footer>
<script>
(function () {
  // Admin calls are authorized by the login session cookie.
  function call(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  var mk = document.getElementById("mk");
  if (mk) mk.addEventListener("click", function () {
    var msg = document.getElementById("keymsg");
    call("POST", "/admin/keys", { label: document.getElementById("lbl").value })
      .then(function (j) {
        msg.innerHTML = "Created — copy it now, it is shown only once: <code>" + j.key + "</code>";
      })
      .catch(function (e) { msg.textContent = "Error: " + e.message; });
  });
  var pw = document.getElementById("pw");
  if (pw) pw.addEventListener("click", function () {
    var currentPassword = prompt("Current password:");
    if (!currentPassword) return;
    var newPassword = prompt("New password (at least 8 characters):");
    if (!newPassword) return;
    call("POST", "/account/password", { currentPassword: currentPassword, newPassword: newPassword })
      .then(function (j) { alert(j.message || "Password changed."); location.href = "/login"; })
      .catch(function (e) { alert("Error: " + e.message); });
  });
  var cu = document.getElementById("cu");
  if (cu) cu.addEventListener("click", function () {
    var msg = document.getElementById("usermsg");
    call("POST", "/admin/users", {
      username: document.getElementById("nu").value,
      password: document.getElementById("np").value,
      role: document.getElementById("nr").value,
    })
      .then(function (j) {
        msg.textContent = "Created user " + j.username + " (" + j.role + ").";
        location.reload();
      })
      .catch(function (e) { msg.textContent = "Error: " + e.message; });
  });
  document.querySelectorAll("button.deluser").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!confirm("Delete user " + b.dataset.name + "? Their API keys will be revoked.")) return;
      call("DELETE", "/admin/users/" + b.dataset.id)
        .then(function () { location.reload(); })
        .catch(function (e) { alert("Error: " + e.message); });
    });
  });
  document.querySelectorAll("button.revoke:not(.deluser)").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!confirm("Revoke key " + b.dataset.id + "? Clients using it will get 401.")) return;
      call("DELETE", "/admin/keys/" + b.dataset.id)
        .then(function () { location.reload(); })
        .catch(function (e) { alert("Error: " + e.message); });
    });
  });
  setInterval(function () {
    var msg = document.getElementById("keymsg");
    if (!msg || !msg.textContent) location.reload();
  }, 15000);
})();
</script>
</body>
</html>`;
}

export interface AppOptions {
  /** Where store.json lives. Defaults to $DATA_DIR or ./data. */
  dataDir?: string;
  /** Raw MCP_API_KEYS value ("label:key,label2:key2"). Defaults to the env var. */
  apiKeys?: string;
  /** Admin token for programmatic access; a login session works too. */
  adminToken?: string;
  /** Dashboard account seeded on first start. Defaults to $ADMIN_USERNAME. */
  adminUsername?: string;
  /** Password for the seeded account. Defaults to $ADMIN_PASSWORD. */
  adminPassword?: string;
  /** Login session lifetime. Defaults to $SESSION_TTL_HOURS or 7 days. */
  sessionTtlMs?: number;
}

export interface AppHandle {
  app: express.Express;
  store: Store;
  /** Resolves once the first-run user seeding has finished. */
  ready: Promise<void>;
  /** Closes live MCP sessions and flushes pending store writes. */
  close(): Promise<void>;
}

const SESSION_COOKIE = "vbl_session";
const MIN_PASSWORD_LENGTH = 8;
/** Failed logins allowed per username+IP before a temporary lockout. */
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60_000;

/**
 * Builds the Express app without binding a port, so tests can drive it on an
 * ephemeral port (or via supertest) with isolated state. `startHttp` wraps it.
 */
export function createApp(options: AppOptions = {}): AppHandle {
  const state = createState();
  const store = new Store(options.dataDir ?? process.env.DATA_DIR ?? "./data");
  store.importEnvKeys(parseApiKeys(options.apiKeys ?? process.env.MCP_API_KEYS));

  const sessionTtlMs =
    options.sessionTtlMs ??
    (process.env.SESSION_TTL_HOURS ? Number(process.env.SESSION_TTL_HOURS) * 3_600_000 : 7 * 24 * 3_600_000);

  /**
   * First-run bootstrap: create the dashboard account from the environment.
   * Only ever creates a user that does not exist — restarts must not reset a
   * password the operator changed from the UI. The seeded account is an admin:
   * it is the one that provisions every other user.
   */
  const ready = (async () => {
    const username = options.adminUsername ?? process.env.ADMIN_USERNAME;
    const password = options.adminPassword ?? process.env.ADMIN_PASSWORD;
    if (!username || !password) return;
    if (store.findUser(username)) return;
    store.createUser(username, await hashPassword(password), "env", "admin");
  })();

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!store.authEnabled()) return next(); // open mode: no key ever configured
    const key = req.header("x-api-key");
    const found = key ? store.findByKey(key) : undefined;
    if (found) {
      res.locals.keyId = found.id;
      res.locals.keyLabel = found.label;
      return next();
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid X-API-Key header" },
      id: null,
    });
  };

  /**
   * A session belongs to the key that opened it. Without this check another
   * key could drive someone else's session and its consumption would be
   * metered against the wrong customer.
   */
  const ownsSession = (entry: SessionEntry, res: Response) =>
    entry.info.keyId === ((res.locals.keyId as string) ?? null);

  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN;

  /** Resolves the signed-in user from the session cookie, if any. */
  const currentUser = (req: Request): User | undefined => {
    const sessionId = parseCookies(req.header("cookie"))[SESSION_COOKIE];
    if (!sessionId) return undefined;
    const session = store.getSession(sessionId);
    return session ? store.findUserById(session.userId) : undefined;
  };

  const setSessionCookie = (req: Request, res: Response, id: string, maxAgeMs: number) => {
    const attrs = [
      `${SESSION_COOKIE}=${id}`,
      "Path=/",
      "HttpOnly",
      // Strict also serves as the CSRF defence for the admin endpoints, which
      // are otherwise authorized by this cookie alone.
      "SameSite=Strict",
      `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    ];
    if (req.secure) attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  };

  const clearSessionCookie = (res: Response) =>
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

  /**
   * Dashboard guard. When no user has been configured the dashboard stays
   * reachable (so upgrading an existing deployment does not lock the operator
   * out) but the page itself carries a warning to set ADMIN_USERNAME.
   */
  const requireLogin = (req: Request, res: Response, next: NextFunction) => {
    if (!store.hasUsers()) return next();
    if (currentUser(req)) return next();
    res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  };

  /**
   * Who is calling an admin endpoint: a signed-in user (with their role) or a
   * script holding ADMIN_TOKEN, which acts as an admin without owning keys.
   */
  interface Actor {
    user?: User;
    isAdmin: boolean;
    /** Owner to attribute new keys to; undefined for the token, which owns none. */
    ownerId?: string;
  }

  const actorOf = (req: Request): Actor | undefined => {
    const user = currentUser(req);
    if (user) return { user, isAdmin: user.role === "admin", ownerId: user.id };
    if (adminToken && req.header("x-admin-token") === adminToken) return { isAdmin: true };
    return undefined;
  };

  /** Admin API: a logged-in session or the admin token both authorize. */
  const requireActor = (req: Request, res: Response, next: NextFunction) => {
    const actor = actorOf(req);
    if (actor) {
      res.locals.actor = actor;
      return next();
    }
    if (!adminToken && !store.hasUsers()) {
      res.status(403).json({
        error: "Admin API disabled: set ADMIN_USERNAME/ADMIN_PASSWORD to sign in, or ADMIN_TOKEN for scripts",
      });
      return;
    }
    res.status(401).json({ error: "Unauthorized: sign in, or send a valid X-Admin-Token header" });
  };

  /** Endpoints reserved to admins: user management. */
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    requireActor(req, res, () => {
      if ((res.locals.actor as Actor).isAdmin) return next();
      res.status(403).json({ error: "Forbidden: administrator privileges required" });
    });
  };

  // ---- Login ----

  const loginAttempts = new Map<string, { count: number; until: number }>();
  const attemptKey = (username: string, req: Request) => `${username.toLowerCase()}@${clientIp(req)}`;

  const isLockedOut = (key: string) => {
    const entry = loginAttempts.get(key);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      loginAttempts.delete(key);
      return false;
    }
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  };

  const registerFailure = (key: string) => {
    const entry = loginAttempts.get(key) ?? { count: 0, until: 0 };
    entry.count++;
    entry.until = Date.now() + LOGIN_LOCKOUT_MS;
    loginAttempts.set(key, entry);
  };

  app.get("/login", (req, res) => {
    if (currentUser(req)) {
      res.redirect(302, safeNextPath(String(req.query.next ?? "/")));
      return;
    }
    res.type("html").send(loginHtml(safeNextPath(String(req.query.next ?? "/"))));
  });

  app.post("/login", async (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const next = safeNextPath(req.body?.next);
    const wantsJson = (req.header("accept") ?? "").includes("application/json");

    const fail = (status: number, message: string) => {
      if (wantsJson) res.status(status).json({ error: message });
      else res.status(status).type("html").send(loginHtml(next, message));
    };

    const key = attemptKey(username, req);
    if (isLockedOut(key)) {
      fail(429, "Too many failed attempts. Try again later.");
      return;
    }

    const user = username ? store.findUser(username) : undefined;
    const ok = user ? await verifyPassword(password, user.passwordHash, user.salt) : false;
    if (!user || !ok) {
      registerFailure(key);
      // Same message either way: the form must not reveal which users exist.
      fail(401, "Invalid username or password.");
      return;
    }

    loginAttempts.delete(key);
    const session = store.createSession(
      user.id,
      sessionTtlMs,
      clientIp(req),
      req.header("user-agent") ?? ""
    );
    store.touchLogin(user.id);
    setSessionCookie(req, res, session.id, sessionTtlMs);
    if (wantsJson) res.status(200).json({ ok: true, next });
    else res.redirect(302, next);
  });

  app.post("/logout", (req, res) => {
    const sessionId = parseCookies(req.header("cookie"))[SESSION_COOKIE];
    if (sessionId) store.deleteSession(sessionId);
    clearSessionCookie(res);
    if ((req.header("accept") ?? "").includes("application/json")) res.json({ ok: true });
    else res.redirect(302, "/login");
  });

  app.post("/account/password", async (req, res) => {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized: sign in first" });
      return;
    }
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash, user.salt))) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
    store.setPassword(user.id, await hashPassword(newPassword));
    // Sign every browser out, including this one: a password change should
    // end any session an attacker might already hold.
    store.deleteUserSessions(user.id);
    clearSessionCookie(res);
    res.json({ ok: true, message: "Password changed. Please sign in again." });
  });

  // ---- Admin API (user management) ----

  /** Public shape of a user: never leaks password material. */
  const publicUser = (u: User) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    source: u.source,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  });

  app.get("/admin/users", requireAdmin, (_req, res) => {
    res.json({ users: store.listUsers() });
  });

  app.post("/admin/users", requireAdmin, async (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const role: Role = req.body?.role === "admin" ? "admin" : "user";

    if (!username) {
      res.status(400).json({ error: "Username must not be empty" });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (store.findUser(username)) {
      res.status(409).json({ error: `User "${username.toLowerCase()}" already exists` });
      return;
    }

    const created = store.createUser(username, await hashPassword(password), "admin", role);
    res.status(201).json(publicUser(created));
  });

  app.delete("/admin/users/:id", requireAdmin, (req, res) => {
    const id = String(req.params.id);
    const actor = res.locals.actor as Actor;
    // Deleting yourself would leave you signed out mid-request, and could
    // remove the last admin.
    if (actor.user?.id === id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }
    if (store.deleteUser(id)) res.json({ ok: true });
    else res.status(404).json({ error: "User not found" });
  });

  // ---- Admin API (key management + usage export) ----
  app.get("/admin/keys", requireActor, (_req, res) => {
    const actor = res.locals.actor as Actor;
    // A plain user must never see keys that are not theirs.
    res.json({
      keys: actor.isAdmin ? store.listKeys() : store.listKeysOwnedBy(actor.ownerId!),
      ...(actor.isAdmin ? {} : { limit: MAX_KEYS_PER_NON_ADMIN }),
    });
  });
  app.post("/admin/keys", requireActor, (req, res) => {
    const actor = res.locals.actor as Actor;
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    try {
      const created = store.createKey(label, actor.ownerId);
      // The full key is returned only here; afterwards it is always masked.
      res.status(201).json({ id: created.id, label: created.label, key: created.key });
    } catch (e) {
      if (e instanceof KeyQuotaExceededError) {
        res.status(403).json({ error: e.message, limit: e.limit });
        return;
      }
      throw e;
    }
  });
  app.delete("/admin/keys/:id", requireActor, (req, res) => {
    const actor = res.locals.actor as Actor;
    const key = store.findKeyById(String(req.params.id));
    // A user may only revoke their own keys. Answering 404 for someone else's
    // key avoids confirming that the id exists.
    if (!key || (!actor.isAdmin && key.ownerId !== actor.ownerId)) {
      res.status(404).json({ error: "Key not found or already revoked" });
      return;
    }
    if (store.revokeKey(key.id)) res.json({ ok: true });
    else res.status(404).json({ error: "Key not found or already revoked" });
  });

  app.get("/health", async (_req, res) => {
    const up = await checkUpstream(state);
    res.json({
      status: "ok",
      service: "vbl-mcp",
      version: VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
      activeSessions: state.sessions.size,
      totalSessions: state.totalSessions,
      totalToolCalls: state.totalCalls,
      totalTokensIn: state.totalTokensIn,
      totalTokensOut: state.totalTokensOut,
      upstream: { url: baseUrl(), ...up, checkedAt: up.checkedAt.toISOString() },
    });
  });

  app.get("/", requireLogin, async (req, res) => {
    const up = await checkUpstream(state);
    const user = currentUser(req);
    // A plain user's dashboard only ever renders their own keys.
    const visibleKeys =
      user && user.role !== "admin" ? store.listKeysOwnedBy(user.id) : store.listKeys();
    res.type("html").send(dashboardHtml(store, state, up, user, visibleKeys));
  });

  app.post("/mcp", requireApiKey, async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let entry = sessionId ? state.sessions.get(sessionId) : undefined;

      if (entry && !ownsSession(entry, res)) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Forbidden: this session belongs to a different API key" },
          id: null,
        });
        return;
      }

      if (!entry) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." },
            id: null,
          });
          return;
        }
        const info: SessionInfo = {
          id: "(pending)",
          client: "unknown",
          clientVersion: "",
          keyId: (res.locals.keyId as string) ?? null,
          keyLabel: (res.locals.keyLabel as string) ?? "-",
          ip: clientIp(req),
          userAgent: req.header("user-agent") ?? "",
          startedAt: new Date(),
          lastSeenAt: new Date(),
          totalCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            info.id = sid;
            state.sessions.set(sid, newEntry);
            state.totalSessions++;
          },
        });
        const mcp = createServer((rec) => {
          info.totalCalls++;
          info.tokensIn += rec.tokensIn;
          info.tokensOut += rec.tokensOut;
          info.lastSeenAt = new Date();
          state.totalCalls++;
          state.totalTokensIn += rec.tokensIn;
          state.totalTokensOut += rec.tokensOut;
          const t = (state.toolTotals[rec.tool] ??= { requests: 0, tokensIn: 0, tokensOut: 0 });
          t.requests++;
          t.tokensIn += rec.tokensIn;
          t.tokensOut += rec.tokensOut;
          state.recentCalls.unshift({
            time: new Date(),
            client: info.client,
            keyLabel: info.keyLabel,
            tool: rec.tool,
            tokensIn: rec.tokensIn,
            tokensOut: rec.tokensOut,
            durationMs: rec.durationMs,
            isError: rec.isError,
          });
          if (state.recentCalls.length > MAX_RECENT) state.recentCalls.pop();
          if (info.keyId) store.recordUsage(info.keyId, rec.tool, rec.tokensIn, rec.tokensOut, rec.isError);
        });
        const newEntry: SessionEntry = { transport, mcp, info };
        transport.onclose = () => {
          if (transport.sessionId) endSession(state, transport.sessionId);
        };
        await mcp.connect(transport);
        entry = newEntry;
      }

      entry.info.lastSeenAt = new Date();
      await entry.transport.handleRequest(req, res, req.body);

      // The client identifies itself in the initialize handshake.
      const ci = entry.mcp.server.getClientVersion();
      if (ci) {
        entry.info.client = ci.name;
        entry.info.clientVersion = ci.version;
      }
    } catch (e) {
      console.error("Error handling /mcp POST:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET = SSE notification stream, DELETE = session termination.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const entry = sessionId ? state.sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).send("Invalid or missing mcp-session-id header");
      return;
    }
    if (!ownsSession(entry, res)) {
      res.status(403).send("This session belongs to a different API key");
      return;
    }
    entry.info.lastSeenAt = new Date();
    await entry.transport.handleRequest(req, res);
  };
  app.get("/mcp", requireApiKey, handleSessionRequest);
  app.delete("/mcp", requireApiKey, handleSessionRequest);

  return {
    app,
    store,
    ready,
    async close() {
      for (const entry of [...state.sessions.values()]) {
        await entry.transport.close().catch(() => {});
      }
      store.close();
    },
  };
}

export async function startHttp(port: number) {
  const { app, store, ready, close } = createApp();
  await ready; // seed the dashboard account before accepting traffic
  const adminEnabled = Boolean(process.env.ADMIN_TOKEN);

  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  app.listen(port, () => {
    console.log(`vbl-mcp v${VERSION} listening on :${port}`);
    console.log(`  MCP endpoint:  POST /mcp`);
    console.log(`  Status page:   GET /`);
    console.log(`  Health check:  GET /health`);
    console.log(
      store.hasUsers()
        ? "  Dashboard:     login required"
        : "  Dashboard:     PUBLIC — set ADMIN_USERNAME and ADMIN_PASSWORD to require a login"
    );
    console.log(`  Admin API:     ${adminEnabled ? "session or X-Admin-Token" : "session only (no ADMIN_TOKEN set)"}`);
    console.log(
      `  Users:         created by an admin via POST /admin/users · non-admins may hold ${MAX_KEYS_PER_NON_ADMIN} keys`
    );
    console.log(
      !store.authEnabled()
        ? "  Auth: OPEN — no API keys configured yet"
        : store.hasActiveKeys()
          ? "  Auth: X-API-Key required on /mcp"
          : "  Auth: X-API-Key required on /mcp — WARNING: every key is revoked, no client can connect"
    );
  });
}
