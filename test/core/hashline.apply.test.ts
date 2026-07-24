import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  applyEdits,
  type HEdit,
} from "../../src/hashline";
import { makeTag, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdits — basic operations", () => {
	it("returns content unchanged for empty edits", () => {
		const result = applyEdits("hello\nworld", []);
		expect(result.content).toBe("hello\nworld");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("replaces a single line", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces a single line with multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB", "B2"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nB2\nccc");
	});

	it("deletes a single line (empty lines array)", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nccc");
	});

  it("treats lines:[\"\"] as inserting a blank line", async () => {
    const content = "aaa\nbbb\nccc\n";
    const edits: HEdit[] = [
      { hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [""] },
    ];
    const result = applyEdits(content, edits);
    expect(result.content).toBe("aaa\n\nccc\n");
  });

  it("treats lines:[\"\"] as a blank line for range replaces too", async () => {
    const content = "aaa\nbbb\nccc\nddd\n";
    const edits: HEdit[] = [
      {
        hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
        content_lines: [""],
      },
    ];
    const result = applyEdits(content, edits);
    expect(result.content).toBe("aaa\n\nddd\n");
  });

	it("does not normalize multi-element empty arrays (those are blank lines)", async () => {
		const content = "aaa\nbbb\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["", ""] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).not.toBe("aaa\n");
		expect(result.content.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(2);
	});

	it("replaces a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
				content_lines: ["BBB", "CCC"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
				content_lines: [],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nddd");
	});
});

describe("applyEdits — multi-edit ordering", () => {
	it("applies multiple edits bottom-up correctly", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["AAA"] },
			{ hash_range_inclusive: [await makeTag(content, 3, home.testPath), await makeTag(content, 3, home.testPath)], content_lines: ["CCC"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("AAA\nbbb\nCCC");
	});

	it("deduplicates identical edits", async () => {
		const content = "aaa\nbbb\nccc";
		const pos = await makeTag(content, 2, home.testPath);
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] },
			{ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("does not mutate caller-owned edit arrays while deduplicating", async () => {
		const content = "aaa\nbbb\nccc";
		const pos = await makeTag(content, 2, home.testPath);
		const edits: HEdit[] = [
			{ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] },
			{ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] },
		];

		applyEdits(content, edits);

		expect(edits).toHaveLength(2);
		expect(edits[0]).toEqual({ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] });
		expect(edits[1]).toEqual({ hash_range_inclusive: [{ ...pos }, { ...pos }], content_lines: ["BBB"] });
	});
});

describe("applyEdits — noop detection", () => {
	it("detects single-line noop", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["bbb"] },
		];
		const result = applyEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
		expect(result.noopEdits![0]!.editIndex).toBe(0);
	});

	it("detects range noop", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
				content_lines: ["bbb", "ccc"],
			},
		];
		const result = applyEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
	});

	it("rejects deleting an entire non-empty file", async () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
				content_lines: [],
			},
		];
		expect(() => applyEdits(content, edits)).toThrow(
			/^\[E_WOULD_EMPTY\]/,
		);
	});

	it("allows whole-file rewrite when the final content is non-empty", async () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
				content_lines: ["ccc"],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.content).toBe("ccc");
	});

	it("allows replacing content with whitespace", async () => {
		const content = "aaa";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["\n"] },
		];

		const result = applyEdits(content, edits);

		expect(result.content).toBe("\n");
	});
});

describe("applyEdits — boundary duplication warnings", () => {
	it("warns on leading duplication instead of auto-fixing", async () => {
		const content = "before\nold one\nold two\nafter";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
				content_lines: ["before", "new one", "new two"],
			},
		];

		const result = applyEdits(content, edits);

		// Duplicate "before" is kept (not auto-fixed)
		expect(result.content).toBe("before\nbefore\nnew one\nnew two\nafter");
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with") && w.includes("before"))).toBe(true);
	});

	it("warns on trailing duplication instead of auto-fixing", async () => {
		const content = "before\nold one\nold two\nafter";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
				content_lines: ["new one", "new two", "after"],
			},
		];

		const result = applyEdits(content, edits);

		// Duplicate "after" is kept (not auto-fixed)
		expect(result.content).toBe("before\nnew one\nnew two\nafter\nafter");
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("ends with") && w.includes("after"))).toBe(true);
	});
});

describe("applyEdits — lastChangedLine tracking", () => {
	it("tracks lastChangedLine when single-line replace expands to multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B1", "B2", "B3", "B4", "B5"],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(6);
	});

	it("tracks lastChangedLine correctly for single-line delete", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] },
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});

	it("tracks lastChangedLine correctly for multi-line delete", async () => {
		const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
		const edits: HEdit[] = [
			{
				hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 4, home.testPath)],
				content_lines: [],
			},
		];

		const result = applyEdits(content, edits);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(4);
	});
});

describe("applyEdits — edge cases (empty, single-line, no trailing newline)", () => {
	it("edits a single-line file without trailing newline", async () => {
		const content = "hello";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("world");
	});

	it("edits a single-line file with trailing newline", async () => {
		const content = "hello\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("world\n");
	});

	it("edits a file with only a trailing newline (one blank line)", async () => {
		const content = "\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["hello"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("hello\n");
	});

	it("deletes the only line in a single-line file without trailing newline", async () => {
		const content = "hello";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: [] },
		];
		expect(() => applyEdits(content, edits)).toThrow(/^\[E_WOULD_EMPTY\]/);
	});

	it("replaces a line in a file with no trailing newline", async () => {
		const content = "aaa\nbbb\nccc";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("appends a line to a file without trailing newline", async () => {
		const content = "aaa\nbbb";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["bbb", "ccc"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("aaa\nbbb\nccc");
	});
});

describe("applyEdits — trailing newline preservation", () => {
	it("preserves trailing newline when replacing the last line of a file with one", async () => {
		const content = "line1\n</br>\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("LINE1\n</br>\n");
	});

	it("preserves trailing newline when replacing the last line itself", async () => {
		const content = "line1\n</br>\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["<br/>"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("line1\n<br/>\n");
	});

	it("preserves trailing newline when replacing a range ending at the last line", async () => {
		const content = "a\nb\nc\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)], content_lines: ["B", "C"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("a\nB\nC\n");
	});

	it("does not add trailing newline when original had none", async () => {
		const content = "line1\n</br>";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("LINE1\n</br>");
	});

	it("does not add trailing newline for mid-file edits", async () => {
		const content = "a\nb\nc\n";
		const edits: HEdit[] = [
			{ hash_range_inclusive: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B"] },
		];
		const result = applyEdits(content, edits);
		expect(result.content).toBe("a\nB\nc\n");
	});
});
