import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome, getText, extractHash, toolError } from "../support/fixtures";

useTestHome();

describe("regReplace", () => {
  it("rejects malformed null lines during direct execute without modifying the file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", join(cwd, "sample.ts"));

      expect(await toolError(() => editTool.execute(
        "e1",
        {
          remove_from: hashes[0]!, remove_to: hashes[0]!, text: null,
        },
        undefined,
        undefined,
        ctx,
      ))).toBeTruthy();
    });
  });

  it("accepts multi-line text as an array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[0]!, remove_to: hashes[0]!,
          text: ["a", "b"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, text: ["BBB"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, text: [`${hashes[1]!}│BBB`],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, text: [`+${hashes[1]!}│BBB`],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[2]!, remove_to: hashes[1]!, text: ["X"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 2 line(s).");
      expect(result.details?.metrics?.warnings).toBe(0);
      expect(result.details?.hints?.[0]).toContain("[H_RANGE_REVERSED]");
      expect(result.details?.diff).toContain("X");
    });
  });

  it("autocorrects HASH│ rows in remove_from/remove_to with a warning", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await editTool.execute(
        "e1",
        {
          remove_from: `${hashes[1]!}│bbb`, remove_to: `${hashes[1]!}│bbb`,
          text: ["BBB"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      const fileReader = await import("../../src/file-reader");
      const spy = vi
        .spyOn(fileReader, "safeSnapId")
        .mockResolvedValue(undefined);
      try {
        const result = await editTool.execute(
          "e1",
          {
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            text: ["BBB"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      const fileReader = await import("../../src/file-reader");
      const spy = vi
        .spyOn(fileReader, "safeSnapId")
        .mockResolvedValue(undefined);
      try {
        const result = await editTool.execute(
          "e1",
          {
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            text: ["bbb"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
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
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            text: ["BBB"],
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
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      const hashStore = await import("../../src/hash-store");
      const spy = vi
        .spyOn(hashStore, "upsertUndo")
        .mockImplementation(() => {
          throw new Error("store down");
        });
      try {
        expect(await toolError(() => editTool.execute(
          "e1",
          {
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            text: ["BBB"],
          },
          undefined,
          undefined,
          ctx,
        ))).toMatch(/E_UNDO_UNAVAILABLE/);
      } finally {
        spy.mockRestore();
      }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nbbb\nccc\n");
    });
  });
});

describe("replace literal escape hints", () => {
  it("hints and writes the literal escaped text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool, getTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, text: [String.raw`stable\u200bCheckout`] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain(String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`);
      const hint = result.details.hints?.[0] ?? "";
      expect(hint).toContain(String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`);
      expect(hint).toContain("col 7");
      expect(result.details.metrics?.warnings).toBe(0);
      expect(await readFile(path, "utf-8")).toBe("aaa\nstable\\u200bCheckout\nccc\n");
      const writtenAnchor = hint.match(/([a-z]{5})│ col/)?.[1];
      expect(writtenAnchor).toMatch(/^[a-z]{5}$/);
      const within = await getTool("replace_match").execute(
        "e2",
        { replace_from: writtenAnchor!, replace_to: writtenAnchor!, match: String.raw`\u200b`, replacement: "\u200b", allowEmbeddedMatch: true },
        undefined,
        undefined,
        ctx,
      );
      expect(within.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("aaa\nstable\u200bCheckout\nccc\n");
    });
  });
});

describe("edit fidelity hints", () => {
  it("hints when the replacement drops an invisible character", async () => {
    await withTempFile("sample.ts", "alpha\nlegacy\u200bCheckout\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nlegacy\u200bCheckout\n", join(cwd, "sample.ts"));
      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, text: ["stableCheckout"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("[H_UNICODE_LOST]");
      expect(result.details.hints).toContainEqual(expect.stringContaining(String.raw`\u200b`));
      expect(result.details.metrics?.warnings).toBe(0);
      expect(await readFile(path, "utf-8")).toBe("alpha\nstableCheckout\n");
    });
  });

  it("does not hint on a plain ASCII edit", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("sample.ts", content, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes(content, join(cwd, "sample.ts"));
      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, text: ["BBB"] },
        undefined, undefined, ctx,
      );
      expect(result.details.hints).toBeUndefined();
    });
  });
});

describe("provided line endings", () => {
  it("writes a CRLF separator embedded in text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, text: ["B1\r\nB2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nB1\r\nB2\nccc\n");
    });
  });

  it("writes a provided CR separator", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.ts"));
      await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, text: ["B1\rB2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nB1\rB2\nccc\n");
    });
  });
});

describe("replace deletion keeps block separators", () => {
  it("keeps a trailing separator blank included in the deleted range", async () => {
    await withTempFile("sample.ts", "aaa\n\nbbb\n\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const rows = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx)).split("\n");
      const bbbIndex = rows.findIndex((row) => row.includes("│bbb"));
      const bbb = extractHash(rows[bbbIndex]!);
      const blankAfter = extractHash(rows[bbbIndex + 1]!);
      const result = await editTool.execute("e1", { remove_from: bbb, remove_to: blankAfter, text: [] }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("Added 0 line(s), removed 1 line(s).");
      expect(await readFile(path, "utf-8")).toBe("aaa\n\n\nccc\n");
    });
  });

  it("keeps a leading separator blank included in the deleted range", async () => {
    await withTempFile("sample.ts", "aaa\n\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const rows = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx)).split("\n");
      const bbbIndex = rows.findIndex((row) => row.includes("│bbb"));
      const blankBefore = extractHash(rows[bbbIndex - 1]!);
      const bbb = extractHash(rows[bbbIndex]!);
      await editTool.execute("e1", { remove_from: blankBefore, remove_to: bbb, text: [] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\n\nccc\n");
    });
  });

  it("still deletes a blank line when the range is blank", async () => {
    await withTempFile("sample.ts", "aaa\n\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const rows = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx)).split("\n");
      const blank = extractHash(rows[1]!);
      await editTool.execute("e1", { remove_from: blank, remove_to: blank, text: [] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nccc\n");
    });
  });

  it("keeps separator blanks on both edges of a deleted range", async () => {
    await withTempFile("sample.ts", "aaa\n\nbbb\n\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const rows = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx)).split("\n");
      const bbbIndex = rows.findIndex((row) => row.includes("│bbb"));
      const blankBefore = extractHash(rows[bbbIndex - 1]!);
      const blankAfter = extractHash(rows[bbbIndex + 1]!);
      await editTool.execute("e1", { remove_from: blankBefore, remove_to: blankAfter, text: [] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\n\n\nccc\n");
    });
  });

  it("does not keep boundary blanks when the replacement is not empty", async () => {
    await withTempFile("sample.ts", "aaa\n\nbbb\n\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const rows = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx)).split("\n");
      const bbbIndex = rows.findIndex((row) => row.includes("│bbb"));
      const blankBefore = extractHash(rows[bbbIndex - 1]!);
      const blankAfter = extractHash(rows[bbbIndex + 1]!);
      await editTool.execute("e1", { remove_from: blankBefore, remove_to: blankAfter, text: ["X"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nX\nccc\n");
    });
  });
});
