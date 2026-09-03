import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { loadHashStore, getSnapshot, shutdownHashStore } from "../../src/hash-store";
import * as hashStoreModule from "../../src/hash-store";
import * as fsWriteModule from "../../src/fs-write";
import * as replaceUndoModule from "../../src/replace-undo";
import {
  withTempFile,
  setupIntegrationTest,
  useTestHome,
  getText,
} from "../support/fixtures";
import register from "../../index";

const home = useTestHome();

describe("undo_last_change", () => {
  it("returns error when there is no undo history", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const undo = getTool("undo_last_change");

      const result = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(getText(result)).toMatch(/no undo history/i);
    });
  });

  it("restores file content after a single-line replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      const afterReplace = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(afterReplace).toBe("aaa\nBBB\nccc\n");

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);

      const afterUndo = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(afterUndo).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("undo works with the file_path alias", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { file_path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);
    });
  });

  it("reports the restored changed range in details metrics", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      expect(undoResult.details.metrics.changed_lines).toEqual({ first: 2, last: 2 });
    });
  });

  it("exposes the undo diff in details with the restored hashes", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const diff = undoResult.details?.diff as string | undefined;
      expect(diff).toBeDefined();
      const postHashes = await lineHashes("aaa\nBBB\nccc\n", home.testPath);
      expect(diff).toContain(`-${postHashes[1]}│BBB`);
      expect(diff).toContain(`+${hashes[1]}│bbb`);
      const patch = undoResult.details?.patch as string | undefined;
      expect(patch).toBeDefined();
      expect(patch).toContain("--- sample.ts");
      expect(patch).toContain("+++ sample.ts");
      expect(patch).toContain("-BBB");
      expect(patch).toContain("+bbb");
    });
  });

  it("reports correct line counts for an addition", async () => {
    await withTempFile("sample.ts", "aaa\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB", "B2"],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      expect(text).toMatch(/removed 2 line/i);
      expect(text).toMatch(/restored 1 line/i);
    });
  });

  it("reports correct line counts for a deletion", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      expect(text).toMatch(/restored 1 line/i);
      expect(text).toMatch(/removed 0 line/i);
    });
  });

  it("reports correct line counts for a mixed replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[2]!,
          replacement_lines: [`XXX`, `YYY`, `ZZZ`],
        },
        undefined,
        undefined,
        ctx,
      );

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(undoResult);
      expect(text).toMatch(/removed 3 line/i);
      expect(text).toMatch(/restored 2 line/i);
    });
  });

  it("restores hash store snapshot after undo", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const absPath = join(cwd, "sample.ts");
      const undoHashes = getSnapshot(store, absPath, "aaa\nbbb\nccc\n");
      expect(undoHashes).toBeDefined();
    });
  });

  it("undo survives a hash-store shutdown (persisted undo)", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      shutdownHashStore();

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");
    });
  });
  it("refuses the edit when undo persistence fails, leaving the file unchanged", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const spy = vi
        .spyOn(hashStoreModule, "upsertUndo")
        .mockImplementation(() => {
          throw new Error("store down");
        });
      try {
        await expect(
          editTool.execute(
            "e1",
            {
              path: "sample.ts",
              remove_from: hashes[1]!, remove_to: hashes[1]!,
              replacement_lines: ["BBB"],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
      } finally {
        spy.mockRestore();
      }

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");

      const retry = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
    });
  });
  it("restores the previous undo record when the file write fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const first = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toContain("Successfully replaced");

      const spy = vi
        .spyOn(fsWriteModule, "writeAtomic")
        .mockRejectedValueOnce(new Error("disk full"));
      try {
        await expect(
          editTool.execute(
            "e2",
            {
              path: "sample.ts",
              remove_from: hashes[2]!, remove_to: hashes[2]!,
              replacement_lines: ["CCC"],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("disk full");
      } finally {
        spy.mockRestore();
      }

      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("aaa\nBBB\nccc\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(getText(undone)).toContain("Undone last change");
      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });
  it("clears the new undo record when the file write fails and there was no previous undo", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const spy = vi
        .spyOn(fsWriteModule, "writeAtomic")
        .mockRejectedValueOnce(new Error("disk full"));
      try {
        await expect(
          editTool.execute(
            "e1",
            {
              path: "sample.ts",
              remove_from: hashes[1]!, remove_to: hashes[1]!,
              replacement_lines: ["BBB"],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("disk full");
      } finally {
        spy.mockRestore();
      }

      const second = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/no undo history/i);
    });
  });
  it("restores the previous undo record when the edit is aborted after the undo record is persisted", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const first = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toContain("Successfully replaced");

      const controller = new AbortController();
      const realSaveUndo = replaceUndoModule.saveUndo;
      const spy = vi
        .spyOn(replaceUndoModule, "saveUndo")
        .mockImplementationOnce(async (path, entry) => {
          const result = await realSaveUndo(path, entry);
          controller.abort();
          return result;
        });
      try {
        await expect(
          editTool.execute(
            "e2",
            {
              path: "sample.ts",
              remove_from: hashes[2]!, remove_to: hashes[2]!,
              replacement_lines: ["CCC"],
            },
            controller.signal,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("Operation aborted");
      } finally {
        spy.mockRestore();
      }

      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("aaa\nBBB\nccc\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(getText(undone)).toContain("Undone last change");
      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });
  it("second undo call returns error (undo clears after use)", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      const first = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(first.isError).toBeFalsy();

      const second = await undo.execute(
        "u2",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/no undo history/i);
    });
  });

  it("undo works after flat-mode replace", async () => {
    await withTempFile("sample.ts", "line1\nline2\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("line1\nline2\n", home.testPath);

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[0]!, remove_to: hashes[0]!,
          replacement_lines: ["LINE1"],
        },
        undefined,
        undefined,
        ctx,
      );

      const afterReplace = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(afterReplace).toBe("LINE1\nline2\n");

      const undoResult = await undo.execute(
        "u1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(undoResult.isError).toBeFalsy();

      const afterUndo = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(afterUndo).toBe("line1\nline2\n");
    });
  });

  it("refuses to undo when the file was modified after the edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      await writeFile(join(cwd, "sample.ts"), "aaa\nEXTERNAL\nccc\n", "utf-8");

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBe(true);
      expect(getText(undoResult)).toMatch(/E_UNDO_STALE/);
      expect(getText(undoResult)).toMatch(/modified after the edit/i);
      expect(getText(undoResult)).toMatch(/do not modify the file/i);
      expect(getText(undoResult)).toMatch(/do not revert your own edit/i);

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("aaa\nEXTERNAL\nccc\n");

      const second = await undo.execute("u2", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/E_UNDO_STALE/);

      await writeFile(join(cwd, "sample.ts"), "aaa\nBBB\nccc\n", "utf-8");

      const third = await undo.execute("u3", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(third.isError).toBeFalsy();
      expect(getText(third)).toMatch(/undone last change/i);
      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("refuses to undo when only line endings changed after the edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      await writeFile(join(cwd, "sample.ts"), "aaa\r\nBBB\r\nccc\r\n", "utf-8");

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBe(true);
      expect(getText(undoResult)).toMatch(/E_UNDO_STALE/);

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("aaa\r\nBBB\r\nccc\r\n");
    });
  });

  it("refuses to undo when only the BOM changed after the edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      await writeFile(join(cwd, "sample.ts"), "\uFEFFaaa\nBBB\nccc\n", "utf-8");

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBe(true);
      expect(getText(undoResult)).toMatch(/E_UNDO_STALE/);

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("\uFEFFaaa\nBBB\nccc\n");
    });
  });

  it("restores a file deleted after the edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      await rm(join(cwd, "sample.ts"));

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);
      expect(getText(undoResult)).toMatch(/deleted; restored/i);
      expect(getText(undoResult)).toMatch(/removed 1 line/i);
      expect(getText(undoResult)).toMatch(/restored 1 line/i);

      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");

      const diff = undoResult.details?.diff as string | undefined;
      expect(diff).toContain(`+${hashes[1]}│bbb`);
      const patch = undoResult.details?.patch as string | undefined;
      expect(patch).toContain("+bbb");

      const second = await undo.execute("u2", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/no undo history/i);
    });
  });

  it("restores an empty file deleted after a seeding edit", async () => {
    await withTempFile("sample.ts", "", async ({ cwd }) => {
      const { getTool, ctx, readTool } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const emptyHash = getText(readResult).split("\n")[0]!.split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: emptyHash, remove_to: emptyHash, replacement_lines: ["first", "second"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("first\nsecond");

      await rm(join(cwd, "sample.ts"));

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);
      expect(getText(undoResult)).toMatch(/deleted; restored/i);
      expect(getText(undoResult)).toMatch(/removed 2 line/i);
      expect(getText(undoResult)).toMatch(/restored 0 line/i);
      expect(await readFile(join(cwd, "sample.ts"), "utf-8")).toBe("");

      const second = await undo.execute("u2", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(second.isError).toBe(true);
      expect(getText(second)).toMatch(/no undo history/i);
    });
  });
});

function makePiWithToolResultCapture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  } as any;
  return { pi, handlers, tools };
}

describe("undo cleared after write", () => {
  it("a successful write clears the undo history for that path", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, handlers, tools } = makePiWithToolResultCapture();
      register(pi);
      const editTool = tools.get("replace")!;
      const undo = tools.get("undo_last_change")!;
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, { cwd } as any,
      );

      const handler = handlers.get("tool_result")!;
      await handler(
        { toolName: "write", toolCallId: "w1", input: { path: "sample.ts", content: "new\ncontent\n" }, content: [], details: undefined, isError: false },
        { cwd } as any,
      );

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, { cwd } as any);
      expect(undoResult.isError).toBe(true);
      expect(getText(undoResult)).toMatch(/no undo history/i);
    });
  });

  it("a failed write keeps the undo history", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, handlers, tools } = makePiWithToolResultCapture();
      register(pi);
      const editTool = tools.get("replace")!;
      const undo = tools.get("undo_last_change")!;
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        undefined, undefined, { cwd } as any,
      );

      const handler = handlers.get("tool_result")!;
      await handler(
        { toolName: "write", toolCallId: "w1", input: { path: "sample.ts" }, content: [], details: undefined, isError: true },
        { cwd } as any,
      );

      const undoResult = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, { cwd } as any);
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);
    });
  });

  it("caps the undo diff when the file contains a very long line", async () => {
    const long = "x".repeat(200 * 1024);
    await withTempFile("min.js", `a\n${long}\nb\n`, async ({ cwd }) => {
      const { getTool, ctx } = setupIntegrationTest(cwd);
      const editTool = getTool("replace");
      const undo = getTool("undo_last_change");
      const hashes = await lineHashes(`a\n${long}\nb\n`, home.testPath);

      await editTool.execute(
        "e1",
        { path: "min.js", remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["ALPHA"] },
        undefined, undefined, ctx,
      );

      const undoResult = await undo.execute("u1", { path: "min.js" }, undefined, undefined, ctx);
      expect(undoResult.isError).toBeFalsy();
      expect(getText(undoResult)).toMatch(/undone last change/i);
      expect(getText(undoResult)).toMatch(/Removed 1 line\(s\), restored 1 line\(s\)\./);
      const details = undoResult.details as { diff?: string; patch?: string; patchTruncated?: boolean };
      expect(details.diff).toBeDefined();
      expect(details.diff!).not.toContain(long);
      expect(Buffer.byteLength(details.diff!, "utf-8")).toBeLessThan(5 * 1024);
      expect(details.patchTruncated).toBe(true);
      expect(details.patch).toBeDefined();
      expect(details.patch!).not.toContain(long);
      expect(Buffer.byteLength(details.patch!, "utf-8")).toBeLessThan(5 * 1024);
    });
  });
});
