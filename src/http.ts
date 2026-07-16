/**
 * HTTP mode: MCP Streamable HTTP endpoint (/mcp), a status dashboard (/)
 * showing who is using the server and what each API key consumes, admin
 * endpoints to manage API keys, and a health endpoint (/health).
 *
 * Auth model (single-tenant):
 *  - Clients call /mcp with an X-API-Key header. Keys come from the
 *    MCP_API_KEYS env var and/or are created at runtime via the admin API.
 *  - Admin endpoints (/admin/*) require the X-Admin-Token header matching
 *    the ADMIN_TOKEN env var; they are disabled when ADMIN_TOKEN is unset.
 *  - Usage (requests + estimated tokens in/out, per key and per tool) is
 *    persisted to DATA_DIR/store.json as the metering basis for billing.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, BASE_URL, VERSION } from "./vbl.js";
import { Store } from "./store.js";

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

const startedAt = new Date();
const sessions = new Map<string, SessionEntry>();
const endedSessions: SessionInfo[] = []; // most recent first, capped
const toolTotals: Record<string, { requests: number; tokensIn: number; tokensOut: number }> = {};
const recentCalls: CallLogEntry[] = []; // most recent first, capped
let totalSessions = 0;
let totalCalls = 0;
let totalTokensIn = 0;
let totalTokensOut = 0;

const MAX_ENDED = 25;
const MAX_RECENT = 50;

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

// Cached upstream (VBL API) reachability check for /health and the dashboard.
let upstream: { status: "ok" | "error"; detail: string; checkedAt: Date } | null = null;
async function checkUpstream(): Promise<NonNullable<typeof upstream>> {
  if (upstream && Date.now() - upstream.checkedAt.getTime() < 60_000) return upstream;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BASE_URL}/TeamDetailByGuid?teamguid=HEALTHCHECK`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    upstream = {
      status: res.ok ? "ok" : "error",
      detail: `HTTP ${res.status}`,
      checkedAt: new Date(),
    };
  } catch (e) {
    upstream = {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
      checkedAt: new Date(),
    };
  }
  return upstream;
}

function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) ?? "unknown";
}

function endSession(id: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  entry.info.endedAt = new Date();
  endedSessions.unshift(entry.info);
  if (endedSessions.length > MAX_ENDED) endedSessions.pop();
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

function fmtUptime(): string {
  const s = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function dashboardHtml(store: Store, adminEnabled: boolean, up: NonNullable<typeof upstream>): string {
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
  const keyRows = store
    .listKeys()
    .map(
      (k) => `<tr${k.revokedAt ? ' class="revoked"' : ""}>
        <td><code>${esc(k.id)}</code></td>
        <td>${esc(k.label)} <span class="dim">${k.source === "env" ? "env" : ""}</span></td>
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
  const adminSection = adminEnabled
    ? `<div class="adminbar">
        <label>Admin token <input id="adm" type="password" placeholder="X-Admin-Token"></label>
        <label>New key label <input id="lbl" placeholder="e.g. hermes"></label>
        <button id="mk">Create API key</button>
        <span id="keymsg"></span>
      </div>`
    : `<div class="dim">Key management is disabled — set the <code>ADMIN_TOKEN</code> environment variable to enable it.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vbl-mcp status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f5f5f4; color: #1c1917; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } .card { background: #292524 !important; } th { color: #a8a29e !important; } input { background:#1c1917; color:#e7e5e4; border-color:#57534e; } }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h1 .v { font-weight: normal; color: #ea580c; }
  .sub { color: #78716c; margin-bottom: 1.5rem; }
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
  .adminbar input { padding: .3rem .5rem; border: 1px solid #d6d3d1; border-radius: .375rem; }
  button { padding: .35rem .75rem; border: 0; border-radius: .375rem; background: #ea580c; color: #fff; font-weight: 600; cursor: pointer; }
  button.revoke { background: #dc2626; padding: .2rem .5rem; font-size: .75rem; }
  #keymsg { font-size: .875rem; }
  #keymsg code { background: rgba(234,88,12,.12); padding: .15rem .4rem; border-radius: .25rem; user-select: all; }
  footer { color: #a8a29e; font-size: .8rem; margin-top: 2rem; }
  code { font-size: .9em; }
</style>
</head>
<body>
<h1>🏀 vbl-mcp <span class="v">v${esc(VERSION)}</span></h1>
<div class="sub">MCP server for the Basketball Vlaanderen API — endpoint <code>/mcp</code>, health <code>/health</code></div>
<div class="cards">
  <div class="card"><div class="label">Uptime</div><div class="value">${esc(fmtUptime())}</div></div>
  <div class="card"><div class="label">Active sessions</div><div class="value">${sessions.size}</div></div>
  <div class="card"><div class="label">Total sessions</div><div class="value">${totalSessions}</div></div>
  <div class="card"><div class="label">Tool calls</div><div class="value">${fmtNum(totalCalls)}</div></div>
  <div class="card"><div class="label">Tokens in / out</div><div class="value">${fmtNum(totalTokensIn)} / ${fmtNum(totalTokensOut)}</div><div class="dim">since start, ≈ chars ÷ 4</div></div>
  <div class="card"><div class="label">VBL API</div><div class="value">${upBadge}</div><div class="dim">${esc(up.detail)} · ${esc(fmtAgo(up.checkedAt))}</div></div>
</div>
<section>
  <h2>API keys &amp; usage (persisted)</h2>
  ${adminSection}
  ${keyRows
    ? `<table><thead><tr><th>ID</th><th>Label</th><th>Key</th><th>Created</th><th>Status / last used</th><th>Requests</th><th>Errors</th><th>Tokens in</th><th>Tokens out</th><th></th></tr></thead><tbody>${keyRows}</tbody></table>`
    : `<div class="empty">No API keys yet${adminEnabled ? " — create one above" : ""}. Without keys, /mcp is open.</div>`}
</section>
<section>
  <h2>Active sessions (who is connected now)</h2>
  ${sessionRows
    ? `<table><thead><tr><th>Session</th><th>Client</th><th>API key</th><th>IP</th><th>Connected</th><th>Last activity</th><th>Calls</th><th>Tokens in/out</th></tr></thead><tbody>${sessionRows}</tbody></table>`
    : `<div class="empty">No active sessions.</div>`}
</section>
<section>
  <h2>Tool usage (since start)</h2>
  ${toolRows
    ? `<table style="max-width:45rem"><thead><tr><th>Tool</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th></tr></thead><tbody>${toolRows}</tbody></table>`
    : `<div class="empty">No tool calls yet.</div>`}
</section>
<section>
  <h2>Recent tool calls (consumption per request)</h2>
  ${callRows
    ? `<table><thead><tr><th>Time</th><th>Client</th><th>API key</th><th>Tool</th><th>Tokens in</th><th>Tokens out</th><th>Duration</th></tr></thead><tbody>${callRows}</tbody></table>`
    : `<div class="empty">No tool calls yet.</div>`}
</section>
<section>
  <h2>Recently ended sessions</h2>
  ${endedRows
    ? `<table><thead><tr><th>Session</th><th>Client</th><th>API key</th><th>IP</th><th>Connected</th><th>Ended</th><th>Calls</th><th>Tokens in/out</th></tr></thead><tbody>${endedRows}</tbody></table>`
    : `<div class="empty">None yet.</div>`}
</section>
<footer>Started ${esc(startedAt.toISOString())} · session/tool tables reset on restart, key usage is persisted · auto-refreshes every 15s (paused while a new key is shown)</footer>
<script>
(function () {
  var adm = document.getElementById("adm");
  if (adm) {
    adm.value = localStorage.getItem("vblAdminToken") || "";
    adm.addEventListener("change", function () { localStorage.setItem("vblAdminToken", adm.value); });
  }
  function call(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "content-type": "application/json", "x-admin-token": adm ? adm.value : "" },
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
  document.querySelectorAll("button.revoke").forEach(function (b) {
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

export function startHttp(port: number) {
  const store = new Store(process.env.DATA_DIR ?? "./data");
  store.importEnvKeys(parseApiKeys(process.env.MCP_API_KEYS));

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!store.hasKeys()) return next(); // open mode: no keys configured
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

  const adminToken = process.env.ADMIN_TOKEN;
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!adminToken) {
      res.status(403).json({ error: "Admin API disabled: set the ADMIN_TOKEN environment variable" });
      return;
    }
    if (req.header("x-admin-token") === adminToken) return next();
    res.status(401).json({ error: "Unauthorized: missing or invalid X-Admin-Token header" });
  };

  // ---- Admin API (key management + usage export) ----
  app.get("/admin/keys", requireAdmin, (_req, res) => {
    res.json({ keys: store.listKeys() });
  });
  app.post("/admin/keys", requireAdmin, (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    const created = store.createKey(label);
    // The full key is returned only here; afterwards it is always masked.
    res.status(201).json({ id: created.id, label: created.label, key: created.key });
  });
  app.delete("/admin/keys/:id", requireAdmin, (req, res) => {
    if (store.revokeKey(String(req.params.id))) res.json({ ok: true });
    else res.status(404).json({ error: "Key not found or already revoked" });
  });

  app.get("/health", async (_req, res) => {
    const up = await checkUpstream();
    res.json({
      status: "ok",
      service: "vbl-mcp",
      version: VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      activeSessions: sessions.size,
      totalSessions,
      totalToolCalls: totalCalls,
      totalTokensIn,
      totalTokensOut,
      upstream: { url: BASE_URL, ...up, checkedAt: up.checkedAt.toISOString() },
    });
  });

  app.get("/", async (_req, res) => {
    const up = await checkUpstream();
    res.type("html").send(dashboardHtml(store, Boolean(adminToken), up));
  });

  app.post("/mcp", requireApiKey, async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let entry = sessionId ? sessions.get(sessionId) : undefined;

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
            sessions.set(sid, newEntry);
            totalSessions++;
          },
        });
        const mcp = createServer((rec) => {
          info.totalCalls++;
          info.tokensIn += rec.tokensIn;
          info.tokensOut += rec.tokensOut;
          info.lastSeenAt = new Date();
          totalCalls++;
          totalTokensIn += rec.tokensIn;
          totalTokensOut += rec.tokensOut;
          const t = (toolTotals[rec.tool] ??= { requests: 0, tokensIn: 0, tokensOut: 0 });
          t.requests++;
          t.tokensIn += rec.tokensIn;
          t.tokensOut += rec.tokensOut;
          recentCalls.unshift({
            time: new Date(),
            client: info.client,
            keyLabel: info.keyLabel,
            tool: rec.tool,
            tokensIn: rec.tokensIn,
            tokensOut: rec.tokensOut,
            durationMs: rec.durationMs,
            isError: rec.isError,
          });
          if (recentCalls.length > MAX_RECENT) recentCalls.pop();
          if (info.keyId) store.recordUsage(info.keyId, rec.tool, rec.tokensIn, rec.tokensOut, rec.isError);
        });
        const newEntry: SessionEntry = { transport, mcp, info };
        transport.onclose = () => {
          if (transport.sessionId) endSession(transport.sessionId);
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
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).send("Invalid or missing mcp-session-id header");
      return;
    }
    entry.info.lastSeenAt = new Date();
    await entry.transport.handleRequest(req, res);
  };
  app.get("/mcp", requireApiKey, handleSessionRequest);
  app.delete("/mcp", requireApiKey, handleSessionRequest);

  process.on("SIGTERM", () => {
    store.saveNow();
    process.exit(0);
  });

  app.listen(port, () => {
    console.log(`vbl-mcp v${VERSION} listening on :${port}`);
    console.log(`  MCP endpoint:  POST /mcp`);
    console.log(`  Status page:   GET /`);
    console.log(`  Health check:  GET /health`);
    console.log(`  Admin API:     ${adminToken ? "/admin/keys (X-Admin-Token)" : "disabled (set ADMIN_TOKEN)"}`);
    console.log(store.hasKeys() ? "  Auth: X-API-Key required on /mcp" : "  Auth: OPEN — no API keys configured yet");
  });
}
