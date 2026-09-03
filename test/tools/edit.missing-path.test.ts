import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { withTempFile, withTempDir, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("replace - missing path resolution", () => {
  it("resolves a missing path when the anchors uniquely identify a file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["AAA"] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain('Missing "path" resolved to');
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\n");
    });
  });

  it("resolves a missing path from served records after a grep", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("anchor_grep");
      const editTool = getTool("replace");

      const grepResult = await grepTool.execute(
        "g1",
        { pattern: "bbb", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      const betaHash = extractHash(getText(grepResult).split("\n").find((l) => l.includes("│bbb"))!);

      const result = await editTool.execute(
        "e1",
        { remove_from: betaHash, remove_to: betaHash, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain('Missing "path" resolved to');
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\n");
    });
  });

  it("rejects a missing path when the anchors match multiple files", async () => {
    await withTempDir("ambig-", async (dir) => {
      const { ctx, editTool } = setupIntegrationTest(dir);
      const first = join(dir, "a.txt");
      const second = join(dir, "b.txt");
      await writeFile(first, "same\n", "utf-8");
      await writeFile(second, "same\n", "utf-8");
      const hashes = await lineHashes("same\n", first);
      await lineHashes("same\n", second);

      await expect(
        editTool.execute(
          "e1",
          { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["X"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/match multiple known files/);
    });
  });

  it("rejects a missing path when the anchors match no file", async () => {
    await withTempFile("sample.ts", "aaa\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          { remove_from: "AAA", remove_to: "AAA", replacement_lines: ["X"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/requires a non-empty "path"/);
    });
  });

  it("keeps the resolved path in the post-edit diff", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details?.diff).toContain("BBB");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});
