/**
 * JSON-file-backed store for dashboard users, their login sessions, API keys
 * and usage metering.
 *
 * Single-tenant: one flat list of users and keys, no owners. Usage is
 * aggregated per key (requests, estimated tokens in/out, per-tool breakdown)
 * so it can later be turned into a bill. Writes are debounced and atomic
 * (tmp + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { newSessionId, type PasswordHash } from "./auth.js";

export interface ToolUsage {
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export interface KeyUsage extends ToolUsage {
  errors: number;
  byTool: Record<string, ToolUsage>;
  lastUsedAt?: string;
}

export interface ApiKey {
  id: string;
  label: string;
  key: string;
  source: "admin" | "env";
  createdAt: string;
  revokedAt?: string;
  /**
   * Dashboard user the key belongs to. Absent for keys seeded from the
   * environment or created with ADMIN_TOKEN, which have no owner.
   */
  ownerId?: string;
  usage: KeyUsage;
}

/** Masked view safe to list on the dashboard / admin API. */
export interface ApiKeyPublic extends Omit<ApiKey, "key"> {
  keyPreview: string;
}

/**
 * Admins manage users and every key; a plain user only ever sees and revokes
 * their own keys, up to MAX_KEYS_PER_NON_ADMIN.
 */
export type Role = "admin" | "user";

/** Active keys a non-admin may hold at once. */
export const MAX_KEYS_PER_NON_ADMIN = 3;

/** Thrown when a non-admin tries to exceed their key quota. */
export class KeyQuotaExceededError extends Error {
  constructor(readonly limit: number = MAX_KEYS_PER_NON_ADMIN) {
    super(`API key limit reached: a user may hold at most ${limit} active keys`);
    this.name = "KeyQuotaExceededError";
  }
}

export interface User {
  id: string;
  /** Stored lowercased; lookups are case-insensitive. */
  username: string;
  passwordHash: string;
  salt: string;
  source: "env" | "admin";
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
}

/** User without any password material — the only shape that leaves the store. */
export type UserPublic = Omit<User, "passwordHash" | "salt">;

export interface LoginSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
}

const emptyUsage = (): KeyUsage => ({
  requests: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: 0,
  byTool: {},
});

interface StoreData {
  keys: ApiKey[];
  users: User[];
  sessions: LoginSession[];
}

export class Store {
  private file: string;
  private data: StoreData;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "store.json");
    if (existsSync(this.file)) {
      const loaded = JSON.parse(readFileSync(this.file, "utf8"));
      // Files written before users/sessions existed lack those arrays.
      this.data = { keys: [], users: [], sessions: [], ...loaded };
      for (const k of this.data.keys) k.usage = { ...emptyUsage(), ...k.usage };
      // Accounts stored before roles existed were the sole operator account:
      // treat them as admins so an upgrade cannot lock anyone out of user and
      // key management.
      for (const u of this.data.users) u.role ??= "admin";
    } else {
      this.data = { keys: [], users: [], sessions: [] };
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // A background flush must never throw: this runs from a timer, where an
      // exception is unhandled and would take the whole process down (a full
      // disk or an unmounted volume must not kill the MCP server).
      try {
        this.write();
      } catch (e) {
        console.error("vbl-mcp: failed to persist store:", e);
      }
    }, 2000);
    // Do not hold the event loop open just for a pending write.
    this.saveTimer.unref?.();
  }

  private write() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  /** Writes immediately. Throws if it cannot, so callers can report failure. */
  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.write();
  }

  /** Flushes anything pending and cancels deferred writes. */
  close() {
    try {
      this.saveNow();
    } catch (e) {
      console.error("vbl-mcp: failed to persist store on shutdown:", e);
    }
  }

  /**
   * Merge keys from the MCP_API_KEYS env var so env-provisioned and
   * admin-created keys are metered uniformly. Existing entries are kept
   * (their usage history survives restarts).
   */
  importEnvKeys(envKeys: Map<string, string>) {
    for (const [key, label] of envKeys) {
      const existing = this.data.keys.find((k) => k.key === key);
      if (existing) {
        if (existing.revokedAt) delete existing.revokedAt; // env re-adds win
        existing.label = label;
        continue;
      }
      this.data.keys.push({
        id: randomBytes(4).toString("hex"),
        label,
        key,
        source: "env",
        createdAt: new Date().toISOString(),
        usage: emptyUsage(),
      });
    }
    this.scheduleSave();
  }

  /**
   * Mints a key. When `ownerId` is a non-admin user the quota is enforced
   * here, in the store, so no caller can bypass it. Keys created without an
   * owner (env seeding, ADMIN_TOKEN scripts) are unlimited.
   */
  createKey(label: string, ownerId?: string): ApiKey {
    if (ownerId && !this.isAdmin(ownerId) && this.activeKeyCountFor(ownerId) >= MAX_KEYS_PER_NON_ADMIN) {
      throw new KeyQuotaExceededError();
    }
    const apiKey: ApiKey = {
      id: randomBytes(4).toString("hex"),
      label: label.trim() || "unnamed",
      key: `vbl_${randomBytes(24).toString("hex")}`,
      source: "admin",
      createdAt: new Date().toISOString(),
      ...(ownerId ? { ownerId } : {}),
      usage: emptyUsage(),
    };
    this.data.keys.push(apiKey);
    this.saveNow();
    return apiKey;
  }

  /** Active keys held by a user, i.e. what counts toward the quota. */
  activeKeyCountFor(ownerId: string): number {
    return this.data.keys.filter((k) => k.ownerId === ownerId && !k.revokedAt).length;
  }

  findKeyById(id: string): ApiKey | undefined {
    return this.data.keys.find((k) => k.id === id);
  }

  /** Revokes every active key of a user, e.g. when the account is deleted. */
  revokeKeysOwnedBy(ownerId: string) {
    const now = new Date().toISOString();
    let changed = false;
    for (const k of this.data.keys) {
      if (k.ownerId === ownerId && !k.revokedAt) {
        k.revokedAt = now;
        changed = true;
      }
    }
    if (changed) this.saveNow();
  }

  revokeKey(id: string): boolean {
    const k = this.data.keys.find((k) => k.id === id && !k.revokedAt);
    if (!k) return false;
    k.revokedAt = new Date().toISOString();
    this.saveNow();
    return true;
  }

  /** Active (non-revoked) key lookup by secret. */
  findByKey(key: string): ApiKey | undefined {
    return this.data.keys.find((k) => k.key === key && !k.revokedAt);
  }

  /**
   * Whether authentication is enforced. True as soon as a key has ever been
   * provisioned — including when every key is currently revoked, otherwise
   * revoking the last key would silently reopen the server to everyone.
   */
  authEnabled(): boolean {
    return this.data.keys.length > 0;
  }

  /** Whether any key can currently authenticate (all revoked = none). */
  hasActiveKeys(): boolean {
    return this.data.keys.some((k) => !k.revokedAt);
  }

  listKeys(): ApiKeyPublic[] {
    return this.data.keys.map(({ key, ...rest }) => ({
      ...rest,
      // Short (env-provided) keys would leak through a prefix+suffix preview.
      keyPreview: key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : `${key.slice(0, 3)}…`,
    }));
  }

  /** Masked keys of one owner — what a non-admin is allowed to see. */
  listKeysOwnedBy(ownerId: string): ApiKeyPublic[] {
    return this.listKeys().filter((k) => k.ownerId === ownerId);
  }

  // ---- Dashboard users ----

  createUser(
    username: string,
    credentials: PasswordHash,
    source: User["source"],
    role: Role = "user"
  ): User {
    const name = username.trim().toLowerCase();
    if (!name) throw new Error("Username must not be empty");
    if (this.findUser(name)) throw new Error(`User "${name}" already exists`);
    const user: User = {
      id: randomBytes(4).toString("hex"),
      username: name,
      passwordHash: credentials.hash,
      salt: credentials.salt,
      source,
      role,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.saveNow();
    return user;
  }

  findUser(username: string): User | undefined {
    const name = username.trim().toLowerCase();
    return this.data.users.find((u) => u.username === name);
  }

  findUserById(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  listUsers(): UserPublic[] {
    return this.data.users.map(({ passwordHash, salt, ...rest }) => rest);
  }

  hasUsers(): boolean {
    return this.data.users.length > 0;
  }

  isAdmin(id: string): boolean {
    return this.findUserById(id)?.role === "admin";
  }

  setPassword(id: string, credentials: PasswordHash): boolean {
    const user = this.findUserById(id);
    if (!user) return false;
    user.passwordHash = credentials.hash;
    user.salt = credentials.salt;
    this.saveNow();
    return true;
  }

  touchLogin(id: string) {
    const user = this.findUserById(id);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    this.scheduleSave();
  }

  deleteUser(id: string): boolean {
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    if (this.data.users.length === before) return false;
    this.deleteUserSessions(id);
    // The account is gone, so its keys must stop authenticating. They are
    // revoked rather than deleted: their usage stays billable.
    this.revokeKeysOwnedBy(id);
    this.saveNow();
    return true;
  }

  // ---- Login sessions ----

  createSession(userId: string, ttlMs: number, ip: string, userAgent: string): LoginSession {
    const session: LoginSession = {
      id: newSessionId(),
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ip,
      userAgent,
    };
    this.data.sessions.push(session);
    this.saveNow();
    return session;
  }

  getSession(id: string): LoginSession | undefined {
    const session = this.data.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.deleteSession(id);
      return undefined;
    }
    return session;
  }

  deleteSession(id: string) {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.scheduleSave();
  }

  /** Used on password change, so other browsers are signed out. */
  deleteUserSessions(userId: string) {
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    this.scheduleSave();
  }

  listSessions(): LoginSession[] {
    return this.data.sessions.filter((s) => Date.parse(s.expiresAt) > Date.now());
  }

  recordUsage(id: string, tool: string, tokensIn: number, tokensOut: number, isError: boolean) {
    const k = this.data.keys.find((k) => k.id === id);
    if (!k) return;
    const u = k.usage;
    u.requests++;
    u.tokensIn += tokensIn;
    u.tokensOut += tokensOut;
    if (isError) u.errors++;
    u.lastUsedAt = new Date().toISOString();
    const t = (u.byTool[tool] ??= { requests: 0, tokensIn: 0, tokensOut: 0 });
    t.requests++;
    t.tokensIn += tokensIn;
    t.tokensOut += tokensOut;
    this.scheduleSave();
  }
}
