import { describe, expect, it } from "vitest";
import anchorData from "../../src/hashline/anchor-table.json";
import { ANCHOR_COUNT, HASH_LEN, anchorAt, anchorIndex } from "../../src/hashline/alphabet";

const TABLE: string = anchorData.anchors;

describe("anchor table", () => {
  it("has the frozen size", () => {
    expect(TABLE.length).toBe(257795 * 4);
    expect(ANCHOR_COUNT).toBe(257795);
    expect(HASH_LEN).toBe(4);
  });

  it("contains only unique 4-char alphanumeric anchors in sorted order", () => {
    const anchors = TABLE.match(/[A-Za-z0-9]{4}/g) ?? [];
    expect(anchors).toHaveLength(ANCHOR_COUNT);
    expect(new Set(anchors).size).toBe(ANCHOR_COUNT);
    expect(anchors.every((a, i) => i === 0 || anchors[i - 1]! < a)).toBe(true);
  });

  it("is built from a shared 550-piece alphabet", () => {
    const heads = new Set<string>();
    const tails = new Set<string>();
    for (let i = 0; i < ANCHOR_COUNT; i++) {
      heads.add(anchorAt(i).slice(0, 2));
      tails.add(anchorAt(i).slice(2));
    }
    expect(heads.size).toBe(550);
    expect(tails.size).toBe(550);
    expect(heads).toEqual(tails);
  });

  it("round-trips anchorAt and anchorIndex", () => {
    for (const idx of [0, 1, 130_000, ANCHOR_COUNT - 2, ANCHOR_COUNT - 1]) {
      expect(anchorIndex(anchorAt(idx))).toBe(idx);
    }
    expect(anchorIndex("zzzz")).toBe(-1);
    expect(anchorIndex("0000")).toBe(-1);
  });
});
