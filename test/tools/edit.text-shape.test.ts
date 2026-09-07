import { join } from "path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

useTestHome();

describe("edit tool text shape (token budget)", () => {
  it("changed mode keeps only anchors in LLM-visible text and line counts in details", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      expect(result.details?.metrics?.added_lines).toBeDefined();
      expect(result.details?.metrics?.removed_lines).toBeDefined();
    });
  });

  it("changed mode uses short anchor header without instructional clause", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("changed mode rejects deleting all content from a non-empty file", async () => {
    await withTempFile("sample.ts", "only\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("only\n", join(cwd, "sample.ts"));

      await expect(
        editTool.execute(
          "e1",
          {
            remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: [],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });

  it("changed mode omits oversized anchor payloads even when the changed span fits by line count", async () => {
    const longLine = "x".repeat(5000);
    await withTempFile("sample.ts", `before\n${longLine}\nafter\n`, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes(`before\n${longLine}\nafter\n`, join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: [`b${longLine.slice(1)}`],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("warns when a replacement_lines element carries embedded newlines", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB\nCCC"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toMatch(/embedded newlines/);
      expect(result.details?.metrics?.warnings).toBeGreaterThan(0);
      await expect(readFile(path, "utf-8")).resolves.toBe("aaa\nBBB\nCCC\nccc\n");
    });
  });
});
