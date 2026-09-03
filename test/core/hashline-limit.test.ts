import { describe, expect, it } from "vitest";
import {
  _lineHashesPure,
  lineHashes,
  HASH_SPACE,
  MAX_HASH_LINES,
} from "../../src/hashline";
import {
  useTestHome,
  withTempFile,
  setupReadTest,
} from "../support/fixtures";

const home = useTestHome();

describe("hashline limits", () => {
  it("derives the hash space from the alphabet and hash length", () => {
    expect(HASH_SPACE).toBe(257795);
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
  });

  it("hashes exactly MAX_HASH_LINES lines with unique anchors", () => {
    const content = Array.from(
      { length: MAX_HASH_LINES },
      (_, i) => `line ${i}`,
    ).join("\n");
    const hashes = _lineHashesPure(content);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);

  it("throws a clear E_FILE_TOO_LARGE error above the limit", () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join(
      "\n",
    );
    expect(() => _lineHashesPure(content)).toThrow("E_FILE_TOO_LARGE");
  }, 300_000);

  it("preserves unique hashes at the boundary through the store path", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join(
      "\n",
    );
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);
});

describe("read tool line cap", () => {
  it("rejects oversized files with E_FILE_TOO_LARGE before hashing", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join(
      "\n",
    );
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      await expect(
        readTool.execute("r1", { path: "huge.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow("E_FILE_TOO_LARGE");
    });
  });

  it("reads a file at the limit without hashing errors", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join(
      "\n",
    );
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "r1",
        { path: "big.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  }, 300_000);
});
