/**
 * Store harness: a Store backed by a throwaway directory, with a helper to
 * reopen it from the same files (to assert on persistence).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/store.js";

export interface TempStore {
  store: Store;
  dir: string;
  /** Flushes and reopens from disk, simulating a restart. */
  reopen(): Store;
  cleanup(): void;
}

/**
 * A throwaway data directory owned by the test, so several app instances can
 * share it (e.g. to assert that billing data survives a restart).
 */
export function tempDataDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "vbl-data-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function withTempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "vbl-store-test-"));
  let store = new Store(dir);
  return {
    get store() {
      return store;
    },
    dir,
    reopen() {
      store.saveNow();
      store = new Store(dir);
      return store;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  } as TempStore;
}
