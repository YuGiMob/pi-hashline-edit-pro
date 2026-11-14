import { describe, expect, it } from "vitest";
import { isIdentifierChar, notIsolatedMessage, scanMatchRange } from "../../src/match-isolation";

const ANCHORS = ["abcde", "fghij", "klmno", "pqrst"];

function scan(lines: string[], matchText: string, firstLine = 1) {
  return scanMatchRange({
    lines,
    anchors: lines.map((_, index) => ANCHORS[index % ANCHORS.length]!),
    matchText,
    firstLine,
  });
}

describe("isIdentifierChar", () => {
  it("accepts letters, digits, $, _, and Unicode identifier characters", () => {
    for (const char of ["a", "Z", "0", "9", "$", "_", "é", "λ", "漢"]) {
      expect(isIdentifierChar(char.codePointAt(0))).toBe(true);
    }
  });

  it("accepts astral identifier characters and rejects astral emoji", () => {
    expect(isIdentifierChar(0x1d465)).toBe(true);
    expect(isIdentifierChar(0x1f600)).toBe(false);
  });

  it("rejects whitespace, punctuation, and a missing character", () => {
    for (const char of [" ", "\t", "-", ".", '"', "(", "，", "—", "😀"]) {
      expect(isIdentifierChar(char.codePointAt(0))).toBe(false);
    }
    expect(isIdentifierChar(undefined)).toBe(false);
  });
});

describe("scanMatchRange", () => {
  it("counts occurrences and flags a match embedded on the left", () => {
    const result = scan(["const ThemeContext = 1;"], "Context");
    expect(result.occurrences).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      line: 1,
      column: 12,
      side: "before",
      identifier: "ThemeContext",
      lineText: "const ThemeContext = 1;",
      anchor: "abcde",
    });
  });

  it("flags a match embedded on the right and on both sides", () => {
    expect(scan(["createContext"], "create").violations[0]).toMatchObject({ side: "after", identifier: "createContext" });
    expect(scan(["aXb"], "X").violations[0]).toMatchObject({ side: "both", identifier: "aXb" });
  });

  it("leaves standalone tokens alone", () => {
    const result = scan(["const x = Theme;", "Theme", " Theme ", "Theme.", "(Theme)"], "Theme");
    expect(result.occurrences).toBe(5);
    expect(result.violations).toEqual([]);
  });

  it("treats $ and _ as identifier characters", () => {
    const dollar = scan(["const total = $price;"], "price");
    expect(dollar.violations[0]).toMatchObject({ side: "before", identifier: "$price" });
    expect(scan(["const price_total = 1;"], "price").violations[0]).toMatchObject({ side: "after", identifier: "price_total" });
    expect(scan(["_price"], "price").violations[0]).toMatchObject({ side: "before", identifier: "_price" });
  });

  it("treats digits and combining marks as identifier characters", () => {
    expect(scan(["const id = 13;"], "3").violations[0]).toMatchObject({ side: "before", identifier: "13" });
    expect(scan(["cafe\u0301"], "cafe").violations[0]).toMatchObject({ side: "after", identifier: "cafe\u0301" });
  });

  it("counts columns in code points and reads astral neighbours whole", () => {
    const result = scan(["const 𝑥y = 1;"], "y");
    expect(result.violations[0]).toMatchObject({ side: "before", column: 8, identifier: "𝑥y" });
  });

  it("reports non-overlapping occurrences only", () => {
    const result = scan(["aa-aa"], "aa");
    expect(result.occurrences).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it("numbers violation lines from firstLine", () => {
    const result = scan(["skip", "const createContext = 1;"], "Context", 20);
    expect(result.violations[0]!.line).toBe(21);
  });

  it("returns an empty scan for an empty match", () => {
    expect(scan(["anything"], "")).toEqual({ occurrences: 0, violations: [] });
  });
});

describe("notIsolatedMessage", () => {
  const LINES = [
    "import { hono } from \"hono\";",
    "const ThemeContext = createContext<Theme>(null);",
    "const SessionContext = createContext<Session>(null);",
    "const OtherContext = 1;",
    "const LaterContext = 2;",
  ];

  it("names the first offending position, limits the rows, and suggests the opt-out", () => {
    const result = scan(LINES, "Context", 10);
    const message = notIsolatedMessage({ matchText: "Context", displayPath: "src/app.ts", startLine: 10, endLine: 14, scan: result });
    expect(message).toContain("[E_MATCH_NOT_ISOLATED]");
    expect(message).toContain("lines 10-14 of src/app.ts");
    expect(message).toContain("all 6 occurrences");
    expect(message).toContain("First at line 11, col 12");
    expect(message).toContain('"ThemeContext"');
    expect(message).toContain("its left edge touches an identifier character");
    expect(message).toContain("Rows (first 3 of 4)");
    expect(message).toContain('fghij│const ThemeContext = createContext<Theme>(null);');
    expect(message).toContain("[1 more offending row;");
    expect(message).toContain('pass "allowEmbeddedMatch": true');
  });

  it("reports the mixed case and a single row without a cap note", () => {
    const result = scan(["const theme = ThemeContext;", "const ctx = createThemeContext(null);"], "ThemeContext");
    const message = notIsolatedMessage({ matchText: "ThemeContext", displayPath: "app.ts", startLine: 1, endLine: 2, scan: result });
    expect(message).toContain("1 of the 2 occurrences");
    expect(message).not.toContain("more embedded occurrence");
    expect(message).toContain("Rows:");
    expect(message).toContain("const ctx = createThemeContext(null);");
  });

  it("escapes an invisible character in the quoted match", () => {
    const result = scan(["xab\u200bcd"], "ab\u200b");
    const message = notIsolatedMessage({ matchText: "ab\u200b", displayPath: "app.ts", startLine: 1, endLine: 1, scan: result });
    expect(message).toContain(String.raw`"ab\u200b"`);
  });
});
