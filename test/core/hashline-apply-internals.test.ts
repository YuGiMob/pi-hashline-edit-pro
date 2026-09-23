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
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "Y"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: "PyBY", remove_to: "PyBY", replacement_lines: ["X"] },
      ), undefined, hashes)
    ).toThrow(/E_STALE_ANCHOR/);
  });

});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: ["X", "Y"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_lines: [] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!, remove_to: hashes[2]!, replacement_lines: [] },
      ), undefined, hashes)
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[4]!, replacement_lines: [] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["b"] },
    ), undefined, hashes);
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["X"] },
    ), undefined, hashes);
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_lines: ["X"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: [] },
    ), undefined, hashes);
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_lines: [] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["A"] },
    ), undefined, hashes);
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

