import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  applyEdits,
  lineHashes,
  resEdits,
  type HTEdit,
} from "../../src/hashline";
import { makeTag, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("resAnchor (via valEdits)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: ["ZZZ", "ZZZ"], content_lines: ["X"] },
      ]))
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
      ]), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });
});

describe("checkBoundaryDup (via valEdits) — [W_DUP] warning", () => {
  it("warns on trailing duplication (duplicate kept)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "d"] },
    ]));
    // Duplicate kept (not auto-fixed)
    expect(result.content).toBe("a\nX\nd\nd");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("ends with"))).toBe(true);
  });

  it("warns on leading duplication (duplicate kept)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["a", "X"] },
    ]));
    // Duplicate kept (not auto-fixed)
    expect(result.content).toBe("a\na\nX\nd");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with"))).toBe(true);
  });

  it("does not warn when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.warnings?.some(w => w.startsWith("[W_DUP]")) ?? false).toBe(false);
  });

  it("does not warn when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.warnings?.some(w => w.startsWith("[W_DUP]")) ?? false).toBe(false);
  });

  it("warns on trailing duplication when content_lines has trailing empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "d", ""] },
    ]));
    // Duplicate kept
    expect(result.content).toBe("a\nX\nd\n\nd");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("ends with") && w.includes("d"))).toBe(true);
  });

  it("warns on leading duplication when content_lines has leading empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["", "a", "X"] },
    ]));
    // Duplicate kept
    expect(result.content).toBe("a\n\na\nX\nd");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with") && w.includes("a"))).toBe(true);
  });

  it("warns on both trailing and leading duplication in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["a", "d"] },
    ]));
    // Both duplicates kept
    expect(result.content).toBe("a\na\nd\nd");
    const dupWarnings = result.warnings?.filter(w => w.startsWith("[W_DUP]")) ?? [];
    expect(dupWarnings).toHaveLength(2);
  });
});

describe("resToSpan (via applyEdits)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X", "Y"] },
    ]));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[0]!, hashes[2]!], content_lines: [] },
      ]))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[4]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns null span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b"] },
    ]));
    expect(result.noopEdits).toHaveLength(1);
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
    ]));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: [] },
    ]));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdits)", () => {
  it("applies multiple non-overlapping edits in correct order", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: ["A"] },
      { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["C"] },
      { hash_range_inclusive: [hashes[4]!, hashes[4]!], content_lines: ["E"] },
    ]));
    expect(result.content).toBe("A\nb\nC\nd\nE");
  });

  it("applies edits bottom-up so earlier edits don't shift later offsets", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[0]!, hashes[0]!], content_lines: [] },
      { hash_range_inclusive: [hashes[4]!, hashes[4]!], content_lines: [] },
    ]));
    expect(result.content).toBe("b\nc\nd");
  });
});

describe("resSpans (via applyEdits)", () => {
  it("deduplicates identical edits", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const hash = hashes[1]!;
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hash, hash], content_lines: ["X"] },
      { hash_range_inclusive: [hash, hash], content_lines: ["X"] },
    ]));
    expect(result.content).toBe("a\nX\nc\nd\ne");
  });

  it("throws on overlapping edits", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdits(content, resEdits([
        { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["X"] },
        { hash_range_inclusive: [hashes[2]!, hashes[2]!], content_lines: ["Y"] },
      ]))
    ).toThrow(/E_EDIT_CONFLICT/);
  });
});

describe("[W_DUP] warning via applyEdits", () => {
  it("warns on trailing duplication (duplicate kept)", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["new one", "new two", "after"] },
    ]));
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("ends with") && w.includes("after"))).toBe(true);
    // Duplicate kept
    expect(result.content).toBe("before\nnew one\nnew two\nafter\nafter");
  });

  it("warns on leading duplication (duplicate kept)", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["before", "new one", "new two"] },
    ]));
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with") && w.includes("before"))).toBe(true);
    // Duplicate kept
    expect(result.content).toBe("before\nbefore\nnew one\nnew two\nafter");
  });

  it("warns on both leading and trailing duplication in one edit (duplicates kept)", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdits(content, resEdits([
      { hash_range_inclusive: [hashes[2]!, hashes[3]!], content_lines: ["ctx2", "dup", "dup", "ctx3"] },
    ]));
    expect(result.warnings).toBeDefined();
    const dupWarnings = result.warnings!.filter(w => w.startsWith("[W_DUP]"));
    expect(dupWarnings).toHaveLength(2);
    // Both duplicates kept
    expect(result.content).toBe("ctx1\nctx2\nctx2\ndup\ndup\nctx3\nctx3\nctx4");
  });
});
