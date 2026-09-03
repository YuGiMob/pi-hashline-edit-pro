import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { MAX_BYTES } from "../../src/constants";
import { withTempFile, withTempBytes, setupIntegrationTest, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("file kind guards in tools", () => {
  it("edit decodes invalid utf-8 as replacement chars and writes them back as utf-8", async () => {
    const bytes = new Uint8Array([0xFF, 0x28, 0x0A, 0x69, 0x6E, 0x74, 0x0A]);
    await withTempBytes("bad-utf.ts", bytes, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "bad-utf.ts" }, undefined, undefined, ctx);
      expect(readResult.content[0].text).toContain("Non-UTF-8 bytes shown as U+FFFD");

      const firstText = readResult.content[0].text as string;
      const intRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│int"))!
        .split("│")[0]!;

      const result = await editTool.execute(
        "e1",
        {
          path: "bad-utf.ts",
          remove_from: intRef, remove_to: intRef, replacement_lines: ["long"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("edit rejects binary files with descriptive error", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
    await withTempBytes("image.png", bytes, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "image.png",
            remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["x"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/image/i);
    });
  });

  it("edit rejects UTF-16 encoded text to prevent corruption", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00, 0x0a, 0x00]);
    await withTempBytes("utf16.txt", bytes, async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "utf16.txt",
            remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["x"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/UTF-16LE/);
    });
  });

  it("edit rejects directories with descriptive error", async () => {
    const { withTempSubdir } = await import("../support/fixtures");
    await withTempSubdir("mydir", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "mydir",
            remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["x"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/directory/i);
    });
  });

  it("edit rejects empty file deletion", async () => {
    await withTempFile("empty.txt", "a\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\n", home.testPath);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "empty.txt",
            remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: [],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });
  it("read rejects files over the byte limit with E_FILE_TOO_LARGE", async () => {
    await withTempFile("huge.txt", "x", async ({ cwd, path }) => {
      const { truncate } = await import("fs/promises");
      await truncate(path, MAX_BYTES + 1);
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute("r1", { path: "huge.txt" }, undefined, undefined, ctx),
      ).rejects.toThrow(/E_FILE_TOO_LARGE/);
    });
  });
});
