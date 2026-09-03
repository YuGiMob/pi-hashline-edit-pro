import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { loadHashStore } from "../../src/hash-store";
import { getServed } from "../../src/served";
import { resolveTarget } from "../../src/fs-write";
import { toCwd } from "../../src/paths";
import { withTempFile, withTempBytes, setupIntegrationTest, useTestHome, getText, extractHash } from "../support/fixtures";

const home = useTestHome();

describe("replace tool - end-to-end", () => {
  it("reads a file and replaces a single line", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const betaHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaHash, remove_to: betaHash,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("replaces a range of lines", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: bHash, remove_to: cHash,
          replacement_lines: ["B", "C"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nB\nC\nddd\n");
    });
  });

  it("deletes a range", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: bHash, remove_to: cHash,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 0 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\n");
    });
  });

  it("stale anchor rejection after edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = getText(firstRead);
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          remove_from: betaRef, remove_to: betaRef,
          replacement_lines: ["BBB"],
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
            remove_from: betaRef, remove_to: betaRef,
            replacement_lines: ["BBB-AGAIN"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);
    });
  });

  it("seeds content into an empty file", async () => {
    await withTempFile("empty.ts", "", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "empty.ts" }, undefined, undefined, ctx);
      const emptyHash = getText(readResult).split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[A-Za-z0-9]{4}$/);

      await editTool.execute(
        "e1",
        {
          path: "empty.ts",
          remove_from: emptyHash, remove_to: emptyHash,
          replacement_lines: ["first", "second"],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("first\nsecond");
    });
  });

  it("preserves CRLF line endings after edit", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "crlf.ts" }, undefined, undefined, ctx);
      const betaRef = getText(readResult)
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "crlf.ts",
          remove_from: betaRef, remove_to: betaRef,
          replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(content).toContain("\r\n");
    });
  });

  it("preserves lone-CR line endings after edit", async () => {
    await withTempBytes("cr.ts", Buffer.from("alpha\rbeta\rgamma\r"), async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "cr.ts" }, undefined, undefined, ctx);
      const betaRef = getText(readResult)
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "cr.ts",
          remove_from: betaRef, remove_to: betaRef,
          replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\rBETA\rgamma\r");
    });
  });

  describe("replace tool - line-ending matrix", () => {
    const cases = [
      {
        name: "LF",
        fileName: "lf.txt",
        bytes: Buffer.from("alpha\nbeta\ngamma\n"),
        afterDelete: "alpha\ngamma\n",
      },
      {
        name: "CRLF",
        fileName: "crlf.txt",
        bytes: Buffer.from("alpha\r\nbeta\r\ngamma\r\n"),
        afterDelete: "alpha\r\ngamma\r\n",
      },
      {
        name: "CR",
        fileName: "cr.txt",
        bytes: Buffer.from("alpha\rbeta\rgamma\r"),
        afterDelete: "alpha\rgamma\r",
      },
    ];

    for (const c of cases) {
      it(`${c.name}: delete middle line preserves the ending`, async () => {
        await withTempBytes(c.fileName, c.bytes, async ({ cwd, path }) => {
          const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
          const readResult = await readTool.execute("r1", { path: c.fileName }, undefined, undefined, ctx);
          const betaRef = getText(readResult)
            .split("\n")
            .find((line: string) => line.includes("│beta"))!
            .split("│")[0]!;
          await editTool.execute(
            "e1",
            { path: c.fileName, remove_from: betaRef, remove_to: betaRef, replacement_lines: [] },
            undefined,
            undefined,
            ctx,
          );
          const content = await readFile(path, "utf-8");
          expect(content).toBe(c.afterDelete);
        });
      });

      it(`${c.name}: noop edit keeps the file byte-identical`, async () => {
        await withTempBytes(c.fileName, c.bytes, async ({ cwd, path }) => {
          const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
          const readResult = await readTool.execute("r1", { path: c.fileName }, undefined, undefined, ctx);
          const betaRef = getText(readResult)
            .split("\n")
            .find((line: string) => line.includes("│beta"))!
            .split("│")[0]!;
          await editTool.execute(
            "e1",
            { path: c.fileName, remove_from: betaRef, remove_to: betaRef, replacement_lines: ["beta"] },
            undefined,
            undefined,
            ctx,
          );
          const content = await readFile(path, "utf-8");
          expect(content).toBe(c.bytes.toString("utf-8"));
        });
      });
    }
  });
  it("accepts top-level remove_from/remove_to and replacement_lines", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const editResult = await editTool.execute(
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

      expect(editResult.content[0].text).toContain("Successfully replaced");
      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("returns a standard unified patch in details that applies cleanly", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);

      const editResult = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined, undefined, ctx,
      );

      const details = editResult.details as { patch?: string };
      expect(details.patch).toBeDefined();
      expect(details.patch!).toContain("--- sample.ts");
      expect(details.patch!).toContain("+++ sample.ts");
      expect(details.patch!).toContain("-bbb");
      expect(details.patch!).toContain("+BBB");
      const { applyPatch } = await import("diff");
      expect(applyPatch("aaa\nbbb\nccc\n", details.patch!)).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("caps the post-edit diff when the file contains a very long line", async () => {
    const long = "x".repeat(200 * 1024);
    await withTempFile("min.js", `a\n${long}\nb\n`, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "min.js" }, undefined, undefined, ctx);
      const aHash = extractHash(getText(readResult).split("\n").find((l: string) => l.includes("│a"))!);

      const editResult = await editTool.execute(
        "e1",
        { path: "min.js", remove_from: aHash, remove_to: aHash, replacement_lines: ["ALPHA"] },
        undefined, undefined, ctx,
      );
      const details = editResult.details as { diff?: string; patch?: string; patchTruncated?: boolean };
      expect(details.diff).toBeDefined();
      expect(details.diff!).not.toContain(long);
      expect(details.diff!).not.toContain("row(s) exceed");
      expect(Buffer.byteLength(details.diff!, "utf-8")).toBeLessThan(5 * 1024);
      const markerRow = details.diff!.split("\n").find((l) => l.includes("│[Row is"))!;
      expect(markerRow).toMatch(/^ [A-Za-z0-9]{4}│\[Row is/);
      const served = getServed(await loadHashStore(), await resolveTarget(toCwd("min.js", cwd)));
      expect(served?.has(markerRow.match(/^ ([A-Za-z0-9]{4})│/)![1]!)).toBe(true);
      expect(details.patchTruncated).toBe(true);
      expect(details.patch).toBeDefined();
      expect(details.patch!).not.toContain(long);
      expect(Buffer.byteLength(details.patch!, "utf-8")).toBeLessThan(5 * 1024);
    });
  });

  it("lets a replace target an oversized line via its read-marker anchor", async () => {
    const long = "x".repeat(210_000);
    await withTempFile("min.js", `a\n${long}\nb\n`, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "min.js" }, undefined, undefined, ctx);
      const text = getText(readResult);
      const markerRow = text.split("\n").find((l) => l.includes("[Line 2 is"))!;
      expect(markerRow).toMatch(/^[A-Za-z0-9]{4}│\[Line 2 is/);
      const markerHash = markerRow.split("│")[0]!;
      const editResult = await editTool.execute(
        "e1",
        { path: "min.js", remove_from: markerHash, remove_to: markerHash, replacement_lines: ["REPLACED"] },
        undefined, undefined, ctx,
      );
      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nREPLACED\nb\n");
    });
  });
});
