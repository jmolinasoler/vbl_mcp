import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeVbl, startHttpHarness, tempDataDir, type FakeVbl } from "../harness/index.js";

let upstream: FakeVbl;

beforeAll(async () => {
  upstream = await startFakeVbl();
  process.env.VBL_BASE_URL = upstream.url;
});

afterAll(async () => {
  await upstream.close();
});

beforeEach(() => upstream.reset());

describe("public endpoints", () => {
  it("serves health without any credentials", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const res = await h.fetch("/health");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "ok", service: "vbl-mcp", activeSessions: 0 });
      expect(body.upstream.status).toBe("ok");
      expect(typeof body.uptimeSeconds).toBe("number");
    } finally {
      await h.close();
    }
  });

  it("reports an unreachable upstream without failing the health check itself", async () => {
    const previous = process.env.VBL_BASE_URL;
    process.env.VBL_BASE_URL = "http://127.0.0.1:9/dead";
    const h = await startHttpHarness();
    try {
      const res = await h.fetch("/health");
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.upstream.status).toBe("error");
    } finally {
      process.env.VBL_BASE_URL = previous;
      await h.close();
    }
  });

  it("renders the dashboard", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const res = await h.fetch("/");
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("vbl-mcp");
      expect(html).toContain("API keys");
    } finally {
      await h.close();
    }
  });

  it("hides the key-management UI from a visitor who is not signed in", async () => {
    const h = await startHttpHarness();
    try {
      const html = await h.fetch("/").then((r) => r.text());
      expect(html).toContain("Sign in to create or revoke API keys");
      expect(html).not.toContain('id="mk"');
    } finally {
      await h.close();
    }
  });
});

describe("admin API", () => {
  it("is disabled with 403 when no admin token is configured", async () => {
    const h = await startHttpHarness();
    try {
      const { status, body } = await h.admin("GET", "/admin/keys", undefined, "anything");
      expect(status).toBe(403);
      expect(body.error).toMatch(/ADMIN_TOKEN/);
    } finally {
      await h.close();
    }
  });

  it("rejects a wrong or missing admin token with 401", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      expect((await h.admin("GET", "/admin/keys", undefined, "wrong")).status).toBe(401);
      expect((await h.admin("GET", "/admin/keys", undefined, null)).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("creates a key, returns the secret once, and masks it afterwards", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const created = await h.createKey("hermes");
      expect(created.key).toMatch(/^vbl_/);

      const { status, body } = await h.admin("GET", "/admin/keys");
      expect(status).toBe(200);
      expect(JSON.stringify(body)).not.toContain(created.key);
      expect(body.keys[0]).toMatchObject({ id: created.id, label: "hermes" });
    } finally {
      await h.close();
    }
  });

  it("revokes a key and 404s on a second attempt", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const created = await h.createKey("hermes");
      expect((await h.admin("DELETE", `/admin/keys/${created.id}`)).status).toBe(200);
      expect((await h.admin("DELETE", `/admin/keys/${created.id}`)).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("exports usage per key and per tool for billing", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const key = await h.createKey("billed-client");
      const client = await h.connectMcp(key.key);
      await client.callTool({ name: "list_clubs", arguments: { search: "giants" } });
      await client.callTool({ name: "get_club", arguments: { club_guid: "BVBL1004" } });

      const { body } = await h.admin("GET", "/admin/keys");
      const usage = body.keys.find((k: any) => k.id === key.id).usage;

      expect(usage.requests).toBe(2);
      expect(usage.tokensOut).toBeGreaterThan(0);
      expect(Object.keys(usage.byTool).sort()).toEqual(["get_club", "list_clubs"]);
    } finally {
      await h.close();
    }
  });
});

describe("API key auth on /mcp", () => {
  it("stays open when no keys exist at all", async () => {
    const h = await startHttpHarness();
    try {
      const client = await h.connectMcp();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("requires a key once one exists", async () => {
    const h = await startHttpHarness({ apiKeys: "hermes:seeded-key" });
    try {
      await expect(h.connectMcp()).rejects.toThrow();
      await expect(h.connectMcp("wrong-key")).rejects.toThrow();
      const client = await h.connectMcp("seeded-key");
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("answers unauthorized requests with a JSON-RPC error body", async () => {
    const h = await startHttpHarness({ apiKeys: "hermes:seeded-key" });
    try {
      const res = await h.fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/X-API-Key/);
    } finally {
      await h.close();
    }
  });

  it("stops accepting a revoked key immediately", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const key = await h.createKey("temporary");
      await h.connectMcp(key.key); // works while active
      await h.admin("DELETE", `/admin/keys/${key.id}`);
      await expect(h.connectMcp(key.key)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });

  it("stays locked down when the last key is revoked, instead of reopening", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const only = await h.createKey("the-only-one");
      await h.admin("DELETE", `/admin/keys/${only.id}`);

      // No key is valid any more — including no key at all.
      await expect(h.connectMcp()).rejects.toThrow();
      await expect(h.connectMcp(only.key)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});

describe("usage attribution", () => {
  it("bills each key only for the calls made with it", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const a = await h.createKey("client-a");
      const b = await h.createKey("client-b");

      const clientA = await h.connectMcp(a.key);
      await clientA.callTool({ name: "list_clubs", arguments: {} });
      await clientA.callTool({ name: "list_clubs", arguments: {} });

      const clientB = await h.connectMcp(b.key);
      await clientB.callTool({ name: "list_clubs", arguments: {} });

      const { body } = await h.admin("GET", "/admin/keys");
      const usageOf = (id: string) => body.keys.find((k: any) => k.id === id).usage;

      expect(usageOf(a.id).requests).toBe(2);
      expect(usageOf(b.id).requests).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("refuses to let one key drive a session opened by another", async () => {
    const h = await startHttpHarness({ adminToken: "admin-secret" });
    try {
      const a = await h.createKey("client-a");
      const b = await h.createKey("client-b");

      // Open a session as A and capture its id.
      const init = await h.fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-api-key": a.key,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "a", version: "1" },
          },
        }),
      });
      const sessionId = init.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // B tries to ride A's session: its consumption would be billed to A.
      const hijack = await h.fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-api-key": b.key,
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_clubs", arguments: {} },
        }),
      });

      expect(hijack.status).toBe(403);

      const { body } = await h.admin("GET", "/admin/keys");
      const usageOf = (id: string) => body.keys.find((k: any) => k.id === id).usage;
      expect(usageOf(a.id).requests).toBe(0);
      expect(usageOf(b.id).requests).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe("billing data durability", () => {
  it("keeps keys and usage across a server restart", async () => {
    const data = tempDataDir();
    try {
      const first = await startHttpHarness({ adminToken: "admin-secret", dataDir: data.dir });
      let key: { id: string; key: string };
      try {
        key = await first.createKey("persistent");
        const client = await first.connectMcp(key.key);
        await client.callTool({ name: "list_clubs", arguments: {} });
      } finally {
        await first.close();
      }

      const second = await startHttpHarness({ adminToken: "admin-secret", dataDir: data.dir });
      try {
        const { body } = await second.admin("GET", "/admin/keys");
        const stored = body.keys.find((k: any) => k.id === key.id);
        expect(stored.usage.requests).toBe(1);

        // The same secret still authenticates after the restart.
        const client = await second.connectMcp(key.key);
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      } finally {
        await second.close();
      }
    } finally {
      data.cleanup();
    }
  });
});

describe("session isolation between app instances", () => {
  it("does not share counters between two apps in the same process", async () => {
    const a = await startHttpHarness();
    const b = await startHttpHarness();
    try {
      const client = await a.connectMcp();
      await client.callTool({ name: "list_clubs", arguments: {} });

      expect((await a.fetch("/health").then((r) => r.json())).totalToolCalls).toBe(1);
      expect((await b.fetch("/health").then((r) => r.json())).totalToolCalls).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
