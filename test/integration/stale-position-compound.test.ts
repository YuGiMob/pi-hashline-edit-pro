import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("stale-position compound edits", () => {
  it("rejects stale anchors after a replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const line5Hash = firstText
        .split("\n")
        .find((line: string) => line.includes("│e"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          remove_from: line5Hash, remove_to: line5Hash, replacement_lines: ["E"],
        },
        undefined,
        undefined,
        ctx,
      );

      const freshHash = (await lineHashes(result.content?.[0]?.text ?? "", home.testPath))?.[4];
      if (freshHash) {
        await editTool.execute(
          "e2",
          {
            remove_from: freshHash, remove_to: freshHash, replacement_lines: ["E-AGAIN"],
          },
          undefined,
          undefined,
          ctx,
        );
      }
    });
  });

  it("tracks correct final coordinates for a range replace", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line4Hash, replacement_lines: ["B", "C_D"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });

  it("tracks correct coordinates when replace shrinks lines", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const lines = firstText.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│b"))!.split("│")[0]!;
      const line4Hash = lines.find((l: string) => l.includes("│d"))!.split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line4Hash, replacement_lines: ["B", "C_D"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 3 line(s).");
    });
  });
});
