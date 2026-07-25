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
  usage: KeyUsage;
}

/** Masked view safe to list on the dashboard / admin API. */
export interface ApiKeyPublic extends Omit<ApiKey, "key"> {
  keyPreview: string;
}

export interface User {
  id: string;
  /** Stored lowercased; lookups are case-insensitive. */
  username: string;
  passwordHash: string;
  salt: string;
  source: "env" | "admin";
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
    } else {
      this.data = { keys: [], users: [], sessions: [] };
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 2000);
  }

  saveNow() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
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

  createKey(label: string): ApiKey {
    const apiKey: ApiKey = {
      id: randomBytes(4).toString("hex"),
      label: label.trim() || "unnamed",
      key: `vbl_${randomBytes(24).toString("hex")}`,
      source: "admin",
      createdAt: new Date().toISOString(),
      usage: emptyUsage(),
    };
    this.data.keys.push(apiKey);
    this.saveNow();
    return apiKey;
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

  // ---- Dashboard users ----

  createUser(username: string, credentials: PasswordHash, source: User["source"]): User {
    const name = username.trim().toLowerCase();
    if (!name) throw new Error("Username must not be empty");
    if (this.findUser(name)) throw new Error(`User "${name}" already exists`);
    const user: User = {
      id: randomBytes(4).toString("hex"),
      username: name,
      passwordHash: credentials.hash,
      salt: credentials.salt,
      source,
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
