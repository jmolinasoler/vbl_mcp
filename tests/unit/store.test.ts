import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withTempStore, type TempStore } from "../harness/index.js";

describe("Store: API key lifecycle", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("mints keys with a recognizable prefix and enough entropy", () => {
    const key = tmp.store.createKey("hermes");
    expect(key.key).toMatch(/^vbl_[0-9a-f]{48}$/);
    expect(key.label).toBe("hermes");
    expect(key.source).toBe("admin");
    expect(key.revokedAt).toBeUndefined();
  });

  it("gives each key a distinct secret and id", () => {
    const a = tmp.store.createKey("a");
    const b = tmp.store.createKey("b");
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  it("falls back to a placeholder label when none is given", () => {
    expect(tmp.store.createKey("   ").label).toBe("unnamed");
  });

  it("resolves an active key by its secret and rejects unknown ones", () => {
    const created = tmp.store.createKey("hermes");
    expect(tmp.store.findByKey(created.key)?.id).toBe(created.id);
    expect(tmp.store.findByKey("vbl_nope")).toBeUndefined();
  });

  it("stops resolving a key once revoked", () => {
    const created = tmp.store.createKey("hermes");
    expect(tmp.store.revokeKey(created.id)).toBe(true);
    expect(tmp.store.findByKey(created.key)).toBeUndefined();
  });

  it("reports revoking an unknown or already-revoked key", () => {
    const created = tmp.store.createKey("hermes");
    tmp.store.revokeKey(created.id);
    expect(tmp.store.revokeKey(created.id)).toBe(false);
    expect(tmp.store.revokeKey("does-not-exist")).toBe(false);
  });

  it("keeps auth enforced after the last key is revoked", () => {
    // Revoking the last key must lock everyone out, never reopen the server.
    expect(tmp.store.authEnabled()).toBe(false);

    const created = tmp.store.createKey("hermes");
    expect(tmp.store.authEnabled()).toBe(true);
    expect(tmp.store.hasActiveKeys()).toBe(true);

    tmp.store.revokeKey(created.id);
    expect(tmp.store.authEnabled()).toBe(true);
    expect(tmp.store.hasActiveKeys()).toBe(false);
  });

  it("remembers that auth is enforced across a restart", () => {
    const created = tmp.store.createKey("hermes");
    tmp.store.revokeKey(created.id);
    expect(tmp.reopen().authEnabled()).toBe(true);
  });
});

describe("Store: secret masking", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("never exposes a full secret when listing keys", () => {
    const created = tmp.store.createKey("hermes");
    const listed = tmp.store.listKeys();
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(created.key);
    expect(listed[0]).not.toHaveProperty("key");
    expect(listed[0].keyPreview).toContain("…");
  });

  it("masks short env-provided keys without leaking most of them", () => {
    tmp.store.importEnvKeys(new Map([["short1", "tiny"]]));
    const preview = tmp.store.listKeys()[0].keyPreview;
    expect(preview).not.toContain("short1");
    expect(preview.length).toBeLessThanOrEqual(6);
  });
});

describe("Store: usage metering", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("accumulates requests and tokens per key and per tool", () => {
    const key = tmp.store.createKey("billing");
    tmp.store.recordUsage(key.id, "list_clubs", 5, 200, false);
    tmp.store.recordUsage(key.id, "list_clubs", 6, 300, false);
    tmp.store.recordUsage(key.id, "get_club", 7, 5000, false);

    const usage = tmp.store.listKeys()[0].usage;
    expect(usage.requests).toBe(3);
    expect(usage.tokensIn).toBe(18);
    expect(usage.tokensOut).toBe(5500);
    expect(usage.byTool.list_clubs).toEqual({ requests: 2, tokensIn: 11, tokensOut: 500 });
    expect(usage.byTool.get_club).toEqual({ requests: 1, tokensIn: 7, tokensOut: 5000 });
  });

  it("counts errors separately but still bills the request", () => {
    const key = tmp.store.createKey("billing");
    tmp.store.recordUsage(key.id, "get_club", 5, 20, true);
    const usage = tmp.store.listKeys()[0].usage;
    expect(usage.requests).toBe(1);
    expect(usage.errors).toBe(1);
  });

  it("stamps the last usage timestamp", () => {
    const key = tmp.store.createKey("billing");
    expect(tmp.store.listKeys()[0].usage.lastUsedAt).toBeUndefined();
    tmp.store.recordUsage(key.id, "list_clubs", 1, 1, false);
    expect(Date.parse(tmp.store.listKeys()[0].usage.lastUsedAt!)).not.toBeNaN();
  });

  it("ignores usage recorded against an unknown key", () => {
    expect(() => tmp.store.recordUsage("ghost", "list_clubs", 1, 1, false)).not.toThrow();
    expect(tmp.store.listKeys()).toHaveLength(0);
  });

  it("keeps metering a key after it is revoked (usage is still billable)", () => {
    const key = tmp.store.createKey("billing");
    tmp.store.recordUsage(key.id, "list_clubs", 1, 10, false);
    tmp.store.revokeKey(key.id);
    tmp.store.recordUsage(key.id, "list_clubs", 1, 10, false);
    expect(tmp.store.listKeys()[0].usage.requests).toBe(2);
  });
});

describe("Store: persistence", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("survives a restart with keys and usage intact", () => {
    const key = tmp.store.createKey("billing");
    tmp.store.recordUsage(key.id, "get_club", 7, 5000, false);

    const reopened = tmp.reopen();

    expect(reopened.findByKey(key.key)?.id).toBe(key.id);
    const usage = reopened.listKeys()[0].usage;
    expect(usage.requests).toBe(1);
    expect(usage.tokensOut).toBe(5000);
    expect(usage.byTool.get_club.requests).toBe(1);
  });

  it("keeps revocations across a restart", () => {
    const key = tmp.store.createKey("billing");
    tmp.store.revokeKey(key.id);
    expect(tmp.reopen().findByKey(key.key)).toBeUndefined();
  });
});

describe("Store: env-provided keys", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = withTempStore();
  });
  afterEach(() => tmp.cleanup());

  it("imports env keys so they are metered like admin-created ones", () => {
    tmp.store.importEnvKeys(new Map([["envsecret", "hermes"]]));
    const found = tmp.store.findByKey("envsecret");
    expect(found?.label).toBe("hermes");
    expect(found?.source).toBe("env");
  });

  it("does not duplicate an env key across restarts", () => {
    const env = new Map([["envsecret", "hermes"]]);
    tmp.store.importEnvKeys(env);
    const reopened = tmp.reopen();
    reopened.importEnvKeys(env);
    expect(reopened.listKeys()).toHaveLength(1);
  });

  it("keeps usage of an env key when it is re-imported", () => {
    const env = new Map([["envsecret", "hermes"]]);
    tmp.store.importEnvKeys(env);
    const id = tmp.store.findByKey("envsecret")!.id;
    tmp.store.recordUsage(id, "list_clubs", 2, 40, false);

    const reopened = tmp.reopen();
    reopened.importEnvKeys(env);

    expect(reopened.listKeys()[0].usage.tokensOut).toBe(40);
  });

  it("updates the label when the env var renames an existing key", () => {
    tmp.store.importEnvKeys(new Map([["envsecret", "old-name"]]));
    tmp.store.importEnvKeys(new Map([["envsecret", "new-name"]]));
    expect(tmp.store.listKeys()).toHaveLength(1);
    expect(tmp.store.findByKey("envsecret")?.label).toBe("new-name");
  });
});
