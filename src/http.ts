/**
 * HTTP mode: MCP Streamable HTTP endpoint (/mcp), a status dashboard (/)
 * showing who is using the server, and a health endpoint (/health).
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, BASE_URL, VERSION } from "./vbl.js";

interface SessionInfo {
  id: string;
  client: string;
  clientVersion: string;
  ip: string;
  userAgent: string;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt?: Date;
  toolCalls: Record<string, number>;
  totalCalls: number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  info: SessionInfo;
}

const startedAt = new Date();
const sessions = new Map<string, SessionEntry>();
const endedSessions: SessionInfo[] = []; // most recent first, capped
const toolTotals: Record<string, number> = {};
const recentCalls: { time: Date; client: string; ip: string; tool: string }[] = []; // capped
let totalSessions = 0;
let totalCalls = 0;

const MAX_ENDED = 25;
const MAX_RECENT = 50;

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

function fmtAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
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

function dashboardHtml(up: NonNullable<typeof upstream>): string {
  const sessionRows = [...sessions.values()]
    .sort((a, b) => b.info.lastSeenAt.getTime() - a.info.lastSeenAt.getTime())
    .map(
      (e) => `<tr>
        <td><code>${esc(e.info.id.slice(0, 8))}…</code></td>
        <td>${esc(e.info.client)} <span class="dim">${esc(e.info.clientVersion)}</span></td>
        <td>${esc(e.info.ip)}</td>
        <td>${esc(fmtAgo(e.info.startedAt))}</td>
        <td>${esc(fmtAgo(e.info.lastSeenAt))}</td>
        <td class="num">${e.info.totalCalls}</td>
      </tr>`
    )
    .join("");
  const endedRows = endedSessions
    .map(
      (i) => `<tr>
        <td><code>${esc(i.id.slice(0, 8))}…</code></td>
        <td>${esc(i.client)} <span class="dim">${esc(i.clientVersion)}</span></td>
        <td>${esc(i.ip)}</td>
        <td>${esc(fmtAgo(i.startedAt))}</td>
        <td>${i.endedAt ? esc(fmtAgo(i.endedAt)) : "-"}</td>
        <td class="num">${i.totalCalls}</td>
      </tr>`
    )
    .join("");
  const toolRows = Object.entries(toolTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<tr><td><code>${esc(t)}</code></td><td class="num">${n}</td></tr>`)
    .join("");
  const callRows = recentCalls
    .map(
      (c) => `<tr>
        <td>${esc(c.time.toISOString().replace("T", " ").slice(0, 19))} UTC</td>
        <td>${esc(c.client)}</td>
        <td>${esc(c.ip)}</td>
        <td><code>${esc(c.tool)}</code></td>
      </tr>`
    )
    .join("");
  const upBadge =
    up.status === "ok"
      ? `<span class="badge ok">reachable</span>`
      : `<span class="badge err">unreachable</span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>vbl-mcp status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f5f5f4; color: #1c1917; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } .card { background: #292524 !important; } th { color: #a8a29e !important; } }
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
  table { border-collapse: collapse; width: 100%; max-width: 70rem; font-size: .875rem; }
  th, td { text-align: left; padding: .4rem .75rem; border-bottom: 1px solid rgba(120,113,108,.25); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #78716c; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: #a8a29e; font-size: .8em; }
  .empty { color: #a8a29e; font-style: italic; }
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
  <div class="card"><div class="label">Tool calls</div><div class="value">${totalCalls}</div></div>
  <div class="card"><div class="label">VBL API</div><div class="value">${upBadge}</div><div class="dim">${esc(up.detail)} · ${esc(fmtAgo(up.checkedAt))}</div></div>
</div>
<section>
  <h2>Active sessions (who is connected now)</h2>
  ${sessionRows
    ? `<table><thead><tr><th>Session</th><th>Client</th><th>IP</th><th>Connected</th><th>Last activity</th><th>Calls</th></tr></thead><tbody>${sessionRows}</tbody></table>`
    : `<div class="empty">No active sessions.</div>`}
</section>
<section>
  <h2>Tool usage (since start)</h2>
  ${toolRows
    ? `<table style="max-width:30rem"><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody>${toolRows}</tbody></table>`
    : `<div class="empty">No tool calls yet.</div>`}
</section>
<section>
  <h2>Recent tool calls</h2>
  ${callRows
    ? `<table><thead><tr><th>Time</th><th>Client</th><th>IP</th><th>Tool</th></tr></thead><tbody>${callRows}</tbody></table>`
    : `<div class="empty">No tool calls yet.</div>`}
</section>
<section>
  <h2>Recently ended sessions</h2>
  ${endedRows
    ? `<table><thead><tr><th>Session</th><th>Client</th><th>IP</th><th>Connected</th><th>Ended</th><th>Calls</th></tr></thead><tbody>${endedRows}</tbody></table>`
    : `<div class="empty">None yet.</div>`}
</section>
<footer>Started ${esc(startedAt.toISOString())} · auto-refreshes every 15s · in-memory stats (reset on restart)</footer>
</body>
</html>`;
}

export function startHttp(port: number) {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  const authToken = process.env.MCP_AUTH_TOKEN;
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) return next();
    const header = req.header("authorization");
    if (header === `Bearer ${authToken}`) return next();
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
  };

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
      upstream: { url: BASE_URL, ...up, checkedAt: up.checkedAt.toISOString() },
    });
  });

  app.get("/", async (_req, res) => {
    const up = await checkUpstream();
    res.type("html").send(dashboardHtml(up));
  });

  app.post("/mcp", requireAuth, async (req, res) => {
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
          ip: clientIp(req),
          userAgent: req.header("user-agent") ?? "",
          startedAt: new Date(),
          lastSeenAt: new Date(),
          toolCalls: {},
          totalCalls: 0,
        };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            info.id = sid;
            sessions.set(sid, newEntry);
            totalSessions++;
          },
        });
        const mcp = createServer((toolName) => {
          info.toolCalls[toolName] = (info.toolCalls[toolName] ?? 0) + 1;
          info.totalCalls++;
          info.lastSeenAt = new Date();
          toolTotals[toolName] = (toolTotals[toolName] ?? 0) + 1;
          totalCalls++;
          recentCalls.unshift({ time: new Date(), client: info.client, ip: info.ip, tool: toolName });
          if (recentCalls.length > MAX_RECENT) recentCalls.pop();
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
  app.get("/mcp", requireAuth, handleSessionRequest);
  app.delete("/mcp", requireAuth, handleSessionRequest);

  app.listen(port, () => {
    console.log(`vbl-mcp v${VERSION} listening on :${port}`);
    console.log(`  MCP endpoint:  POST /mcp`);
    console.log(`  Status page:   GET /`);
    console.log(`  Health check:  GET /health`);
    if (authToken) console.log("  Auth: bearer token required on /mcp");
  });
}
