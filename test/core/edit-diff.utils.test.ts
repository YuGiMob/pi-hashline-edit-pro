import { beforeAll, describe, expect, it } from "vitest";
import { detectEnding, toLF, restoreEndings, stripBOM, genDiff, genPatch } from "../../src/replace-diff";
import { _lineHashesPure, initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});

describe("detectEnding", () => {
  it("detects CRLF when \\r\\n appears first", () => {
    expect(detectEnding("hello\r\nworld")).toBe("\r\n");
  });

  it("defaults to LF when only \\n is present", () => {
    expect(detectEnding("hello\nworld")).toBe("\n");
  });

  it("detects CRLF when both exist but CRLF comes first", () => {
    expect(detectEnding("line1\r\nline2\nline3")).toBe("\r\n");
  });

  it("defaults to LF when no line endings exist", () => {
    expect(detectEnding("hello world")).toBe("\n");
  });

  it("defaults to LF for empty string", () => {
    expect(detectEnding("")).toBe("\n");
  });

  it("detects lone CR when no LF is present", () => {
    expect(detectEnding("hello\rworld")).toBe("\r");
  });

  it("detects lone CR for a single trailing CR", () => {
    expect(detectEnding("a\r")).toBe("\r");
  });

  it("prefers CRLF over lone CR when both appear", () => {
    expect(detectEnding("a\r\nb\rc")).toBe("\r\n");
  });

  it("defaults to LF when LF appears before any CR", () => {
    expect(detectEnding("a\nb\rc")).toBe("\n");
  });
});

describe("toLF", () => {
  it("converts \\r\\n to \\n", () => {
    expect(toLF("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts bare \\r to \\n", () => {
    expect(toLF("hello\rworld")).toBe("hello\nworld");
  });

  it("leaves already-LF text unchanged", () => {
    expect(toLF("hello\nworld")).toBe("hello\nworld");
  });

  it("handles mixed line endings", () => {
    expect(toLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("returns empty string for empty input", () => {
    expect(toLF("")).toBe("");
  });
});

describe("stripBOM", () => {
  it("strips \\uFEFF prefix", () => {
    const result = stripBOM("\uFEFFhello");
    expect(result).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("returns empty bom when no BOM present", () => {
    const result = stripBOM("hello");
    expect(result).toEqual({ bom: "", text: "hello" });
  });

  it("handles empty string with BOM only", () => {
    const result = stripBOM("\uFEFF");
    expect(result).toEqual({ bom: "\uFEFF", text: "" });
  });

  it("handles plain empty string", () => {
    const result = stripBOM("");
    expect(result).toEqual({ bom: "", text: "" });
  });
});

describe("restoreEndings", () => {
  it("converts LF back to CRLF when original used CRLF", () => {
    expect(restoreEndings("hello\nworld", "\r\n")).toBe("hello\r\nworld");
  });

  it("leaves LF unchanged when original used LF", () => {
    expect(restoreEndings("hello\nworld", "\n")).toBe("hello\nworld");
  });

  it("handles empty string with CRLF target", () => {
    expect(restoreEndings("", "\r\n")).toBe("");
  });

  it("handles empty string with LF target", () => {
    expect(restoreEndings("", "\n")).toBe("");
  });

  it("handles multiple lines with CRLF target", () => {
    expect(restoreEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("preserves content without newlines", () => {
    expect(restoreEndings("hello", "\r\n")).toBe("hello");
    expect(restoreEndings("hello", "\n")).toBe("hello");
    expect(restoreEndings("hello", "\r")).toBe("hello");
  });

  it("converts LF back to CR when original used lone CR", () => {
    expect(restoreEndings("hello\nworld", "\r")).toBe("hello\rworld");
  });

  it("round-trips lone CR through toLF", () => {
    expect(restoreEndings(toLF("a\rb\r"), "\r")).toBe("a\rb\r");
  });
});

describe("genDiff", () => {
  it("renders a literal __ELLIPSIS__ line as content, not as a truncation marker", () => {
    const oldContent = "a\n__ELLIPSIS__\nc\nd\n";
    const newContent = "a\n__ELLIPSIS__\nc\nD\n";
    const { diff } = genDiff(oldContent, newContent, 3);
    const lines = diff.split("\n");
    expect(lines.some((line) => line.endsWith("│__ELLIPSIS__"))).toBe(true);
    expect(lines.filter((line) => line.trim() === "...")).toHaveLength(0);
  });

  it("keeps hashes aligned when a literal __ELLIPSIS__ line sits in diff context", () => {
    const oldContent = "a\n__ELLIPSIS__\nc\nd\n";
    const newContent = "a\n__ELLIPSIS__\nc\nD\n";
    const hashes = _lineHashesPure(newContent);
    const { diff } = genDiff(oldContent, newContent, 2, hashes);
    const cLine = diff.split("\n").find((line) => line.endsWith("│c"))!;
    expect(cLine.startsWith(` ${hashes[2]}`)).toBe(true);
  });

  it("marks skipped lines before the first change with an ellipsis", () => {
    const top = Array.from({ length: 10 }, (_, i) => `u${i + 1}`).join("\n");
    const oldContent = `${top}\nOLD\nx\ny\n`;
    const newContent = `${top}\nNEW\nx\ny\n`;
    const { diff } = genDiff(oldContent, newContent, 2);
    const lines = diff.split("\n");
    expect(lines[0].trim()).toBe("...");
    expect(lines[1].endsWith("│u9")).toBe(true);
  });

  it("marks skipped lines between two changes with an ellipsis", () => {
    const middle = Array.from({ length: 10 }, (_, i) => `u${i + 1}`).join("\n");
    const oldContent = `a\nb\nOLD1\n${middle}\nOLD2\nc\nd\n`;
    const newContent = `a\nb\nNEW1\n${middle}\nNEW2\nc\nd\n`;
    const { diff } = genDiff(oldContent, newContent, 2);
    const lines = diff.split("\n");
    const markers = lines.filter((line) => line.trim() === "...");
    expect(markers).toHaveLength(1);
    const markerIdx = lines.findIndex((line) => line.trim() === "...");
    expect(lines[markerIdx - 1]!.endsWith("│u2")).toBe(true);
    expect(lines[markerIdx + 1]!.endsWith("│u9")).toBe(true);
  });

  it("shows all lines of a middle block that fits within twice the context", () => {
    const oldContent = "a\nb\nOLD1\nu1\nu2\nu3\nOLD2\nc\nd\n";
    const newContent = "a\nb\nNEW1\nu1\nu2\nu3\nNEW2\nc\nd\n";
    const { diff } = genDiff(oldContent, newContent, 2);
    const lines = diff.split("\n");
    expect(lines.some((line) => line.endsWith("│u3"))).toBe(true);
    expect(lines.filter((line) => line.trim() === "...")).toHaveLength(0);
  });

  it("marks skipped lines after the last change with a trailing ellipsis", () => {
    const tail = Array.from({ length: 10 }, (_, i) => `u${i + 1}`).join("\n");
    const oldContent = `a\nb\nOLD\n${tail}\n`;
    const newContent = `a\nb\nNEW\n${tail}\n`;
    const { diff } = genDiff(oldContent, newContent, 2);
    const lines = diff.split("\n");
    expect(lines.filter((line) => line.trim() === "...")).toHaveLength(1);
    expect(lines[lines.length - 1]!.trim()).toBe("...");
    expect(lines[lines.length - 2]!.endsWith("│u2")).toBe(true);
  });

  it("does not add a trailing ellipsis when the trailing block fits the context", () => {
    const oldContent = "a\nb\nOLD\nu1\nu2\n";
    const newContent = "a\nb\nNEW\nu1\nu2\n";
    const { diff } = genDiff(oldContent, newContent, 2);
    expect(diff.split("\n").filter((line) => line.trim() === "...")).toHaveLength(0);
  });
});

describe("genDiff - output limits", () => {
  it("replaces an oversized row with a marker that keeps the diff prefix", () => {
    const long = "z".repeat(60 * 1024);
    const { diff } = genDiff(`a\n${long}\nb`, `a\n${long}!\nb`);
    expect(diff).not.toContain(long);
    const markers = diff.split("\n").filter((line) => line.includes("content not shown"));
    expect(markers).toHaveLength(2);
    expect(markers[0]!).toMatch(/^- {3}│/);
    expect(markers[1]!).toMatch(/^\+[A-Za-z0-9]{3}│/);
    expect(markers[0]!.indexOf("│")).toBe(4);
    expect(markers[1]!.indexOf("│")).toBe(4);
    expect(diff).not.toContain("row(s) exceed");
  });

  it("stops emitting once the total byte budget is exhausted", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `l${i} ` + "y".repeat(80));
    const { diff } = genDiff(body.join("\n"), body.map((l) => l + "!").join("\n"));
    expect(diff).toContain("diff truncated at 50.0KB");
    expect(diff).not.toContain("l1999 ");
    expect(Buffer.byteLength(diff, "utf-8")).toBeLessThan(60 * 1024);
  });

  it("keeps the full output with unlimited limits", () => {
    const long = "y".repeat(60 * 1024);
    const { diff } = genDiff(`a\n${long}\nb`, `a\n${long}!\nb`, 0, undefined, undefined, { unlimited: true });
    expect(diff).toContain(long);
    expect(diff).not.toContain("content not shown");
  });
});

describe("genPatch - output limits", () => {
  it("keeps a small patch intact and applicable", () => {
    const result = genPatch("sample.ts", "a\nb\nc\n", "a\nB\nc\n");
    expect(result.truncated).toBe(false);
    expect(result.patch).toContain("--- sample.ts");
    expect(result.patch).toContain("+B");
  });

  it("replaces oversized patch lines with markers and flags the patch as truncated", () => {
    const long = "z".repeat(60 * 1024);
    const result = genPatch("min.js", `a\n${long}\nb\n`, `a\n${long}!\nb\n`);
    expect(result.truncated).toBe(true);
    expect(result.patch).not.toContain(long);
    expect(result.patch).toContain("content not shown");
    expect(Buffer.byteLength(result.patch, "utf-8")).toBeLessThan(2 * 1024);
  });

  it("cuts the patch when the total byte budget is exhausted", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `l${i} ` + "y".repeat(80));
    const result = genPatch("wide.txt", body.join("\n"), body.map((l) => l + "!").join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("patch truncated at 50.0KB");
    expect(result.patch).not.toContain("l1999 ");
    expect(Buffer.byteLength(result.patch, "utf-8")).toBeLessThan(60 * 1024);
  });
});
