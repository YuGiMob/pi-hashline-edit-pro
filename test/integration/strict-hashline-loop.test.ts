import { describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("strict hashline tool loop", () => {
  it("supports read -> fresh edit -> stale rejection -> retry with fresh anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(
        editTool.execute(
          "e2",
          {
            path: "sample.ts",
            remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA-AGAIN"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/2 stale anchor.*sample\.ts/);

      const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const secondText = secondRead.content[0].text as string;
      const freshRef = secondText
        .split("\n")
        .find((line: string) => line.includes("│BETA"))!
        .split("│")[0]!;

      await editTool.execute(
        "e3",
        {
          path: "sample.ts",
          remove_from: freshRef, remove_to: freshRef, replacement_lines: ["BETA-AGAIN"],
        },
        undefined,
        undefined,
        ctx,
      );
    });
  });

  it("seeds content into an empty file via the empty-line hash", async () => {
    await withTempFile("empty.ts", "", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "empty.ts" }, undefined, undefined, ctx);
      const emptyHash = readResult.content[0].text.split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[A-Za-z0-9]{4}$/);

      await editTool.execute(
        "e1",
        { path: "empty.ts", remove_from: emptyHash, remove_to: emptyHash, replacement_lines: ["first", "second"] },
        undefined,
        undefined,
        ctx,
      );

      const { readFile } = await import("fs/promises");
      expect(await readFile(path, "utf-8")).toBe("first\nsecond");
    });
  });
});

describe("CRLF line ending preservation", () => {
  it("preserves CRLF line endings after edit", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "crlf.ts" }, undefined, undefined, ctx);
      const betaRef = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "crlf.ts", remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctx,
      );

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(content).toContain("\r\n");
      expect(content).not.toMatch(/[^\r]\n/);
    });
  });

  it("preserves LF line endings after edit (no CRLF introduced)", async () => {
    await withTempFile("lf.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "lf.ts" }, undefined, undefined, ctx);
      const betaRef = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "lf.ts", remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctx,
      );

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\nBETA\ngamma\n");
      expect(content).not.toContain("\r");
    });
  });
});

describe("UTF-8 BOM handling", () => {
  it("strips the BOM for display and restores it on write", async () => {
    await withTempFile("bom.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { readFile, writeFile } = await import("fs/promises");
      await writeFile(path, "\uFEFFalpha\nbeta\n", "utf-8");

      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "bom.ts" }, undefined, undefined, ctx);
      expect(readResult.content[0].text).not.toContain("\uFEFF");
      const betaRef = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "bom.ts", remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("\uFEFFalpha\nBETA\n");
    });
  });
});
