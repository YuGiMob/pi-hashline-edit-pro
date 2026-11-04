import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, makeFakePiRegistry, setupIntegrationTest, getText, extractHash, toolError } from "../support/fixtures";
import { resolveTarget } from "../../src/fs-write";
import { toCwd } from "../../src/paths";
import register from "../../index";
import { insertPreview, buildInsertToolDef, assertInsertReq } from "../../src/insert";
import type { RRState } from "../../src/replace-render";

describe("insert tool", () => {
  it("registers a tool named insert", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("insert");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("insert");
  });

  it("declares anchor, direction, and text in the schema", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const schema = getTool("insert").parameters as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.path).toBeUndefined();
    expect(schema.properties.anchor).toBeDefined();
    expect(schema.properties.direction).toBeDefined();
    expect(schema.properties.text).toBeDefined();
    expect(schema.properties.lines).toBeUndefined();
    expect(schema.additionalProperties).toBe(true);
  });

  it("declares direction as a flat string enum", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const schema = getTool("insert").parameters as { properties: Record<string, unknown> };
    expect(schema.properties.direction).toEqual({ type: "string", enum: ["after", "before"], description: '"after" or "before"' });
    const validator = Compile(schema.properties.direction as never);
    expect(validator.Check("after")).toBe(true);
    expect(validator.Check("before")).toBe(true);
    expect(validator.Check("below")).toBe(false);
  });

  it("inserts lines after the anchor line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      const result = await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ["beta1", "beta2"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 0 line(s).");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("inserts lines before the anchor line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "before", text: ["zero"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nzero\nbeta\ngamma\n");
    });
  });

  it("inserts before the first line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await insertTool.execute(
        "i1",
        { anchor: alphaHash, direction: "before", text: ["head"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("head\nalpha\nbeta\n");
    });
  });

  it("appends at EOF without adding a trailing newline", async () => {
    await withTempFile("sample.ts", "alpha\nbeta", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ["gamma"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma");
    });
  });

  it("seeds an empty file without a leading blank line", async () => {
    await withTempFile("empty.ts", "", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "empty.ts" }, undefined, undefined, ctx);
      const emptyHash = getText(readResult).split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[a-z]{5}$/);

      await insertTool.execute(
        "i1",
        { anchor: emptyHash, direction: "after", text: ["first", "second"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("first\nsecond");
    });
  });

  it("applies inserted lines that duplicate a neighbor literally", async () => {
    await withTempFile("sample.ts", "a\nb\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const aHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│a"))!);

      const result = await insertTool.execute(
        "i1",
        { anchor: aHash, direction: "after", text: ["b"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nb\n");
    });
  });

  it("inserts one blank line for an empty lines payload", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await insertTool.execute(
        "i1",
        { anchor: alphaHash, direction: "after", text: [] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\n\nbeta\n");
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      expect(await toolError(() => insertTool.execute("i1", { anchor: "pybyx", direction: "after", text: ["x"] }, undefined, undefined, ctx))).toMatch(/E_STALE_ANCHOR/);
    });
  });

  it("rejects an anchor that was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      await readTool.execute("r1", { path: "sample.ts", limit: 2 }, undefined, undefined, ctx);
      const hashes = await lineHashes("a\nb\nc\nd\n", await resolveTarget(toCwd("sample.ts", cwd)));

      expect(await toolError(() => insertTool.execute("i", { anchor: hashes[2]!, direction: "after", text: ["x"] }, undefined, undefined, ctx))).toMatch(/E_RANGE_STALE/);
    });
  });

  it("rejects an invalid direction", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await expect(
        insertTool.execute(
          "i1",
          { anchor: alphaHash, direction: "sideways", text: ["x"] },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_BAD_SHAPE/);
    });
  });

  it("rejects a missing lines array", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await expect(
        insertTool.execute(
          "i1",
          { anchor: alphaHash, direction: "after" } as any,
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_BAD_SHAPE/);
    });
  });

  it("rejects a NUL byte in lines before any file I/O", () => {
    const nul = String.fromCharCode(0);
    expect(() => assertInsertReq({ anchor: "hasux", direction: "after", text: nul })).toThrow(/NUL byte/);
  });

  it("rejects a NUL byte in inserted lines", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);
      const nul = String.fromCharCode(0);

      expect(await toolError(() => insertTool.execute("i1", { anchor: betaHash, direction: "after", text: `a${nul}b` }, undefined, undefined, ctx))).toMatch(/NUL byte/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("accepts a matching path in anchor-only mode", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await insertTool.execute("i1", { anchor: alphaHash, direction: "after", text: "x", path: "sample.ts" } as any, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\nx\n");
    });
  });

  it("preserves CRLF line endings", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "crlf.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await insertTool.execute(
        "i1",
        { anchor: alphaHash, direction: "after", text: ["mid"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nmid\r\nbeta\r\n");
    });
  });

  it("keeps untouched-line anchors valid after an insert", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const alphaHash = extractHash(lines.find((l) => l.includes("│alpha"))!);
      const gammaHash = extractHash(lines.find((l) => l.includes("│gamma"))!);

      await insertTool.execute(
        "i1",
        { anchor: alphaHash, direction: "after", text: ["mid"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nmid\nbeta\ngamma\n");

      const editTool = getTool("replace");
      await editTool.execute(
        "e1",
        { remove_from: gammaHash, remove_to: gammaHash, text: ["GAMMA"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nmid\nbeta\nGAMMA\n");
    });
  });

  it("undoes an insert with undo_last_change", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const undo = getTool("undo_last_change");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ["B1", "B2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nB1\nB2\ngamma\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("expands a stringified lines array", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);

      const result = await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ['["beta1", "beta2"]'] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("applies stringified lines with trailing commas", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);

      const result = await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ['["beta1", "beta2",]'] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("expands a method-chained stringified lines array", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);

      const result = await insertTool.execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ['["beta1", "beta2"].map(s => s)'] },
        undefined, undefined, ctx,
      );

      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("previews expanded lines for a stringified array", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);
      const preview = await insertPreview({ anchor: betaHash, direction: "after", text: ['["beta1", "beta2"]'] }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("beta1");
    });
  });

  it("returns an error preview for an unknown anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const preview = await insertPreview({ anchor: "!!!!", direction: "after", text: ["x"] }, cwd);
      expect(preview).toHaveProperty("error");
    });
  });
});

describe("insert strip warnings", () => {
  it("reports a stripped line with the caller's index for direction after", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const betaHash = extractHash(text.split("\n").find((line) => line.includes("│beta"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor: betaHash, direction: "after", text: [`+${betaHash}│beta1`, "beta2"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Stripped diff-preview marker from text line 1.");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("reports a stripped line with the caller's index for direction before", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const betaHash = extractHash(text.split("\n").find((line) => line.includes("│beta"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor: betaHash, direction: "before", text: ["beta1", `+${betaHash}│beta2`] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Stripped diff-preview marker from text line 2.");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta1\nbeta2\nbeta\ngamma\n");
    });
  });

  it("lists every stripped line in the caller's numbering", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const betaHash = extractHash(text.split("\n").find((line) => line.includes("│beta"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor: betaHash, direction: "after", text: ["abcde│one", `+${betaHash}│two`, "three"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain('Stripped "anchor│" prefix from text line 1.');
      expect(result.content[0].text).toContain("Stripped diff-preview marker from text line 2.");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\none\ntwo\nthree\ngamma\n");
    });
  });

  it("accepts a line-numbered served row as the anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const betaHash = extractHash(text.split("\n").find((line) => line.includes("│beta"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor: `2:│ ${betaHash}│beta`, direction: "after", text: "beta1" },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Stripped line-numbered row from anchor entry");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\ngamma\n");
    });
  });
});

describe("insert literal escape hints", () => {
  it("hints and writes the literal escaped text", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const betaHash = extractHash(text.split("\n").find((line) => line.includes("│beta"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor: betaHash, direction: "after", text: [String.raw`stable\u200bCheckout`] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain(String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`);
      const hint = result.details.hints?.[0] ?? "";
      expect(hint).toContain(String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`);
      expect(hint).toContain("col 7");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nstable\\u200bCheckout\n");
      const writtenAnchor = hint.match(/([a-z]{5})│ col/)?.[1];
      expect(writtenAnchor).toMatch(/^[a-z]{5}$/);
      const within = await getTool("replace_match").execute(
        "i2",
        { replace_from: writtenAnchor!, replace_to: writtenAnchor!, match: String.raw`\u200b`, replacement: "\u200b", allowEmbeddedMatch: true },
        undefined,
        undefined,
        ctx,
      );
      expect(within.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nstable\u200bCheckout\n");
    });
  });
});

describe("insert indentation hints", () => {
  it("flags an inserted line that lost the anchor line's indentation", async () => {
    await withTempFile("routes.yaml", "routes:\n  - id: checkout-5\n    feature: legacyCheckout\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.yaml" }, undefined, undefined, ctx));
      const anchor = extractHash(text.split("\n").find((line: string) => line.includes("│  - id: checkout-5"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor, direction: "before", text: ["- id: checkout-11\n    feature: stableCheckout"] },
        undefined,
        undefined,
        ctx,
      );
      const hint = ((result.details.hints ?? []) as string[]).find((entry) => entry.startsWith("[H_INDENT_MISMATCH]")) ?? "";
      expect(hint).toContain("[H_INDENT_MISMATCH]");
      expect(hint).toMatch(/new line [a-z]{5}│ has 0 leading whitespace characters; neighboring line [a-z]{5}│ has 2\./);
      expect(hint).toContain("│ has");
      expect(await readFile(path, "utf-8")).toBe("routes:\n- id: checkout-11\n    feature: stableCheckout\n  - id: checkout-5\n    feature: legacyCheckout\n");
    });
  });

  it("flags an unindented inserted line that echoes a nearby body line", async () => {
    await withTempFile("cases.test.ts", "test(\"a\", () => {\n  assert(result).toEqual(expected);\n});\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "cases.test.ts" }, undefined, undefined, ctx));
      const anchor = extractHash(text.split("\n").find((line: string) => line.includes("│});"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor, direction: "before", text: ["assert(result).toContain(\"extra\");"] },
        undefined,
        undefined,
        ctx,
      );
      const hint = ((result.details.hints ?? []) as string[]).find((entry) => entry.startsWith("[H_INDENT_MISMATCH]")) ?? "";
      expect(hint).toContain("[H_INDENT_MISMATCH]");
      expect(hint).toContain("│ has");
    });
  });

  it("flags an inserted block that landed against a blank-separated anchor", async () => {
    await withTempFile("doc.md", "intro\n\n## Next\nend\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "doc.md" }, undefined, undefined, ctx));
      const anchor = extractHash(text.split("\n").find((line: string) => line.includes("│## Next"))!);
      const result = await getTool("insert").execute(
        "i1",
        { anchor, direction: "before", text: "## Added\n\nbody" },
        undefined,
        undefined,
        ctx,
      );
      const hint = ((result.details.hints ?? []) as string[]).find((entry) => entry.startsWith("[H_SEPARATOR_MOVED]")) ?? "";
      expect(hint).toContain("[H_SEPARATOR_MOVED]");
      expect(hint).toContain(`was displaced; add a blank line before ${anchor}│ if unintended.`);
      expect(await readFile(path, "utf-8")).toBe("intro\n\n## Added\n\nbody\n## Next\nend\n");
    });
  });
});

describe("insert tool rendering", () => {
  it("computes a diff preview for an insert request", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);
      const preview = await insertPreview({ anchor: betaHash, direction: "after", text: ["BETA1"] }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("BETA1");
    });
  });

  it("keeps the anchor line anchor in a before-insert preview", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);
      const preview = await insertPreview({ anchor: betaHash, direction: "before", text: ["BETA0"] }, cwd);
      const diff = (preview as { diff: string }).diff;
      expect(diff).toContain(` ${betaHash}│beta`);
      expect(diff).not.toMatch(/^-[a-z]{5}│beta$/m);
      expect(diff).not.toMatch(/^\+[a-z]{5}│beta$/m);
    });
  });

  it("renders the post-insert diff via renderResult", () => {
    const tool = buildInsertToolDef();
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      strikethrough: (text: string) => text,
    } as any;
    const result = {
      content: [{ type: "text", text: "Successfully inserted in sample.ts. Added 1 line(s), removed 0 line(s)." }],
      details: {
        diff: "+atimx│BETA1\n-atimx│beta",
        metrics: { classification: "applied", added_lines: 1, removed_lines: 0 },
      },
    };
    const component = tool.renderResult!(result as any, { expanded: false, isPartial: false }, theme, { state: {}, lastComponent: undefined, isError: false } as any) as any;
    expect(component.text).toContain("+atimx│BETA1");
    expect(component.text).toContain("-atimx│beta");
  });

  it("computes a diff preview in renderCall for insert args", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);
      const tool = buildInsertToolDef();
      const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
      const state: RRState = {};
      let notifyInvalidate: (() => void) | undefined;
      const invalidated = new Promise<void>((resolve) => {
        notifyInvalidate = resolve;
      });
      const context = {
        executionStarted: false,
        argsComplete: true,
        expanded: false,
        cwd,
        lastComponent: undefined,
        invalidate: () => notifyInvalidate?.(),
        state,
      };
      tool.renderCall!(
        { anchor: betaHash, direction: "after", text: ["BETA1"] },
        theme as any,
        context as any,
      );
      await Promise.race([
        invalidated,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("renderCall never produced a preview")), 2000),
        ),
      ]);
      expect(state.preview).toHaveProperty("diff");
      expect((state.preview as { diff: string }).diff).toContain("BETA1");
    });
  });
});

describe("provided line endings", () => {
  it("writes a CRLF separator embedded in lines", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const alphaHash = extractHash(text.split("\n").find((line) => line.includes("│alpha"))!);
      await getTool("insert").execute("i1", { anchor: alphaHash, direction: "after", text: ["I1\r\nI2"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\nI1\r\nI2\nbeta\n");
    });
  });
});
