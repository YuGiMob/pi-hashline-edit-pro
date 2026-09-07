import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest } from "../support/fixtures";

describe("snapshotId surface (details-only after W2)", () => {
  it("edit succeeds when the file changed on disk between read and edit, as long as the changed line is outside the replaced range", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        {
          remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("rejects the edit when a line inside the replaced range changed on disk between read and edit", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const alphaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;
      const gammaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│gamma"))!
        .split("│")[0]!;

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      await expect(
        editTool.execute(
          "e1",
          {
            remove_from: alphaRef, remove_to: gammaRef, replacement_lines: ["alpha", "x", "gamma"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("edit text response no longer contains a SnapshotId line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).not.toContain("SnapshotId");
    });
  });

  it("a stale anchor still triggers [E_STALE_ANCHOR] with refresh hints", async () => {
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
            remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA-AGAIN"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR.*not owned in this session/);
    });
  });
});
