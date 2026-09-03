import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/replace-diff";
import { initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});
describe("genDiff", () => {
	it("adds hash hints for context and addition lines and pads deletion lines to align the '│' column", () => {
		const result = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		expect(diff).toMatch(/^ [A-Za-z0-9]{4}│alpha$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9]{4}│BETA$/m);
		expect(diff).toMatch(/^- {4}│beta$/m);
		expect(diff).toMatch(/^ [A-Za-z0-9]{4}│gamma$/m);
	});

	it("carries the old hashes on deletion rows when oldContentHashes are provided", () => {
		const { diff } = genDiff(
			"alpha\nbeta\ngamma",
			"alpha\nBETA\ngamma",
			1,
			undefined,
			["ATIm", "BeSR", "DAfo"],
		);
		expect(diff).toMatch(/^-BeSR│beta$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9]{4}│BETA$/m);
	});

	it("tracks old line numbers across skipped context and multi-line deletions", () => {
		const { diff } = genDiff(
			"a\nb\nc\nd",
			"a\nd",
			0,
			undefined,
			["ATIm", "BeSR", "DAfo", "Emno"],
		);
		expect(diff).toContain("-BeSR│b");
		expect(diff).toContain("-DAfo│c");
	});

	it("keeps the '│' column aligned across context, addition, and deletion lines", () => {

		const before = [
			"function greet(name) {",
			"  console.log('old')",
			"  return 'hi'",
			"}",
		].join("\n");
		const after = [
			"function greet(name) {",
			"  return `Hello, ${name}`",
			"}",
		].join("\n");

		const { diff } = genDiff(before, after);

		const lines = diff.split("\n");

		const colonColumns = lines.map((line) => line.indexOf("│"));
		expect(colonColumns).toEqual(lines.map(() => 5));

		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{4}│function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {4}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9]{4}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{4}│\}$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {4}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9]{4}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{4}│\}$/));
	});
	it("truncates context between two distant changes", () => {
		const lines = [];
		for (let i = 1; i <= 1000; i++) lines.push("line " + i);
		const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
		const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

		const { diff } = genDiff(before, after, 4);
		const diffLines = diff.split("\n");

		expect(diffLines.length).toBeLessThan(50);

		const ellipsisCount = diffLines.filter((l: string) => l.trim() === "...").length;
		expect(ellipsisCount).toBe(1);

		const ellipsisIdx = diffLines.findIndex((l: string) => l.trim() === "...");
		expect(ellipsisIdx).toBeGreaterThan(0);
		expect(ellipsisIdx).toBeLessThan(diffLines.length - 1);

		expect(diffLines[ellipsisIdx - 1]).toContain("line 4");
		expect(diffLines[ellipsisIdx + 1]).toContain("line 997");

		expect(diff).toContain("BEFORE_CHANGED");
		expect(diff).toContain("AFTER_CHANGED");
	});
});

describe("genDiff - blank context line extension", () => {
  const row = (content: string) => new RegExp(`^ [A-Za-z0-9]{4}│${content}$`, "m");
  const blankRow = /^ [A-Za-z0-9]{4}│\s*$/m;

  it("shows one more line below the change when the adjacent context line is blank", () => {
    const { diff } = genDiff(
      "alpha\nbeta\n\ngamma\ndelta",
      "alpha\nBETA\n\ngamma\ndelta",
      1,
    );
    const rows = diff.split("\n");
    expect(diff).toMatch(blankRow);
    expect(diff).toMatch(row("gamma"));
    expect(diff).not.toMatch(row("delta"));
    expect(rows.findIndex((l) => blankRow.test(l))).toBeLessThan(rows.findIndex((l) => row("gamma").test(l)));
    expect(rows[rows.length - 1]!.trim()).toBe("...");
  });

  it("shows one more line above the change when the adjacent context line is blank", () => {
    const { diff } = genDiff(
      "alpha\n\nbeta\ngamma",
      "alpha\n\nBETA\ngamma",
      1,
    );
    const rows = diff.split("\n");
    expect(diff).toMatch(row("alpha"));
    expect(diff).toMatch(blankRow);
    expect(rows.findIndex((l) => row("alpha").test(l))).toBeLessThan(rows.findIndex((l) => blankRow.test(l)));
    expect(rows[0]!.trim()).not.toBe("...");
  });

  it("treats a whitespace-only context line as blank", () => {
    const { diff } = genDiff(
      "alpha\n   \nbeta",
      "alpha\n   \nBETA",
      1,
    );
    expect(diff).toMatch(row("alpha"));
    expect(diff).toMatch(blankRow);
  });

  it("extends both sides when both adjacent context lines are blank", () => {
    const { diff } = genDiff(
      "alpha\n\nbeta\n\ngamma",
      "alpha\n\nBETA\n\ngamma",
      1,
    );
    const rows = diff.split("\n");
    expect(diff).toMatch(row("alpha"));
    expect(diff).toMatch(row("gamma"));
    expect(rows.filter((l) => blankRow.test(l))).toHaveLength(2);
  });

  it("does not extend when the adjacent context line has content", () => {
    const { diff } = genDiff(
      "alpha\nbeta\ngamma\ndelta",
      "alpha\nbeta\nGAMMA\ndelta",
      1,
    );
    const contextRows = diff.split("\n").filter((l) => /^ [A-Za-z0-9]{4}│/.test(l));
    expect(contextRows).toHaveLength(2);
  });

  it("does not extend when there are no lines beyond the blank one", () => {
    const { diff } = genDiff("\nbeta", "\nBETA", 1);
    const rows = diff.split("\n");
    expect(rows[0]!.trim()).not.toBe("...");
    expect(rows[0]).toMatch(blankRow);
  });

  it("adds no context rows when contextLines is 0", () => {
    const { diff } = genDiff("a\n\nc", "a\n\nC", 0);
    const contextRows = diff.split("\n").filter((r) => /^ [A-Za-z0-9]{4}│/.test(r));
    expect(contextRows).toHaveLength(0);
  });

  it("extends the head group toward a blank line between two changes", () => {
    const { diff } = genDiff(
      "a\nb\n\nx\ny\nz\nc\nd\ne",
      "A\nb\n\nx\ny\nz\nc\nD\ne",
      2,
    );
    const rows = diff.split("\n");
    expect(diff).toMatch(row("x"));
    expect(diff).toMatch(row("b"));
    expect(diff).toMatch(row("z"));
    expect(diff).not.toMatch(row("y"));
    const markerIdx = rows.findIndex((l) => l.trim() === "...");
    expect(markerIdx).toBeGreaterThan(rows.findIndex((l) => row("x").test(l)));
    expect(markerIdx).toBeLessThan(rows.findIndex((l) => row("z").test(l)));
  });

  it("shows the whole middle block when blank extensions would overlap", () => {
    const { diff } = genDiff(
      "a\n\n\n\n\n\nc\nd\ne",
      "A\n\n\n\n\n\nc\nD\ne",
      2,
    );
    const rows = diff.split("\n");
    const contextRows = rows.filter((l) => /^ [A-Za-z0-9]{4}│/.test(l));
    expect(contextRows).toHaveLength(7);
    expect(diff).toMatch(row("c"));
    expect(diff).toMatch(row("e"));
    expect(rows.filter((l) => l.trim() === "...")).toHaveLength(0);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

describe("genDiff - property: column alignment", () => {
  const vocab = [
    "",
    "}",
    "  foo",
    "import x",
    "a = 1;",
    "// c",
    "a│b",
    "line with │ inside",
    "  const y = 2;",
  ];

  it("keeps the │ separator at column 5 for every diff row across random content", () => {
    for (let iter = 0; iter < 200; iter++) {
      const rnd = mulberry32(iter * 2654435761 + 17);
      const oldContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");
      const newContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");

      const { diff } = genDiff(oldContent, newContent, randInt(rnd, 0, 4));
      for (const line of diff.split("\n")) {
        if (line.includes("│")) {
          expect(
            line.indexOf("│"),
            `column drift for iter ${iter}: ${JSON.stringify(line)}`,
          ).toBe(5);
        }
      }
    }
  });

  it("keeps the │ separator aligned with single-line diffs too", () => {
    const { diff } = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
    for (const line of diff.split("\n")) {
      if (line.includes("│")) expect(line.indexOf("│")).toBe(5);
    }
  });
});
