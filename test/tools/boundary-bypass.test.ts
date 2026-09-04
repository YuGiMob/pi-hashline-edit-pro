import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import {
  withTempFile,
  setupIntegrationTest,
  makeFakePiRegistry,
  getText,
} from "../support/fixtures";
import register from "../../index";

const NOOP_LINE_1 = "bbb";

async function readSample(ctx: any, readTool: any): Promise<string[]> {
  await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
  return lineHashes("aaa\nbbb\nccc\n");
}

function cutPayload(hashes: string[]) {
  return {
    path: "sample.ts",
    remove_from: hashes[1]!,
    remove_to: hashes[1]!,
    replacement_lines: [NOOP_LINE_1, "ccc"],
  };
}

describe("boundary dedup noop bypass", () => {
  it("does not count a boundary-cut noop and applies the literal replacement on the resend", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);
      const payload = cutPayload(hashes);

      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      expect(first.details.classification).toBe("noop");
      expect(getText(first)).toContain("No changes made");
      expect(getText(first)).not.toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");

      const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
      expect(getText(second)).toContain("Successfully replaced");
      expect(getText(second)).toContain("[E_BOUNDARY_BYPASS] Boundary dedup was off for this call and is back on.");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nccc\n");

      const third = await editTool.execute("e3", payload, undefined, undefined, ctx);
      expect(third.details.classification).toBe("noop");
      expect(getText(third)).toContain("No changes made");
      expect(getText(third)).not.toContain("[E_BOUNDARY_BYPASS]");

      const fourth = await editTool.execute("e4", payload, undefined, undefined, ctx);
      expect(getText(fourth)).toContain("Successfully replaced");
      expect(getText(fourth)).toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nccc\nccc\n");
    });
  });

  it("an applied edit clears the pending bypass", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);
      const payload = cutPayload(hashes);

      await editTool.execute("e1", payload, undefined, undefined, ctx);

      await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          remove_from: hashes[0]!,
          remove_to: hashes[0]!,
          replacement_lines: ["ATIm"],
        },
        undefined,
        undefined,
        ctx,
      );

      const again = await editTool.execute("e3", payload, undefined, undefined, ctx);
      expect(again.details.classification).toBe("noop");
      expect(getText(again)).toContain("No changes made");
      expect(getText(again)).not.toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("ATIm\nbbb\nccc\n");

      const resend = await editTool.execute("e4", payload, undefined, undefined, ctx);
      expect(getText(resend)).toContain("Successfully replaced");
      expect(getText(resend)).toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("ATIm\nbbb\nccc\nccc\n");
    });
  });

  it("a missing-path resend shares the bypass with the explicit-path form", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);

      await editTool.execute("e1", cutPayload(hashes), undefined, undefined, ctx);

      const missingPath = await editTool.execute(
        "e2",
        {
          remove_from: hashes[1]!,
          remove_to: hashes[1]!,
          replacement_lines: [NOOP_LINE_1, "ccc"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(missingPath)).toContain("Successfully replaced");
      expect(getText(missingPath)).toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nccc\n");
    });
  });

  it("repeated plain noops are allowed and do not touch the bypass", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);
      const plain = {
        path: "sample.ts",
        remove_from: hashes[1]!,
        remove_to: hashes[1]!,
        replacement_lines: [NOOP_LINE_1],
      };

      for (let i = 0; i < 3; i++) {
        const result = await editTool.execute(`e${i}`, plain, undefined, undefined, ctx);
        expect(result.details.classification).toBe("noop");
        expect(getText(result)).toContain("No changes made");
        expect(getText(result)).not.toContain("[E_BOUNDARY_BYPASS]");
      }
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");

      await editTool.execute("e3", cutPayload(hashes), undefined, undefined, ctx);
      const resend = await editTool.execute("e4", cutPayload(hashes), undefined, undefined, ctx);
      expect(getText(resend)).toContain("Successfully replaced");
      expect(getText(resend)).toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nccc\n");
    });
  });

  it("previews (noPersist) do not arm the bypass", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);

      for (let i = 0; i < 3; i++) {
        const preview = await compPreview(cutPayload(hashes), cwd);
        expect("error" in preview ? preview.error : "no error").toContain(
          "No changes made",
        );
        expect("error" in preview ? preview.error : "no error").not.toContain("[E_BOUNDARY_BYPASS]");
      }

      const result = await editTool.execute("e1", cutPayload(hashes), undefined, undefined, ctx);
      expect(result.details.classification).toBe("noop");
      expect(getText(result)).not.toContain("[E_BOUNDARY_BYPASS]");
    });
  });

  it("keeps the bypass per file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await writeFile(join(cwd, "other.ts"), "aaa\nbbb\nccc\n", "utf-8");

      const hashes = await readSample(ctx, readTool);
      await readTool.execute("r1", { path: "other.ts" }, undefined, undefined, ctx);

      await editTool.execute("a1", cutPayload(hashes), undefined, undefined, ctx);

      const other = await editTool.execute(
        "b1",
        {
          path: "other.ts",
          remove_from: hashes[1]!,
          remove_to: hashes[1]!,
          replacement_lines: [NOOP_LINE_1, "ccc"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(other.details.classification).toBe("noop");
      expect(getText(other)).not.toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");

      const resend = await editTool.execute("a2", cutPayload(hashes), undefined, undefined, ctx);
      expect(getText(resend)).toContain("Successfully replaced");
      expect(getText(resend)).toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\nccc\n");
    });
  });

  it("a write clears the pending bypass before it can be consumed", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool, handlers } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const hashes = await readSample(ctx, readTool);

      await editTool.execute("c1", cutPayload(hashes), undefined, undefined, ctx);

      const writeHandler = handlers.get("tool_result");
      expect(writeHandler).toBeDefined();
      await writeHandler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          isError: false,
          input: { path: "sample.ts", content: "aaa\nbbb\nccc\n" },
          content: [{ type: "text", text: "File written." }],
          details: undefined,
        },
        ctx,
      );

      const resend = await editTool.execute("e2", cutPayload(hashes), undefined, undefined, ctx);
      expect(resend.details.classification).toBe("noop");
      expect(getText(resend)).toContain("No changes made");
      expect(getText(resend)).not.toContain("[E_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("an applied edit with boundary dedup reports the stripped lines and does not re-insert them", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!,
          remove_to: hashes[1]!,
          replacement_lines: ["aaa", "BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(getText(result)).toContain('Boundary dedup: 1 line not added again (see dedup│ row).');
      expect(result.details.diff).toContain('dedup│aaa');
      const rows = String(result.details.diff).split("\n");
      const survivor = rows.findIndex((row) => row.includes('│aaa') && !row.includes('dedup'));
      const deduped = rows.findIndex((row) => row === 'dedup│aaa');
      expect(survivor).toBeGreaterThanOrEqual(0);
      expect(deduped).toBe(survivor + 1);
      expect(result.details.diff).not.toContain('"aaa" already exists');
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
  it("places a trailing dedup row beside the surviving line below the change", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await readSample(ctx, readTool);
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!,
          remove_to: hashes[1]!,
          replacement_lines: ["BBB", "ccc"],
        },
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
