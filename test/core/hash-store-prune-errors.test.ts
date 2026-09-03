import { mkdirSync } from "node:fs";
import type { HashStore } from "../../src/hash-store";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statErrors: new Map<string, Error>(),
}));

function statError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code }) as Error;
}

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => {
      const err = state.statErrors.get(path);
      if (err) throw err;
      return actual.stat(path);
    }),
  };
});

let tmpHome: string;

beforeAll(async () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "hash-store-prune-errors-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  const { initHasher } = await import("../../src/hashline/hasher");
  await initHasher();
});

afterAll(async () => {
  const { shutdownHashStore } = await import("../../src/hash-store");
  shutdownHashStore();
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  state.statErrors.clear();
});

async function putSnapshot(store: HashStore, path: string, content: string, hashes: string[]): Promise<void> {
  const { upsertSnapshot } = await import("../../src/hash-store");
  const { contentChecksum } = await import("../../src/hashline/hasher");
  const { splitLines } = await import("../../src/utils");
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes);
}

describe("hash-store - pruneMissing error handling", () => {
  it("keeps the snapshot and served record when stat fails with EACCES", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    const { recordServed, getServed } = await import("../../src/served");
    shutdownHashStore();
    const store = await loadHashStore();
    const locked = join(tmpHome, "locked.ts");
    await putSnapshot(store, locked, "locked\n", ["ATIm"]);
    recordServed(store, locked, new Map([["ATIm", "ATIm"]]));

    state.statErrors.set(locked, statError("EACCES", "permission denied"));
    await pruneMissing(store);

    expect(getSnapshot(store, locked, "locked\n")).toEqual(["ATIm"]);
    expect(getServed(store, locked)).toEqual(new Map([["ATIm", "ATIm"]]));
  });

  it("keeps the snapshot when stat fails with ELOOP", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const loop = join(tmpHome, "loop.ts");
    await putSnapshot(store, loop, "loop\n", ["BeSR"]);

    state.statErrors.set(loop, statError("ELOOP", "too many symbolic links"));
    await pruneMissing(store);

    expect(getSnapshot(store, loop, "loop\n")).toEqual(["BeSR"]);
  });

  it("still prunes paths that stat reports as ENOENT", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const gone = join(tmpHome, "gone.ts");
    await putSnapshot(store, gone, "gone\n", ["DAfo"]);

    state.statErrors.set(gone, statError("ENOENT", "no such file"));
    await pruneMissing(store);

    expect(getSnapshot(store, gone, "gone\n")).toBeUndefined();
  });
});
