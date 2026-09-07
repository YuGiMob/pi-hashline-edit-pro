import { describe, expect, it, beforeEach } from "vitest";
import { lineHashes, _lineHashesPure, HASH_SPACE } from "../../src/hashline";
import { resetRegistryForTests } from "../../src/anchor-registry";
import { useTestHome } from "../support/fixtures";

beforeEach(() => {
  resetRegistryForTests();
});

const home = useTestHome();

describe("large file stress tests - store path", () => {
  it("handles 10,000 identical lines via store with unique hashes", async () => {
    const line = "}";
    const content = Array.from({ length: 10_000 }, () => line).join("\n");
    const start = performance.now();
    const hashes = await lineHashes(content, home.testPath);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(10_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(10_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("handles 50,000 unique lines via store without timeout", async () => {
    const content = Array.from({ length: 50_000 }, (_, i) => `line${i}`).join("\n");
    const start = performance.now();
    const hashes = await lineHashes(content, home.testPath);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(50_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(50_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("cache hit returns identical hashes for repeated content", async () => {
    const content = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const first = await lineHashes(content, home.testPath);
    const second = await lineHashes(content, home.testPath);
    expect(second).toEqual(first);
  }, 60_000);

  it("preserves hashes for unchanged lines in a 10,000-line file after small edit", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const lines = oldContent.split("\n");
    lines[5000] = "MODIFIED";
    const newContent = lines.join("\n");

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(10_000);
    expect(result[0]).toBe(oldHashes[0]);
    expect(result[4999]).toBe(oldHashes[4999]);
    expect(result[5001]).toBe(oldHashes[5001]);
    expect(result[5000]).not.toBe(oldHashes[5000]);
  }, 120_000);

  it("preserves hashes when prepending 1,000 lines to a 10,000-line file", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const prefix = Array.from({ length: 1_000 }, (_, i) => `new${i}`).join("\n");
    const newContent = prefix + "\n" + oldContent;

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(11_000);
    for (let i = 0; i < 10_000; i++) {
      expect(result[i + 1_000]).toBe(oldHashes[i]);
    }
  }, 120_000);

  it("preserves hashes when appending 1,000 lines to a 10,000-line file", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const suffix = Array.from({ length: 1_000 }, (_, i) => `new${i}`).join("\n");
    const newContent = oldContent + "\n" + suffix;

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(11_000);
    for (let i = 0; i < 10_000; i++) {
      expect(result[i]).toBe(oldHashes[i]);
    }
  }, 120_000);
});

describe("large file stress tests - pure path (no store)", () => {
  it("handles 100,000 unique lines without timeout", () => {
    const content = Array.from({ length: 100_000 }, (_, i) => `line${i}`).join("\n");
    const start = performance.now();
    const hashes = _lineHashesPure(content);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(100_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(100_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("handles 20,000 identical closing braces", () => {
    const content = Array.from({ length: 20_000 }, () => "}").join("\n");
    const start = performance.now();
    const hashes = _lineHashesPure(content);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(20_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(20_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});

describe("hash collision stress tests", () => {
  it("assigns unique hashes to 1,000 identical lines via store", async () => {
    const content = Array.from({ length: 1_000 }, () => "same").join("\n");
    const hashes = await lineHashes(content, home.testPath);
    const unique = new Set(hashes);
    expect(unique.size).toBe(1_000);
  }, 60_000);

  it("assigns unique hashes to 10,000 identical lines (pure)", () => {
    const content = Array.from({ length: 10_000 }, () => "same").join("\n");
    const hashes = _lineHashesPure(content);
    const unique = new Set(hashes);
    expect(unique.size).toBe(10_000);
  }, 60_000);

  it("handles 100 identical lines with mixed content types via store", async () => {
    const lines = [
      ...Array.from({ length: 25 }, () => "import { foo } from 'bar';"),
      ...Array.from({ length: 25 }, () => "const x = 1;"),
      ...Array.from({ length: 25 }, () => "}"),
      ...Array.from({ length: 25 }, () => "  return result;"),
    ];
    const content = lines.join("\n");
    const hashes = await lineHashes(content, home.testPath);
    const unique = new Set(hashes);
    expect(unique.size).toBe(100);
  }, 60_000);

  it("near-capacity collision: 200,000 identical lines (pure)", () => {
    const content = Array.from({ length: 200_000 }, () => "x").join("\n");
    const start = performance.now();
    const hashes = _lineHashesPure(content);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(200_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(200_000);
    expect(elapsed).toBeLessThan(120_000);
  }, 300_000);

  it("throws a clear error when hash space is exhausted", () => {
    const line = "x";
    const content = Array.from({ length: HASH_SPACE + 1 }, () => line).join("\n");
    expect(() => _lineHashesPure(content)).toThrow("E_FILE_TOO_LARGE");
  }, 300_000);
});

describe("mapStableHashes - large file stress", () => {
  it("handles 10,000 identical lines with interleaved insert/delete/modify", async () => {
    const oldContent = Array.from({ length: 10_000 }, () => "same").join("\n");
    const oldHashes = _lineHashesPure(oldContent);

    const newLines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      if (i % 5 === 0) {
        newLines.push("INSERTED");
      } else if (i % 5 === 1) {
        continue;
      } else if (i % 5 === 2) {
        newLines.push("MODIFIED");
      } else {
        newLines.push("same");
      }
    }
    const newContent = newLines.join("\n");

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(newLines.length);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  }, 120_000);

  it("does not degrade when every candidate is removed (regression)", async () => {
    const oldContent = Array.from({ length: 100_000 }, () => "dup").join("\n");
    const oldHashes = _lineHashesPure(oldContent);
    const newContent = Array.from({ length: 100_000 }, () => "dup").join("\n");
    const start = performance.now();
    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes
    });
    const elapsed = performance.now() - start;
    expect(result).toEqual(oldHashes);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});
