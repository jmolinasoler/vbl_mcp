import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeVbl, startHttpHarness, tempDataDir, type FakeVbl } from "../harness/index.js";

let upstream: FakeVbl;

const account = { adminUsername: "julio", adminPassword: "s3cret-password" };

beforeAll(async () => {
  upstream = await startFakeVbl();
  process.env.VBL_BASE_URL = upstream.url;
});
afterAll(async () => upstream.close());
beforeEach(() => upstream.reset());

describe("bootstrapping the first user", () => {
  it("seeds the account given in the environment", async () => {
    const h = await startHttpHarness(account);
    try {
      expect(h.store.hasUsers()).toBe(true);
      expect(h.store.findUser("julio")?.source).toBe("env");
      // The password is never stored as given.
      expect(h.store.findUser("julio")?.passwordHash).not.toContain("s3cret");
    } finally {
      await h.close();
    }
  });

  it("does not re-seed or reset the password on restart", async () => {
    const data = tempDataDir();
    try {
      const first = await startHttpHarness({ ...account, dataDir: data.dir });
      const originalHash = first.store.findUser("julio")!.passwordHash;
      await first.close();

      const second = await startHttpHarness({ ...account, dataDir: data.dir });
      try {
        expect(second.store.listUsers()).toHaveLength(1);
        expect(second.store.findUser("julio")!.passwordHash).toBe(originalHash);
      } finally {
        await second.close();
      }
    } finally {
      data.cleanup();
    }
  });
});

describe("protected dashboard", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.fetch("/", { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?next=%2F");
    } finally {
      await h.close();
    }
  });

  it("serves the login form", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.fetch("/login");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('name="username"');
      expect(html).toContain('name="password"');
      expect(html).toContain('type="password"');
    } finally {
      await h.close();
    }
  });

  it("shows the dashboard to a signed-in user", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const res = await h.fetch("/", { headers: { cookie } });
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain("API keys");
      expect(html).toContain("julio"); // signed-in indicator
    } finally {
      await h.close();
    }
  });

  it("keeps /health public for container health checks", async () => {
    const h = await startHttpHarness(account);
    try {
      expect((await h.fetch("/health")).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("does not put a login in front of the MCP endpoint", async () => {
    const h = await startHttpHarness(account);
    try {
      const client = await h.connectMcp();
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });
});

describe("logging in", () => {
  it("rejects a wrong password without issuing a cookie", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.postLogin("julio", "wrong");
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("rejects an unknown user with the same generic message", async () => {
    const h = await startHttpHarness(account);
    try {
      const unknown = await h.postLogin("nobody", "whatever");
      const wrongPassword = await h.postLogin("julio", "wrong");
      expect(unknown.status).toBe(401);
      // Identical wording, so the form cannot be used to enumerate users.
      expect(await unknown.clone().text()).toBe(await wrongPassword.clone().text());
    } finally {
      await h.close();
    }
  });

  it("issues a hardened session cookie on success", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.postLogin("julio", "s3cret-password");
      const cookie = res.headers.get("set-cookie") ?? "";

      expect(res.status).toBe(302);
      expect(cookie).toMatch(/vbl_session=[0-9a-f]{64}/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\//);
    } finally {
      await h.close();
    }
  });

  it("accepts the username case-insensitively", async () => {
    const h = await startHttpHarness(account);
    try {
      expect((await h.postLogin("JULIO", "s3cret-password")).status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("returns to the page the visitor was denied", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.postLogin("julio", "s3cret-password", "/admin/keys");
      expect(res.headers.get("location")).toBe("/admin/keys");
    } finally {
      await h.close();
    }
  });

  it("refuses to redirect off-site after login", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.postLogin("julio", "s3cret-password", "https://evil.example");
      expect(res.headers.get("location")).toBe("/");
    } finally {
      await h.close();
    }
  });

  it("locks out brute force after repeated failures", async () => {
    const h = await startHttpHarness(account);
    try {
      for (let i = 0; i < 10; i++) await h.postLogin("julio", `guess-${i}`);
      const blocked = await h.postLogin("julio", "guess-final");
      expect(blocked.status).toBe(429);

      // Even the correct password is refused while locked out.
      expect((await h.postLogin("julio", "s3cret-password")).status).toBe(429);
    } finally {
      await h.close();
    }
  });
});

describe("session lifetime", () => {
  it("signs the user out on logout and invalidates the cookie", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const out = await h.fetch("/logout", { method: "POST", headers: { cookie }, redirect: "manual" });
      expect(out.status).toBe(302);

      const after = await h.fetch("/", { headers: { cookie }, redirect: "manual" });
      expect(after.status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("ignores a forged or stale cookie", async () => {
    const h = await startHttpHarness(account);
    try {
      const forged = `vbl_session=${"f".repeat(64)}`;
      const res = await h.fetch("/", { headers: { cookie: forged }, redirect: "manual" });
      expect(res.status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("expires a session once its lifetime is over", async () => {
    const h = await startHttpHarness({ ...account, sessionTtlMs: -1 });
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const res = await h.fetch("/", { headers: { cookie }, redirect: "manual" });
      expect(res.status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("keeps the user signed in across a server restart", async () => {
    const data = tempDataDir();
    try {
      const first = await startHttpHarness({ ...account, dataDir: data.dir });
      const cookie = await first.login("julio", "s3cret-password");
      await first.close();

      const second = await startHttpHarness({ ...account, dataDir: data.dir });
      try {
        expect((await second.fetch("/", { headers: { cookie } })).status).toBe(200);
      } finally {
        await second.close();
      }
    } finally {
      data.cleanup();
    }
  });
});

describe("admin API authorization", () => {
  it("accepts a logged-in session, so the dashboard needs no token field", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const res = await h.fetch("/admin/keys", { headers: { cookie } });
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("still accepts the admin token, so scripts keep working", async () => {
    const h = await startHttpHarness({ ...account, adminToken: "script-token" });
    try {
      expect((await h.admin("GET", "/admin/keys", undefined, "script-token")).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("refuses anonymous access", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.fetch("/admin/keys");
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("lets a signed-in user create and revoke keys", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const created = await h
        .fetch("/admin/keys", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ label: "from-ui" }),
        })
        .then((r) => r.json());
      expect(created.key).toMatch(/^vbl_/);

      const revoked = await h.fetch(`/admin/keys/${created.id}`, { method: "DELETE", headers: { cookie } });
      expect(revoked.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe("password change", () => {
  it("changes the password and signs other sessions out", async () => {
    const h = await startHttpHarness(account);
    try {
      const browserA = await h.login("julio", "s3cret-password");
      const browserB = await h.login("julio", "s3cret-password");

      const res = await h.fetch("/account/password", {
        method: "POST",
        headers: { cookie: browserA, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: "s3cret-password", newPassword: "even-better-one" }),
      });
      expect(res.status).toBe(200);

      // The other browser is signed out...
      expect((await h.fetch("/", { headers: { cookie: browserB }, redirect: "manual" })).status).toBe(302);
      // ...and the new password is the one that works.
      expect((await h.postLogin("julio", "s3cret-password")).status).toBe(401);
      expect((await h.postLogin("julio", "even-better-one")).status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("requires the current password", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const res = await h.fetch("/account/password", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: "wrong", newPassword: "even-better-one" }),
      });
      expect(res.status).toBe(401);
      expect((await h.postLogin("julio", "s3cret-password")).status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("rejects a too-short new password", async () => {
    const h = await startHttpHarness(account);
    try {
      const cookie = await h.login("julio", "s3cret-password");
      const res = await h.fetch("/account/password", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: "s3cret-password", newPassword: "short" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("cannot be used anonymously", async () => {
    const h = await startHttpHarness(account);
    try {
      const res = await h.fetch("/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: "s3cret-password", newPassword: "even-better-one" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe("deployments with no user configured", () => {
  it("keeps the dashboard reachable but warns loudly", async () => {
    const h = await startHttpHarness({});
    try {
      const res = await h.fetch("/");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toMatch(/ADMIN_USERNAME/);
    } finally {
      await h.close();
    }
  });
});
