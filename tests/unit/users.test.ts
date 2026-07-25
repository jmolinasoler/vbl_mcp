import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withTempStore, type TempStore } from "../harness/index.js";

const credentials = { hash: "a".repeat(128), salt: "b".repeat(32) };

describe("Store: users", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("creates a user and finds it back by name", () => {
    const user = tmp.store.createUser("julio", credentials, "admin");
    expect(user.username).toBe("julio");
    expect(tmp.store.findUser("julio")?.id).toBe(user.id);
  });

  it("treats usernames case-insensitively", () => {
    tmp.store.createUser("Julio", credentials, "admin");
    expect(tmp.store.findUser("julio")).toBeTruthy();
    expect(tmp.store.findUser("JULIO")).toBeTruthy();
    expect(() => tmp.store.createUser("JULIO", credentials, "admin")).toThrow(/exists/i);
  });

  it("refuses an empty username", () => {
    expect(() => tmp.store.createUser("  ", credentials, "admin")).toThrow();
  });

  it("never exposes password material when listing users", () => {
    tmp.store.createUser("julio", credentials, "admin");
    const listed = tmp.store.listUsers();
    const serialized = JSON.stringify(listed);

    expect(serialized).not.toContain(credentials.hash);
    expect(serialized).not.toContain(credentials.salt);
    expect(listed[0]).not.toHaveProperty("passwordHash");
    expect(listed[0]).not.toHaveProperty("salt");
    expect(listed[0].username).toBe("julio");
  });

  it("reports whether any user exists, so the app knows if login is enforced", () => {
    expect(tmp.store.hasUsers()).toBe(false);
    tmp.store.createUser("julio", credentials, "env");
    expect(tmp.store.hasUsers()).toBe(true);
  });

  it("replaces the stored credentials on a password change", () => {
    const user = tmp.store.createUser("julio", credentials, "admin");
    const next = { hash: "c".repeat(128), salt: "d".repeat(32) };
    tmp.store.setPassword(user.id, next);
    expect(tmp.store.findUser("julio")?.passwordHash).toBe(next.hash);
  });

  it("records the last login", () => {
    const user = tmp.store.createUser("julio", credentials, "admin");
    expect(tmp.store.listUsers()[0].lastLoginAt).toBeUndefined();
    tmp.store.touchLogin(user.id);
    expect(Date.parse(tmp.store.listUsers()[0].lastLoginAt!)).not.toBeNaN();
  });

  it("keeps users across a restart", () => {
    tmp.store.createUser("julio", credentials, "admin");
    expect(tmp.reopen().findUser("julio")?.passwordHash).toBe(credentials.hash);
  });
});

describe("Store: login sessions", () => {
  let tmp: TempStore;
  let userId: string;
  beforeEach(() => {
    tmp = withTempStore();
    userId = tmp.store.createUser("julio", credentials, "admin").id;
  });
  afterEach(() => tmp.cleanup());

  it("issues a session that resolves back to its user", () => {
    const session = tmp.store.createSession(userId, 3600_000, "1.2.3.4", "curl");
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(tmp.store.getSession(session.id)?.userId).toBe(userId);
  });

  it("does not resolve an unknown session", () => {
    expect(tmp.store.getSession("nope")).toBeUndefined();
  });

  it("stops resolving an expired session", () => {
    const session = tmp.store.createSession(userId, -1000, "1.2.3.4", "curl");
    expect(tmp.store.getSession(session.id)).toBeUndefined();
  });

  it("drops a session on logout", () => {
    const session = tmp.store.createSession(userId, 3600_000, "1.2.3.4", "curl");
    tmp.store.deleteSession(session.id);
    expect(tmp.store.getSession(session.id)).toBeUndefined();
  });

  it("can revoke every session of a user at once", () => {
    const a = tmp.store.createSession(userId, 3600_000, "1.2.3.4", "curl");
    const b = tmp.store.createSession(userId, 3600_000, "5.6.7.8", "browser");
    tmp.store.deleteUserSessions(userId);
    expect(tmp.store.getSession(a.id)).toBeUndefined();
    expect(tmp.store.getSession(b.id)).toBeUndefined();
  });

  it("keeps a session valid across a restart", () => {
    const session = tmp.store.createSession(userId, 3600_000, "1.2.3.4", "curl");
    expect(tmp.reopen().getSession(session.id)?.userId).toBe(userId);
  });

  it("forgets sessions of a deleted user", () => {
    const session = tmp.store.createSession(userId, 3600_000, "1.2.3.4", "curl");
    tmp.store.deleteUser(userId);
    expect(tmp.store.getSession(session.id)).toBeUndefined();
    expect(tmp.store.findUser("julio")).toBeUndefined();
  });
});
