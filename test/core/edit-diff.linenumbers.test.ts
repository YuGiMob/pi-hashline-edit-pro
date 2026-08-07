import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/replace-diff";
import { numberedDiffRows } from "../../src/replace-render";
import { initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});

describe("genDiff rowLines", () => {
  it("numbers added rows by new-file line and removed rows by old-file line", () => {
    const { diff, rowLines } = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
    const rows = diff.split("\n");
    expect(rows.length).toBe(rowLines.length);
    expect(rows[0]).toMatch(/^ [A-Za-z0-9]{3}│alpha$/);
    expect(rowLines[0]).toBe(1);
    expect(rows[1]).toMatch(/^- {3}│beta$/);
    expect(rowLines[1]).toBe(2);
    expect(rows[2]).toMatch(/^\+[A-Za-z0-9]{3}│BETA$/);
    expect(rowLines[2]).toBe(2);
    expect(rows[3]).toMatch(/^ [A-Za-z0-9]{3}│gamma$/);
    expect(rowLines[3]).toBe(3);
  });

  it("marks ellipsis rows as undefined and keeps following rows numbered", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 1000; i++) lines.push("line " + i);
    const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
    const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

    const { diff, rowLines } = genDiff(before, after, 4);
    const rows = diff.split("\n");
    expect(rows.length).toBe(rowLines.length);

    const ellipsisIdx = rows.findIndex((l) => l.trim() === "...");
    expect(ellipsisIdx).toBeGreaterThan(0);
    expect(rowLines[ellipsisIdx]).toBeUndefined();

    const beforeLast = rowLines[ellipsisIdx - 1]!;
    const afterFirst = rowLines[ellipsisIdx + 1]!;
    expect(afterFirst).toBeGreaterThan(beforeLast);

    const lastRowNum = rowLines[rowLines.length - 1]!;
    expect(rows[rows.length - 1]).toContain("AFTER_CHANGED");
    expect(lastRowNum).toBeGreaterThan(1000);
  });
});

describe("numberedDiffRows", () => {
  it("prefixes rows with right-aligned line numbers", () => {
    const diff = [
      " aB3│alpha",
      "+szJ│BETA",
      "-   │beta",
      " kQm│gamma",
    ].join("\n");
    const out = numberedDiffRows(diff, [1, 2, 2, 3]);
    expect(out).toEqual([
      "1 │  aB3│alpha",
      "2 │ +szJ│BETA",
      "2 │ -   │beta",
      "3 │  kQm│gamma",
    ]);
  });

  it("aligns the number column to the widest number", () => {
    const diff = ["+aB3│x", " kQm│y"].join("\n");
    const out = numberedDiffRows(diff, [9, 10]);
    expect(out).toEqual([" 9 │ +aB3│x", "10 │  kQm│y"]);
  });

  it("keeps the diff content column aligned for ellipsis rows", () => {
    const diff = [" ...", "+szJ│x"].join("\n");
    const out = numberedDiffRows(diff, [undefined, 42]);
    expect(out).toEqual(["      ...", "42 │ +szJ│x"]);
  });

  it("returns rows unchanged when line numbers are absent", () => {
    const diff = "+szJ│x\n kQm│y";
    expect(numberedDiffRows(diff, undefined)).toEqual(diff.split("\n"));
  });
});
