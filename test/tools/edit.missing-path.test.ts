import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { withTempFile, withTempDir, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("replace - missing path resolution", () => {
  it("resolves a missing path when the anchors uniquely identify a file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\n", path);

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["ATIm"] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain('[W_BAD_SHAPE] Missing "path" resolved to');
      expect(await readFile(path, "utf-8")).toBe("ATIm\nbbb\n");
    });
  });

  it("resolves a missing path from served records after a grep", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("anchor_grep");
      const editTool = getTool("replace");

      const grepResult = await grepTool.execute(
        "g1",
        { pattern: "bbb", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      const betaHash = extractHash(getText(grepResult).split("\n").find((l) => l.includes("│bbb"))!);

      const result = await editTool.execute(
        "e1",
        { remove_from: betaHash, remove_to: betaHash, replacement_lines: ["BeSR"] },
        undefined, undefined, ctx,
      );

      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain('Missing "path" resolved to');
      expect(await readFile(path, "utf-8")).toBe("aaa\nBeSR\n");
    });
  });

  it("picks the most recent file when the anchors match multiple files", async () => {
    await withTempDir("ambig-", async (dir) => {
      const { ctx, editTool } = setupIntegrationTest(dir);
      const first = join(dir, "a.txt");
      const second = join(dir, "b.txt");
      await writeFile(first, "same\n", "utf-8");
      await writeFile(second, "same\n", "utf-8");
      const hashes = await lineHashes("same\n", first);
      await lineHashes("same\n", second);

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["X"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(result.content[0].text).toContain('Missing "path" resolved to');
      expect(result.content[0].text).toContain("picked most recent of 2");
      expect(await readFile(second, "utf-8")).toBe("X\n");
      expect(await readFile(first, "utf-8")).toBe("same\n");
    });
  });

  it("rejects a missing path when the anchors match no file", async () => {
    await withTempFile("sample.ts", "aaa\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);

      await expect(
        editTool.execute(
          "e1",
          { remove_from: "ATIm", remove_to: "ATIm", replacement_lines: ["X"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/requires a non-empty "path"/);
    });
  });

  it("keeps the resolved path in the post-edit diff", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BeSR"] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details?.diff).toContain("BeSR");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBeSR\nccc\n");
    });
  });
});

describe("insert - missing path resolution", () => {
  it("resolves a missing path when the anchor uniquely identifies a file", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const hashes = await lineHashes("aaa\nbbb\n", path);
      const result = await insertTool.execute("e1", { anchor: hashes[0]!, direction: "after", lines: ["NEW"] }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("Successfully inserted");
      expect(result.content[0].text).toContain('Missing "path" resolved to');
      expect(await readFile(path, "utf-8")).toBe("aaa\nNEW\nbbb\n");
    });
  });

  it("returns undefined for early-return shapes", async () => {
    const { resolveReplacePath, resolveInsertPath, resolvePathFromHashes } = await import("../../src/missing-path");
    await expect(resolveReplacePath({ path: "x" })).resolves.toBeUndefined();
    await expect(resolveReplacePath({})).resolves.toBeUndefined();
    await expect(resolveReplacePath({ remove_from: "!!!", remove_to: "!!!" })).resolves.toBeUndefined();
    await expect(resolveInsertPath({ path: "x" })).resolves.toBeUndefined();
    await expect(resolveInsertPath({})).resolves.toBeUndefined();
    await expect(resolveInsertPath({ anchor: "!!!" })).resolves.toBeUndefined();
    await expect(resolvePathFromHashes(["ZZZZ"])).resolves.toBeUndefined();
  });

  it("caps the candidate list at 3 paths", async () => {
    const { resolvePathFromHashes } = await import("../../src/missing-path");
    const { withTempDir } = await import("../support/fixtures");
    await withTempDir("many-", async (dir) => {
      const { join } = await import("path");
      const { writeFile } = await import("fs/promises");
      const paths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = join(dir, `f${i}.txt`);
        await writeFile(p, "same\n", "utf-8");
        paths.push(p);
      }
      const { lineHashes } = await import("../../src/hashline");
      const hashes = await lineHashes("same\n", paths[0]!);
      for (let i = 1; i < paths.length; i++) await lineHashes("same\n", paths[i]!);
      const resolved = await resolvePathFromHashes([hashes[0]!]);
      expect(resolved?.warning).toContain("picked most recent of 5");
      expect(resolved?.warning).toContain("(+2 more)");
    });
  });

  it("falls back to stored activity when the session has no touches", async () => {
    await withTempFile("sample.ts", "aaa\n", async ({ cwd, path }) => {
      const hashes = await lineHashes("aaa\n", path);
      const { clearSession } = await import("../../src/hash-store/cache");
      const { loadHashStore, pathActivity, pickRecentPath } = await import("../../src/hash-store");
      clearSession();
      const store = await loadHashStore();
      expect(pathActivity(store, path)).toBeGreaterThanOrEqual(0);
      expect(pickRecentPath(store, [path])).toBe(path);
      expect(hashes.length).toBeGreaterThan(0);
      expect(cwd.length).toBeGreaterThan(0);
    });
  });
});
