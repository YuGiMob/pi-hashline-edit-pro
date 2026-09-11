import { beforeAll, describe, expect, it } from "vitest";
import { genDiff, disambiguateDuplicateAnchors, spansFromHashes } from "../../src/replace-diff";
import { initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});

function anchoredRows(diff: string, prefix: "+" | "-" | " "): string[] {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && line.includes("│") && !line.startsWith(`${prefix}    │`));
}

function rowAnchor(row: string): string {
  const match = /^[+ -]([A-Za-z0-9]{4})│/.exec(row);
  return match ? match[1]! : "(blank)";
}

describe("genDiff with true spans", () => {
  it("stamps - rows with true removed anchors when duplicates neighbor the edit", () => {
    const oldContent = "alpha one\n  }\nbeta two\n  }\ngamma three\n  }\ndelta four";
    const newContent = "alpha one\n  }\nbeta two\nREPLACED\n  }\ndelta four";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg"];
    const newHashes = ["Aaaa", "Bbbb", "Cccc", "Hhhh", "Ffff", "Gggg"];
    const spans = [{ start: 3, end: 4, replacementCount: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    const removed = anchoredRows(diff, "-").map(rowAnchor);
    expect(removed).toContain("Dddd");
    expect(removed).toContain("Eeee");
    const live = new Set([...anchoredRows(diff, "+").map(rowAnchor), ...anchoredRows(diff, " ").map(rowAnchor)]);
    expect(removed.filter((anchor) => live.has(anchor))).toEqual([]);
    expect(diff.split("\n").find((line) => line.startsWith("-") && line.includes("Ffff"))).toBeUndefined();
  });

  it("renders insertion spans as context plus added rows without removing the anchor line", () => {
    const oldContent = "alpha\nX\nbeta";
    const newContent = "alpha\nX\nNEW\nbeta";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc"];
    const newHashes = ["Aaaa", "Bbbb", "Hhhh", "Cccc"];
    const spans = [{ start: 1, end: 1, replacementCount: 2 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain(" Bbbb│X");
    expect(diff).toContain("+Hhhh│NEW");
    expect(diff.split("\n").find((line) => line.startsWith("-"))).toBeUndefined();
  });

  it("renders multi-span batches with true attribution per hunk", () => {
    const oldContent = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const newContent = "l0\nR1\nl2\nl3\nl4\nl5\nl6\nR2\nl8";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg", "Hhhh", "Iiii"];
    const newHashes = ["Aaaa", "Jjjj", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg", "Kkkk", "Iiii"];
    const spans = [
      { start: 1, end: 1, replacementCount: 1 },
      { start: 7, end: 7, replacementCount: 1 },
    ];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-Bbbb│l1");
    expect(diff).toContain("+Jjjj│R1");
    expect(diff).toContain("-Hhhh│l7");
    expect(diff).toContain("+Kkkk│R2");
    expect(diff).toContain(" ...");
  });

  it("falls back to content diff when spans are absent or invalid", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nBETA\ngamma";
    const fallback = genDiff(oldContent, newContent, 1);
    expect(fallback.diff).toContain("BETA");
    const invalid = genDiff(oldContent, newContent, 1, ["Hhhh"], ["Aaaa", "Bbbb", "Cccc"], undefined, [{ start: 99, end: 100, replacementCount: 1 }]);
    expect(invalid.diff).toContain("BETA");
    const overlapping = genDiff(oldContent, newContent, 1, ["Aaaa", "Hhhh", "Cccc"], ["Aaaa", "Bbbb", "Cccc"], undefined, [
      { start: 0, end: 1, replacementCount: 1 },
      { start: 1, end: 2, replacementCount: 1 },
    ]);
    expect(overlapping.diff).toContain("BETA");
  });

  it("blanks stale - rows that duplicate a live anchor as a safety net", () => {
    const dup = "-Dddd│  }\n+Hhhh│REPLACED\n-Ffff│  }\n Ffff│  }";
    const fixed = disambiguateDuplicateAnchors(dup);
    expect(fixed).toContain("-    │  }");
    expect(fixed).toContain(" Ffff│  }");
    expect(fixed).not.toMatch(/^-Ffff│/m);
  });

  it("derives batch spans from anchor sequences without content pairing", () => {
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee"];
    const newHashes = ["Aaaa", "Hhhh", "Cccc", "Dddd", "Kkkk", "Eeee"];
    const spans = spansFromHashes(oldHashes, newHashes);
    expect(spans).toEqual([
      { start: 1, end: 1, replacementCount: 1 },
      { start: 4, end: 3, replacementCount: 1 },
    ]);
  });
});
