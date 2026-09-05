import { describe, expect, it, vi } from "vitest";
import {
	getPreviewInput,
	toNumberedDiff,
	colorLines,
	fmtPreview,
	fmtResult,
	fmtCall,
	getResultText,
	extractWarnings,
	isApplied,
	buildAppliedText,
	fmtResultMd,
	mkMdTheme,
} from "../../src/replace-render";
import { withDedupRows } from "../../src/replace-response";

const mockTheme = {
	fg: vi.fn((color: string, text: string) => `[${color}]${text}`),
	bold: vi.fn((text: string) => `**${text}**`),
	italic: vi.fn((text: string) => `_${text}_`),
	underline: vi.fn((text: string) => `__${text}__`),
	strikethrough: vi.fn((text: string) => `~~${text}~~`),
};

describe("getPreviewInput", () => {
	it("returns null for non-record input", () => {
		expect(getPreviewInput("string")).toBeNull();
		expect(getPreviewInput(null)).toBeNull();
		expect(getPreviewInput(42)).toBeNull();
	});

  it("returns partial input for record without path", () => {
    expect(getPreviewInput({ remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] })).toEqual({ remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] });
  });

	it("returns null for record with non-string path", () => {
		expect(getPreviewInput({ path: 42 })).toBeNull();
	});

	it("returns null for record without edit fields", () => {
		expect(getPreviewInput({ path: "test.txt" })).toBeNull();
	});

	it("returns request for valid input", () => {
		const input = { path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const result = getPreviewInput(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const result = getPreviewInput(input);
		expect(result?.path).toBe("test.txt");
	});
});

describe("colorLines", () => {
	it("colors addition lines green", () => {
		const lines = ["+added line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[success]");
	});

	it("colors removal lines red", () => {
		const lines = ["-removed line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors context lines dim", () => {
		const lines = [" context line"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
	});

	it("does not color +++ or --- lines", () => {
		const lines = ["+++header+++", "---header---"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[dim]");
		expect(result[1]).toContain("[dim]");
	});

	it("colors dedup rows red", () => {
		const lines = ["dedup│aaa"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors numbered dedup rows red", () => {
		const lines = ["12 │ dedup│aaa"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors blank-gutter dedup rows red", () => {
		const lines = ["   │ dedup│aaa"];
		const result = colorLines(lines, mockTheme);
		expect(result[0]).toContain("[error]");
	});

	it("colors dedup rows red in the numbered diff", () => {
		const { diff, lineNumbers } = withDedupRows("+AAA│x\n BBB│y", [1, 2], ["kept"], []);
		const numbered = toNumberedDiff(diff, lineNumbers);
		const result = colorLines(numbered.split("\n"), mockTheme);
		const dedupRow = result.find((row) => row.includes("dedup│kept"));
		expect(dedupRow).toContain("[error]");
	});
});

describe("fmtPreview", () => {
	it("truncates long diffs", () => {
		const lines = Array.from({ length: 50 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = fmtPreview(diff, false, mockTheme);
		expect(result).toContain("more diff lines");
	});

	it("shows all lines when expanded", () => {
		const lines = Array.from({ length: 30 }, (_, i) => ` line ${i}`);
		const diff = lines.join("\n");
		const result = fmtPreview(diff, true, mockTheme);
		expect(result).not.toContain("more diff lines");
	});
});

describe("fmtResult", () => {
	it("formats diff with colors", () => {
		const diff = "+added\n-removed\n context";
		const result = fmtResult(diff, mockTheme);
		expect(result).toContain("[success]");
		expect(result).toContain("[error]");
		expect(result).toContain("[dim]");
	});
});

describe("fmtCall", () => {
	it("formats call with path", () => {
		const args = { path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const state = { preview: undefined };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("test.txt");
	});

	it("formats call with error preview", () => {
		const args = { path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const state = { preview: { error: "test error" } };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("test error");
	});

	it("formats call with diff preview", () => {
		const args = { path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const state = { preview: { diff: "+added\n-removed" } };
		const result = fmtCall(args, state, false, mockTheme);
		expect(result).toContain("+added");
	});

	it("handles undefined args", () => {
		const state = { preview: undefined };
		const result = fmtCall(undefined, state, false, mockTheme);
		expect(result).toContain("...");
	});
});

describe("getResultText", () => {
	it("extracts text content", () => {
		const result = {
			content: [
				{ type: "image", data: "base64" },
				{ type: "text", text: "hello" },
			],
		};
		expect(getResultText(result)).toBe("hello");
	});

	it("returns undefined for no text content", () => {
		const result = {
			content: [{ type: "image", data: "base64" }],
		};
		expect(getResultText(result)).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(getResultText({})).toBeUndefined();
	});
});

describe("extractWarnings", () => {
	it("extracts warnings block", () => {
		const text = "Some text\nWarnings:\nWarning 1\nWarning 2";
		const result = extractWarnings(text);
		expect(result).toContain("Warnings:");
		expect(result).toContain("Warning 1");
	});

	it("returns undefined for no warnings", () => {
		expect(extractWarnings("No warnings here")).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(extractWarnings(undefined)).toBeUndefined();
	});
});

describe("isApplied", () => {
	it("returns true for applied changes", () => {
	const details = {
		diff: "",
		metrics: {
			classification: "applied" as const,
			edits_attempted: 1,
			edits_noop: 0,
			warnings: 0,
			added_lines: 1,
			removed_lines: 1,
		},
	};
		expect(isApplied(details)).toBe(true);
	});

	it("returns false for noop", () => {
	const details = {
		diff: "",
		metrics: {
			classification: "noop" as const,
			edits_attempted: 1,
			edits_noop: 1,
			warnings: 0,
		},
	};
		expect(isApplied(details)).toBe(false);
	});

	it("returns false for undefined details", () => {
		expect(isApplied({ diff: "" })).toBe(false);
	});

	it("returns false for missing metrics", () => {
		expect(isApplied({ diff: "" })).toBe(false);
	});
});

describe("buildAppliedText", () => {
	it("builds text with diff and warnings", () => {
		const text = "Some text\nWarnings:\nWarning 1";
		const details = {
			diff: "+added\n-removed",
			metrics: {
				classification: "applied" as const,
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 1,
				added_lines: 1,
				removed_lines: 1,
			},
		};
		const result = buildAppliedText(text, details, mockTheme, false);
		expect(result).toContain("[success]");
		expect(result).toContain("Warnings:");
	});

	it("returns undefined for no content", () => {
		const result = buildAppliedText(undefined, undefined, mockTheme, false);
		expect(result).toBeUndefined();
	});

	it("shows summary, excerpt, and expand hint when collapsed", () => {
		const text = "Successfully replaced in x. Added 1 line(s), removed 1 line(s).";
		const diff = Array.from({ length: 30 }, (_, i) => ` line ${i}`).join("\n");
		const result = buildAppliedText(text, { diff }, mockTheme, false);
		expect(result).toContain("Successfully replaced in x.");
		expect(result).toContain("more diff lines");
		expect(result).toContain("to expand");
		expect(result).not.toContain(" line 29");
	});

	it("shows the full diff without hint when expanded", () => {
		const text = "Successfully replaced in x.";
		const diff = Array.from({ length: 30 }, (_, i) => ` line ${i}`).join("\n");
		const result = buildAppliedText(text, { diff }, mockTheme, true);
		expect(result).toContain(" line 29");
		expect(result).not.toContain("to expand");
	});

	it("omits the hint when the diff fits the preview", () => {
		const result = buildAppliedText("Successfully replaced in x.", { diff: "+a\n-b" }, mockTheme, false);
		expect(result).not.toContain("to expand");
	});

	it("omits the summary when the content is the handler-replaced diff (auto-read on)", () => {
		const diff = Array.from({ length: 30 }, (_, i) => ` Jkx│chain ${i}`).join("\n");
		const result = buildAppliedText(diff, { diff }, mockTheme, false);
		expect(result).not.toContain("Successfully replaced");
		expect(result!.split("chain 0").length - 1).toBe(1);
		expect(result).toContain("to expand");
	});

	it("shows the summary when the content still carries it (auto-read off)", () => {
		const text = "Successfully replaced in x. Added 1 line(s), removed 1 line(s).";
		const diff = Array.from({ length: 30 }, (_, i) => ` Jkx│chain ${i}`).join("\n");
		const result = buildAppliedText(text, { diff }, mockTheme, false);
		expect(result).toContain("Successfully replaced in x.");
		expect(result!.split("chain 0").length - 1).toBe(1);
		expect(result).toContain("to expand");
	});
});

describe("fmtResultMd", () => {
	it("keeps plain text unchanged", () => {
		const text = "Just plain text";
		expect(fmtResultMd(text)).toBe("Just plain text");
	});

	it("trims leading and trailing empty lines", () => {
		const text = "\n\nNo changes made to x\nClassification: noop\n\n";
		expect(fmtResultMd(text)).toBe("No changes made to x\nClassification: noop");
	});

	it("keeps interior blank lines", () => {
		const text = "Summary\n\nWarnings:\nWarning 1";
		expect(fmtResultMd(text)).toBe("Summary\n\nWarnings:\nWarning 1");
	});
});

describe("mkMdTheme", () => {
	it("creates theme with all properties", () => {
		const theme = mkMdTheme(mockTheme);
		expect(theme.heading).toBeDefined();
		expect(theme.link).toBeDefined();
		expect(theme.code).toBeDefined();
		expect(theme.codeBlock).toBeDefined();
		expect(theme.bold).toBeDefined();
		expect(theme.highlightCode).toBeDefined();
	});

	it("highlightCode handles diff language", () => {
		const theme = mkMdTheme(mockTheme);
		const result = theme.highlightCode("+added\n-removed\n context", "diff");
		expect(result.length).toBe(3);
	});

	it("highlightCode handles non-diff language", () => {
		const theme = mkMdTheme(mockTheme);
		const result = theme.highlightCode("const x = 1;", "javascript");
		expect(result.length).toBe(1);
	});
});
