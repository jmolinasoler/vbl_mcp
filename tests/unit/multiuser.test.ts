import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withTempStore, type TempStore } from "../harness/index.js";
import { KeyQuotaExceededError, MAX_KEYS_PER_NON_ADMIN } from "../../src/store.js";

const credentials = { hash: "a".repeat(128), salt: "b".repeat(32) };

describe("Store: user roles", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("creates a plain user by default, so privileges are never granted by accident", () => {
    const user = tmp.store.createUser("player", credentials, "admin");
    expect(user.role).toBe("user");
    expect(tmp.store.isAdmin(user.id)).toBe(false);
  });

  it("creates an admin when the role is requested explicitly", () => {
    const user = tmp.store.createUser("boss", credentials, "env", "admin");
    expect(user.role).toBe("admin");
    expect(tmp.store.isAdmin(user.id)).toBe(true);
  });

  it("exposes the role when listing users, without password material", () => {
    tmp.store.createUser("boss", credentials, "env", "admin");
    tmp.store.createUser("player", credentials, "admin");

    const listed = tmp.store.listUsers();
    expect(listed.map((u) => [u.username, u.role]).sort()).toEqual([
      ["boss", "admin"],
      ["player", "user"],
    ]);
    expect(JSON.stringify(listed)).not.toContain(credentials.hash);
  });

  it("keeps the role across a restart", () => {
    tmp.store.createUser("player", credentials, "admin");
    expect(tmp.reopen().findUser("player")?.role).toBe("user");
  });

  it("treats an account stored before roles existed as admin", () => {
    // Upgrading a deployment must not demote the only existing account.
    const legacy = tmp.store.createUser("legacy", credentials, "env", "admin");
    delete (tmp.store.findUserById(legacy.id) as { role?: string }).role;

    expect(tmp.reopen().findUser("legacy")?.role).toBe("admin");
  });
});

describe("Store: API key ownership", () => {
  let tmp: TempStore;
  let owner: string;
  let other: string;
  beforeEach(() => {
    tmp = withTempStore();
    owner = tmp.store.createUser("owner", credentials, "admin").id;
    other = tmp.store.createUser("other", credentials, "admin").id;
  });
  afterEach(() => tmp.cleanup());

  it("records the owner of a key", () => {
    const key = tmp.store.createKey("mine", owner);
    expect(key.ownerId).toBe(owner);
    expect(tmp.store.listKeys()[0].ownerId).toBe(owner);
  });

  it("leaves env and token-created keys unowned", () => {
    tmp.store.importEnvKeys(new Map([["envsecret", "hermes"]]));
    const scripted = tmp.store.createKey("scripted");
    expect(tmp.store.findByKey("envsecret")?.ownerId).toBeUndefined();
    expect(scripted.ownerId).toBeUndefined();
  });

  it("lists only the keys of the requested owner", () => {
    tmp.store.createKey("mine", owner);
    tmp.store.createKey("theirs", other);
    tmp.store.createKey("unowned");

    const mine = tmp.store.listKeysOwnedBy(owner);
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe("mine");
  });

  it("resolves a key by id so ownership can be authorized before revoking", () => {
    const key = tmp.store.createKey("mine", owner);
    expect(tmp.store.findKeyById(key.id)?.ownerId).toBe(owner);
    expect(tmp.store.findKeyById("ghost")).toBeUndefined();
  });

  it("keeps ownership across a restart", () => {
    const key = tmp.store.createKey("mine", owner);
    expect(tmp.reopen().findKeyById(key.id)?.ownerId).toBe(owner);
  });
});

describe("Store: key quota", () => {
  let tmp: TempStore;
  let user: string;
  let admin: string;
  beforeEach(() => {
    tmp = withTempStore();
    user = tmp.store.createUser("player", credentials, "admin").id;
    admin = tmp.store.createUser("boss", credentials, "env", "admin").id;
  });
  afterEach(() => tmp.cleanup());

  it("allows a normal user exactly three active keys", () => {
    for (let i = 0; i < MAX_KEYS_PER_NON_ADMIN; i++) tmp.store.createKey(`key-${i}`, user);
    expect(tmp.store.activeKeyCountFor(user)).toBe(3);
    expect(() => tmp.store.createKey("one-too-many", user)).toThrow(KeyQuotaExceededError);
  });

  it("frees a slot when the user revokes one of their keys", () => {
    const first = tmp.store.createKey("a", user);
    tmp.store.createKey("b", user);
    tmp.store.createKey("c", user);

    tmp.store.revokeKey(first.id);

    expect(tmp.store.activeKeyCountFor(user)).toBe(2);
    expect(() => tmp.store.createKey("d", user)).not.toThrow();
  });

  it("counts only the owner's own keys toward the quota", () => {
    const other = tmp.store.createUser("other", credentials, "admin").id;
    for (let i = 0; i < MAX_KEYS_PER_NON_ADMIN; i++) tmp.store.createKey(`k-${i}`, other);
    tmp.store.createKey("unowned");

    expect(tmp.store.activeKeyCountFor(user)).toBe(0);
    expect(() => tmp.store.createKey("mine", user)).not.toThrow();
  });

  it("does not limit an admin", () => {
    for (let i = 0; i < 7; i++) tmp.store.createKey(`admin-key-${i}`, admin);
    expect(tmp.store.activeKeyCountFor(admin)).toBe(7);
  });

  it("does not limit unowned keys created by a script", () => {
    for (let i = 0; i < 5; i++) tmp.store.createKey(`scripted-${i}`);
    expect(tmp.store.listKeys()).toHaveLength(5);
  });

  it("enforces the quota again after a restart", () => {
    for (let i = 0; i < MAX_KEYS_PER_NON_ADMIN; i++) tmp.store.createKey(`key-${i}`, user);
    const reopened = tmp.reopen();
    expect(() => reopened.createKey("one-too-many", user)).toThrow(KeyQuotaExceededError);
  });
});
