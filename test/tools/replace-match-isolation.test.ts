import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertReplaceMatchReq } from "../../src/payload-contract";
import { replaceMatchPreview } from "../../src/replace-match";
import {
  anchorFor,
  assistantMessage,
  getText,
  setupIntegrationTest,
  toolCall,
  toolError,
  withTempFile,
} from "../support/fixtures";

const CONTEXTS = [
  'import { createContext } from "hono";',
  "",
  "const ThemeContext = createContext<Theme>(null);",
  "const SessionContext = createContext<Session>(null);",
  "",
].join("\n");

const SUBSTRING_REPLACED = [
  'import { createContext } from "hono";',
  "",
  "const ThemeHonoContext = createHonoContext<Theme>(null);",
  "const SessionHonoContext = createHonoContext<Session>(null);",
  "",
].join("\n");

describe("replace_match identifier isolation", () => {
  it("refuses the issue #73 substring edit and writes nothing", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const from = anchorFor(text, "const ThemeContext");
      const to = anchorFor(text, "const SessionContext");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: from, replace_to: to, match: "Context", replacement: "HonoContext" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { ok: boolean; kind: string; error: { code: string; message: string } };
      expect(structured).toMatchObject({ ok: false, kind: "error" });
      expect(structured.error.code).toBe("E_MATCH_NOT_ISOLATED");
      const message = getText(result);
      expect(message).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(message).toMatch(/lines 3-4 of .*contexts\.ts/);
      expect(message).toContain("First at line 3, col 12");
      expect(message).toContain('"ThemeContext"');
      expect(message).toContain('pass "allowEmbeddedMatch": true');
      expect(await readFile(path, "utf-8")).toBe(CONTEXTS);
    });
  });

  it("replaces inside identifiers when allowEmbeddedMatch is true", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const from = anchorFor(text, "const ThemeContext");
      const to = anchorFor(text, "const SessionContext");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: from, replace_to: to, match: "Context", replacement: "HonoContext", allowEmbeddedMatch: true },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe(SUBSTRING_REPLACED);
    });
  });

  it("keeps a standalone identifier replacement working across occurrences", async () => {
    const content = "const ThemeContext = createContext(null);\nconst RootContext = ThemeContext;\n";
    await withTempFile("app.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "app.ts" }, undefined, undefined, ctx));
      const first = anchorFor(text, "const ThemeContext");
      const second = anchorFor(text, "const RootContext");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: first, replace_to: second, match: "ThemeContext", replacement: "AppContext" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("const AppContext = createContext(null);\nconst RootContext = AppContext;\n");
    });
  });

  const BOUNDARY_CASES: Array<{
    title: string;
    content: string;
    match: string;
    replacement: string;
    isolated: boolean;
  }> = [
    { title: "a dollar prefix", content: "const total = $price;\n", match: "price", replacement: "cost", isolated: false },
    { title: "an underscore suffix", content: "const price_total = 1;\n", match: "price", replacement: "cost", isolated: false },
    { title: "an underscore prefix", content: "const _price = 1;\n", match: "price", replacement: "cost", isolated: false },
    { title: "a digit neighbour", content: "const id = 13;\n", match: "3", replacement: "4", isolated: false },
    { title: "a combining mark", content: "const cafe\u0301 = 1;\n", match: "cafe", replacement: "caff", isolated: false },
    { title: "surrounding whitespace", content: "const price = 1;\n", match: "price", replacement: "cost", isolated: true },
    { title: "surrounding punctuation", content: "total = (price);\n", match: "price", replacement: "cost", isolated: true },
    { title: "surrounding quotes", content: 'feature: "legacyCheckout"\n', match: "legacyCheckout", replacement: "stableCheckout", isolated: true },
    { title: "the line edges", content: "price\n", match: "price", replacement: "cost", isolated: true },
  ];

  for (const testCase of BOUNDARY_CASES) {
    it(`guards ${testCase.title}`, async () => {
      await withTempFile("sample.txt", testCase.content, async ({ cwd, path }) => {
        const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
        const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
        const anchor = anchorFor(text, testCase.content.trim());
        const args = { replace_from: anchor, replace_to: anchor, match: testCase.match, replacement: testCase.replacement };
        if (!testCase.isolated) {
          const message = await toolError(() => getTool("replace_match").execute("w1", args, undefined, undefined, ctx));
          expect(message).toContain("[E_MATCH_NOT_ISOLATED]");
          expect(await readFile(path, "utf-8")).toBe(testCase.content);
          return;
        }
        const result = await getTool("replace_match").execute("w1", args, undefined, undefined, ctx);
        expect(getText(result)).toContain("Successfully replaced");
        expect(await readFile(path, "utf-8")).toBe(testCase.content.replace(testCase.match, testCase.replacement));
      });
    });
  }

  it("treats astral identifier characters as neighbours and reports code-point columns", async () => {
    await withTempFile("sample.ts", "const 𝑥y = 1;\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "const 𝑥y");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "y", replacement: "z" },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toContain("First at line 1, col 8");
      expect(message).toContain("𝑥y");
      expect(await readFile(path, "utf-8")).toBe("const 𝑥y = 1;\n");
    });
  });

  it("refuses the whole range when only one occurrence is embedded", async () => {
    const content = "top\nconst theme = ThemeContext;\nconst ctx = createThemeContext(null);\nbottom\n";
    await withTempFile("app.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "app.ts" }, undefined, undefined, ctx));
      const from = anchorFor(text, "const theme");
      const to = anchorFor(text, "const ctx");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: from, replace_to: to, match: "ThemeContext", replacement: "Hono" },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(message).toContain("1 of the 2 occurrences");
      expect(message).toContain("const ctx = createThemeContext(null);");
      expect(message).not.toContain("const theme = ThemeContext;");
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("still reports a missing match before the isolation check", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "const ThemeContext");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "Missing", replacement: "x" },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toContain("[E_SUBSTRING_NOT_FOUND]");
    });
  });

  it("rejects a non-boolean allowEmbeddedMatch", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "const ThemeContext");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "Context", replacement: "HonoContext", allowEmbeddedMatch: "yes" },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toContain("[E_BAD_SHAPE]");
      expect(message).toContain("must be boolean");
      expect(await readFile(path, "utf-8")).toBe(CONTEXTS);
    });
  });

  it("validates allowEmbeddedMatch at the request layer", () => {
    const request = { replace_from: "abcde", replace_to: "abcde", match: "a", replacement: "b" };
    expect(() => assertReplaceMatchReq({ ...request, allowEmbeddedMatch: "yes" })).toThrow(/allowEmbeddedMatch/);
    expect(() => assertReplaceMatchReq({ ...request, allowEmbeddedMatch: true })).not.toThrow();
    expect(() => assertReplaceMatchReq(request)).not.toThrow();
  });

  it("refuses in the preview path without writing", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const from = anchorFor(text, "const ThemeContext");
      const to = anchorFor(text, "const SessionContext");
      const preview = await replaceMatchPreview(
        { replace_from: from, replace_to: to, match: "Context", replacement: "HonoContext" },
        cwd,
      );
      expect(preview).toHaveProperty("error");
      expect((preview as { error: string }).error).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(await readFile(path, "utf-8")).toBe(CONTEXTS);
    });
  });

  it("previews an opted-out substring replacement", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const from = anchorFor(text, "const ThemeContext");
      const to = anchorFor(text, "const SessionContext");
      const preview = await replaceMatchPreview(
        { replace_from: from, replace_to: to, match: "Context", replacement: "HonoContext", allowEmbeddedMatch: true },
        cwd,
      );
      expect((preview as { diff?: string }).diff).toContain("ThemeHonoContext");
      expect(await readFile(path, "utf-8")).toBe(CONTEXTS);
    });
  });

  it("keeps the guard in a same-message batch and applies the valid sibling", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, handlers, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const theme = anchorFor(text, "const ThemeContext");
      const session = anchorFor(text, "const SessionContext");
      const unsafe = { replace_from: theme, replace_to: theme, match: "Context", replacement: "HonoContext" };
      const safe = { replace_from: session, replace_to: session, match: "SessionContext", replacement: "AppContext" };
      const message = assistantMessage([
        toolCall("k1", "replace_match", unsafe),
        toolCall("k2", "replace_match", safe),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const failure = await toolError(() => getTool("replace_match").execute("k1", unsafe, undefined, undefined, ctx));
      expect(failure).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(failure).not.toContain("Aborts batch");

      const applied = await getTool("replace_match").execute("k2", safe, undefined, undefined, ctx);
      expect(applied.details.metrics.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe([
        'import { createContext } from "hono";',
        "",
        "const ThemeContext = createContext<Theme>(null);",
        "const AppContext = createContext<Session>(null);",
        "",
      ].join("\n"));
    });
  });

  it("writes nothing when every batch member is embedded", async () => {
    await withTempFile("contexts.ts", CONTEXTS, async ({ cwd, path }) => {
      const { ctx, handlers, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "contexts.ts" }, undefined, undefined, ctx));
      const theme = anchorFor(text, "const ThemeContext");
      const session = anchorFor(text, "const SessionContext");
      const first = { replace_from: theme, replace_to: theme, match: "Context", replacement: "HonoContext" };
      const second = { replace_from: session, replace_to: session, match: "Context", replacement: "HonoContext" };
      const message = assistantMessage([
        toolCall("j1", "replace_match", first),
        toolCall("j2", "replace_match", second),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      expect(await toolError(() => getTool("replace_match").execute("j1", first, undefined, undefined, ctx))).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(await toolError(() => getTool("replace_match").execute("j2", second, undefined, undefined, ctx))).toContain("[E_MATCH_NOT_ISOLATED]");
      expect(await readFile(path, "utf-8")).toBe(CONTEXTS);
    });
  });
});
