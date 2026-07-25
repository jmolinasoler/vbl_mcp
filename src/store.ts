/**
 * JSON-file-backed store for API keys and their usage metering.
 *
 * Single-tenant: one flat list of keys, no owners. Usage is aggregated per
 * key (requests, estimated tokens in/out, per-tool breakdown) so it can later
 * be turned into a bill. Writes are debounced and atomic (tmp + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

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

const emptyUsage = (): KeyUsage => ({
  requests: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: 0,
  byTool: {},
});

export class Store {
  private file: string;
  private data: { keys: ApiKey[] };
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "store.json");
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      for (const k of this.data.keys) k.usage = { ...emptyUsage(), ...k.usage };
    } else {
      this.data = { keys: [] };
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

  hasKeys(): boolean {
    return this.data.keys.some((k) => !k.revokedAt);
  }

  listKeys(): ApiKeyPublic[] {
    return this.data.keys.map(({ key, ...rest }) => ({
      ...rest,
      // Short (env-provided) keys would leak through a prefix+suffix preview.
      keyPreview: key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : `${key.slice(0, 3)}…`,
    }));
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
