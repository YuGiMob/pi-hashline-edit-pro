import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { loadHashStore, shutdownHashStore, pruneMissing } from "../../src/hash-store";
import { getServed, recordServed, recordServedDiff, clearServed, servedHashesFromDiff, recordServedSafe, recordServedDiffSafe } from "../../src/served";
import * as hashStoreModule from "../../src/hash-store";
import { initHasher } from "../../src/hashline";
import { contentChecksum } from "../../src/hashline/hasher";
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
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]));
      recordServed(store, "/a.ts", new Map([["ioor", "ioor"], ["laSH", "laSH"]]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["ATIm", "ATIm"], ["ioor", "ioor"], ["laSH", "laSH"]]));
    });
  });

  it("ignores empty records and clears existing ones", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map());
      expect(getServed(store, "/a.ts")).toBeUndefined();
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"]]));
      clearServed(store, "/a.ts");
      expect(getServed(store, "/a.ts")).toBeUndefined();
    });
  });

  it("prunes hashes outside the scope of the current file", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"], ["laSH", "laSH"]]));
      recordServed(store, "/a.ts", new Map([["niTw", "niTw"]]), new Set(["ioor", "laSH", "niTw"]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["ioor", "ioor"], ["laSH", "laSH"], ["niTw", "niTw"]]));
    });
  });

  it("prunes stale hashes even when no new hashes are recorded", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]));
      recordServed(store, "/a.ts", new Map(), new Set(["ioor"]));
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Map([["ioor", "ioor"]]));
    });
  });

  it("scopes diff recording to the current file hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"], ["laSH", "laSH"]]));
      recordServedDiff(store, "/a.ts", " ATIm│x\n-    │y\n+ioor│z\n", new Set(["ATIm", "ioor"]));
      {
      const served = getServed(store, "/a.ts")!;
      expect(served.get("ATIm")).toBe(contentChecksum("x"));
      expect(served.get("ioor")).toBe(contentChecksum("z"));
      expect(new Set(served.keys())).toEqual(new Set(["ATIm", "ioor"]));
    }
    });
  });

  it("treats a row with unparseable hashes as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"]]));
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
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"]]));
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
      recordServed(store, "/a.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]));
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(getServed(reopened, "/a.ts")).toEqual(new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]));
    });
  });

  it("prunes served records for deleted files", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      recordServed(store, "/deleted.ts", new Map([["ATIm", "ATIm"]]));
      await pruneMissing(store);
      expect(getServed(store, "/deleted.ts")).toBeUndefined();
    });
  });
});

describe("servedHashesFromDiff", () => {
  it("extracts + and context rows but not removed rows", () => {
    const diff = " Hasu│aaa\n-    │bbb\n-arvm│old\n+ATIm│BBB\n niTw│ccc\n";
    expect(servedHashesFromDiff(diff)).toEqual(["Hasu", "ATIm", "niTw"]);
  });

  it("returns nothing for empty or row-less text", () => {
    expect(servedHashesFromDiff("")).toEqual([]);
    expect(servedHashesFromDiff("plain text\nno rows")).toEqual([]);
  });

  it("extracts the hash of every + and context row in order", () => {
    const diff = "+Hasu│x\n ATIm│y\n+arvm│z\n Emno│w\n";
    expect(servedHashesFromDiff(diff)).toEqual(["Hasu", "ATIm", "arvm", "Emno"]);
  });
});

describe("served safe helpers", () => {
  it("recordServedSafe records hashes without throwing", async () => {
    await withTempHome(async () => {
      await recordServedSafe("/safe.ts", new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]), "test");
      const store = await loadHashStore();
      expect(getServed(store, "/safe.ts")).toEqual(new Map([["ATIm", "ATIm"], ["ioor", "ioor"]]));
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
      await recordServedDiffSafe("/safe.ts", "+ATIm│x\n laSH│y\n-ioor│z\n", "test");
      const store = await loadHashStore();
      {
      const served = getServed(store, "/safe.ts")!;
      expect(served.get("ATIm")).toBe(contentChecksum("x"));
      expect(served.get("laSH")).toBe(contentChecksum("y"));
      expect(new Set(served.keys())).toEqual(new Set(["ATIm", "laSH"]));
    }
    });
  });

  it("recordServedSafe swallows store failures", async () => {
    const spy = vi
      .spyOn(hashStoreModule, "loadHashStore")
      .mockRejectedValue(new Error("store down"));
    try {
      await expect(recordServedSafe("/safe.ts", new Map([["ATIm", "ATIm"]]), "test")).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
