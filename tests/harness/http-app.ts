/**
 * HTTP harness: boots the real Express app on an ephemeral port with an
 * isolated temp DATA_DIR, plus helpers for the admin API and for driving
 * /mcp with a real Streamable HTTP MCP client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type AppOptions } from "../../src/http.js";
import type { Store } from "../../src/store.js";

export interface HttpHarness {
  url: string;
  store: Store;
  dataDir: string;
  /** fetch() against the app, with a path relative to its root. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Admin API call. By default it carries the harness's admin token; pass a
   * string to send a different one, or `null` to omit the header entirely.
   */
  admin(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    token?: string | null
  ): Promise<{ status: number; body: any }>;
  /** Creates an API key through the admin API and returns the full secret. */
  createKey(label: string): Promise<{ id: string; label: string; key: string }>;
  /** Connects a real MCP client over Streamable HTTP using `apiKey`. */
  connectMcp(apiKey?: string): Promise<Client>;
  close(): Promise<void>;
}

export interface HarnessOptions extends Omit<AppOptions, "dataDir"> {
  /** Reuse an existing data dir (e.g. to assert persistence across restarts). */
  dataDir?: string;
}

export async function startHttpHarness(options: HarnessOptions = {}): Promise<HttpHarness> {
  const ownsDataDir = !options.dataDir;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "vbl-mcp-test-"));
  const handle = createApp({ ...options, dataDir });

  const server: Server = await new Promise((resolve) => {
    const s = handle.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];

  const doFetch = (path: string, init?: RequestInit) => fetch(`${url}${path}`, init);

  const admin: HttpHarness["admin"] = async (
    method,
    path,
    body,
    token = options.adminToken
  ) => {
    const res = await doFetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null || token === undefined ? {} : { "x-admin-token": token }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return {
    url,
    dataDir,
    store: handle.store,
    fetch: doFetch,
    admin,
    async createKey(label) {
      const { status, body } = await admin("POST", "/admin/keys", { label });
      if (status !== 201) throw new Error(`createKey failed: ${status} ${JSON.stringify(body)}`);
      return body;
    },
    async connectMcp(apiKey) {
      const client = new Client({ name: "http-test-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: apiKey ? { headers: { "x-api-key": apiKey } } : undefined,
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Parses the JSON payload out of an MCP tool result. */
export function toolJson<T = any>(result: any): T {
  const text = (result.content ?? []).map((c: any) => c.text ?? "").join("");
  if (result.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text) as T;
}
