/**
 * Password hashing and login helpers.
 *
 * scrypt (from node:crypto) with a per-password salt — memory-hard, no third
 * party dependency, and the comparison is timing-safe. Passwords are never
 * stored or logged in the clear.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

const KEY_LENGTH = 64; // bytes -> 128 hex chars
const SALT_LENGTH = 16; // bytes -> 32 hex chars

export interface PasswordHash {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string, salt?: string): Promise<PasswordHash> {
  const useSalt = salt ?? randomBytes(SALT_LENGTH).toString("hex");
  const derived = await scryptAsync(password, useSalt, KEY_LENGTH);
  return { hash: derived.toString("hex"), salt: useSalt };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string
): Promise<boolean> {
  try {
    const expected = Buffer.from(hash, "hex");
    // A malformed stored hash must fail closed, never throw.
    if (expected.length !== KEY_LENGTH || !salt) return false;
    const derived = await scryptAsync(password, salt, KEY_LENGTH);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Opaque session cookie value. */
export const newSessionId = () => randomBytes(32).toString("hex");

/**
 * Sanitizes a post-login redirect target. Only same-site absolute paths are
 * allowed, so `?next=` cannot be used to bounce a freshly authenticated user
 * to an attacker's page.
 */
export function safeNextPath(next: string | undefined | null): string {
  if (!next) return "/";
  // Must be a single-slash-prefixed path; reject protocol-relative and
  // backslash tricks that some parsers treat as a host.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login")) return "/";
  return next;
}

/** Minimal Cookie header parser (avoids pulling in cookie-parser). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}
