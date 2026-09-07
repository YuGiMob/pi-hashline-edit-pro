import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
  type HEdit,
} from "../../src/hashline";
import { makeTag, useTestHome } from "../support/fixtures";

const home = useTestHome();

async function applyWithAnchors(content: string, edit: HEdit) {
	return applyEdit(content, edit, undefined, await lineHashes(content, home.testPath));
}

describe("applyEdit - basic operations", () => {
	it("replaces a single line", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces a single line with multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB", "B2"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nBBB\nB2\nccc");
	});

	it("deletes a single line (empty lines array)", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nccc");
	});

  it("treats lines:[\"\"] as inserting a blank line", async () => {
    const content = "aaa\nbbb\nccc\n";
    const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [""] };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\n\nccc\n");
  });

  it("treats lines:[\"\"] as a blank line for range replaces too", async () => {
    const content = "aaa\nbbb\nccc\nddd\n";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
      content_lines: [""],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\n\nddd\n");
  });

	it("does not normalize multi-element empty arrays (those are blank lines)", async () => {
		const content = "aaa\nbbb\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["", ""] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).not.toBe("aaa\n");
		expect(result.content.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(2);
	});

	it("replaces a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["BBB", "CCC"],
		};
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: [],
		};
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nddd");
	});
});

describe("applyEdit - noop detection", () => {
	it("detects single-line noop", async () => {
		const content = "aaa\nbbb\nccc";
		const tag = await makeTag(content, 2, home.testPath);
		const edit: HEdit = { hash_bounds: [tag, tag], content_lines: ["bbb"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.noopEdit).toBeDefined();
		expect(result.noopEdit!.loc).toBe(tag.hash);
	});

	it("detects range noop", async () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["bbb", "ccc"],
		};
		const result = await applyWithAnchors(content, edit);
		expect(result.noopEdit).toBeDefined();
	});

	it("rejects deleting an entire non-empty file", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
			content_lines: [],
		};
		await expect(async () => applyWithAnchors(content, edit)).rejects.toThrow(
			/^\[E_WOULD_EMPTY\]/,
		);
	});

	it("allows whole-file rewrite when the final content is non-empty", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 2, home.testPath)],
			content_lines: ["ccc"],
		};

		const result = await applyWithAnchors(content, edit);

		expect(result.content).toBe("ccc");
	});

	it("allows replacing content with whitespace", async () => {
		const content = "aaa";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["\n"] };

		const result = await applyWithAnchors(content, edit);

		expect(result.content).toBe("\n");
	});
});

describe("applyEdit - auto-fix heuristics", () => {
	it("auto-fixes leading duplication by stripping the first replacement line", async () => {
		const content = "before\nold one\nold two\nafter";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["before", "new one", "new two"],
		};

		const result = await applyWithAnchors(content, edit);

		expect(result.content).toBe("before\nnew one\nnew two\nafter");
		expect(result.autoFixes).toHaveLength(1);
		expect(result.autoFixes![0]!.kind).toBe("leading");
		expect(result.autoFixes![0]!.removedLine).toBe("before");
	});

	it("auto-fixes trailing duplication by stripping the last replacement line", async () => {
		const content = "before\nold one\nold two\nafter";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)],
			content_lines: ["new one", "new two", "after"],
		};

		const result = await applyWithAnchors(content, edit);

		expect(result.content).toBe("before\nnew one\nnew two\nafter");
		expect(result.autoFixes).toHaveLength(1);
		expect(result.autoFixes![0]!.kind).toBe("trailing");
		expect(result.autoFixes![0]!.removedLine).toBe("after");
	});
});

describe("applyEdit - lastChangedLine tracking", () => {
	it("tracks lastChangedLine when single-line replace expands to multiple lines", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B1", "B2", "B3", "B4", "B5"],
		};

		const result = await applyWithAnchors(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(6);
	});

	it("tracks lastChangedLine correctly for single-line delete", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: [] };

		const result = await applyWithAnchors(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});

	it("tracks lastChangedLine correctly for multi-line delete", async () => {
		const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
		const edit: HEdit = {
			hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 4, home.testPath)],
			content_lines: [],
		};

		const result = await applyWithAnchors(content, edit);

		expect(result.firstChangedLine).toBe(2);
		expect(result.lastChangedLine).toBe(2);
	});
});

describe("applyEdit - edge cases (empty, single-line, no trailing newline)", () => {
	it("edits a single-line file without trailing newline", async () => {
		const content = "hello";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("world");
	});

	it("edits a single-line file with trailing newline", async () => {
		const content = "hello\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["world"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("world\n");
	});

	it("edits a file with only a trailing newline (one blank line)", async () => {
		const content = "\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["hello"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("hello\n");
	});

	it("deletes the only line in a single-line file without trailing newline", async () => {
		const content = "hello";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: [] };
		await expect(applyWithAnchors(content, edit)).rejects.toThrow(/^\[E_WOULD_EMPTY\]/);
	});

	it("replaces a line in a file with no trailing newline", async () => {
		const content = "aaa\nbbb\nccc";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["BBB"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("appends a line to a file without trailing newline", async () => {
		const content = "aaa\nbbb";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["bbb", "ccc"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("aaa\nbbb\nccc");
	});
});

describe("applyEdit - trailing newline preservation", () => {
	it("preserves trailing newline when replacing the last line of a file with one", async () => {
		const content = "line1\n</br>\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("LINE1\n</br>\n");
	});

	it("preserves trailing newline when replacing the last line itself", async () => {
		const content = "line1\n</br>\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["<br/>"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("line1\n<br/>\n");
	});

	it("preserves trailing newline when replacing a range ending at the last line", async () => {
		const content = "a\nb\nc\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 3, home.testPath)], content_lines: ["B", "C"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("a\nB\nC\n");
	});

	it("does not add trailing newline when original had none", async () => {
		const content = "line1\n</br>";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 1, home.testPath), await makeTag(content, 1, home.testPath)], content_lines: ["LINE1"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("LINE1\n</br>");
	});

	it("does not add trailing newline for mid-file edits", async () => {
		const content = "a\nb\nc\n";
		const edit: HEdit = { hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)], content_lines: ["B"] };
		const result = await applyWithAnchors(content, edit);
		expect(result.content).toBe("a\nB\nc\n");
	});
});

describe("applyEdit - deletion and range matrix", () => {
	const cases = [
		{
			name: "delete first line with trailing newline",
			content: "a\nb\nc\n",
			range: [1, 1] as const,
			contentLines: [],
			expected: "b\nc\n",
		},
		{
			name: "delete first line without trailing newline",
			content: "a\nb\nc",
			range: [1, 1] as const,
			contentLines: [],
			expected: "b\nc",
		},
		{
			name: "delete middle line with trailing newline",
			content: "a\nb\nc\n",
			range: [2, 2] as const,
			contentLines: [],
			expected: "a\nc\n",
		},
		{
			name: "delete last line with trailing newline",
			content: "a\nb\nc\n",
			range: [3, 3] as const,
			contentLines: [],
			expected: "a\nb\n",
		},
		{
			name: "delete last line without trailing newline",
			content: "a\nb\nc",
			range: [3, 3] as const,
			contentLines: [],
			expected: "a\nb",
		},
		{
			name: "delete range at start of file",
			content: "a\nb\nc\nd\n",
			range: [1, 2] as const,
			contentLines: [],
			expected: "c\nd\n",
		},
		{
			name: "delete range ending at last line",
			content: "a\nb\nc\nd\n",
			range: [3, 4] as const,
			contentLines: [],
			expected: "a\nb\n",
		},
		{
			name: "delete range ending at last line without trailing newline",
			content: "a\nb\nc\nd",
			range: [3, 4] as const,
			contentLines: [],
			expected: "a\nb",
		},
		{
			name: "replace whole file keeps trailing newline",
			content: "a\nb\nc\n",
			range: [1, 3] as const,
			contentLines: ["X", "Y"],
			expected: "X\nY\n",
		},
		{
			name: "replace whole file without trailing newline",
			content: "a\nb\nc",
			range: [1, 3] as const,
			contentLines: ["X", "Y"],
			expected: "X\nY",
		},
		{
			name: "replace last line expands without trailing newline",
			content: "a\nb\nc",
			range: [3, 3] as const,
			contentLines: ["X", "Y"],
			expected: "a\nb\nX\nY",
		},
		{
			name: "replace first line keeps the rest intact",
			content: "a\nb\nc\n",
			range: [1, 1] as const,
			contentLines: ["X", "Y"],
			expected: "X\nY\nb\nc\n",
		},
		{
			name: "single-line noop on the last line keeps the file byte-identical",
			content: "a\nb\nc\n",
			range: [3, 3] as const,
			contentLines: ["c"],
			expected: "a\nb\nc\n",
		},
	];

	for (const c of cases) {
		it(c.name, async () => {
			const edit: HEdit = {
				hash_bounds: [
					await makeTag(c.content, c.range[0], home.testPath),
					await makeTag(c.content, c.range[1], home.testPath),
				],
				content_lines: c.contentLines,
			};
			const result = await applyWithAnchors(c.content, edit);
			expect(result.content).toBe(c.expected);
		});
	}
});

describe("applyEdit - EOF deletion preserves an empty preceding line", () => {
  it("keeps an empty line before a deleted last line without trailing newline", async () => {
    const content = "a\n\nb";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 3, home.testPath), await makeTag(content, 3, home.testPath)],
      content_lines: [],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("a\n\n");
  });

  it("does not empty a file when deleting its last line after an empty line", async () => {
    const content = "\nb";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 2, home.testPath), await makeTag(content, 2, home.testPath)],
      content_lines: [],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("\n");
  });

  it("keeps an empty line before a deleted range ending at EOF without trailing newline", async () => {
    const content = "a\n\nb\nc";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 3, home.testPath), await makeTag(content, 4, home.testPath)],
      content_lines: [],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("a\n\n");
  });

  it("keeps multiple empty lines before a deleted last line without trailing newline", async () => {
    const content = "a\n\n\nb";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 4, home.testPath), await makeTag(content, 4, home.testPath)],
      content_lines: [],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("a\n\n\n");
  });

  it("still removes the newline when the preceding line is non-empty", async () => {
    const content = "a\nb\nc";
    const edit: HEdit = {
      hash_bounds: [await makeTag(content, 3, home.testPath), await makeTag(content, 3, home.testPath)],
      content_lines: [],
    };
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("a\nb");
  });
});

describe("applyEdit - trailing blank lines (no trailing-newline special case)", () => {
  it("preserves a trailing blank line when replacement_lines mirror it with a trailing empty element", async () => {
    const content = "def a():\n    pass\n\ndef b():\n    pass\n";
    const edit = resEdit({
      remove_from: (await makeTag(content, 1, home.testPath)).hash,
      remove_to: (await makeTag(content, 3, home.testPath)).hash,
      replacement_lines: ["def a():", "    return 1", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("def a():\n    return 1\n\ndef b():\n    pass\n");
  });

  it("preserves two trailing blank lines when replacement_lines mirror them", async () => {
    const content = "def a():\n    pass\n\n\ndef b():\n";
    const edit = resEdit({
      remove_from: (await makeTag(content, 1, home.testPath)).hash,
      remove_to: (await makeTag(content, 4, home.testPath)).hash,
      replacement_lines: ["def a():", "    return 1", "", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("def a():\n    return 1\n\n\ndef b():\n");
  });

  it("drops a trailing blank line when replacement_lines do not mirror it", async () => {
    const content = "def a():\n    pass\n\ndef b():\n";
    const edit = resEdit({
      remove_from: (await makeTag(content, 1, home.testPath)).hash,
      remove_to: (await makeTag(content, 3, home.testPath)).hash,
      replacement_lines: ["def a():", "    return 1"],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("def a():\n    return 1\ndef b():\n");
  });

  it("adds a trailing blank line for a normal range when replacement_lines end with an empty element", async () => {
    const content = "aaa\nbbb\nccc\n";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["X", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nX\n\nccc\n");
  });
});

describe("applyEdit - trailing blank at EOF without trailing newline", () => {
  it('keeps [""] as a blank line when replacing the last line', async () => {
    const content = "aaa\nbbb";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: [""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\n\n");
  });

  it('keeps a trailing blank after a non-empty replacement line', async () => {
    const content = "aaa\nbbb";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["x", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nx\n\n");
  });

  it("keeps multiple trailing blanks at the end of a no-trailing-newline file", async () => {
    const content = "aaa\nbbb";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["x", "", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nx\n\n\n");
  });

  it("replaces the only line of a single-line file with a blank line", async () => {
    const content = "aaa";
    const edit = resEdit({
      remove_from: (await makeTag(content, 1, home.testPath)).hash,
      remove_to: (await makeTag(content, 1, home.testPath)).hash,
      replacement_lines: [""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("\n");
  });

  it("keeps a middle blank and a non-empty last line unchanged", async () => {
    const content = "aaa\nbbb";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["x", "", "y"],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nx\n\ny");
  });

  it("does not add a newline when the last replacement line is non-empty", async () => {
    const content = "aaa\nbbb";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["x"],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nx");
  });

  it("does not add a newline for a trailing blank when the file ends with a newline", async () => {
    const content = "aaa\nbbb\n";
    const edit = resEdit({
      remove_from: (await makeTag(content, 2, home.testPath)).hash,
      remove_to: (await makeTag(content, 2, home.testPath)).hash,
      replacement_lines: ["x", ""],
    });
    const result = await applyWithAnchors(content, edit);
    expect(result.content).toBe("aaa\nx\n\n");
  });
});
