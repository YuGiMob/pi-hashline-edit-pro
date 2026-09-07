import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import {
  withTempFile,
  setupIntegrationTest,
  getText,
  extractHash,
} from "../support/fixtures";

describe("chained edits on files with duplicated content", () => {
  it("verifies a second edit against hashes served by the first read", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nb\nd\ne\nb\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const refs: Record<string, string> = {};
      for (const needle of ["a", "c", "d", "e"]) {
        refs[needle] = extractHash(r1.split("\n").find((l: string) => l.includes(`│${needle}`))!);
      }

      const edit1 = await editTool.execute(
        "e1",
        {
          remove_from: refs["a"]!,
          remove_to: refs["c"]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edit1.content[0].text).toContain("Successfully replaced");

      const edit2 = await editTool.execute(
        "e2",
        {
          remove_from: refs["d"]!,
          remove_to: refs["e"]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edit2.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("b\nb\nf\n");
    });
  });

  it("anchors a follow-up edit on a context row shown in the post-edit diff", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nb\nd\ne\nb\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const refs: Record<string, string> = {};
      for (const needle of ["a", "c"]) {
        refs[needle] = extractHash(r1.split("\n").find((l: string) => l.includes(`│${needle}`))!);
      }

      const edit1 = await editTool.execute(
        "e1",
        {
          remove_from: refs["a"]!,
          remove_to: refs["c"]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );
      const diff = (edit1.details as { diff?: string } | undefined)?.diff ?? "";
      const contextRow = diff.split("\n").find((l: string) => l.startsWith(" ") && l.includes("│b"))!;
      const contextHash = extractHash(contextRow);

      const edit2 = await editTool.execute(
        "e2",
        {
          remove_from: contextHash,
          remove_to: contextHash,
          replacement_lines: ["B"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edit2.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("B\nd\ne\nb\nf\n");
    });
  });
});
