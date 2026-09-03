import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("resAnchor (via applyEdit)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "Y"] },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: "PyBY", remove_to: "PyBY", replacement_lines: ["X"] },
      ))
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["X"] },
      ), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });
});

describe("checkBoundaryDup (via applyEdit) - auto-fix", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "d"] },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["a", "X"] },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "Y"] },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [] },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("auto-fixes trailing duplication when content_lines has trailing empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [`X`, `d`, ``] },
    ));
    expect(result.content).toBe("a\nX\n\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("d");
  });

  it("auto-fixes leading duplication when content_lines has leading empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [``, `a`, `X`] },
    ));
    expect(result.content).toBe("a\n\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("a");
  });

  it("auto-fixes both trailing and leading in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["a", "d"] },
    ));
    expect(result.content).toBe("a\nd");
    expect(result.autoFixes).toHaveLength(2);
  });
});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "Y"] },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: hashes[0]!, remove_to: hashes[2]!, replacement_lines: [] },
      ))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[4]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["b"] },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["X"] },
    ));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_lines: ["X"] },
    ));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["A"] },
    ));
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

describe("auto-fix via applyEdit", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [`new one`, `new two`, `after`] },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("after");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [`before`, `new one`, `new two`] },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("before");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes both leading and trailing in one edit", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[3]!, replacement_lines: [`ctx2`, `dup`, `dup`, `ctx3`] },
    ));
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(2);
    expect(result.content).toBe("ctx1\nctx2\ndup\ndup\nctx3\nctx4");
  });
});

describe("boundary-dup autocorrection (via applyEdit)", () => {
  it("strips a trailing duplicate without a warning", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "d"] },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLineIndex).toBe(1);
  });

  it("strips a new line duplicating a unique line after the range (noop)", async () => {
    const content = "class A {\n  x = 1;\n\n  constructor() {}\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[2]!, replacement_lines: ["class A {", "  x = 1;", "", "  constructor() {}", "}"] },
    ));
    expect(result.content).toBe(content);
    expect(result.noopEdit).toBeDefined();
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toHaveLength(2);
    expect(result.autoFixes!.map((f) => f.kind)).toEqual(["first-new-after", "first-new-after"]);
  });

  it("strips a new line duplicating a unique line before the range (noop)", async () => {
    const content = "foo();\nbar();\nbaz();\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["bar();", "baz();", "foo();"] },
    ));
    expect(result.content).toBe(content);
    expect(result.noopEdit).toBeDefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("last-new-before");
  });

  it("does not strip new-line duplicates when the adjacent line is not unique in the file", async () => {
    const content = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[3]!, remove_to: hashes[4]!, replacement_lines: ["if (b) {", "  yNew();", "}"] },
    ));
    expect(result.content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n");
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });

  it("does not strip a whitespace-only line next to a unique empty line before the range", async () => {
    const content = "\nsecond";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["   ", "second"] },
    ));
    expect(result.content).toBe("\n   \nsecond");
    expect(result.autoFixes ?? []).toHaveLength(0);
    expect(result.noopEdit).toBeUndefined();
  });

  it("does not strip a whitespace-only line next to a unique empty line after the range", async () => {
    const content = "second\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["second", "   "] },
    ));
    expect(result.content).toBe("second\n   \n");
    expect(result.autoFixes ?? []).toHaveLength(0);
    expect(result.noopEdit).toBeUndefined();
  });

  it("strips a re-included content run but stops at a whitespace-only line", async () => {
    const content = "a\nfoo\n\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["foo", "   "] },
    ));
    expect(result.content).toBe("   \nfoo\n\n");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("first-new-after");
    expect(result.autoFixes![0]!.removedLine).toBe("foo");
  });
});
