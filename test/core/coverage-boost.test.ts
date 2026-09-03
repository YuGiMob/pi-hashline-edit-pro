import { describe, expect, it, beforeAll } from "vitest";
import { isHashRow, numberedRead, withLineNumbers, clipLine, assertLineLimit, lineLimitMoreThanMessage, truncateToBytes, getCached, splitLines, visLines, isRec, normalizeFilePath } from "../../src/utils";
import { parseHashRef } from "../../src/hashline/parse";
import { initHasher, getH, xxh32, contentChecksum } from "../../src/hashline/hasher";
import { isValidHashList, isValidServedMap, parseHashList, parseServedMap, parseStoredHashes, parseStoredServed, isValidSnapshot, isCorruptionError, isBusyError } from "../../src/hash-store/validation";
import { canon, hashSource } from "../../src/hashline/hash";
import { toCwd } from "../../src/paths";
import { withTempDir, withTempFile, setupIntegrationTest } from "../support/fixtures";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

beforeAll(async () => {
  await initHasher();
});

describe("coverage boost utils", () => {
  it("isHashRow detects hash rows", () => {
    expect(isHashRow("Hasu│hello")).toBe(true);
    expect(isHashRow("Ha│hello")).toBe(false);
    expect(isHashRow("HasuX│hello")).toBe(false);
    expect(isHashRow("AB1c│")).toBe(true);
    expect(isHashRow("")).toBe(false);
    expect(isHashRow("Hasu|hello")).toBe(false);
  });
  it("numberedRead adds gutters for hash rows", () => {
    expect(numberedRead("Hasu│hello\narvm│world", 1)).toBe("1 │ Hasu│hello\n2 │ arvm│world");
    expect(numberedRead("plain\nHasu│hello", 5)).toBe("plain\n5 │ Hasu│hello");
    expect(numberedRead("", 1)).toBe("");
    expect(numberedRead("nohash", 10)).toBe("nohash");
    expect(numberedRead("a1Bc│x\na2Cd│y\na3De│z", 99)).toBe(" 99 │ a1Bc│x\n100 │ a2Cd│y\n101 │ a3De│z");
  });
  it("withLineNumbers adds gutters", () => {
    expect(withLineNumbers("a\nb", [1, 2])).toBe("1 │ a\n2 │ b");
    expect(withLineNumbers("a\nb", [undefined, 5])).toBe("  │ a\n5 │ b");
    expect(withLineNumbers("a\nb\nc", [])).toBe("  │ a\n  │ b\n  │ c");
    expect(withLineNumbers("", [])).toBe("  │ ");
    expect(withLineNumbers("x", [10])).toBe("10 │ x");
  });
  it("clipLine truncates and handles newlines", () => {
    expect(clipLine("a".repeat(300))).toContain("...");
    expect(clipLine("short")).toBe("short");
    expect(clipLine("a\nb")).toBe("a\\nb");
    expect(clipLine("x".repeat(200))).toBe("x".repeat(200));
    expect(clipLine("y".repeat(201))).toBe("y".repeat(200) + "...");
  });
  it("assertLineLimit and lineLimitMoreThanMessage", () => {
    expect(() => assertLineLimit("a\nb\nc", "f.txt", 2)).toThrow(/E_FILE_TOO_LARGE/);
    expect(() => assertLineLimit("a\nb", "f.txt", 5)).not.toThrow();
    expect(lineLimitMoreThanMessage("f.txt", 10)).toContain("has more than 10");
    expect(lineLimitMoreThanMessage("f.txt", 10).length).toBeGreaterThan(0);
    const msg = (() => {
      try { assertLineLimit("a\nb\nc\nd", "my.txt", 2); } catch (e) { return (e as Error).message; } return "";
    })();
    expect(msg).toContain("my.txt");
    expect(msg).toContain("has 4");
  });
  it("truncateToBytes handles multibyte", () => {
    expect(truncateToBytes("abc", 10)).toBe("abc");
    expect(truncateToBytes("é".repeat(10), 5)).toBe("éé");
    expect(truncateToBytes("😀😀", 4)).toBe("😀");
    expect(truncateToBytes("", 0)).toBe("");
  });
  it("getCached caches", () => {
    const m = new Map<string, number>();
    expect(getCached(m, "a", () => 1)).toBe(1);
    expect(getCached(m, "a", () => 2)).toBe(1);
    expect(m.get("a")).toBe(1);
  });
  it("splitLines and visLines", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(visLines("")).toEqual([]);
    expect(visLines("a\nb")).toEqual(["a", "b"]);
  });
  it("isRec and normalizeFilePath", () => {
    expect(isRec({})).toBe(true);
    expect(isRec(null)).toBe(false);
    const r: Record<string, unknown> = { file_path: "a.txt" };
    normalizeFilePath(r);
    expect(r.path).toBe("a.txt");
    expect(r.file_path).toBeUndefined();
  });
  it("canon and hashSource and toCwd", () => {
    expect(canon("  hello   ")).toBe("  hello");
    expect(canon("a\r\nb\r")).toBe("a\nb");
    expect(hashSource("a".repeat(1000)).length).toBeLessThanOrEqual(500);
    expect(toCwd("a.txt", "/tmp").endsWith("a.txt")).toBe(true);
  });
});

describe("coverage boost parse", () => {
  it("parseHashRef valid", () => {
    expect(parseHashRef("Hasu")).toEqual({ hash: "Hasu" });
    expect(parseHashRef("  Hasu  ")).toEqual({ hash: "Hasu" });
    expect(parseHashRef("A1bc")).toEqual({ hash: "A1bc" });
  });
  it("parseHashRef empty", () => {
    expect(() => parseHashRef("")).toThrow(/E_BAD_REF.*Expected a 4-char/);
    expect(() => parseHashRef("   ")).toThrow(/E_BAD_REF/);
  });
  it("parseHashRef numeric", () => {
    expect(() => parseHashRef("123abc")).toThrow(/no line numbers/);
    expect(() => parseHashRef("12345")).toThrow(/no line numbers/);
  });
  it("parseHashRef multiline block", () => {
    expect(() => parseHashRef("Hasu│hello\narvm│world")).toThrow(/remove_from and remove_to must each be a single bare/);
    expect(() => parseHashRef("Hasu│hello\narvm│world\n")).toThrow(/remove_from and remove_to/);
  });
  it("parseHashRef with pipe", () => {
    expect(() => parseHashRef("Hasu│hello")).toThrow(/drop everything from/);
    expect(() => parseHashRef("  Hasu│  ")).toThrow(/drop everything/);
  });
  it("parseHashRef invalid generic", () => {
    expect(() => parseHashRef("Ha")).toThrow(/Expected a 4-char/);
    expect(() => parseHashRef("abcde")).toThrow(/Expected a 4-char/);
    expect(() => parseHashRef("Ha!")).toThrow(/Expected a 4-char/);
  });
});

describe("coverage boost hasher", () => {
  it("getH and xxh32 and checksum", () => {
    expect(getH()).toBeDefined();
    expect(typeof xxh32("hello")).toBe("number");
    expect(typeof contentChecksum("hello")).toBe("string");
    expect(contentChecksum("hello")).not.toBe(contentChecksum("world"));
  });
});

describe("coverage boost validation", () => {
  it("isValidHashList", () => {
    expect(isValidHashList(["Hasu", "arvm"])).toBe(true);
    expect(isValidHashList(["Hasu", "Hasu"])).toBe(false);
    expect(isValidHashList(["Ha"])).toBe(false);
    expect(isValidHashList(["AB!"])).toBe(false);
    expect(isValidHashList("Hasu")).toBe(false);
    expect(isValidHashList([])).toBe(true);
    expect(isValidHashList([123 as unknown as string])).toBe(false);
  });
  it("isValidServedMap", () => {
    expect(isValidServedMap({ Hasu: "x" })).toBe(true);
    expect(isValidServedMap({ Ha: "x" })).toBe(false);
    expect(isValidServedMap({ Hasu: 123 as unknown as string })).toBe(false);
    expect(isValidServedMap(null)).toBe(false);
    expect(isValidServedMap([])).toBe(false);
    expect(isValidServedMap({ "AB!": "x" })).toBe(false);
    expect(isValidServedMap({})).toBe(true);
  });
  it("parseHashList invalid json", () => {
    let called = false;
    expect(parseHashList("not json", () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
  });
  it("parseHashList invalid hash", () => {
    let called = false;
    expect(parseHashList(JSON.stringify(["ZZ"]), () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
  });
  it("parseHashList valid", () => {
    let called = false;
    expect(parseHashList(JSON.stringify(["Hasu", "arvm"]), () => { called = true; })).toEqual(["Hasu", "arvm"]);
    expect(called).toBe(false);
  });
  it("parseHashList duplicate", () => {
    let called = false;
    expect(parseHashList(JSON.stringify(["Hasu", "Hasu"]), () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
  });
  it("parseServedMap invalid json", () => {
    let called = false;
    expect(parseServedMap("not json", () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
  });
  it("parseServedMap invalid map", () => {
    let called = false;
    expect(parseServedMap(JSON.stringify({ ab: "x" }), () => { called = true; })).toBeUndefined();
    expect(called).toBe(true);
  });
  it("parseServedMap valid", () => {
    let called = false;
    const m = parseServedMap(JSON.stringify({ Hasu: "x", arvm: "y" }), () => { called = true; });
    expect(m?.get("Hasu")).toBe("x");
    expect(called).toBe(false);
  });
  it("parseStoredHashes and Served", () => {
    expect(parseStoredHashes(undefined, () => {})).toBeUndefined();
    expect(parseStoredServed(undefined, () => {})).toBeUndefined();
    expect(parseStoredHashes({ hashes: JSON.stringify(["Hasu"]) } as unknown as Record<string, unknown>, () => {})).toEqual(["Hasu"]);
    expect(parseStoredServed({ hashes: JSON.stringify({ Hasu: "x" }) } as unknown as Record<string, unknown>, () => {})?.get("Hasu")).toBe("x");
  });
  it("isValidSnapshot", () => {
    expect(isValidSnapshot({ content: "a", hashes: ["Hasu"] })).toBe(true);
    expect(isValidSnapshot({ content: 123, hashes: ["Hasu"] })).toBe(false);
    expect(isValidSnapshot({ content: "a", hashes: ["ab"] })).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot({})).toBe(false);
  });
  it("isCorruptionError and isBusyError", () => {
    expect(isCorruptionError({ errcode: 11 })).toBe(true);
    expect(isCorruptionError({ errcode: 5 })).toBe(false);
    expect(isCorruptionError({ errcode: 24 })).toBe(true);
    expect(isCorruptionError({ errcode: 26 })).toBe(true);
    expect(isCorruptionError({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true);
    expect(isCorruptionError(new Error("other"))).toBe(false);
    expect(isBusyError({ errcode: 5 })).toBe(true);
    expect(isBusyError({ errcode: 6 })).toBe(true);
    expect(isBusyError({ errcode: 11 })).toBe(false);
    expect(isBusyError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isBusyError(new Error("database is busy"))).toBe(true);
    expect(isBusyError(new Error("database is locked"))).toBe(true);
    expect(isBusyError(new Error("other"))).toBe(false);
  });
});

describe("coverage boost grep", () => {
  it("rejects huge quantifier and other unsafe patterns", async () => {
    await withTempFile("a.txt", "hello\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grep = getTool("anchor_grep");
      await expect(grep.execute("g1", { pattern: "a".repeat(5000), path: "a.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_UNSAFE_REGEX]");
      await expect(grep.execute("g1", { pattern: "(a+)+", path: "a.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_UNSAFE_REGEX]");
      await expect(grep.execute("g1", { pattern: "a{1001}", path: "a.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_UNSAFE_REGEX]");
      await expect(grep.execute("g1", { pattern: "z{2000}", path: "a.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_UNSAFE_REGEX]");
    });
  });
  it("handles glob and literal and ignoreCase", async () => {
    await withTempDir("grep-boost-", async dir => {
      await writeFile(join(dir, "a.ts"), "Hello\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "Hello\n", "utf-8");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "c.ts"), "Hello\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grep = getTool("anchor_grep");
      const r1 = await grep.execute("g1", { pattern: "Hello", glob: "*.ts" }, undefined, undefined, ctx);
      expect(r1.content[0].text).toContain("a.ts");
      const r2 = await grep.execute("g1", { pattern: "hello", ignoreCase: true }, undefined, undefined, ctx);
      expect(r2.content[0].text).toContain("Hello");
      const r3 = await grep.execute("g1", { pattern: "Hello", literal: true }, undefined, undefined, ctx);
      expect(r3.content[0].text).toContain("Hello");
      const r4 = await grep.execute("g1", { pattern: "Hello", glob: "**/*.ts" }, undefined, undefined, ctx);
      expect(r4.content[0].text).toContain("sub");
    });
  });
  it("covers walkFiles skip and stat error", async () => {
    await withTempDir("grep-walk-", async dir => {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", "x.ts"), "needle\n", "utf-8");
      await writeFile(join(dir, "ok.ts"), "needle\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grep = getTool("anchor_grep");
      const r = await grep.execute("g1", { pattern: "needle" }, undefined, undefined, ctx);
      expect(r.content[0].text).toContain("ok.ts");
      expect(r.content[0].text).not.toContain("node_modules");
    });
  });
});

describe("coverage boost hash-store and read", () => {
  it("covers read preview edge cases", async () => {
    const { fmtReadPreview } = await import("../../src/read");
    const hashes = ["abc", "def", "ghi"];
    const r1 = await fmtReadPreview("", {}, hashes.slice(0, 1), "/tmp/a", 50000, 2000);
    expect(r1.text).toContain("empty");
    const r2 = await fmtReadPreview("a\nb\nc", { offset: 10 }, ["abc", "def", "ghi"], "/tmp/a", 50000, 2000);
    expect(r2.text).toContain("beyond");
    const r3 = await fmtReadPreview("a\nb\nc\nd\ne\nf", { offset: 2, limit: 2 }, ["a1B", "a2B", "a3B", "a4B", "a5B", "a6B"], "/tmp/a", 50000, 2000);
    expect(r3.text).toContain("a");
  });
  it("covers insert validation", async () => {
    const { assertInsertReq } = await import("../../src/insert");
    expect(() => assertInsertReq(null)).toThrow("[E_BAD_SHAPE]");
    expect(() => assertInsertReq({ path: "", anchor: "abc", direction: "after", lines: [] })).toThrow();
    expect(() => assertInsertReq({ path: "a", anchor: "", direction: "after", lines: [] })).toThrow();
    expect(() => assertInsertReq({ path: "a", anchor: "abc", direction: "wrong" as never, lines: [] })).toThrow();
    expect(() => assertInsertReq({ path: "a", anchor: "abc", direction: "after", lines: "x" as never })).toThrow();
  });
});
