import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("regReplace", () => {
  it("rejects malformed null lines during direct execute without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", home.testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: null,
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  it("accepts multi-line replacement_lines as an array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[0]!, remove_to: hashes[0]!,
          replacement_lines: ["a", "b"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nbbb\n");
    });
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      expect(result.details?.diff).toBeDefined();
      expect(result.details?.diff).toContain("BBB");
    });
  });

  it("autocorrects bare HASH│ prefix in content_lines with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: [`${hashes[1]!}│BBB`],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain(`Stripped "anchor│" prefix`);
      expect(result.details?.diff).toContain("BBB");
      expect(result.details?.diff).not.toContain(`${hashes[1]}│BBB`);
    });
  });

  it("autocorrects diff-preview rows in content_lines with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: [`+${hashes[1]!}│BBB`],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain(`Stripped diff-preview marker`);
      expect(result.details?.diff).toContain("BBB");
      expect(result.details?.diff).not.toContain(`+${hashes[1]}│BBB`);
    });
  });

  it("autocorrects reversed remove_from/remove_to with correct line counts", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: hashes[2]!, remove_to: hashes[1]!, replacement_lines: ["X"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 2 line(s).");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain("were reversed");
      expect(result.details?.diff).toContain("X");
    });
  });

  it("autocorrects HASH│ rows in remove_from/remove_to with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: `${hashes[1]!}│bbb`, remove_to: `${hashes[1]!}│bbb`,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain(`Stripped "anchor│" prefix`);
      expect(result.details?.diff).toContain("BBB");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });
});

describe("regReplace - robustness", () => {
  it("reports success even when the post-edit snapshot fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const fileReader = await import("../../src/file-reader");
      const spy = vi
        .spyOn(fileReader, "safeSnapId")
        .mockResolvedValue(undefined);
      try {
        const result = await editTool.execute(
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
        expect(result.content[0].text).toContain("Successfully replaced");
        expect(result.details?.snapshotId).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("reports success even when the noop-path snapshot fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const fileReader = await import("../../src/file-reader");
      const spy = vi
        .spyOn(fileReader, "safeSnapId")
        .mockResolvedValue(undefined);
      try {
        const result = await editTool.execute(
          "e1",
          {
            path: "sample.ts",
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            replacement_lines: ["bbb"],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.content[0].text).toContain("No changes made");
        expect(result.details?.classification).toBe("noop");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("applies the edit even when snapshot persistence fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const hashStore = await import("../../src/hash-store");
      const spy = vi
        .spyOn(hashStore, "upsertSnapshot")
        .mockImplementation(() => {
          throw new Error("store down");
        });
      try {
        const result = await editTool.execute(
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
        expect(result.content[0].text).toContain("Successfully replaced");
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("still refuses the edit when undo persistence fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const hashStore = await import("../../src/hash-store");
      const spy = vi
        .spyOn(hashStore, "upsertUndo")
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
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");
    });
  });
});
