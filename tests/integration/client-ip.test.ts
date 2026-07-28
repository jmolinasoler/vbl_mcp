/**
 * Client-IP resolution behind a reverse proxy.
 *
 * In a Coolify/Traefik (or nginx) deployment the socket peer is the proxy's
 * container-network address, so the dashboard used to attribute every caller to
 * something like 172.18.0.2. These tests pin the forwarded-header handling that
 * recovers the real address.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeVbl, startHttpHarness, type FakeVbl, type HttpHarness } from "../harness/index.js";

let upstream: FakeVbl;

const account = { adminUsername: "julio", adminPassword: "s3cret-password" };

beforeAll(async () => {
  upstream = await startFakeVbl();
  process.env.VBL_BASE_URL = upstream.url;
});
afterAll(async () => upstream.close());
beforeEach(() => upstream.reset());

/** Logs in with the given proxy headers and returns the IP that was recorded. */
async function loginIp(h: HttpHarness, headers: Record<string, string>): Promise<string> {
  const before = h.store.listSessions().length;
  const res = await fetch(`${h.url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({
      username: account.adminUsername,
      password: account.adminPassword,
    }).toString(),
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const sessions = h.store.listSessions();
  expect(sessions.length).toBe(before + 1);
  return sessions[sessions.length - 1].ip;
}

describe("resolving the client IP behind a proxy", () => {
  it("takes the original client from an X-Forwarded-For chain", async () => {
    const h = await startHttpHarness(account);
    try {
      // Traefik appends its own hop; the client is the left-most entry.
      const ip = await loginIp(h, { "x-forwarded-for": "203.0.113.9, 10.0.1.5, 172.18.0.2" });
      expect(ip).toBe("203.0.113.9");
    } finally {
      await h.close();
    }
  });

  it("honours X-Real-IP when that is the only header the proxy sets", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(await loginIp(h, { "x-real-ip": "203.0.113.77" })).toBe("203.0.113.77");
    } finally {
      await h.close();
    }
  });

  it("honours the RFC 7239 Forwarded header", async () => {
    const h = await startHttpHarness(account);
    try {
      const ip = await loginIp(h, { forwarded: "for=203.0.113.88;proto=https;by=proxy" });
      expect(ip).toBe("203.0.113.88");
    } finally {
      await h.close();
    }
  });

  it("skips proxy hops that only report a container address", async () => {
    const h = await startHttpHarness(account);
    try {
      // The regression: a chain of internal hops must not be reported as the
      // client, when a later header does carry the real address.
      const ip = await loginIp(h, {
        "x-forwarded-for": "172.18.0.2, 10.0.1.5",
        "x-real-ip": "198.51.100.4",
      });
      expect(ip).toBe("198.51.100.4");
    } finally {
      await h.close();
    }
  });

  it("normalizes IPv4-mapped IPv6 so one client is not counted twice", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(await loginIp(h, { "x-forwarded-for": "::ffff:203.0.113.9" })).toBe("203.0.113.9");
    } finally {
      await h.close();
    }
  });

  it("strips a port from a forwarded address", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(await loginIp(h, { "x-forwarded-for": "203.0.113.9:54321" })).toBe("203.0.113.9");
      expect(await loginIp(h, { forwarded: 'for="[2001:db8::1]:4711"' })).toBe("2001:db8::1");
    } finally {
      await h.close();
    }
  });

  it("ignores an empty X-Forwarded-For and falls back to the socket", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(await loginIp(h, { "x-forwarded-for": "" })).toBe("127.0.0.1");
    } finally {
      await h.close();
    }
  });

  it("falls back to the socket peer with no proxy in front", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(await loginIp(h, {})).toBe("127.0.0.1");
    } finally {
      await h.close();
    }
  });

  it("keeps per-IP login lockouts separate for different clients", async () => {
    const h = await startHttpHarness(account);
    try {
      const attempt = (ip: string, password: string) =>
        fetch(`${h.url}/login`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": ip,
          },
          body: new URLSearchParams({ username: account.adminUsername, password }).toString(),
          redirect: "manual",
        });

      for (let i = 0; i < 10; i++) await attempt("203.0.113.9", `guess-${i}`);
      expect((await attempt("203.0.113.9", "guess-final")).status).toBe(429);

      // A different client must not inherit that lockout — which is exactly
      // what happened when every request resolved to the proxy's address.
      expect((await attempt("198.51.100.4", account.adminPassword)).status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("records the resolved IP for an MCP session too", async () => {
    const h = await startHttpHarness({ ...account, adminToken: "script-token" });
    try {
      const cookie = await h.login(account.adminUsername, account.adminPassword);
      const key = await h.createKey("proxy-test");
      await fetch(`${h.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-api-key": key.key,
          "x-forwarded-for": "203.0.113.55, 172.18.0.2",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "proxy-client", version: "1.0.0" },
          },
        }),
      });

      const html = await h.fetch("/", { headers: { cookie } }).then((r) => r.text());
      expect(html).toContain("203.0.113.55");
      expect(html).not.toContain("172.18.0.2");
    } finally {
      await h.close();
    }
  });
});
