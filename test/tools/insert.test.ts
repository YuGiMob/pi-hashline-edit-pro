import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, makeFakePiRegistry, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import register from "../../index";
import { insertPreview, buildInsertToolDef } from "../../src/insert";
import type { RRState } from "../../src/replace-render";

describe("insert tool", () => {
  it("registers a tool named insert", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("insert");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("insert");
  });

  it("declares path, anchor, direction, and lines in the schema", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const schema = getTool("insert").parameters as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.path).toBeDefined();
    expect(schema.properties.anchor).toBeDefined();
    expect(schema.properties.direction).toBeDefined();
    expect(schema.properties.lines).toBeDefined();
    expect(schema.properties.replacement_lines).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("inserts lines after the anchor line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);

      const result = await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ["beta1", "beta2"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 1 line(s).");
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
        { path: "sample.ts", anchor: betaHash, direction: "before", lines: ["zero"] },
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
        { path: "sample.ts", anchor: alphaHash, direction: "before", lines: ["head"] },
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
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ["gamma"] },
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
      expect(emptyHash).toMatch(/^[A-Za-z0-9]{4}$/);

      await insertTool.execute(
        "i1",
        { path: "empty.ts", anchor: emptyHash, direction: "after", lines: ["first", "second"] },
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
        { path: "sample.ts", anchor: aHash, direction: "after", lines: ["b"] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nb\n");
    });
  });

  it("reports a noop when inserting nothing", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      const result = await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: alphaHash, direction: "after", lines: [] },
        undefined, undefined, ctx,
      );
      expect(result.details.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      await expect(
        insertTool.execute(
          "i1",
          { path: "sample.ts", anchor: "PyBY", direction: "after", lines: ["x"] },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("rejects an anchor that was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      await readTool.execute("r1", { path: "sample.ts", limit: 2 }, undefined, undefined, ctx);
      const hashes = await lineHashes("a\nb\nc\nd\n", `${cwd}/sample.ts`);

      await expect(
        insertTool.execute(
          "i",
          { path: "sample.ts", anchor: hashes[2]!, direction: "after", lines: ["x"] },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_RANGE_STALE/);
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
          { path: "sample.ts", anchor: alphaHash, direction: "sideways", lines: ["x"] },
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
          { path: "sample.ts", anchor: alphaHash, direction: "after" } as any,
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_BAD_SHAPE/);
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
        { path: "crlf.ts", anchor: alphaHash, direction: "after", lines: ["mid"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nmid\r\nbeta\r\n");
    });
  });

  it("supports the file_path alias", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│alpha"))!);

      await insertTool.execute(
        "i1",
        { file_path: "sample.ts", anchor: alphaHash, direction: "after", lines: ["mid"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nmid\nbeta\n");
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
        { path: "sample.ts", anchor: alphaHash, direction: "after", lines: ["mid"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nmid\nbeta\ngamma\n");

      const editTool = getTool("replace");
      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: gammaHash, remove_to: gammaHash, replacement_lines: ["GAMMA"] },
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
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ["B1", "B2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nB1\nB2\ngamma\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("an applied insert clears a pending boundary bypass", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const editTool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", `${cwd}/sample.ts`);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const payload = {
        path: "sample.ts",
        remove_from: hashes[1]!,
        remove_to: hashes[1]!,
        replacement_lines: ["bbb", "ccc"],
      };

      const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
      expect(first.details.classification).toBe("noop");

      await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: hashes[0]!, direction: "after", lines: ["AAA2"] },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("aaa\nAAA2\nbbb\nccc\n");

      const resend = await editTool.execute("e2", payload, undefined, undefined, ctx);
      expect(resend.details.classification).toBe("noop");
      expect(getText(resend)).not.toContain("[W_BOUNDARY_BYPASS]");
      expect(await readFile(path, "utf-8")).toBe("aaa\nAAA2\nbbb\nccc\n");
    });
  });

  it("expands a stringified lines array with a warning", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);

      const result = await insertTool.execute(
        "i1",
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ['["beta1", "beta2"]'] },
        undefined, undefined, ctx,
      );
      expect(result.content[0].text).toContain("Successfully inserted in sample.ts");
      expect(result.content[0].text).toContain("Unwrapped JSON array syntax");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta1\nbeta2\ngamma\n");
    });
  });

  it("previews expanded lines for a stringified array", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("beta"))!);
      const preview = await insertPreview({ path: "sample.ts", anchor: betaHash, direction: "after", lines: ['["beta1", "beta2"]'] }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("beta1");
    });
  });

  it("returns an error preview for an unknown anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const preview = await insertPreview({ path: "sample.ts", anchor: "!!!!", direction: "after", lines: ["x"] }, cwd);
      expect(preview).toHaveProperty("error");
    });
  });
});

describe("insert tool rendering", () => {
  it("computes a diff preview for an insert request", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaHash = extractHash(getText(readResult).split("\n").find((l) => l.includes("│beta"))!);
      const preview = await insertPreview({ path: "sample.ts", anchor: betaHash, direction: "after", lines: ["BETA1"] }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("BETA1");
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
      content: [{ type: "text", text: "Successfully inserted in sample.ts. Added 1 line(s), removed 1 line(s)." }],
      details: {
        diff: "+ATIm│BETA1\n-ATIm│beta",
        metrics: { classification: "applied", added_lines: 1, removed_lines: 1 },
      },
    };
    const component = tool.renderResult!(result as any, { expanded: false, isPartial: false }, theme, { state: {}, lastComponent: undefined, isError: false } as any) as any;
    expect(component.text).toContain("+ATIm│BETA1");
    expect(component.text).toContain("-ATIm│beta");
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
        { path: "sample.ts", anchor: betaHash, direction: "after", lines: ["BETA1"] },
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
