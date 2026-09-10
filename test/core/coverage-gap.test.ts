import { describe, expect, it, vi, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline";
import { lineHashes } from "../../src/hashline";
import { applyEdit, fmtRegion } from "../../src/hashline";
import { valEdit, resEdit, resolveAnchorLine } from "../../src/hashline/resolve";
import { mkMdTheme, renderEditResult } from "../../src/replace-render";
import { fmtDedupRow, withDedupRows, isDedupRow, isChangeRow } from "../../src/replace-response";
import { assertReq, assertInsertReq, getPreviewInput } from "../../src/payload-contract";
import { decodeStringArray, cntDiff } from "../../src/utils";
import { parseHashList, parseServedMap } from "../../src/hash-store/validation";
import { tryReadNormFile } from "../../src/file-reader";
import { commitEdit } from "../../src/commit";
import { insertPreview } from "../../src/insert";
import { withTempDir, makeFakePiRegistry } from "../support/fixtures";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

beforeAll(async () => {
  await initHasher();
});

function fakeTheme() {
  return {
    fg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => `**${text}**`,
    italic: (text: string) => `_${text}_`,
    underline: (text: string) => `__${text}__`,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

describe("gap mkMdTheme", () => {
  it("invokes every getter and highlight branches", () => {
    const theme = mkMdTheme(fakeTheme() as never);
    expect(theme.heading("h")).toContain("h");
    expect(theme.link("l")).toContain("l");
    expect(theme.linkUrl("u")).toContain("u");
    expect(theme.code("c")).toContain("c");
    expect(theme.codeBlock("b")).toContain("b");
    expect(theme.codeBlockBorder("bb")).toContain("bb");
    expect(theme.quote("q")).toContain("q");
    expect(theme.quoteBorder("qb")).toContain("qb");
    expect(theme.hr("h")).toContain("h");
    expect(theme.listBullet("x")).toContain("x");
    expect(theme.bold("b")).toContain("b");
    expect(theme.italic("i")).toContain("i");
    expect(theme.underline("u")).toContain("u");
    expect(theme.strikethrough("s")).toContain("s");
    const diffed = theme.highlightCode("+a\n-b\n c", "diff");
    expect(diffed.length).toBe(3);
    const plain = theme.highlightCode("x", "js");
    expect(plain.length).toBe(1);
    const bare = fakeTheme() as unknown as Record<string, unknown>;
    delete bare.italic;
    delete bare.underline;
    delete bare.strikethrough;
    const fallback = mkMdTheme(bare as never);
    expect(fallback.italic("i")).toBe("i");
    expect(fallback.underline("u")).toBe("u");
    expect(fallback.strikethrough("s")).toBe("s");
  });
  it("clears pending preview state in renderEditResult", () => {
    const theme = { fg: (c: string, t: string) => t };
    const timer = setTimeout(() => undefined, 10000);
    const controller = new AbortController();
    const context = { state: { previewTimer: timer, previewAbort: controller, preview: { diff: "x" }, previewGeneration: 1 }, lastComponent: undefined, expanded: false, isError: false };
    const result = renderEditResult({ content: [{ type: "text", text: "hello" }] }, { isPartial: false }, theme as never, context as never);
    expect(result).toBeDefined();
    clearTimeout(timer);
    expect(context.state.previewTimer).toBeUndefined();
    expect(context.state.previewAbort).toBeUndefined();
  });
});

describe("gap dedup rows", () => {
  it("truncates oversized dedup rows", () => {
    const big = "x".repeat(60000);
    const row = fmtDedupRow(big);
    expect(row).toContain("exceeds");
    expect(isDedupRow(row)).toBe(true);
    expect(isDedupRow("plain")).toBe(false);
    expect(isChangeRow("+a")).toBe(true);
    expect(isChangeRow("-a")).toBe(true);
    expect(isChangeRow(" a")).toBe(false);
  });
  it("handles empty diff with dedup rows", () => {
    const out = withDedupRows("", [undefined], ["a"], ["b"]);
    expect(out.diff).toContain("a");
    expect(out.diff).toContain("b");
  });
  it("appends dedup rows when diff has no change rows", () => {
    const out = withDedupRows(" context", [1], ["a"], ["b"]);
    expect(out.diff).toContain("a");
    expect(out.diff).toContain("context");
  });
});

describe("gap payload contract", () => {
  it("rejects non-string path", () => {
    expect(() => assertReq({ path: 42, remove_from: "Hasu", remove_to: "Hasu", replacement_lines: [] })).toThrow("[E_BAD_SHAPE]");
    expect(() => assertInsertReq({ path: 42, anchor: "Hasu", direction: "after", lines: [] })).toThrow("[E_BAD_SHAPE]");
  });
  it("covers getPreviewInput catch via throwing getter", () => {
    const evil = {};
    Object.defineProperty(evil, "path", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(getPreviewInput(evil)).toBeNull();
  });
});

describe("gap resolve", () => {
  it("throws on misaligned inputs", () => {
    expect(() => valEdit({ content_lines: [], hash_bounds: [{ hash: "Hasu" }, { hash: "Hasu" }] }, ["a"], ["x", "y"], [], undefined)).toThrow("must match");
    expect(() => fmtRegion(["a"], ["x", "y"])).toThrow("must match");
  });
  it("rejects non-string anchors in resEdit", () => {
    expect(() => resEdit({ replacement_lines: [], remove_from: 42 as unknown as string, remove_to: "Hasu" })).toThrow("remove_from");
    expect(() => resEdit({ replacement_lines: [], remove_from: "Hasu", remove_to: 42 as unknown as string })).toThrow("remove_to");
  });
  it("throws AnchorMismatchError for unknown anchor", () => {
    expect(() => resolveAnchorLine({ hash: "ZZZZ" }, ["a"], ["Hasu"], undefined)).toThrow("[E_STALE_ANCHOR]");
  });
});

describe("gap apply and hashes", () => {
  it("requires precomputed hashes", () => {
    expect(() => applyEdit("a", { content_lines: ["b"], hash_bounds: [{ hash: "Hasu" }, { hash: "Hasu" }] })).toThrow("[E_BAD_SHAPE]");
  });
  it("hashes without path", async () => {
    const hashes = await lineHashes("a\nb");
    expect(hashes.length).toBe(2);
  });
  it("counts empty diff as zero", () => {
    expect(cntDiff("", "+")).toBe(0);
    expect(cntDiff("+a\n-b", "+")).toBe(1);
  });
});

describe("gap decode array", () => {
  it("handles non-string and unterminated inputs", () => {
    expect(decodeStringArray(123)).toBeUndefined();
    expect(decodeStringArray([123 as unknown as string])).toBeUndefined();
    expect(decodeStringArray('["a]')).toBeUndefined();
    expect(decodeStringArray('["a","b"]')).toEqual(["a", "b"]);
  });
});

describe("gap validation with context", () => {
  it("includes context in parse errors", () => {
    let called = false;
    expect(parseHashList("not json", () => { called = true; }, "ctx")).toBeUndefined();
    expect(called).toBe(true);
    called = false;
    expect(parseHashList(JSON.stringify(["ZZ"]), () => { called = true; }, "ctx")).toBeUndefined();
    expect(called).toBe(true);
    called = false;
    expect(parseServedMap("not json", () => { called = true; }, "ctx")).toBeUndefined();
    expect(called).toBe(true);
  });
  it("covers stringify fallback via mock", () => {
    const payload = JSON.stringify("ZZ");
    const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("boom"); });
    let called = false;
    expect(parseHashList(payload, () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
    spy.mockRestore();
    const payload2 = JSON.stringify({ bad: "x" });
    const spy2 = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("boom"); });
    let called2 = false;
    expect(parseServedMap(payload2, () => { called2 = true; })).toBeUndefined();
    expect(called2).toBe(true);
    spy2.mockRestore();
  });
});

describe("gap undo tool rendering", () => {
  it("renders call and result and rejects empty path", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    const { regUndo } = await import("../../src/replace-undo");
    regUndo(pi as never);
    const tool = getTool("undo_last_change");
    const theme = fakeTheme();
    const callText = tool.renderCall({ path: "a.txt" }, theme, { lastComponent: undefined, expanded: true });
    expect(callText).toBeDefined();
    const callEmpty = tool.renderCall(undefined, theme, { lastComponent: undefined, expanded: false });
    expect(callEmpty).toBeDefined();
    const res = tool.renderResult({ content: [{ type: "text", text: "hi" }] }, { isPartial: false }, theme, { lastComponent: undefined, expanded: false, isError: false });
    expect(res).toBeDefined();
    await withTempDir("undo-gap-", async (dir) => {
      const ctx = { cwd: dir } as never;
      await expect(tool.execute("u1", { path: "" }, undefined, undefined, ctx)).rejects.toThrow("[E_BAD_SHAPE]");
    });
  });
});

describe("gap read rendering", () => {
  it("covers read renderResult branches", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    const { regRead } = await import("../../src/read");
    regRead(pi as never);
    const tool = getTool("read");
    const theme = fakeTheme();
    const partial = tool.renderResult({ content: [{ type: "text", text: "x" }] }, { isPartial: true }, theme, {});
    expect(partial).toBeDefined();
    const missing = tool.renderResult({ content: [] }, { isPartial: false }, theme, {});
    expect(missing).toBeDefined();
    const errCtx = tool.renderResult({ content: [{ type: "text", text: "boom" }] }, { isPartial: false }, theme, { isError: true });
    expect(errCtx).toBeDefined();
    const collapsed = tool.renderResult({ content: [{ type: "text", text: "Hasu│hi" }] }, { isPartial: false }, theme, { expanded: false });
    expect(collapsed).toBeDefined();
    const expanded = tool.renderResult({ content: [{ type: "text", text: "Hasu│hi" }] }, { isPartial: false, expanded: true }, theme, { expanded: false, args: { offset: 3 }, state: {} });
    expect(expanded).toBeDefined();
  });
});

describe("gap insert preview", () => {
  it("throws on aborted signal", async () => {
    await withTempDir("insert-gap-", async (dir) => {
      const controller = new AbortController();
      controller.abort();
      await expect(insertPreview({ anchor: "Hasu", direction: "after", lines: ["x"] }, dir, controller.signal)).rejects.toThrow();
    });
  });
  it("covers getInsertInput via renderCall", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    const { regInsert } = await import("../../src/insert");
    regInsert(pi as never);
    const tool = getTool("insert");
    const theme = fakeTheme();
    const mkCtx = () => ({ cwd: "/tmp", state: {}, lastComponent: undefined, argsComplete: false, executionStarted: false, expanded: false, invalidate() {} });
    const evil = {};
    Object.defineProperty(evil, "anchor", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(tool.renderCall(evil, theme, mkCtx())).toBeDefined();
    expect(tool.renderCall("nope", theme, mkCtx())).toBeDefined();
    expect(tool.renderCall({ anchor: 42 }, theme, mkCtx())).toBeDefined();
  });
});

describe("gap commit guards", () => {
  it("refuses when file was deleted after edit started", async () => {
    await withTempDir("commit-gap-", async (dir) => {
      const missing = join(dir, "missing.txt");
      const pipe = {
        path: "missing.txt",
        originalNormalized: "old",
        result: "new",
        bom: "",
        originalEnding: "\n" as const,
        hadUtf8DecodeErrors: false,
        warnings: [],
        originalHashes: ["Hasu"],
        resultHashes: ["arvm"],
        totalAddedLines: 1,
        totalRemovedLines: 1,
        hadBoundaryDedup: false,
        boundaryRemovedLines: 0,
        boundaryRemovedLineTexts: [],
        boundaryDedupAbove: [],
        boundaryDedupBelow: [],
        identity: { dev: 1, ino: 1 },
      };
      await expect(commitEdit(pipe as never, { path: "missing.txt", absolutePath: missing, mutationTargetPath: missing } as never)).rejects.toThrow("[E_OP_ABORTED]");
    });
  });
  it("refuses when file changed after edit started", async () => {
    await withTempDir("commit-gap2-", async (dir) => {
      const target = join(dir, "f.txt");
      await writeFile(target, "different", "utf-8");
      const pipe = {
        path: "f.txt",
        originalNormalized: "old",
        result: "new",
        bom: "",
        originalEnding: "\n" as const,
        hadUtf8DecodeErrors: false,
        warnings: [],
        originalHashes: ["Hasu"],
        resultHashes: ["arvm"],
        totalAddedLines: 1,
        totalRemovedLines: 1,
        hadBoundaryDedup: false,
        boundaryRemovedLines: 0,
        boundaryRemovedLineTexts: [],
        boundaryDedupAbove: [],
        boundaryDedupBelow: [],
        identity: { dev: 1, ino: 1 },
      };
      await expect(commitEdit(pipe as never, { path: "f.txt", absolutePath: target, mutationTargetPath: target } as never)).rejects.toThrow("[E_OP_ABORTED]");
    });
  });
});

describe("gap file reader", () => {
  it("returns undefined for missing and non-text", async () => {
    await withTempDir("reader-gap-", async (dir) => {
      const missing = join(dir, "nope.txt");
      expect(await tryReadNormFile(missing, dir)).toBeUndefined();
      const sub = join(dir, "sub");
      await mkdir(sub, { recursive: true });
      expect(await tryReadNormFile(sub, dir)).toBeUndefined();
    });
  });
  it("returns undefined for too-large preview", async () => {
    await withTempDir("reader-gap2-", async (dir) => {
      const target = join(dir, "f.txt");
      await writeFile(target, "a\nb\nc", "utf-8");
      expect(await tryReadNormFile(target, dir, { maxLines: 1 })).toBeUndefined();
    });
  });
});
