import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeVbl, startHttpHarness, tempDataDir, type FakeVbl } from "../harness/index.js";

let upstream: FakeVbl;

const admin = { adminUsername: "boss", adminPassword: "s3cret-password" };
const adminLogin = ["boss", "s3cret-password"] as const;

beforeAll(async () => {
  upstream = await startFakeVbl();
  process.env.VBL_BASE_URL = upstream.url;
});
afterAll(async () => upstream.close());
beforeEach(() => upstream.reset());

const json = (cookie: string, body?: unknown) => ({
  method: body === undefined ? "GET" : "POST",
  headers: { cookie, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("the seeded account is an admin", () => {
  it("marks the environment-seeded user as admin", async () => {
    const h = await startHttpHarness(admin);
    try {
      expect(h.store.findUser("boss")?.role).toBe("admin");
    } finally {
      await h.close();
    }
  });
});

describe("creating users", () => {
  it("lets an admin create a normal user who can then sign in", async () => {
    const h = await startHttpHarness(admin);
    try {
      const cookie = await h.login(...adminLogin);
      const res = await h.fetch(
        "/admin/users",
        json(cookie, { username: "player", password: "player-password" })
      );
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body).toMatchObject({ username: "player", role: "user" });
      expect(body).not.toHaveProperty("passwordHash");
      // The new account works immediately.
      expect((await h.postLogin("player", "player-password")).status).toBe(302);
    } finally {
      await h.close();
    }
  });

  it("can create another admin when asked explicitly", async () => {
    const h = await startHttpHarness(admin);
    try {
      const cookie = await h.login(...adminLogin);
      const res = await h.fetch(
        "/admin/users",
        json(cookie, { username: "second", password: "second-password", role: "admin" })
      );
      expect(res.status).toBe(201);
      expect(h.store.findUser("second")?.role).toBe("admin");
    } finally {
      await h.close();
    }
  });

  it("refuses to let a normal user create accounts", async () => {
    const h = await startHttpHarness(admin);
    try {
      const adminCookie = await h.login(...adminLogin);
      await h.fetch("/admin/users", json(adminCookie, { username: "player", password: "player-password" }));

      const userCookie = await h.login("player", "player-password");
      const res = await h.fetch(
        "/admin/users",
        json(userCookie, { username: "sneaky", password: "sneaky-password" })
      );

      expect(res.status).toBe(403);
      expect(h.store.findUser("sneaky")).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("refuses anonymous access", async () => {
    const h = await startHttpHarness(admin);
    try {
      const res = await h.fetch("/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "sneaky", password: "sneaky-password" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("rejects a duplicate username and a too-short password", async () => {
    const h = await startHttpHarness(admin);
    try {
      const cookie = await h.login(...adminLogin);
      const duplicate = await h.fetch("/admin/users", json(cookie, { username: "boss", password: "another-one" }));
      const short = await h.fetch("/admin/users", json(cookie, { username: "player", password: "short" }));

      expect(duplicate.status).toBe(409);
      expect(short.status).toBe(400);
      expect(h.store.findUser("player")).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("lets an admin list and delete users, but not delete itself", async () => {
    const h = await startHttpHarness(admin);
    try {
      const cookie = await h.login(...adminLogin);
      const created = await h
        .fetch("/admin/users", json(cookie, { username: "player", password: "player-password" }))
        .then((r) => r.json());

      const listed = await h.fetch("/admin/users", { headers: { cookie } }).then((r) => r.json());
      expect(listed.users.map((u: any) => u.username).sort()).toEqual(["boss", "player"]);

      const self = h.store.findUser("boss")!;
      expect((await h.fetch(`/admin/users/${self.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(400);

      const removed = await h.fetch(`/admin/users/${created.id}`, { method: "DELETE", headers: { cookie } });
      expect(removed.status).toBe(200);
      expect(h.store.findUser("player")).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("keeps a created user across a restart", async () => {
    const data = tempDataDir();
    try {
      const first = await startHttpHarness({ ...admin, dataDir: data.dir });
      const cookie = await first.login(...adminLogin);
      await first.fetch("/admin/users", json(cookie, { username: "player", password: "player-password" }));
      await first.close();

      const second = await startHttpHarness({ ...admin, dataDir: data.dir });
      try {
        expect((await second.postLogin("player", "player-password")).status).toBe(302);
      } finally {
        await second.close();
      }
    } finally {
      data.cleanup();
    }
  });
});

describe("API keys per user", () => {
  /** Signs in an admin, creates a normal user, and returns both cookies. */
  const withUser = async (h: Awaited<ReturnType<typeof startHttpHarness>>) => {
    const adminCookie = await h.login(...adminLogin);
    await h.fetch("/admin/users", json(adminCookie, { username: "player", password: "player-password" }));
    const userCookie = await h.login("player", "player-password");
    return { adminCookie, userCookie };
  };

  const createKey = (h: any, cookie: string, label: string) =>
    h.fetch("/admin/keys", json(cookie, { label }));

  it("lets a normal user create up to three keys and refuses the fourth", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { userCookie } = await withUser(h);

      for (const label of ["a", "b", "c"]) {
        expect((await createKey(h, userCookie, label)).status).toBe(201);
      }

      const fourth = await createKey(h, userCookie, "d");
      expect(fourth.status).toBe(403);
      expect((await fourth.json()).error).toMatch(/3/);
    } finally {
      await h.close();
    }
  });

  it("lets a user create again after revoking one of their keys", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { userCookie } = await withUser(h);
      const first = await createKey(h, userCookie, "a").then((r: Response) => r.json());
      await createKey(h, userCookie, "b");
      await createKey(h, userCookie, "c");

      const revoked = await h.fetch(`/admin/keys/${first.id}`, { method: "DELETE", headers: { cookie: userCookie } });
      expect(revoked.status).toBe(200);
      expect((await createKey(h, userCookie, "d")).status).toBe(201);
    } finally {
      await h.close();
    }
  });

  it("does not limit the admin", async () => {
    const h = await startHttpHarness(admin);
    try {
      const cookie = await h.login(...adminLogin);
      for (const label of ["a", "b", "c", "d", "e"]) {
        expect((await createKey(h, cookie, label)).status).toBe(201);
      }
    } finally {
      await h.close();
    }
  });

  it("shows a user only their own keys", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { adminCookie, userCookie } = await withUser(h);
      await createKey(h, adminCookie, "admin-key");
      await createKey(h, userCookie, "user-key");

      const mine = await h.fetch("/admin/keys", { headers: { cookie: userCookie } }).then((r) => r.json());
      expect(mine.keys.map((k: any) => k.label)).toEqual(["user-key"]);

      const all = await h.fetch("/admin/keys", { headers: { cookie: adminCookie } }).then((r) => r.json());
      expect(all.keys.map((k: any) => k.label).sort()).toEqual(["admin-key", "user-key"]);
    } finally {
      await h.close();
    }
  });

  it("refuses to let a user revoke a key they do not own", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { adminCookie, userCookie } = await withUser(h);
      const foreign = await createKey(h, adminCookie, "admin-key").then((r: Response) => r.json());

      const res = await h.fetch(`/admin/keys/${foreign.id}`, {
        method: "DELETE",
        headers: { cookie: userCookie },
      });

      expect(res.status).toBe(404);
      // The key still authenticates, so nothing was revoked.
      expect(h.store.findByKey(foreign.key)).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("lets the admin revoke a key belonging to a user", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { adminCookie, userCookie } = await withUser(h);
      const userKey = await createKey(h, userCookie, "user-key").then((r: Response) => r.json());

      const res = await h.fetch(`/admin/keys/${userKey.id}`, {
        method: "DELETE",
        headers: { cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      expect(h.store.findByKey(userKey.key)).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("keeps the admin token unrestricted for scripts", async () => {
    const h = await startHttpHarness({ ...admin, adminToken: "script-token" });
    try {
      for (const label of ["a", "b", "c", "d"]) {
        expect((await h.admin("POST", "/admin/keys", { label }, "script-token")).status).toBe(201);
      }
      const { body } = await h.admin("GET", "/admin/keys", undefined, "script-token");
      expect(body.keys).toHaveLength(4);
    } finally {
      await h.close();
    }
  });

  it("revokes the keys of a deleted user so they stop authenticating", async () => {
    const h = await startHttpHarness(admin);
    try {
      const { adminCookie, userCookie } = await withUser(h);
      const key = await createKey(h, userCookie, "user-key").then((r: Response) => r.json());
      const player = h.store.findUser("player")!;

      expect(
        (await h.fetch(`/admin/users/${player.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status
      ).toBe(200);

      expect(h.store.findByKey(key.key)).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});

describe("dashboard scoping", () => {
  it("hides other users' keys and the user panel from a normal user", async () => {
    const h = await startHttpHarness(admin);
    try {
      const adminCookie = await h.login(...adminLogin);
      await h.fetch("/admin/users", json(adminCookie, { username: "player", password: "player-password" }));
      const userCookie = await h.login("player", "player-password");

      await h.fetch("/admin/keys", json(adminCookie, { label: "admin-only-key" }));

      const userPage = await h.fetch("/", { headers: { cookie: userCookie } }).then((r) => r.text());
      expect(userPage).not.toContain("admin-only-key");
      expect(userPage).not.toContain("Create user");

      const adminPage = await h.fetch("/", { headers: { cookie: adminCookie } }).then((r) => r.text());
      expect(adminPage).toContain("admin-only-key");
      expect(adminPage).toContain("Create user");
    } finally {
      await h.close();
    }
  });
});
