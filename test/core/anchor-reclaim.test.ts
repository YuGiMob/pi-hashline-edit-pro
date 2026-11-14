import { describe, expect, it, vi } from "vitest";
import { ANCHOR_COUNT, anchorAt } from "../../src/hashline/alphabet";
import { HASH_PROBE_STRIDE } from "../../src/hashline/hash";
import {
  foldRegistryEvents,
  formatAnchorReclaimNotice,
  mintAnchor,
  reclaimAnchorSpace,
  resetRegistryForTests,
  shadowStateFrom,
  takeReclaimedPaths,
} from "../../src/anchor-registry";
import { ANCHOR_RECLAIM_WARNING_CODE, MAX_RECLAIMED_PATHS_REPORTED } from "../../src/constants";

type Entry = { path: string; checksum: string };

interface SaturatingOwned {
  readonly size: number;
  has(anchor: string): boolean;
  get(anchor: string): Entry | undefined;
  set(anchor: string, entry: Entry): unknown;
  delete(anchor: string): boolean;
  clear(): void;
  keys(): Iterable<string>;
  values(): Iterable<Entry>;
  entries(): Iterable<[string, Entry]>;
  [Symbol.iterator](): IterableIterator<[string, Entry]>;
}

interface SaturatingMintedSet {
  readonly size: number;
  has(anchor: string): boolean;
  add(anchor: string): unknown;
  [Symbol.iterator](): IterableIterator<string>;
}

class FakeMintedSet implements SaturatingMintedSet {
  private readonly members = new Set<string>();
  private readonly base: number;

  constructor(base: number) {
    this.base = base;
  }

  get size(): number {
    return this.base + this.members.size;
  }

  has(anchor: string): boolean {
    return this.members.has(anchor);
  }

  add(anchor: string): this {
    this.members.add(anchor);
    return this;
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.members.values();
  }
}

function saturatedState(entries: Array<{ path: string; anchors: string[]; usedAt: number }>) {
  const owned = new Map<string, Entry>();
  for (const entry of entries) {
    for (const anchor of entry.anchors) owned.set(anchor, { path: entry.path, checksum: `ck:${anchor}` });
  }
  const released = new Set<string>();
  const ownedView: SaturatingOwned = {
    get size() {
      return ANCHOR_COUNT;
    },
    has: (anchor) => !released.has(anchor),
    get: (anchor) => owned.get(anchor),
    set: (anchor, entry) => {
      owned.set(anchor, entry);
      released.delete(anchor);
      return ownedView;
    },
    delete: (anchor) => {
      released.add(anchor);
      return owned.delete(anchor);
    },
    clear: () => {
      for (const anchor of owned.keys()) released.add(anchor);
      owned.clear();
    },
    keys: () => owned.keys(),
    values: () => owned.values(),
    entries: () => owned.entries(),
    [Symbol.iterator]: () => owned.entries(),
  };
  const served = new Map<string, Map<string, string>>();
  const lastUsedAt = new Map<string, number>();
  for (const entry of entries) {
    served.set(entry.path, new Map(entry.anchors.map((anchor) => [anchor, `ck:${anchor}`])));
    lastUsedAt.set(entry.path, entry.usedAt);
  }
  return {
    owned: ownedView,
    served,
    everMinted: new FakeMintedSet(0),
    probe: 0,
    allocatedChecksum: new Map<string, string>(),
    lastUsedAt,
    usageClock: 1000,
    reclaimed: [] as string[],
    shadow: false,
  };
}
function fullyMinted(): FakeMintedSet {
  return new FakeMintedSet(ANCHOR_COUNT);
}

function saturatedMintState(anchors: string[], probe: number): ReturnType<typeof saturatedState> {
  const state = saturatedState([{ path: "/p.ts", anchors: [], usedAt: 1 }]);
  const owned = new Map<string, Entry>();
  for (const anchor of anchors) owned.set(anchor, { path: "/p.ts", checksum: "ck" });
  state.owned = owned;
  state.probe = probe;
  state.everMinted = fullyMinted();
  return state;
}

describe("reclaimAnchorSpace", () => {
  it("evicts the least recently used file and clears its served record", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0), anchorAt(1)], usedAt: 1 },
      { path: "/new.ts", anchors: [anchorAt(2)], usedAt: 5 },
      { path: "/active.ts", anchors: [anchorAt(3)], usedAt: 9 },
    ]);
    const result = reclaimAnchorSpace(state as never, "/active.ts");
    expect(result).toBe("/old.ts");
    expect(state.reclaimed).toEqual(["/old.ts"]);
    expect(state.served.has("/old.ts")).toBe(false);
    expect(state.lastUsedAt.has("/old.ts")).toBe(false);
    expect(state.owned.get(anchorAt(0))).toBeUndefined();
    expect(state.owned.get(anchorAt(1))).toBeUndefined();
    expect(state.owned.get(anchorAt(3))).toBeDefined();
    expect(state.served.has("/new.ts")).toBe(true);
  });

  it("continues with the next least recently used file", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0)], usedAt: 1 },
      { path: "/mid.ts", anchors: [anchorAt(1)], usedAt: 3 },
      { path: "/active.ts", anchors: [anchorAt(2)], usedAt: 9 },
    ]);
    const stateArg = state as never;
    expect(reclaimAnchorSpace(stateArg, "/active.ts")).toBe("/old.ts");
    expect(reclaimAnchorSpace(stateArg, "/active.ts")).toBe("/mid.ts");
    expect(state.reclaimed).toEqual(["/old.ts", "/mid.ts"]);
  });

  it("never evicts the protected path or a shadow state", () => {
    const only = saturatedState([{ path: "/active.ts", anchors: [anchorAt(0)], usedAt: 1 }]);
    expect(reclaimAnchorSpace(only as never, "/active.ts")).toBeUndefined();
    expect(only.reclaimed).toEqual([]);

    const shadow = { ...saturatedState([{ path: "/old.ts", anchors: [anchorAt(1)], usedAt: 1 }]), shadow: true };
    expect(reclaimAnchorSpace(shadow as never)).toBeUndefined();
    expect(shadow.owned.get(anchorAt(1))).toBeDefined();
  });

  it("treats a missing timestamp as the oldest entry", () => {
    const state = saturatedState([
      { path: "/timed.ts", anchors: [anchorAt(0)], usedAt: 10 },
      { path: "/untimed.ts", anchors: [anchorAt(1)], usedAt: 10 },
    ]);
    state.lastUsedAt.delete("/untimed.ts");
    expect(reclaimAnchorSpace(state as never)).toBe("/untimed.ts");
  });
});

describe("mintAnchor reclamation", () => {
  it("mints from the reclaimed file when the pool is saturated", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0), anchorAt(1)], usedAt: 1 },
      { path: "/active.ts", anchors: [anchorAt(2)], usedAt: 9 },
    ]);
    const anchor = mintAnchor(state as never, "/active.ts");
    expect([anchorAt(0), anchorAt(1)]).toContain(anchor);
    expect(state.reclaimed).toEqual(["/old.ts"]);
    expect(state.served.has("/old.ts")).toBe(false);
    expect(state.owned.get(anchorAt(2))).toBeDefined();
  }, 15000);
});

describe("mintAnchor saturation", () => {
  it("skips the dead fresh-anchor probe once every pool anchor was minted", () => {
    const state = saturatedMintState([], 0);
    const mintedHas = vi.spyOn(state.everMinted, "has").mockReturnValue(true);
    const anchor = mintAnchor(state as never);
    expect(mintedHas).not.toHaveBeenCalled();
    expect(anchor).toBe(anchorAt(1));
  });

  it("still probes for a fresh anchor above the near-full threshold", () => {
    const state = saturatedMintState([], 0);
    state.everMinted = new FakeMintedSet(ANCHOR_COUNT - Math.floor(ANCHOR_COUNT / 64) - 1);
    const mintedHas = vi.spyOn(state.everMinted, "has");
    const anchor = mintAnchor(state as never);
    expect(mintedHas).toHaveBeenCalled();
    expect(anchor).toBe(anchorAt(HASH_PROBE_STRIDE));
  });

  it.each([1, Math.floor(ANCHOR_COUNT / 64)])("recycles without probing when %i anchors remain unminted", (remaining) => {
    const state = saturatedMintState([anchorAt(1)], 0);
    state.everMinted = new FakeMintedSet(ANCHOR_COUNT - remaining);
    const mintedHas = vi.spyOn(state.everMinted, "has").mockReturnValue(true);
    const recycled = anchorAt(2);
    state.served.set("/old.ts", new Map([[recycled, "stale"]]));

    const first = mintAnchor(state as never);
    expect(mintedHas.mock.calls.length).toBe(0);
    expect(first).toBe(recycled);
    expect(state.served.get("/old.ts")!.has(recycled)).toBe(false);

    const anchors = new Set([first]);
    state.owned.set(first, { path: "/p.ts", checksum: "ck" });
    for (let i = 1; i < 2_000; i++) {
      const anchor = mintAnchor(state as never);
      anchors.add(anchor);
      state.owned.set(anchor, { path: "/p.ts", checksum: "ck" });
    }
    expect(mintedHas.mock.calls.length).toBe(0);
    expect(anchors.size).toBe(2_000);
    expect(state.probe).toBe(2_001);
  });

  it.each([0, 1])("skips the fresh probe in a shadow with %i unminted anchors", (remaining) => {
    const real = foldRegistryEvents([]);
    real.everMinted = new FakeMintedSet(ANCHOR_COUNT - remaining);
    const shadow = shadowStateFrom(real);
    const mintedHas = vi.spyOn(shadow.everMinted, "has");
    const anchor = mintAnchor(shadow);
    expect(mintedHas.mock.calls.length).toBe(0);
    expect(anchor).toBe(anchorAt(1));
  });

  it("advances the cursor past the recycled anchor instead of re-walking it", () => {
    const start = 10;
    const owned = Array.from({ length: 100 }, (_, index) => anchorAt(start + 1 + index));
    const state = saturatedMintState(owned, start);
    const recycled = anchorAt(start + 101);
    state.served.set("/p.ts", new Map([[recycled, "ck"]]));
    const ownedHas = vi.spyOn(state.owned, "has");
    const first = mintAnchor(state as never);
    expect(first).toBe(recycled);
    expect(state.probe).toBe(start + 101);
    expect(state.served.get("/p.ts")!.has(recycled)).toBe(false);
    expect(ownedHas).toHaveBeenCalledTimes(101);
    state.owned.set(first, { path: "/p.ts", checksum: "ck" });
    ownedHas.mockClear();
    const second = mintAnchor(state as never);
    expect(second).toBe(anchorAt(start + 102));
    expect(state.probe).toBe(start + 102);
    expect(ownedHas).toHaveBeenCalledTimes(1);
  });
});

describe("foldRegistryEvents recency", () => {
  it("restores recency from the allocation order in the registry log", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "allocate", path: "/b.ts", rows: [[anchorAt(1), "ck"]] },
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(2), "ck"]] },
    ]);
    expect(state.lastUsedAt.get("/a.ts")!).toBeGreaterThan(state.lastUsedAt.get("/b.ts")!);
  });

  it("drops recency for paths whose anchors were freed", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "free", path: "/a.ts" },
    ]);
    expect(state.lastUsedAt.has("/a.ts")).toBe(false);
  });

  it("keeps recency while an anchor of the path survives a partial free", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"], [anchorAt(1), "ck"]] },
      { kind: "free", path: "/a.ts", anchors: [anchorAt(0)] },
    ]);
    expect(state.owned.has(anchorAt(0))).toBe(false);
    expect(state.owned.has(anchorAt(1))).toBe(true);
    expect(state.lastUsedAt.has("/a.ts")).toBe(true);
  });

  it("drops recency when the free event names every anchor of the path", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "free", path: "/a.ts", anchors: [anchorAt(0)] },
    ]);
    expect(state.lastUsedAt.has("/a.ts")).toBe(false);
  });

  it("clears recency on a clear event", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "clear" },
    ]);
    expect(state.lastUsedAt.size).toBe(0);
  });
});

describe("formatAnchorReclaimNotice", () => {
  it("names the reclaimed files and caps the list", () => {
    const paths = Array.from({ length: MAX_RECLAIMED_PATHS_REPORTED + 3 }, (_, index) => `/p/${index}.ts`);
    const notice = formatAnchorReclaimNotice(paths)!;
    expect(notice.startsWith(ANCHOR_RECLAIM_WARNING_CODE)).toBe(true);
    expect(notice).toContain("/p/0.ts");
    expect(notice).toContain("(+3 more)");
    expect(notice).not.toContain(`/p/${MAX_RECLAIMED_PATHS_REPORTED}.ts`);
  });

  it("deduplicates repeated paths and returns undefined for an empty list", () => {
    expect(formatAnchorReclaimNotice([])).toBeUndefined();
    const notice = formatAnchorReclaimNotice(["/p/0.ts", "/p/0.ts"])!;
    expect(notice).not.toContain("more");
    expect(notice.split("/p/0.ts")).toHaveLength(2);
  });
});

describe("takeReclaimedPaths", () => {
  it("returns an empty list without an active session", () => {
    resetRegistryForTests();
    expect(takeReclaimedPaths()).toEqual([]);
  });
});
