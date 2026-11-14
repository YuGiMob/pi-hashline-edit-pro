import { isBlankLine, splitLines } from "./utils.ts";
import { HASH_CLASS, HASH_SEP, canon } from "./hashline/index.ts";
import type { DiffSpan } from "./replace-diff.ts";

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const LOOKALIKE_DASH_RE = /[\u2010-\u2015\u2212]/u;
const LOOKALIKE_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;
const FULLWIDTH_PUNCT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xff01, 0xff0f],
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff5e],
];
const IDEOGRAPHIC_PUNCT_SUBSTITUTES: Readonly<Record<string, string>> = {
  "\u3001": ",",
  "\u3002": ".",
  "\uff61": ".",
  "\uff64": ",",
};
const FULLWIDTH_PUNCT_SUBSTITUTES: Readonly<Record<string, string>> = Object.fromEntries(
  FULLWIDTH_PUNCT_RANGES.flatMap(([start, end]): Array<[string, string]> =>
    Array.from({ length: end - start + 1 }, (_, offset): [string, string] => {
      const code = start + offset;
      return [String.fromCodePoint(code), String.fromCodePoint(code - 0xfee0)];
    }),
  ),
);
const LOOKALIKE_PUNCT_RE = new RegExp(
  `[${FULLWIDTH_PUNCT_RANGES.map(([start, end]) => `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`).join("")}${Object.keys(IDEOGRAPHIC_PUNCT_SUBSTITUTES).join("")}]`,
  "u",
);
const MAX_FIDELITY_HINTS = 3;
const INSERT_REFERENCE_WINDOW = 12;
const INDENT_REFERENCE_WINDOW = 1;
const SIMILARITY_RUN = 10;
const ECHO_TEXT_RE = /[\p{L}\p{N}]/u;
const INDENT_SIMILARITY_RUN = 14;
const CALL_HEAD_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/;
const INSERT_GRAM_BUDGET = 200_000;

const LOOKALIKE_SUBSTITUTES: Readonly<Record<string, string>> = {
  "\u00a0": " ",
  "\u1680": " ",
  "\u2000": " ",
  "\u2001": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u205f": " ",
  "\u3000": " ",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": "\"",
  "\u201d": "\"",
  ...FULLWIDTH_PUNCT_SUBSTITUTES,
  ...IDEOGRAPHIC_PUNCT_SUBSTITUTES,
};

const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);
export function isFidelitySensitiveChar(char: string): boolean {
  return char === REPLACEMENT_CHAR || INVISIBLE_RE.test(char) || LOOKALIKE_SPACE_RE.test(char) || LOOKALIKE_DASH_RE.test(char) || LOOKALIKE_QUOTE_RE.test(char) || LOOKALIKE_PUNCT_RE.test(char);
}

export function formatCharEscape(char: string): string {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return "";
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const pair = codePoint - 0x10000;
  return `\\u${(0xd800 + (pair >> 10)).toString(16).padStart(4, "0")}\\u${(0xdc00 + (pair & 0x3ff)).toString(16).padStart(4, "0")}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface ReferenceRow {
  line: string;
  index: number;
}

function hiddenCharHint(char: string, reference: ReferenceRow, liveAnchor: string | undefined, referenceAnchor: string | undefined): string {
  const column = [...reference.line].indexOf(char) + 1;
  const escape = formatCharEscape(char);
  const located = referenceAnchor === undefined
    ? `the replaced row had it at col ${column}`
    : `${referenceAnchor}${HASH_SEP} has it at col ${column}`;
  if (liveAnchor === undefined) {
    return `[H_UNICODE_LOST] "${escape}" missing; ${located}.`;
  }
  return `[H_UNICODE_LOST] ${liveAnchor}${HASH_SEP} missing "${escape}"; ${located}.`;
}

function withCharsRestored(line: string, chars: readonly string[], replacementFor: (char: string) => string): string {
  let out = line;
  for (const char of chars) out = out.split(char).join(replacementFor(char));
  return out;
}

function isDeliberateCharFix(oldLine: string, newLine: string, lostChars: readonly string[]): boolean {
  if (lostChars.length === 0) return false;
  if (withCharsRestored(oldLine, lostChars, (char) => LOOKALIKE_SUBSTITUTES[char] ?? "") === newLine) return true;
  return withCharsRestored(oldLine, lostChars, () => "") === newLine;
}

interface IndexedLine {
  line: string;
  index: number;
}

interface SwappedChar {
  oldChar: string;
  newChar: string;
  column: number;
}

interface SwapCandidate {
  reference: ReferenceRow;
  swapped: SwappedChar;
  liveAnchor?: string;
}

function containsSensitiveChar(line: string): boolean {
  return line.includes(REPLACEMENT_CHAR) || INVISIBLE_RE.test(line) || LOOKALIKE_SPACE_RE.test(line) || LOOKALIKE_DASH_RE.test(line) || LOOKALIKE_QUOTE_RE.test(line) || LOOKALIKE_PUNCT_RE.test(line);
}

function normalizeSensitiveChars(line: string): string {
  let normalized = "";
  for (const char of line) normalized += isFidelitySensitiveChar(char) ? "?" : char;
  return normalized;
}

function sensitiveStripped(line: string): string {
  let visible = "";
  for (const char of line) {
    if (!isFidelitySensitiveChar(char)) visible += char;
  }
  return visible;
}

function isLookalikeSwap(oldChar: string, newChar: string): boolean {
  if (isFidelitySensitiveChar(oldChar) && isFidelitySensitiveChar(newChar)) return true;
  return LOOKALIKE_SUBSTITUTES[newChar] === oldChar;
}
function sharesFidelityClass(left: string, right: string): boolean {
  if (left === REPLACEMENT_CHAR || right === REPLACEMENT_CHAR) return isFidelitySensitiveChar(left) || isFidelitySensitiveChar(right);
  return (
    (INVISIBLE_RE.test(left) && INVISIBLE_RE.test(right)) ||
    (LOOKALIKE_SPACE_RE.test(left) && LOOKALIKE_SPACE_RE.test(right)) ||
    (LOOKALIKE_DASH_RE.test(left) && LOOKALIKE_DASH_RE.test(right)) ||
    (LOOKALIKE_QUOTE_RE.test(left) && LOOKALIKE_QUOTE_RE.test(right)) ||
    (LOOKALIKE_PUNCT_RE.test(left) && LOOKALIKE_PUNCT_RE.test(right)) ||
    LOOKALIKE_SUBSTITUTES[left] === right
  );
}

interface SubstituteMatch {
  value: string;
  payloadIndex: number;
  column: number;
}

interface SubstituteRank {
  echo: boolean;
  aligned: boolean;
  distance: number;
}

function preferSubstitute(candidate: SubstituteRank, best: SubstituteRank | undefined): boolean {
  if (best === undefined) return true;
  if (candidate.echo !== best.echo) return candidate.echo;
  if (candidate.aligned !== best.aligned) return candidate.aligned;
  return candidate.distance < best.distance;
}

function findSubstitute(char: string, reference: ReferenceRow, payload: readonly string[]): SubstituteMatch | undefined {
  const referenceChars = [...reference.line];
  const column = referenceChars.indexOf(char);
  const visibleReference = sensitiveStripped(reference.line);
  let best: SubstituteMatch | undefined;
  let bestRank: SubstituteRank | undefined;
  for (let index = 0; index < payload.length; index += 1) {
    const line = payload[index]!;
    const candidateChars = [...line];
    const echo = sensitiveStripped(line) === visibleReference;
    const sameLength = candidateChars.length === referenceChars.length;
    for (let at = 0; at < candidateChars.length; at += 1) {
      const candidate = candidateChars[at]!;
      if (candidate === char || !sharesFidelityClass(char, candidate)) continue;
      const rank = { echo, aligned: sameLength && at === column, distance: Math.abs(at - column) };
      if (!preferSubstitute(rank, bestRank)) continue;
      bestRank = rank;
      best = { value: candidate, payloadIndex: index, column: at + 1 };
    }
  }
  return best;
}

function swappedCharPair(oldLine: string, newLine: string): SwappedChar | undefined {
  const oldChars = [...oldLine];
  const newChars = [...newLine];
  if (oldChars.length !== newChars.length) return undefined;
  let swapped: SwappedChar | undefined;
  for (let index = 0; index < oldChars.length; index += 1) {
    const oldChar = oldChars[index]!;
    const newChar = newChars[index]!;
    if (oldChar === newChar) continue;
    if (!isLookalikeSwap(oldChar, newChar)) return undefined;
    swapped ??= { oldChar, newChar, column: index + 1 };
  }
  return swapped;
}

function swappedCandidate(line: string, matches: IndexedLine[], spanStart: number, spanEnd: number): SwapCandidate | undefined {
  const candidates: SwapCandidate[] = [];
  for (const match of matches) {
    if (match.line === line) continue;
    const swapped = swappedCharPair(match.line, line);
    if (swapped === undefined) continue;
    candidates.push({ reference: { line: match.line, index: match.index }, swapped });
  }
  return candidates.find((candidate) => candidate.reference.index >= spanStart && candidate.reference.index <= spanEnd) ?? candidates[0];
}

function swappedCharHint(swapped: SwappedChar, liveAnchor: string | undefined, referenceAnchor: string | undefined): string {
  const newEscape = formatCharEscape(swapped.newChar);
  const oldEscape = formatCharEscape(swapped.oldChar);
  if (liveAnchor === undefined) {
    const label = referenceAnchor === undefined ? "the replaced line" : `${referenceAnchor}${HASH_SEP}`;
    return `[H_UNICODE_SWAPPED] "${newEscape}" at col ${swapped.column} where ${label} has "${oldEscape}".`;
  }
  const referenceNote = referenceAnchor === undefined ? `; expected "${oldEscape}"` : `; ${referenceAnchor}${HASH_SEP} has "${oldEscape}"`;
  return `[H_UNICODE_SWAPPED] ${liveAnchor}${HASH_SEP} has "${newEscape}" at col ${swapped.column}${referenceNote}.`;
}

function trailingWhitespaceHint(oldLine: string, newLine: string, anchor: string | undefined): string {
  const oldTrail = oldLine.length - oldLine.trimEnd().length;
  const newTrail = newLine.length - newLine.trimEnd().length;
  const column = newLine.trimEnd().length + 1;
  const label = anchor === undefined ? "the replaced line" : `${anchor}${HASH_SEP}`;
  return `[H_TRAILING_WHITESPACE] ${plural(newTrail, "trailing whitespace character")} at col ${column}; ${label} had ${oldTrail}.`;
}

function leadingWhitespace(line: string): string {
  const trimmed = line.trimStart();
  return line.slice(0, line.length - trimmed.length);
}

function sameCallHead(payloadLine: string, referenceLine: string): boolean {
  const left = CALL_HEAD_RE.exec(payloadLine.trimStart())?.[0];
  const right = CALL_HEAD_RE.exec(referenceLine.trimStart())?.[0];
  return left !== undefined && left === right;
}

function indentMismatchHint(
  payloadLine: string,
  reference: ReferenceRow,
  newAnchor: string | undefined,
  referenceAnchor: string | undefined,
): string | undefined {
  const payloadIndent = leadingWhitespace(payloadLine);
  const referenceIndent = leadingWhitespace(reference.line);
  if (payloadIndent.length >= referenceIndent.length || !referenceIndent.startsWith(payloadIndent)) return undefined;
  const grams = gramSet([payloadLine], INDENT_SIMILARITY_RUN);
  const sharesLongRun = grams !== undefined && sharesRun(reference.line, grams, INDENT_SIMILARITY_RUN);
  if (!sharesLongRun && !sameCallHead(payloadLine, reference.line)) return undefined;
  const count = plural(payloadIndent.length, "leading whitespace character");
  const referenceLabel = referenceAnchor === undefined ? "the nearby line" : `neighboring line ${referenceAnchor}${HASH_SEP}`;
  const newLabel = newAnchor === undefined ? "new line" : `new line ${newAnchor}${HASH_SEP}`;
  return `[H_INDENT_MISMATCH] ${newLabel} has ${count}; ${referenceLabel} has ${referenceIndent.length}.`;
}

function referenceRows(lines: string[], start: number, end: number): ReferenceRow[] {
  const from = Math.max(0, start - INSERT_REFERENCE_WINDOW);
  const to = Math.min(lines.length - 1, end + INSERT_REFERENCE_WINDOW);
  const rows: ReferenceRow[] = [];
  for (let index = from; index <= to; index++) rows.push({ line: lines[index]!, index });
  return rows;
}

function separatorMovedHint(
  oldLines: string[],
  anchorIndex: number,
  carried: number | undefined,
  payload: string[],
  anchor: string | undefined,
): string | undefined {
  if (carried === undefined || payload.length < 2) return undefined;
  const anchorLine = oldLines[anchorIndex] ?? "";
  if (anchorLine.trim().length === 0) return undefined;
  let side: "before" | "after";
  if (carried === 0) {
    if (anchorIndex + 1 >= oldLines.length || !isBlankLine(oldLines[anchorIndex + 1])) return undefined;
    if ((payload[0] ?? "").trim().length === 0) return undefined;
    side = "after";
  } else if (carried === payload.length) {
    if (anchorIndex === 0 || !isBlankLine(oldLines[anchorIndex - 1])) return undefined;
    if ((payload[payload.length - 1] ?? "").trim().length === 0) return undefined;
    side = "before";
  } else {
    return undefined;
  }
  const label = anchor === undefined ? "the anchor line" : `${anchor}${HASH_SEP}`;
  return `[H_SEPARATOR_MOVED] blank separator ${side === "before" ? "above" : "below"} ${label} was displaced; add a blank line ${side} ${label} if unintended.`;
}

function gramSet(lines: readonly string[], size: number, requireText = false): Set<string> | undefined {
  const grams = new Set<string>();
  let total = 0;
  for (const line of lines) {
    total += line.length;
    if (total > INSERT_GRAM_BUDGET) return undefined;
    const chars = [...line];
    for (let index = 0; index + size <= chars.length; index += 1) {
      const gram = chars.slice(index, index + size).join("");
      if (requireText && !ECHO_TEXT_RE.test(gram)) continue;
      grams.add(gram);
    }
  }
  return grams;
}

function sharesRun(line: string, grams: Set<string>, size: number): boolean {
  const chars = [...line];
  for (let index = 0; index + size <= chars.length; index += 1) {
    if (grams.has(chars.slice(index, index + size).join(""))) return true;
  }
  return false;
}

const LITERAL_ESCAPE_HINT_PREFIX = "[H_LITERAL_ESCAPE] ";
const LITERAL_ESCAPE_TEXT_RE = /^\[H_LITERAL_ESCAPE\] [^:]*: "(.*)" written as literal text$/;
const MAX_LITERAL_ESCAPE_ROWS = 3;

function literalEscapeColumn(line: string, escape: string): number {
  const index = line.indexOf(escape);
  return index < 0 ? 1 : [...line.slice(0, index)].length + 1;
}

function literalEscapeHintRows(
  resultContent: string,
  spans: readonly DiffSpan[],
  resultHashes: readonly string[],
  escape: string,
): ReferenceRow[] {
  const newLines = splitLines(resultContent);
  const rows: ReferenceRow[] = [];
  let offset = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    for (let index = 0; index < inserted.length; index += 1) {
      if (span.carry === index) continue;
      const line = inserted[index]!;
      if (!line.includes(escape)) continue;
      const resultIndex = span.start + offset + index;
      if (resultIndex >= 0 && resultIndex < resultHashes.length) rows.push({ line, index: resultIndex });
    }
    offset += span.replacementCount - removedCount;
  }
  return rows;
}

export function annotateLiteralEscapeHints(
  hints: string[],
  resultContent: string,
  spans: readonly DiffSpan[] | undefined,
  resultHashes: readonly string[],
): string[] {
  if (spans === undefined || spans.length === 0) return hints;
  return hints.map((hint) => {
    if (!hint.startsWith(LITERAL_ESCAPE_HINT_PREFIX)) return hint;
    const escape = LITERAL_ESCAPE_TEXT_RE.exec(hint)?.[1];
    if (escape === undefined || escape.length === 0) return hint;
    const rows = literalEscapeHintRows(resultContent, spans, resultHashes, escape);
    if (rows.length === 0) return hint;
    if (rows.length > MAX_LITERAL_ESCAPE_ROWS) {
      return `${hint} on ${plural(rows.length, "row")}; undo_last_change if unintended.`;
    }
    const locations = rows.map((row) => `${resultHashes[row.index]!}${HASH_SEP} col ${literalEscapeColumn(row.line, escape)}`).join(", ");
    return `${hint} (${locations}).`;
  });
}

const LITERAL_ESCAPE_DETAIL_RE = /^\[H_LITERAL_ESCAPE\] [^:]*: "(.*?)" written as literal text(?: \((.*)\))?\.?$/;
const LITERAL_ESCAPE_ANCHOR_RE = new RegExp(`(${HASH_CLASS})│`, "g");
const UNICODE_LOST_DETAIL_RE = new RegExp(`^\\[H_UNICODE_LOST\\] (${HASH_CLASS})│ missing "([^"]*)"`);

export function dedupeLiteralEscapeHints(hints: readonly string[]): string[] {
  const suppressed = new Set<string>();
  for (const hint of hints) {
    const literal = LITERAL_ESCAPE_DETAIL_RE.exec(hint);
    if (literal === null) continue;
    const escape = literal[1] ?? "";
    for (const anchor of (literal[2] ?? "").matchAll(LITERAL_ESCAPE_ANCHOR_RE)) suppressed.add(`${anchor[1]}\0${escape}`);
  }
  if (suppressed.size === 0) return [...hints];
  return hints.filter((hint) => {
    const lost = UNICODE_LOST_DETAIL_RE.exec(hint);
    return lost === null || !suppressed.has(`${lost[1]}\0${lost[2]}`);
  });
}

function separatorLostHint(oldLines: string[], span: DiffSpan, originalHashes?: readonly string[]): string | undefined {
  if (span.replacementCount !== 0 || span.end < span.start) return undefined;
  const beforeIndex = span.start - 1;
  const afterIndex = span.end + 1;
  if (beforeIndex < 0 || afterIndex >= oldLines.length) return undefined;
  for (let index = span.start; index <= span.end; index += 1) {
    if (!isBlankLine(oldLines[index])) return undefined;
  }
  if (isBlankLine(oldLines[beforeIndex]) || isBlankLine(oldLines[afterIndex])) return undefined;
  const before = originalHashes?.[beforeIndex];
  const after = originalHashes?.[afterIndex];
  if (before === undefined || after === undefined) return undefined;
  return `[H_SEPARATOR_LOST] deletion removed ${plural(span.end - span.start + 1, "blank line")} between ${before}${HASH_SEP} and ${after}${HASH_SEP}.`;
}

export function fidelityHints(
  originalContent: string,
  resultContent: string,
  spans: readonly DiffSpan[] | undefined,
  originalHashes?: readonly string[],
  options?: { separatorMoved?: boolean; indentHints?: boolean; resultHashes?: readonly string[] },
): string[] {
  if (spans === undefined || spans.length === 0) return [];
  const oldLines = splitLines(originalContent);
  const newLines = splitLines(resultContent);
  const resultHashes = options?.resultHashes;
  const hints: string[] = [];
  const seen = new Set<string>();
  let sensitiveIndex: Map<string, IndexedLine[]> | undefined;
  const sensitiveLines = (): Map<string, IndexedLine[]> => {
    if (sensitiveIndex === undefined) {
      sensitiveIndex = new Map();
      for (let index = 0; index < oldLines.length; index += 1) {
        const line = oldLines[index]!;
        if (!containsSensitiveChar(line)) continue;
        const key = normalizeSensitiveChars(line);
        const list = sensitiveIndex.get(key) ?? [];
        list.push({ line, index });
        sensitiveIndex.set(key, list);
      }
    }
    return sensitiveIndex;
  };
  let offset = 0;
  const removedByAnySpan = (index: number): boolean =>
    spans.some((candidate) => index >= candidate.start && index <= candidate.end);
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const removed = removedCount > 0 ? oldLines.slice(span.start, span.end + 1) : [];
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    if (removed.length > 0 && inserted.length > 0) {
      const carried = span.carry;
      const payload = carried === undefined ? inserted : inserted.filter((_, index) => index !== carried);
      const payloadText = payload.join("\n");
      const references: ReferenceRow[] = carried === undefined
        ? removed.map((line, index) => ({ line, index: span.start + index }))
        : referenceRows(oldLines, span.start, span.end);
      const insertGate = carried === undefined ? null : (gramSet(payload, SIMILARITY_RUN, true) ?? new Set<string>());
      const resultIndexForPayload = (payloadIndex: number): number =>
        span.start + offset + (carried !== undefined && payloadIndex >= carried ? payloadIndex + 1 : payloadIndex);
      const referenceSurvives = (reference: ReferenceRow): boolean =>
        (carried !== undefined && reference.index === span.start && inserted[carried] === oldLines[reference.index]) ||
        !removedByAnySpan(reference.index);
      const liveAnchorForPayload = (payloadIndex: number): string | undefined =>
        resultHashes?.[resultIndexForPayload(payloadIndex)];
      const payloadIndexSharingRun = (line: string): number => {
        const grams = gramSet([sensitiveStripped(line)], SIMILARITY_RUN);
        return grams === undefined ? -1 : payload.findIndex((candidate) => sharesRun(sensitiveStripped(candidate), grams, SIMILARITY_RUN));
      };
      const liveAnchorForReference = (reference: ReferenceRow): string | undefined => {
        const shared = payloadIndexSharingRun(reference.line);
        if (shared >= 0) return liveAnchorForPayload(shared);
        if (carried !== undefined || removed.length !== payload.length) return undefined;
        const payloadIndex = reference.index - span.start;
        return payloadIndex >= 0 && payloadIndex < payload.length ? liveAnchorForPayload(payloadIndex) : undefined;
      };
      const referenceAnchorFor = (reference: ReferenceRow): string | undefined =>
        referenceSurvives(reference) ? originalHashes?.[reference.index] : undefined;
      const swapKeys = new Set<string>();
      const swaps: SwapCandidate[] = [];
      let candidates: Map<string, IndexedLine[]> | undefined;
      for (let payloadIndex = 0; payloadIndex < payload.length; payloadIndex += 1) {
        const line = payload[payloadIndex]!;
        if (!containsSensitiveChar(line)) continue;
        candidates ??= sensitiveLines();
        const matches = [...(candidates.get(normalizeSensitiveChars(line)) ?? []), ...references];
        const candidate = swappedCandidate(line, matches, span.start, span.end);
        if (candidate === undefined) continue;
        const key = `${candidate.reference.index}:${candidate.swapped.oldChar}`;
        if (swapKeys.has(key)) continue;
        swapKeys.add(key);
        swaps.push({ ...candidate, liveAnchor: liveAnchorForPayload(payloadIndex) });
      }
      const missing = new Map<string, ReferenceRow>();
      for (const reference of references) {
        if (insertGate !== null && !sharesRun(reference.line, insertGate, SIMILARITY_RUN)) continue;
        for (const char of reference.line) {
          if (missing.has(char) || !isFidelitySensitiveChar(char) || payloadText.includes(char)) continue;
          if (swapKeys.has(`${reference.index}:${char}`)) continue;
          missing.set(char, reference);
        }
      }
      if (carried === undefined && removed.length === 1 && inserted.length === 1) {
        const chars = [...missing.keys()];
        if (isDeliberateCharFix(removed[0]!, inserted[0]!, chars)) missing.clear();
      }
      for (const [char, reference] of missing) {
        if (seen.has(char) || hints.length >= MAX_FIDELITY_HINTS) continue;
        seen.add(char);
        const substitute = findSubstitute(char, reference, payload);
        if (substitute !== undefined) {
          seen.add(`swap:${reference.index}:${char}`);
          hints.push(swappedCharHint({ oldChar: char, newChar: substitute.value, column: substitute.column }, liveAnchorForPayload(substitute.payloadIndex), referenceAnchorFor(reference)));
          continue;
        }
        hints.push(hiddenCharHint(char, reference, liveAnchorForReference(reference), referenceAnchorFor(reference)));
      }
      for (const candidate of swaps) {
        if (hints.length >= MAX_FIDELITY_HINTS) break;
        const key = `swap:${candidate.reference.index}:${candidate.swapped.oldChar}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push(swappedCharHint(candidate.swapped, candidate.liveAnchor, referenceAnchorFor(candidate.reference)));
      }
      const indentReferenceFor = (payloadIndex: number): ReferenceRow | undefined => {
        if (options?.indentHints === false) return undefined;
        if (carried !== undefined) {
          let nearest: ReferenceRow | undefined;
          let nearestDistance = Number.POSITIVE_INFINITY;
          for (const candidate of references) {
            if (candidate.index < span.start - INDENT_REFERENCE_WINDOW || candidate.index > span.end + INDENT_REFERENCE_WINDOW) continue;
            if (indentMismatchHint(payload[payloadIndex]!, candidate, undefined, undefined) === undefined) continue;
            const distance = Math.abs(candidate.index - span.start);
            if (distance < nearestDistance) {
              nearest = candidate;
              nearestDistance = distance;
            }
          }
          return nearest;
        }
        if (removed.length === payload.length) {
          return { line: removed[payloadIndex]!, index: span.start + payloadIndex };
        }
        return undefined;
      };
      for (let index = 0; index < payload.length; index += 1) {
        if (hints.length >= MAX_FIDELITY_HINTS) break;
        const payloadLine = payload[index]!;
        const reference = indentReferenceFor(index);
        if (reference === undefined) continue;
        const indentHint = indentMismatchHint(payloadLine, reference, resultHashes?.[resultIndexForPayload(index)], originalHashes?.[reference.index]);
        if (indentHint === undefined) continue;
        const key = `indent:${reference.index}:${payloadLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push(indentHint);
      }
      if (options?.separatorMoved) {
        const separatorHint = separatorMovedHint(oldLines, span.start, carried, payload, originalHashes?.[span.start]);
        if (separatorHint !== undefined && hints.length < MAX_FIDELITY_HINTS) hints.push(separatorHint);
      }
      if (carried === undefined && removed.length === inserted.length) {
        for (let index = 0; index < removed.length; index += 1) {
          if (hints.length >= MAX_FIDELITY_HINTS) break;
          const oldLine = removed[index]!;
          const newLine = inserted[index]!;
          if (oldLine === newLine || canon(oldLine) !== canon(newLine)) continue;
          const key = `trailing:${span.start + index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hints.push(trailingWhitespaceHint(oldLine, newLine, originalHashes?.[span.start + index]));
        }
      }
    }
    if (removed.length > 0 && inserted.length === 0) {
      const lost = separatorLostHint(oldLines, span, originalHashes);
      if (lost !== undefined && hints.length < MAX_FIDELITY_HINTS) hints.push(lost);
    }
    offset += span.replacementCount - removedCount;
  }
  return hints;
}
