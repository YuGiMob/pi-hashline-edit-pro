import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, anchorFor } from "../support/fixtures";
import { writeConfig } from "../../src/config";

describe("boundary dedup diagnostics", () => {
  it("reports stripped lines and does not re-insert them", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "on" });
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const ref = anchorFor(text, "bbb");

      const result = await editTool.execute(
        "e1",
        { remove_from: ref, remove_to: ref, replacement_lines: ["aaa", "BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(getText(result)).toContain("Boundary dedup: 1 line not added again (see dedup│ row).");
      expect(result.details.diff).toContain("dedup│aaa");
      const rows = String(result.details.diff).split("\n");
      const survivor = rows.findIndex((row) => row.includes("│aaa") && !row.includes("dedup"));
      const deduped = rows.findIndex((row) => row === "dedup│aaa");
      expect(survivor).toBeGreaterThanOrEqual(0);
      expect(deduped).toBe(survivor + 1);
      expect(result.details.diff).not.toContain('"aaa" already exists');
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("places a trailing dedup row beside the surviving line below the change", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "on" });
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const ref = anchorFor(text, "bbb");

      const result = await editTool.execute(
        "e1",
        { remove_from: ref, remove_to: ref, replacement_lines: ["BBB", "ccc"] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      const rows = String(result.details.diff).split("\n");
      const added = rows.findIndex((row) => row.endsWith("│BBB"));
      const deduped = rows.findIndex((row) => row === "dedup│ccc");
      const survivor = rows.findIndex((row) => row.includes("│ccc") && !row.includes("dedup"));
      expect(added).toBeGreaterThanOrEqual(0);
      expect(deduped).toBe(added + 1);
      expect(survivor).toBe(deduped + 1);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});
