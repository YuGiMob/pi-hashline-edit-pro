import { describe, expect, it } from "vitest";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { loadHashStore, getSnapshot } from "../../src/hash-store";
import { getServed } from "../../src/served";
import { resolveTarget } from "../../src/fs-write";
import { toCwd } from "../../src/paths";
import { withTempFile, withTempDir, makeFakePiRegistry, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import register from "../../index";

describe("grep tool", () => {
  it("registers a tool named grep", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("grep");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("grep");
  });

  it("returns matching lines with the same anchors as read", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const readHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      const result = await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("=== sample.ts ===");
      expect(text).toContain("│beta");
      const grepHash = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);
      expect(grepHash).toBe(readHash);
    });
  });

  it("serves grep anchors so a replace edits immediately", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const editTool = getTool("replace");

      const result = await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      const betaHash = extractHash(getText(result).split("\n").find((l) => l.includes("│beta"))!);

      const edit = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: betaHash, remove_to: betaHash, replacement_lines: ["BETA"] },
        undefined, undefined, ctx,
      );
      expect(edit.content[0].text).toContain("Successfully replaced");
      expect(await import("fs/promises").then((m) => m.readFile(path, "utf-8"))).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("does not persist hash snapshots while searching", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts" },
        undefined, undefined, ctx,
      );

      const store = await loadHashStore();
      const resolved = await resolveTarget(toCwd("sample.ts", cwd));
      expect(getSnapshot(store, resolved, "alpha\nbeta\n")).toBeUndefined();
      expect(getServed(store, resolved)?.size).toBeGreaterThan(0);
    });
  });

  it("includes context lines with anchors", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      const result = await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts", context: 1 },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("│alpha");
      expect(text).toContain("│beta");
      expect(text).toContain("│gamma");
      expect(text).not.toContain("│delta");
    });
  });

  it("matches regex patterns by default and literals with literal", async () => {
    await withTempFile("sample.ts", "axb\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      const regexResult = await grepTool.execute(
        "g1",
        { pattern: "a.b", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      expect(getText(regexResult)).toContain("│axb");

      const literalResult = await grepTool.execute(
        "g2",
        { pattern: "a.b", path: "sample.ts", literal: true },
        undefined, undefined, ctx,
      );
      expect(getText(literalResult)).toBe("No matches found.");
    });
  });

  it("rejects nested quantified regexes before scanning files", async () => {
    await withTempFile("sample.ts", `${"a".repeat(10_000)}!\n`, async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      await expect(
        grepTool.execute(
          "g1",
          { pattern: "(a+)+$", path: "sample.ts" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("[E_UNSAFE_REGEX]");
    });
  });

  it("rejects regex backreferences but permits the same text literally", async () => {
    await withTempFile("sample.ts", "(a+)\\1\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      await expect(
        grepTool.execute(
          "g1",
          { pattern: "(a+)\\1", path: "sample.ts" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("[E_UNSAFE_REGEX]");

      const literalResult = await grepTool.execute(
        "g2",
        { pattern: "(a+)\\1", path: "sample.ts", literal: true },
        undefined, undefined, ctx,
      );
      expect(getText(literalResult)).toContain("│(a+)\\1");
    });
  });

  it("rejects multiple variable quantifiers that can cause polynomial backtracking", async () => {
    await withTempFile("sample.ts", "aaaa!\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      await expect(
        grepTool.execute(
          "g1",
          { pattern: "a*a*a*b", path: "sample.ts" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("[E_UNSAFE_REGEX]");
    });
  });

  it("supports case-insensitive search", async () => {
    await withTempFile("sample.ts", "ALPHA\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      const result = await grepTool.execute(
        "g1",
        { pattern: "alpha", path: "sample.ts", ignoreCase: true },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("│ALPHA");
    });
  });

  it("searches a directory recursively and skips node_modules", async () => {
    await withTempDir("grep-dir-", async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "needle in src\n", "utf-8");
      await writeFile(join(dir, "node_modules", "pkg", "b.ts"), "needle in node_modules\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("=== src/a.ts ===");
      expect(text).toContain("│needle in src");
      expect(text).not.toContain("node_modules");
    });
  });

  it("skips binary files silently", async () => {
    await withTempDir("grep-bin-", async (dir) => {
      await writeFile(join(dir, "a.txt"), "needle here\n", "utf-8");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      await writeFile(join(dir, "img.png"), png);

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("│needle here");
      expect(text).not.toContain("img.png");
    });
  });

  it("caps matches at the limit with a hint", async () => {
    await withTempFile("sample.ts", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");

      const result = await grepTool.execute(
        "g1",
        { pattern: "^line", path: "sample.ts", limit: 5 },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("showing first 5 matches");
      const rows = text.split("\n").filter((l) => /[A-Za-z0-9]{3}│/.test(l));
      expect(rows).toHaveLength(5);
    });
  });

  it("filters by glob", async () => {
    await withTempDir("grep-glob-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", glob: "*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("a.ts");
      expect(text).not.toContain("b.txt");
    });
  });

  it("glob * matches files in subdirectories", async () => {
    await withTempDir("grep-glob-deep-", async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "top.spec.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", glob: "*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("src/a.ts");
      expect(text).toContain("top.spec.ts");
    });
  });

  it("matches glob against the search root when path is a subdirectory", async () => {
    await withTempDir("grep-glob-root-", async (dir) => {
      await mkdir(join(dir, "lib", "deep"), { recursive: true });
      await writeFile(join(dir, "lib", "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "lib", "deep", "b.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "c.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", path: "lib", glob: "*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("lib/a.ts");
      expect(text).toContain("lib/deep/b.ts");
      expect(text).not.toContain("c.ts");
    });
  });

  it("matches a glob with a leading slash", async () => {
    await withTempDir("grep-glob-slash-", async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", glob: "/src/*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("src/a.ts");
      expect(text).not.toContain("b.ts");
    });
  });

  it("matches a leading-slash glob when path is a subdirectory", async () => {
    await withTempDir("grep-glob-slash-root-", async (dir) => {
      await mkdir(join(dir, "src", "auth"), { recursive: true });
      await writeFile(join(dir, "src", "auth", "login.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "src", "other.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", path: "src", glob: "/src/*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("src/auth/login.ts");
      expect(text).toContain("src/other.ts");
    });
  });

  it("matches a cwd-relative glob when path is a subdirectory", async () => {
    await withTempDir("grep-glob-cwd-", async (dir) => {
      await mkdir(join(dir, "lib", "deep"), { recursive: true });
      await writeFile(join(dir, "lib", "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "lib", "deep", "b.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", path: "lib", glob: "lib/*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("lib/a.ts");
      expect(text).toContain("lib/deep/b.ts");
    });
  });

  it("prefers the search-root-relative glob when both match", async () => {
    await withTempDir("grep-glob-root-first-", async (dir) => {
      await mkdir(join(dir, "lib", "deep"), { recursive: true });
      await writeFile(join(dir, "lib", "deep", "b.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", path: "lib", glob: "deep/*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("lib/deep/b.ts");
    });
  });

  it("matches **/*.ts across directories", async () => {
    await withTempDir("grep-glob-dstar-", async (dir) => {
      await mkdir(join(dir, "src", "deep"), { recursive: true });
      await writeFile(join(dir, "src", "deep", "a.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "top.spec.ts"), "needle\n", "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle", glob: "**/*.ts" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("src/deep/a.ts");
      expect(text).toContain("top.spec.ts");
    });
  });

  it("skips a line-oversized file in a directory scan", async () => {
    await withTempDir("grep-big-", async (dir) => {
      await writeFile(join(dir, "small.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "huge.ts"), Array.from({ length: 240000 }, (_, i) => `line ${i}`).join("\n"), "utf-8");

      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "needle" },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("small.ts");
      expect(text).toContain("│needle");
      expect(text).not.toContain("huge.ts");
      expect(text).not.toContain("E_FILE_TOO_LARGE");
    });
  });

  it("labels a 2000-row output as a row cut, not as a match-limit cut", async () => {
    await withTempDir("grep-rows-", async (dir) => {
      const lines = Array.from({ length: 2500 }, (_, i) => (i % 3 === 0 ? "m" : "s"));
      await writeFile(join(dir, "many.txt"), lines.join("\n") + "\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "m", path: "many.txt", context: 2, limit: 1000 },
        undefined, undefined, ctx,
      );
      const text = getText(result);
      expect(text).toContain("output truncated at 2000 rows");
      expect(text).not.toContain("showing first");
    });
  });

  it("reports no matches", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { pattern: "zzz", path: "sample.ts" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toBe("No matches found.");
      expect((result.details as { metrics: { matches: number } }).metrics.matches).toBe(0);
    });
  });

  it("rejects an invalid pattern", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      await expect(
        grepTool.execute(
          "g1",
          { pattern: "(", path: "sample.ts" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_BAD_SHAPE/);
    });
  });

  it("rejects a missing path", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      await expect(
        grepTool.execute(
          "g1",
          { pattern: "alpha", path: "missing.ts" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_NOT_FOUND/);
    });
  });

  it("supports the file_path alias", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute(
        "g1",
        { file_path: "sample.ts", pattern: "alpha" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("│alpha");
    });
  });

  it("shows a fragment around the match for an oversized line and keeps the line editable", async () => {
    const longLine = "const x = '" + "a".repeat(10000) + "';";
    await withTempFile("min.js", longLine + "\n", async ({ cwd, path }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const editTool = getTool("replace");
      const result = await grepTool.execute("g1", { pattern: "const x", path: "min.js" }, undefined, undefined, ctx);
      const text = getText(result);
      expect(text).toContain("=== min.js ===");
      const row = text.split("\n").find((l) => l.includes("│const x = 'aaaa"))!;
      expect(row).toContain("...");
      expect(Buffer.byteLength(row, "utf-8")).toBeLessThanOrEqual(510);
      expect(text).toContain("truncated fragments");
      expect(text).not.toContain("a".repeat(10000));
      const grepHash = extractHash(row);
      const store = await loadHashStore();
      const served = getServed(store, await resolveTarget(toCwd("min.js", cwd)));
      expect(served?.has(grepHash)).toBe(true);
      const edit = await editTool.execute(
        "e1",
        { path: "min.js", remove_from: grepHash, remove_to: grepHash, replacement_lines: ["REPLACED"] },
        undefined, undefined, ctx,
      );
      expect(edit.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("REPLACED\n");
    });
  });

  it("shows a fragment for a match inside a line over 50KB", async () => {
    const big = "a".repeat(60_000) + "NEEDLE" + "b".repeat(60_000);
    await withTempFile("bigline.txt", big + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "NEEDLE", path: "bigline.txt" }, undefined, undefined, ctx);
      const text = getText(result);
      const row = text.split("\n").find((l) => /[A-Za-z0-9]{3}│/.test(l))!;
      expect(row).toContain("NEEDLE");
      expect(row).toContain("...");
      expect(Buffer.byteLength(row, "utf-8")).toBeLessThanOrEqual(510);
      expect(text).not.toContain("a".repeat(60_000));
      expect(text).toContain("truncated fragments");
    });
  });

  it("enforces a total byte budget across rows", async () => {
    const lines = Array.from({ length: 700 }, (_, i) => `line ${i} ` + "x".repeat(90));
    await withTempFile("wide.txt", lines.join("\n") + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "^line", path: "wide.txt", limit: 1000 }, undefined, undefined, ctx);
      const text = getText(result);
      expect(text).toContain("output truncated at 2000 rows or 50.0KB");
      const rows = text.split("\n").filter((l) => /[A-Za-z0-9]{3}│/.test(l));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(700);
      expect(Buffer.byteLength(rows.join("\n"), "utf-8")).toBeLessThanOrEqual(50 * 1024);
      expect((result.details as { metrics: { truncated: boolean } }).metrics.truncated).toBe(true);
      const served = getServed(await loadHashStore(), await resolveTarget(toCwd("wide.txt", cwd)));
      expect(served?.size).toBe(rows.length);
    });
  });

  it("fragments a multi-megabyte context line without pathological slowdown", async () => {
    const huge = "y".repeat(2 * 1024 * 1024);
    await withTempFile("huge.txt", `needle\n${huge}\n`, async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const started = Date.now();
      const result = await grepTool.execute("g1", { pattern: "needle", path: "huge.txt", context: 1 }, undefined, undefined, ctx);
      expect(Date.now() - started).toBeLessThan(5000);
      const text = getText(result);
      expect(text).toContain("│needle");
      expect(text).toContain("...");
      expect(text).not.toContain("y".repeat(1000));
    });
  });

  it("fragments a match that itself spans megabytes without pathological slowdown", async () => {
    const huge = "z".repeat(2 * 1024 * 1024);
    await withTempFile("huge2.txt", `${huge}\n`, async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const started = Date.now();
      const result = await grepTool.execute("g1", { pattern: "z", path: "huge2.txt" }, undefined, undefined, ctx);
      expect(Date.now() - started).toBeLessThan(5000);
      const text = getText(result);
      expect(text).toContain("truncated fragments");
      expect(text).not.toContain("z".repeat(1000));
    });
  });
  it("rejects huge quantifiers that would cause pathological backtracking", async () => {
    await withTempFile("huge2.txt", "z\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      await expect(grepTool.execute("g1", { pattern: "z{1000000}", path: "huge2.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_UNSAFE_REGEX]");
    });
  });

  it("fragments an emoji-heavy line without splitting surrogate pairs", async () => {
    const line = "😀".repeat(300) + "needleX";
    await withTempFile("emoji.txt", line + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "needleX", path: "emoji.txt" }, undefined, undefined, ctx);
      const row = getText(result).split("\n").find((l) => /[A-Za-z0-9]{3}│/.test(l))!;
      expect(row.isWellFormed()).toBe(true);
      expect(row).toContain("...");
      expect(Buffer.byteLength(row, "utf-8")).toBeLessThanOrEqual(510);
    });
  });

  it("counts only shown fragments in the truncation note", async () => {
    const lines = Array.from({ length: 300 }, () => "x".repeat(600));
    await withTempFile("many.txt", lines.join("\n") + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "x{600}", path: "many.txt", limit: 1000 }, undefined, undefined, ctx);
      const text = getText(result);
      const rowsShown = text.split("\n").filter((l) => /[A-Za-z0-9]{3}│/.test(l)).length;
      const note = text.match(/grep: (\d+) line\(s\) exceed 500B/);
      expect(note).not.toBeNull();
      expect(Number(note![1]!)).toBe(rowsShown);
      expect(Number(note![1]!)).toBeLessThan(300);
      const details = result.details as { truncation: { totalLines: number }; metrics: { matches: number } };
      expect(details.truncation.totalLines).toBe(300);
      expect(details.metrics.matches).toBe(300);
    });
  });

  it("counts rows from files after the byte-budget cutoff", async () => {
    const a = Array.from({ length: 200 }, () => "x".repeat(600)).join("\n") + "\n";
    const b = Array.from({ length: 100 }, () => "x".repeat(600)).join("\n") + "\n";
    await withTempDir("grep-totals-", async (dir) => {
      await writeFile(join(dir, "a.txt"), a, "utf-8");
      await writeFile(join(dir, "b.txt"), b, "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "x{600}", limit: 1000 }, undefined, undefined, ctx);
      const details = result.details as { truncation: { totalLines: number; totalBytes: number }; metrics: { matches: number } };
      expect(details.truncation.totalLines).toBe(300);
      expect(details.truncation.totalBytes).toBe(300 * 503);
      expect(details.metrics.matches).toBe(300);
    });
  });

  it("keeps every fragment row within the 500-byte budget", async () => {
    const line = "a".repeat(300) + "NEEDLE1234" + "b".repeat(300);
    await withTempFile("wide2.txt", line + "\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "NEEDLE1234", path: "wide2.txt" }, undefined, undefined, ctx);
      const rows = getText(result).split("\n").filter((l) => /[A-Za-z0-9]{3}│/.test(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toContain("NEEDLE1234");
      expect(rows[0]!).toContain("...");
      expect(Buffer.byteLength(rows[0]!, "utf-8")).toBeLessThanOrEqual(510);
    });
  });

  it("keeps context head fragments within the 500-byte budget", async () => {
    const wide = "c".repeat(1000);
    await withTempFile("wide3.txt", `needle\n${wide}\n`, async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "needle", path: "wide3.txt", context: 1 }, undefined, undefined, ctx);
      const rows = getText(result).split("\n").filter((l) => /[A-Za-z0-9]{3}│/.test(l));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Buffer.byteLength(row, "utf-8")).toBeLessThanOrEqual(510);
      }
    });
  });

  it("caps matches at limit when counting files after the byte-budget cutoff", async () => {
    const a = Array.from({ length: 200 }, () => "x".repeat(600)).join("\n") + "\n";
    const b = Array.from({ length: 200 }, () => "x".repeat(600)).join("\n") + "\n";
    await withTempDir("grep-limit-cap-", async (dir) => {
      await writeFile(join(dir, "a.txt"), a, "utf-8");
      await writeFile(join(dir, "b.txt"), b, "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "x{600}", limit: 300 }, undefined, undefined, ctx);
      const details = result.details as { truncation: { totalLines: number }; metrics: { matches: number; truncated: boolean } };
      expect(details.metrics.matches).toBe(300);
      expect(details.truncation.totalLines).toBe(400);
      expect(details.metrics.truncated).toBe(true);
      expect(getText(result)).toContain("showing first 300 matches");
    });
  });
});
