import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdit - recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[3]!,
      remove_to: hashes[1]!, replacement_lines: ["X"] },
    ));
    expect(result.content).toBe("a\nX\ne");
    expect(result.warnings?.[0]).toMatch(/Swapped reversed remove_from\/remove_to/);
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: hashes[1]!, replacement_lines: ["X", "Y"] },
      ), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "PyBY";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: staleStart,
        remove_to: hashes[2]!, replacement_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 3: ${hashes[2]}│c`);
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "PyBY";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: staleEnd, replacement_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 1: ${hashes[0]}│a`);
  });

  it("omits context when both anchors are stale", async () => {
    const content = "a\nb\nc";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: "PyBY",
        remove_to: "YYY", replacement_lines: ["X"] },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/Current context around resolved anchor/);
  });

  it("rejects ambiguous anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: hashes[0]!, replacement_lines: ["X"] },
      ), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });

  it("rejects unknown fields in edit items", () => {
    const edit = { remove_from: "PyBY", remove_to: "PyBY", replacement_lines: ["x"], extra: true } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing replacement_lines", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "replacement_lines" array/);
  });

  it("rejects null replacement_lines", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", replacement_lines: null } as any;
    expect(() => resEdit(edit)).toThrow(/must be an array of strings/);
  });

  it("rejects a single string replacement_lines", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", replacement_lines: "hello" } as any;
    expect(() => resEdit(edit)).toThrow(/must be an array of strings/);
  });

  it("accepts array replacement_lines", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", replacement_lines: ["hello", "world", ""] } as any;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["hello", "world", ""]);
  });

  it("rejects malformed hash_bounds", () => {
    const edit = { remove_from: "not-valid",
    remove_to: "not-valid", replacement_lines: ["x"] };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("strips bare hash prefix in content_lines", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[2]!, replacement_lines: [`${hashes[1]!}│b`, `X`] },
    ));
    expect(result.content).toBe("a\nb\nX\nd\ne");
    expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
  });

  it("strips diff preview rows in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_lines: [`+${hashes[1]!}│B`] },
    ));
    expect(result.content).toBe("a\nB\nc");
    expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_lines: ["\\uDDDD"] },
    ));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_lines: ["\t\treplaced"] },
    ));
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_lines: ["\t\treplaced"] },
    ));
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_lines: ["b"] },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[2]!, replacement_lines: ["b", "c"] },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, replacement_lines: ["world"] },
    ));
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_lines: ["b", "c"] },
    ));
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_lines: [] },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("handles replace of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[2]!, replacement_lines: ["x", "y"] },
    ));
    expect(result.content).toBe("x\ny");
  });
});
