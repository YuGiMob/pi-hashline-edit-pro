import { fmtRegion } from "./hashline/index.ts";
import { formatCharEscape, isFidelitySensitiveChar } from "./edit-fidelity.ts";

export const MAX_ISOLATION_ROWS = 3;

const IDENTIFIER_CHAR_RE = /^[\p{ID_Continue}$]$/u;
const DOLLAR_SIGN = 0x24;

export type IsolationSide = "before" | "after" | "both";

export interface IsolationViolation {
  readonly line: number;
  readonly column: number;
  readonly side: IsolationSide;
  readonly identifier: string;
  readonly lineText: string;
  readonly anchor: string;
}

export interface MatchScan {
  readonly occurrences: number;
  readonly violations: readonly IsolationViolation[];
}

function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

export function isIdentifierChar(codePoint: number | undefined): boolean {
  if (codePoint === undefined) return false;
  if (codePoint === DOLLAR_SIGN) return true;
  return IDENTIFIER_CHAR_RE.test(String.fromCodePoint(codePoint));
}

function identifierStart(line: string, index: number): number {
  let start = index;
  for (;;) {
    const previous = codePointBefore(line, start);
    if (!isIdentifierChar(previous)) return start;
    start -= previous! > 0xffff ? 2 : 1;
  }
}

function identifierEnd(line: string, index: number): number {
  let end = index;
  for (;;) {
    const next = line.codePointAt(end);
    if (!isIdentifierChar(next)) return end;
    end += next! > 0xffff ? 2 : 1;
  }
}

function codePointColumn(line: string, index: number): number {
  return [...line.slice(0, index)].length + 1;
}

function sideOf(leftGlued: boolean, rightGlued: boolean): IsolationSide {
  if (leftGlued && rightGlued) return "both";
  return leftGlued ? "before" : "after";
}

function violationAt(
  line: string,
  found: number,
  matchText: string,
): { side: IsolationSide; identifier: string } | undefined {
  const end = found + matchText.length;
  const leftGlued = isIdentifierChar(codePointBefore(line, found)) && isIdentifierChar(matchText.codePointAt(0));
  const rightGlued = isIdentifierChar(line.codePointAt(end)) && isIdentifierChar(codePointBefore(matchText, matchText.length));
  if (!leftGlued && !rightGlued) return undefined;
  return {
    side: sideOf(leftGlued, rightGlued),
    identifier: line.slice(identifierStart(line, found), identifierEnd(line, end)),
  };
}

export function scanMatchRange(input: {
  lines: readonly string[];
  anchors: readonly string[];
  matchText: string;
  firstLine: number;
}): MatchScan {
  if (input.matchText.length === 0) return { occurrences: 0, violations: [] };
  let occurrences = 0;
  const violations: IsolationViolation[] = [];
  for (let offset = 0; offset < input.lines.length; offset += 1) {
    const line = input.lines[offset]!;
    let cursor = 0;
    for (;;) {
      const found = line.indexOf(input.matchText, cursor);
      if (found < 0) break;
      cursor = found + input.matchText.length;
      occurrences += 1;
      const violation = violationAt(line, found, input.matchText);
      if (violation === undefined) continue;
      violations.push({
        line: input.firstLine + offset,
        column: codePointColumn(line, found),
        side: violation.side,
        identifier: violation.identifier,
        lineText: line,
        anchor: input.anchors[offset]!,
      });
    }
  }
  return { occurrences, violations };
}

function quoteText(text: string): string {
  let quoted = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (char === '"') quoted += '\\"';
    else if (char === "\\") quoted += "\\\\";
    else if (codePoint < 0x20 || isFidelitySensitiveChar(char)) quoted += formatCharEscape(char);
    else quoted += char;
  }
  return `"${quoted}"`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sidePhrase(side: IsolationSide): string {
  if (side === "both") return "both of its edges touch identifier characters";
  return side === "before" ? "its left edge touches an identifier character" : "its right edge touches an identifier character";
}

function firstViolationPerLine(violations: readonly IsolationViolation[]): IsolationViolation[] {
  const seen = new Set<number>();
  const rows: IsolationViolation[] = [];
  for (const violation of violations) {
    if (seen.has(violation.line)) continue;
    seen.add(violation.line);
    rows.push(violation);
  }
  return rows;
}

export function notIsolatedMessage(input: {
  matchText: string;
  displayPath: string;
  startLine: number;
  endLine: number;
  scan: MatchScan;
}): string {
  const { scan } = input;
  const first = scan.violations[0]!;
  const offendingRows = firstViolationPerLine(scan.violations);
  const shown = offendingRows.slice(0, MAX_ISOLATION_ROWS);
  const rows = fmtRegion(shown.map((violation) => violation.anchor), shown.map((violation) => violation.lineText));
  const hidden = offendingRows.length - shown.length;
  const more = hidden > 0 ? `\n[${plural(hidden, "more offending row")}; narrow replace_from/replace_to to inspect ${hidden === 1 ? "it" : "them"}.]` : "";
  const range = input.startLine === input.endLine ? `line ${input.startLine}` : `lines ${input.startLine}-${input.endLine}`;
  const count = scan.violations.length === scan.occurrences
    ? `all ${plural(scan.occurrences, "occurrence")}`
    : `${scan.violations.length} of the ${plural(scan.occurrences, "occurrence")}`;
  const header = `[E_MATCH_NOT_ISOLATED] "match" ${quoteText(input.matchText)} is embedded in a larger identifier in ${range} of ${input.displayPath}: ${count} touch an identifier character, so replacing every occurrence would rewrite text outside the fragment. Nothing was written.`;
  const located = `First at line ${first.line}, col ${first.column}: the occurrence sits inside ${quoteText(first.identifier)}, and ${sidePhrase(first.side)}.`;
  const rowCount = shown.length === offendingRows.length ? "Rows" : `Rows (first ${shown.length} of ${offendingRows.length})`;
  const advice = `Fix: narrow replace_from/replace_to to the rows that should change, put the whole identifier in "match" (the first is ${quoteText(first.identifier)}), or pass "allowEmbeddedMatch": true to replace inside a larger identifier on purpose.`;
  return `${header}\n\n${located}\n${rowCount}:\n\n${rows}${more}\n\n${advice}`;
}
