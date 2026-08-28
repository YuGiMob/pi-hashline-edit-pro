import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { loadHashStore, shutdownHashStore, pruneMissing } from "../../src/hash-store";
import { getServed, recordServed, recordServedDiff, clearServed, servedHashesFromDiff, recordServedSafe, recordServedDiffSafe } from "../../src/served";
import * as hashStoreModule from "../../src/hash-store";
import { initHasher } from "../../src/hashline";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

describe("served store", () => {
  it("returns undefined for a path with no served record", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(getServed(store, "/missing.ts")).toBeUndefined();
    });
  });

  it("round-trips served hashes and unions repeated records", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"]]));
      recordServed(store, "/a.ts", new Map([["cD4", "cD4"], ["eF5", "eF5"]]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["aB3", "aB3"], ["cD4", "cD4"], ["eF5", "eF5"]]));
    });
  });

  it("ignores empty records and clears existing ones", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map());
      expect(getServed(store, "/a.ts")).toBeUndefined();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"]]));
      clearServed(store, "/a.ts");
      expect(getServed(store, "/a.ts")).toBeUndefined();
    });
  });

  it("prunes hashes outside the scope of the current file", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"], ["eF5", "eF5"]]));
      recordServed(store, "/a.ts", new Map([["gH6", "gH6"]]), new Set(["cD4", "eF5", "gH6"]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["cD4", "cD4"], ["eF5", "eF5"], ["gH6", "gH6"]]));
    });
  });

  it("prunes stale hashes even when no new hashes are recorded", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"]]));
      recordServed(store, "/a.ts", new Map(), new Set(["cD4"]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["cD4", "cD4"]]));
    });
  });

  it("scopes diff recording to the current file hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"], ["eF5", "eF5"]]));
      recordServedDiff(store, "/a.ts", " aB3│x\n-   │y\n+cD4│z\n", new Set(["aB3", "cD4"]));
      expect(getServed(store, "/a.ts")).toEqual(new Map([["aB3", "x"], ["cD4", "z"]]));
    });
  });

  it("treats a row with unparseable hashes as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"]]));
      const db = new DatabaseSync(join(home, ".config", "pi-hashline-edit-pro", "hash-store.sqlite"), { defensive: false } as any);
      db.prepare("UPDATE served SET hashes = ? WHERE path = ?").run("{not json", "/a.ts");
      db.close();
      expect(getServed(store, "/a.ts")).toBeUndefined();
      const check = new DatabaseSync(join(home, ".config", "pi-hashline-edit-pro", "hash-store.sqlite"), { defensive: false } as any);
      const remaining = check.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("treats a row with malformed hash strings as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"]]));
      const db = new DatabaseSync(join(home, ".config", "pi-hashline-edit-pro", "hash-store.sqlite"), { defensive: false } as any);
      db.prepare("UPDATE served SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', "/a.ts");
      db.close();
      expect(getServed(store, "/a.ts")).toBeUndefined();
      const check = new DatabaseSync(join(home, ".config", "pi-hashline-edit-pro", "hash-store.sqlite"), { defensive: false } as any);
      const remaining = check.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("keeps the served record after a store reopen", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"]]));
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(getServed(reopened, "/a.ts")).toEqual(new Map([["aB3", "aB3"], ["cD4", "cD4"]]));
    });
  });

  it("prunes served records for deleted files", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/deleted.ts", new Map([["aB3", "aB3"]]));
      await pruneMissing(store);
      expect(getServed(store, "/deleted.ts")).toBeUndefined();
    });
  });
});

describe("servedHashesFromDiff", () => {
  it("extracts + and context rows but not removed rows", () => {
    const diff = " aaa│aaa\n-   │bbb\n-OLD│old\n+XYZ│BBB\n ccc│ccc\n";
    expect(servedHashesFromDiff(diff)).toEqual(["aaa", "XYZ", "ccc"]);
  });

  it("returns nothing for empty or row-less text", () => {
    expect(servedHashesFromDiff("")).toEqual([]);
    expect(servedHashesFromDiff("plain text\nno rows")).toEqual([]);
  });

  it("extracts the hash of every + and context row in order", () => {
    const diff = "+AAA│x\n BBB│y\n+CCC│z\n DDD│w\n";
    expect(servedHashesFromDiff(diff)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });
});

describe("served safe helpers", () => {
  it("recordServedSafe records hashes without throwing", async () => {
    await withTempHome(async () => {
      await recordServedSafe("/safe.ts", new Map([["aB3", "aB3"], ["cD4", "cD4"]]), "test");
      const store = await loadHashStore();
      expect(getServed(store, "/safe.ts")).toEqual(new Map([["aB3", "aB3"], ["cD4", "cD4"]]));
    });
  });

  it("recordServedSafe skips empty hash lists", async () => {
    await withTempHome(async () => {
      await recordServedSafe("/safe.ts", new Map(), "test");
      const store = await loadHashStore();
      expect(getServed(store, "/safe.ts")).toBeUndefined();
    });
  });

  it("recordServedDiffSafe records diff rows", async () => {
    await withTempHome(async () => {
      await recordServedDiffSafe("/safe.ts", "+aB3│x\n pQ2│y\n-cD4│z\n", "test");
      const store = await loadHashStore();
      expect(getServed(store, "/safe.ts")).toEqual(new Map([["aB3", "x"], ["pQ2", "y"]]));
    });
  });

  it("recordServedSafe swallows store failures", async () => {
    const spy = vi
      .spyOn(hashStoreModule, "loadHashStore")
      .mockRejectedValue(new Error("store down"));
    try {
      await expect(recordServedSafe("/safe.ts", new Map([["aB3", "aB3"]]), "test")).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
