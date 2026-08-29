import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { join } from "path";
import { withTempFile, withTempDir, makeFakePiRegistry, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import register from "../../index";

describe("insert and grep loop", () => {
  it("read → grep → insert → undo", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("anchor_grep");
      const insertTool = getTool("insert");
      const undo = getTool("undo_last_change");

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(getText(readResult)).toContain("│beta");

      const grepResult = await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      const betaHash = extractHash(getText(grepResult).split("\n").find((l) => l.includes("│beta"))!);

      const inserted = await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ["BETA1"] },
        undefined, undefined, ctx,
      );
      expect(inserted.content[0].text).toContain("Successfully inserted");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nBETA1\ngamma\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("inserts into a second file found by a directory grep", async () => {
    await withTempDir("grep-loop-", async (dir) => {
      await mkdir(join(dir, "lib"), { recursive: true });
      await writeFile(join(dir, "lib", "a.ts"), "alpha\n", "utf-8");
      await writeFile(join(dir, "lib", "b.ts"), "beta\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("anchor_grep");
      const insertTool = getTool("insert");

      const result = await grepTool.execute(
        "g1",
        { pattern: "beta" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("=== lib/b.ts ===");
      const betaHash = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);

      await insertTool.execute(
        "i1",
        { path: "lib/b.ts", anchor: betaHash, direction: "after", lines: ["BETA2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(join(dir, "lib", "b.ts"), "utf-8")).toBe("beta\nBETA2\n");
      expect(await readFile(join(dir, "lib", "a.ts"), "utf-8")).toBe("alpha\n");
    });
  });

  it("chains an insert off the post-insert diff rows", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      const first = await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: alphaHash, direction: "after", lines: ["mid1"] },
        undefined, undefined, ctx,
      );
      const diff = (first.details as { diff?: string } | undefined)?.diff ?? "";
      const mid1Row = diff.split("\n").find((l) => l.includes("│mid1"))!;

      const second = await insertTool.execute(
        "i2",
        { path: "sample.ts", anchor: mid1Row, direction: "after", lines: ["mid2"] },
        undefined, undefined, ctx,
      );
      expect(second.content[0].text).toContain("Stripped diff-preview marker from anchor entry");
      expect(await readFile(path, "utf-8")).toBe("alpha\nmid1\nmid2\nbeta\ngamma\n");
    });
  });

  it("auto-read shows the post-insert diff instead of the summary", async () => {
    await withTempDir("auto-read-insert-", async (dir) => {
      await writeFile(join(dir, "diff.txt"), "alpha\nbeta\n", "utf-8");
      const { pi, handlers } = makeFakePiRegistry();
      register(pi);
      const handler = handlers.get("tool_result")!;
      const diff = " aaa\n-   │beta\n+XYZ│beta\n+BET│BETA";
      const result = await handler!(
        {
          toolName: "insert",
          isError: false,
          input: { path: "diff.txt" },
          details: {
            diff,
            metrics: { classification: "applied", changed_lines: { first: 2, last: 3 } },
          },
          content: [{ type: "text", text: "Successfully inserted in diff.txt. Added 1 line(s), removed 1 line(s)." }],
        },
        { cwd: dir },
      );
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(1);
      expect(content[0].text).toBe(diff);
      expect(content[0].text).not.toContain("Successfully inserted");
    });
  });
});
