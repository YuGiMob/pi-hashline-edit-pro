import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["bbb"] }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.classification).toBe("noop");
    });
  });

  it("warns on trailing duplicate instead of auto-fixing silently", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB", "ccc"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Should NOT be a noop
      expect(result.details.classification).not.toBe("noop");

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      // Duplicate ccc is kept (not auto-fixed)
      expect(content).toBe("aaa\nBBB\nccc\nccc\n");
    });
  });
});
