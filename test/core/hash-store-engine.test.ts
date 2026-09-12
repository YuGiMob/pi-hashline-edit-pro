import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HASH_STORE_BUSY_TIMEOUT } from "../../src/constants";

const state = vi.hoisted(() => ({ closes: 0, busyTimeouts: [] as string[] }));

function fakeStatement(sql: string) {
  return {
    get: () => {
      if (sql.includes("PRAGMA quick_check")) return { quick_check: "ok" };
      if (sql.includes("SELECT value FROM meta WHERE key = 'version'")) return undefined;
      return {};
    },
    all: () => [],
    run: () => undefined,
  };
}

class FakeBunDatabase {
  exec(sql: string) {
    if (sql.startsWith("PRAGMA busy_timeout")) state.busyTimeouts.push(sql);
  }
  prepare(sql: string) {
    return fakeStatement(sql);
  }
  close() {
    state.closes += 1;
  }
}

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "hash-store-engine-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
});

afterAll(async () => {
  const { shutdownHashStore } = await import("../../src/hash-store");
  shutdownHashStore();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("hash store sqlite engine fallback", () => {
  it("falls back to bun:sqlite when node:sqlite cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("node:sqlite is not a built-in module");
    });
    vi.doMock("bun:sqlite", () => ({ Database: FakeBunDatabase }));

    const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
    const store = await loadHashStore();

    expect(store.engine).toBe("bun:sqlite");
    expect(state.busyTimeouts).toEqual([`PRAGMA busy_timeout = ${HASH_STORE_BUSY_TIMEOUT}`]);

    shutdownHashStore();
    expect(state.closes).toBe(1);
  });
});
