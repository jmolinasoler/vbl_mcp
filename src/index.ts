#!/usr/bin/env node
/**
 * Entry point. Two transports:
 *  - stdio (default): for local MCP clients (Claude Code, Claude Desktop).
 *  - HTTP (--http or MCP_TRANSPORT=http): Streamable HTTP endpoint plus a
 *    status dashboard and /health, for container deployments (e.g. Coolify).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./vbl.js";
import { startHttp } from "./http.js";

const useHttp = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";

if (useHttp) {
  startHttp(Number(process.env.PORT ?? 3000));
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("vbl-mcp server running on stdio");
}
