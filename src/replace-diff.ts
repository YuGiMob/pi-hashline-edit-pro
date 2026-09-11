import * as Diff from "diff";
import { formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  _lineHashesPure,
  ANCHOR_LEN,
  HASH_SEP,
  changedRange,
} from "./hashline";
import { MAX_DIFF_INPUT_BYTES } from "./constants";
import { splitLines } from "./utils";
import {
  detectEnding,
  toLF,
  restoreEndings,
  stripBOM,
  type LineEnding,
} from "./normalize";

export { detectEnding, toLF, restoreEndings, stripBOM, type LineEnding };

export interface DiffSpan {
  start: number;
  end: number;
  replacementCount: number;
}

interface PlacedSpan {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function fmtDiffLine(
  prefix: " " | "+" | "-",
  line: string,
  hash: string | undefined,
): string {
  if (hash === undefined) {
    return `${prefix}${" ".repeat(ANCHOR_LEN)}${HASH_SEP}${line}`;
  }
  return `${prefix}${hash}${HASH_SEP}${line}`;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

const ELLIPSIS_MARKER: unique symbol = Symbol("ellipsis");
const isEllipsisMarker = (line: string | symbol): line is symbol =>
  line === ELLIPSIS_MARKER;

export interface DiffLimits {
  maxLineBytes?: number;
  maxBytes?: number;
  unlimited?: boolean;
}

export function spansFromHashes(oldHashes: string[], newHashes: string[]): DiffSpan[] {
  const parts = Diff.diffArrays(oldHashes, newHashes) as unknown as Array<{ added?: boolean; removed?: boolean; count?: number; value?: string[] }>;
  const spans: DiffSpan[] = [];
  let oldIdx = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    const isChange = part.added === true || part.removed === true;
    if (!isChange) {
      const count = part.count ?? part.value?.length ?? 0;
      oldIdx += count;
      i += 1;
      continue;
    }
    const runStart = oldIdx;
    let removedTotal = 0;
    let addedTotal = 0;
    while (i < parts.length) {
      const runPart = parts[i]!;
      const runChange = runPart.added === true || runPart.removed === true;
      if (!runChange) break;
      const count = runPart.count ?? runPart.value?.length ?? 0;
      if (runPart.removed === true && runPart.added !== true) {
        removedTotal += count;
        oldIdx += count;
      } else if (runPart.added === true && runPart.removed !== true) {
        addedTotal += count;
      } else {
        removedTotal += count;
        addedTotal += count;
        oldIdx += count;
      }
      i += 1;
    }
    spans.push({
      start: runStart,
      end: runStart + removedTotal - 1,
      replacementCount: addedTotal,
    });
  }
  return spans;
}

const ANCHORED_DIFF_ROW_RE = /^([+ -])([A-Za-z0-9]{4})│/;

export function disambiguateDuplicateAnchors(diff: string): string {
  if (!diff.includes("│")) return diff;
  const live = new Set<string>();
  const lines = diff.split("\n");
  for (const line of lines) {
    const match = ANCHORED_DIFF_ROW_RE.exec(line);
    if (!match) continue;
    const prefix = match[1]!;
    const anchor = match[2]!;
    if (prefix === "+" || prefix === " ") live.add(anchor);
  }
  if (live.size === 0) return diff;
  let changed = false;
  const out = lines.map((line) => {
    const match = ANCHORED_DIFF_ROW_RE.exec(line);
    if (!match || match[1] !== "-") return line;
    if (!live.has(match[2]!)) return line;
    changed = true;
    return `-    │${line.slice(match[0].length)}`;
  });
  return changed ? out.join("\n") : diff;
}

function placeSpans(
  oldLen: number,
  newLen: number,
  spans: DiffSpan[],
): PlacedSpan[] | undefined {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const span of sorted) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || !Number.isInteger(span.replacementCount)) return undefined;
    if (span.replacementCount < 0) return undefined;
    if (span.start > span.end) {
      if (span.end !== span.start - 1) return undefined;
      if (span.start < 0 || span.start > oldLen) return undefined;
    } else {
      if (span.start < 0 || span.end >= oldLen) return undefined;
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start <= sorted[i - 1]!.end) return undefined;
  }
  const placed: PlacedSpan[] = [];
  let offset = 0;
  let removedSum = 0;
  let addedSum = 0;
  for (const span of sorted) {
    const spanLen = Math.max(0, span.end - span.start + 1);
    const newStart = span.start + offset;
    const newEnd = newStart + span.replacementCount - 1;
    if (newStart < 0 || newStart > newLen) return undefined;
    if (span.replacementCount === 0) {
      if (newEnd !== newStart - 1) return undefined;
    } else if (newEnd >= newLen) return undefined;
    placed.push({ oldStart: span.start, oldEnd: span.end, newStart, newEnd });
    offset += span.replacementCount - spanLen;
    removedSum += spanLen;
    addedSum += span.replacementCount;
  }
  if (oldLen - removedSum + addedSum !== newLen) return undefined;
  return placed;
}

function trimPlacedSpans(
  placed: PlacedSpan[],
  oldLines: string[],
  newLines: string[],
): PlacedSpan[] {
  const out: PlacedSpan[] = [];
  for (const span of placed) {
    let oldStart = span.oldStart;
    let oldEnd = span.oldEnd;
    let newStart = span.newStart;
    let newEnd = span.newEnd;
    while (oldStart <= oldEnd && newStart <= newEnd && oldLines[oldStart] === newLines[newStart]) {
      oldStart += 1;
      newStart += 1;
    }
    while (oldStart <= oldEnd && newStart <= newEnd && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    if (oldStart > oldEnd && newStart > newEnd) continue;
    out.push({ oldStart, oldEnd, newStart, newEnd });
  }
  return out;
}

function genSpanDiff(
  oldContent: string,
  newContent: string,
  contextLines: number,
  newHashes: string[],
  oldHashes: string[],
  maxLineBytes: number,
  maxBytes: number,
  spans: DiffSpan[],
): { diff: string; firstChangedLine: number | undefined; lineNumbers: (number | undefined)[] } | undefined {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  if (oldHashes.length !== oldLines.length || newHashes.length !== newLines.length) return undefined;
  const placed = placeSpans(oldLines.length, newLines.length, spans);
  if (!placed) return undefined;
  const trimmed = trimPlacedSpans(placed, oldLines, newLines);
  const ordered = [...trimmed].sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart);
  let oldPos = 0;
  let newPos = 0;
  for (const span of ordered) {
    if (span.oldStart < oldPos || span.newStart < newPos) return undefined;
    const gapOld = span.oldStart - oldPos;
    const gapNew = span.newStart - newPos;
    if (gapOld !== gapNew || gapOld < 0) return undefined;
    oldPos = span.oldEnd + 1;
    newPos = span.newEnd + 1;
  }
  if (oldLines.length - ordered.reduce((sum, span) => sum + Math.max(0, span.oldEnd - span.oldStart + 1), 0) + ordered.reduce((sum, span) => sum + Math.max(0, span.newEnd - span.newStart + 1), 0) !== newLines.length) {
    return undefined;
  }
  const output: string[] = [];
  const lineNumbers: (number | undefined)[] = [];
  let firstChangedLine: number | undefined;
  let outBytes = 0;
  let stopped = false;
  let diffTruncated = false;
  const emitPlain = (line: string, num?: number): void => {
    if (stopped) return;
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (outBytes + lineBytes > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += lineBytes;
    output.push(line);
    lineNumbers.push(num);
  };
  const emitRow = (prefix: " " | "+" | "-", line: string, hash: string | undefined, num?: number): void => {
    if (stopped) return;
    const full = fmtDiffLine(prefix, line, hash);
    const rowBytes = Buffer.byteLength(full, "utf-8");
    if (rowBytes > maxLineBytes) {
      const marker = `[Row is ${formatSize(rowBytes)}, exceeds ${formatSize(maxLineBytes)}; content not shown. Use read to see the full line.]`;
      emitPlain(fmtDiffLine(prefix, marker, hash), num);
      return;
    }
    if (outBytes + rowBytes + 1 > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += rowBytes + 1;
    output.push(full);
    lineNumbers.push(num);
  };
  const emitGap = (gapStartNew: number, gapLen: number, position: "leading" | "middle" | "trailing"): void => {
    if (stopped || gapLen <= 0) return;
    if (position === "leading") {
      let count = contextLines;
      if (contextLines > 0 && gapLen > count && isBlankLine(newLines[gapStartNew + gapLen - 1]!)) count += 1;
      count = Math.min(count, gapLen);
      const skipStart = gapLen - count;
      if (skipStart > 0) emitPlain(" ...", undefined);
      for (let k = gapLen - count; k < gapLen && !stopped; k++) {
        const newIdx = gapStartNew + k;
        emitRow(" ", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
      }
      return;
    }
    if (position === "trailing") {
      let count = contextLines;
      if (contextLines > 0 && gapLen > count && isBlankLine(newLines[gapStartNew]!)) count += 1;
      count = Math.min(count, gapLen);
      for (let k = 0; k < count && !stopped; k++) {
        const newIdx = gapStartNew + k;
        emitRow(" ", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
      }
      if (gapLen > count) emitPlain(" ...", undefined);
      return;
    }
    let headCount = contextLines;
    let tailCount = contextLines;
    if (contextLines > 0 && gapLen - headCount > tailCount && isBlankLine(newLines[gapStartNew + headCount - 1]!)) headCount += 1;
    if (contextLines > 0 && gapLen - tailCount > headCount && isBlankLine(newLines[gapStartNew + gapLen - tailCount]!)) tailCount += 1;
    const middleLen = gapLen - headCount - tailCount;
    if (middleLen <= 0) {
      for (let k = 0; k < gapLen && !stopped; k++) {
        const newIdx = gapStartNew + k;
        emitRow(" ", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
      }
      return;
    }
    for (let k = 0; k < headCount && !stopped; k++) {
      const newIdx = gapStartNew + k;
      emitRow(" ", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
    }
    if (!stopped) emitPlain(" ...", undefined);
    for (let k = gapLen - tailCount; k < gapLen && !stopped; k++) {
      const newIdx = gapStartNew + k;
      emitRow(" ", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
    }
  };
  oldPos = 0;
  newPos = 0;
  for (let spanIdx = 0; spanIdx < ordered.length && !stopped; spanIdx++) {
    const span = ordered[spanIdx]!;
    const gapLen = span.oldStart - oldPos;
    emitGap(newPos, gapLen, spanIdx === 0 ? "leading" : "middle");
    if (stopped) break;
    if (firstChangedLine === undefined) firstChangedLine = span.newStart + 1;
    for (let oldIdx = span.oldStart; oldIdx <= span.oldEnd && !stopped; oldIdx++) {
      emitRow("-", oldLines[oldIdx]!, oldHashes[oldIdx], oldIdx + 1);
    }
    for (let newIdx = span.newStart; newIdx <= span.newEnd && !stopped; newIdx++) {
      emitRow("+", newLines[newIdx]!, newHashes[newIdx], newIdx + 1);
    }
    oldPos = span.oldEnd + 1;
    newPos = span.newEnd + 1;
  }
  if (!stopped) {
    const trailingLen = oldLines.length - oldPos;
    emitGap(newPos, trailingLen, "trailing");
  }
  if (diffTruncated) {
    output.push(" ...");
    lineNumbers.push(undefined);
    output.push(`[diff truncated at ${formatSize(maxBytes)}; use read to see the rest.]`);
    lineNumbers.push(undefined);
  }
  return { diff: output.join("\n"), firstChangedLine, lineNumbers };
}

export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
  limits?: DiffLimits,
  spans?: DiffSpan[],
): { diff: string; firstChangedLine: number | undefined; lineNumbers: (number|undefined)[] } {
  const maxLineBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxLineBytes ?? DEFAULT_MAX_BYTES);
  const maxBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxBytes ?? DEFAULT_MAX_BYTES);
  if (spans && newContentHashes && oldContentHashes) {
    const anchored = genSpanDiff(oldContent, newContent, contextLines, newContentHashes, oldContentHashes, maxLineBytes, maxBytes, spans);
    if (anchored) {
      const diff = disambiguateDuplicateAnchors(anchored.diff);
      return { diff, firstChangedLine: anchored.firstChangedLine, lineNumbers: anchored.lineNumbers };
    }
  }
  if (!limits?.unlimited && Buffer.byteLength(oldContent, "utf-8") + Buffer.byteLength(newContent, "utf-8") > MAX_DIFF_INPUT_BYTES) {
    const guardedRange = changedRange(oldContent, newContent);
    const guardNote = `[diff truncated at ${formatSize(maxBytes)}; use read to see the rest.]`;
    if (!guardedRange || !newContentHashes) {
      return { diff: ` ...\n${guardNote}`, firstChangedLine: guardedRange?.firstChangedLine, lineNumbers: [undefined, undefined] };
    }
    const newLines = splitLines(newContent);
    const oldLines = splitLines(oldContent);
    const first = guardedRange.firstChangedLine;
    const last = guardedRange.lastChangedLine;
    const suffixLen = newLines.length - last;
    const oldLast = oldLines.length - suffixLen;
    const beforeStart = Math.max(1, first - contextLines);
    const afterEnd = Math.min(newLines.length, last + contextLines);
    const guarded: string[] = [];
    const guardedNumbers: (number|undefined)[] = [];
    let guardedBytes = 0;
    const pushGuarded = (text: string, num?: number): boolean => {
      const size = Buffer.byteLength(text, "utf-8") + 1;
      if (guardedBytes + size > maxBytes) return false;
      guardedBytes += size;
      guarded.push(text);
      guardedNumbers.push(num);
      return true;
    };
    const pushGuardedRow = (prefix: " " | "+" | "-", line: string, hash: string | undefined, num?: number): boolean => {
      const full = fmtDiffLine(prefix, line, hash);
      if (Buffer.byteLength(full, "utf-8") > maxLineBytes) {
        const marker = `[Row is ${formatSize(Buffer.byteLength(full, "utf-8"))}, exceeds ${formatSize(maxLineBytes)}; content not shown. Use read to see the full line.]`;
        return pushGuarded(fmtDiffLine(prefix, marker, hash), num);
      }
      return pushGuarded(full, num);
    };
    if (beforeStart > 1) pushGuarded(" ...", undefined);
    for (let n = beforeStart; n < first; n++) {
      if (!pushGuardedRow(" ", newLines[n - 1]!, newContentHashes[n - 1], n)) break;
    }
    if (oldContent.length > 0) {
      for (let n = first; n <= Math.min(oldLast, oldLines.length); n++) {
        if (!pushGuardedRow("-", oldLines[n - 1]!, oldContentHashes?.[n - 1], n)) break;
      }
    }
    for (let n = first; n <= last; n++) {
      if (!pushGuardedRow("+", newLines[n - 1]!, newContentHashes[n - 1], n)) break;
    }
    for (let n = last + 1; n <= afterEnd; n++) {
      if (!pushGuardedRow(" ", newLines[n - 1]!, newContentHashes[n - 1], n)) break;
    }
    guarded.push(" ...");
    guardedNumbers.push(undefined);
    guarded.push(guardNote);
    guardedNumbers.push(undefined);
    return { diff: disambiguateDuplicateAnchors(guarded.join("\n")), firstChangedLine: first, lineNumbers: guardedNumbers };
  }
  const effectiveNewHashes = newContentHashes ?? _lineHashesPure(newContent);

  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  let newLineNum = 1;
  let oldLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  let outBytes = 0;
  let stopped = false;
  let diffTruncated = false;
  const lineNumbers: (number|undefined)[] = [];

  const emitPlain = (line: string, num?: number): void => {
    if (stopped) return;
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (outBytes + lineBytes > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += lineBytes;
    output.push(line);
    lineNumbers.push(num);
  };

  const emitRow = (prefix: " " | "+" | "-", line: string, hash: string | undefined, num?: number): void => {
    if (stopped) return;
    const full = fmtDiffLine(prefix, line, hash);
    const rowBytes = Buffer.byteLength(full, "utf-8");
    if (rowBytes > maxLineBytes) {
      const marker = `[Row is ${formatSize(rowBytes)}, exceeds ${formatSize(maxLineBytes)}; content not shown. Use read to see the full line.]`;
      emitPlain(fmtDiffLine(prefix, marker, hash), num);
      return;
    }
    if (outBytes + rowBytes + 1 > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += rowBytes + 1;
    output.push(full);
    lineNumbers.push(num);
  };

  for (let i = 0; i < parts.length; i++) {
    if (stopped) break;
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    const displayLines = raw;

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (let k = 0; k < displayLines.length; k++) {
        if (stopped) break;
        if (part.added) {
          const hash = effectiveNewHashes[newLineNum - 1];
          emitRow("+", displayLines[k]!, hash, newLineNum);
          newLineNum++;
        } else {
          const hash = oldContentHashes?.[oldLineNum - 1];
          emitRow("-", displayLines[k]!, hash, oldLineNum);
          oldLineNum++;
        }
      }
      if (stopped) break;
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange =
      i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      let linesToShow: (string | symbol)[] = displayLines;
      let skipStart = 0;
      let skipMiddle = 0;
      let skipTail = 0;

      if (!lastWasChange) {
        let count = contextLines;
        if (
          contextLines > 0 &&
          displayLines.length > count &&
          isBlankLine(displayLines[displayLines.length - 1]!)
        ) {
          count += 1;
        }
        count = Math.min(count, displayLines.length);
        skipStart = displayLines.length - count;
        linesToShow = displayLines.slice(skipStart);
      } else if (nextPartIsChange && displayLines.length > contextLines * 2) {
        let headCount = contextLines;
        let tailCount = contextLines;
        if (
          contextLines > 0 &&
          displayLines.length - headCount > tailCount &&
          isBlankLine(displayLines[headCount - 1]!)
        ) {
          headCount += 1;
        }
        if (
          contextLines > 0 &&
          displayLines.length - tailCount > headCount &&
          isBlankLine(displayLines[displayLines.length - tailCount]!)
        ) {
          tailCount += 1;
        }
        const middleLen = displayLines.length - headCount - tailCount;
        if (middleLen > 0) {
          linesToShow = [
            ...displayLines.slice(0, headCount),
            ELLIPSIS_MARKER,
            ...displayLines.slice(displayLines.length - tailCount),
          ];
          skipMiddle = middleLen;
        } else {
          linesToShow = displayLines;
        }
      } else if (!nextPartIsChange && linesToShow.length > contextLines) {
        let count = contextLines;
        const firstLine = linesToShow[0];
        if (contextLines > 0 && typeof firstLine === "string" && isBlankLine(firstLine)) count += 1;
        count = Math.min(count, linesToShow.length);
        linesToShow = linesToShow.slice(0, count);
        skipTail = displayLines.length - count;
      }

      if (skipStart > 0) {
        emitPlain(" ...", undefined);
        newLineNum += skipStart;
        oldLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (stopped) break;
        if (isEllipsisMarker(line)) {
          emitPlain(" ...", undefined);
          newLineNum += skipMiddle;
          oldLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        emitRow(" ", line, hash, newLineNum);
        newLineNum++;
        oldLineNum++;
      }
      if (skipTail > 0) {
        emitPlain(" ...", undefined);
      }
    } else {
      newLineNum += displayLines.length;
      oldLineNum += displayLines.length;
    }
    lastWasChange = false;
  }

  if (diffTruncated) {
    output.push(" ...");
    lineNumbers.push(undefined);
    output.push(`[diff truncated at ${formatSize(maxBytes)}; use read to see the rest.]`);
    lineNumbers.push(undefined);
  }

  const diff = newContentHashes && oldContentHashes ? disambiguateDuplicateAnchors(output.join("\n")) : output.join("\n");
  return { diff, firstChangedLine, lineNumbers };
}

export function genPatch(
  path: string,
  oldContent: string,
  newContent: string,
  limits?: DiffLimits,
): { patch: string; truncated: boolean } {
  const patchOpts: Record<string, unknown> = { context: 4 };
  const ho = (Diff as unknown as Record<string, unknown>).FILE_HEADERS_ONLY;
  if (ho !== undefined) patchOpts.headerOptions = ho;
  const full = (Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, patchOpts as never) as unknown as string) ?? "";
  const maxLineBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxLineBytes ?? DEFAULT_MAX_BYTES);
  const maxBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxBytes ?? DEFAULT_MAX_BYTES);
  const out: string[] = [];
  let outBytes = 0;
  let truncated = false;
  for (const line of full.split("\n")) {
    const lineBytes = Buffer.byteLength(line, "utf-8");
    if (lineBytes > maxLineBytes) {
      truncated = true;
      const prefix = /^[ +-]/.test(line) ? line[0]! : "";
      const marker = `${prefix}[Patch line is ${formatSize(lineBytes)}, exceeds ${formatSize(maxLineBytes)}; content not shown. Use read to see the full line.]`;
      const markerBytes = Buffer.byteLength(marker, "utf-8") + 1;
      if (outBytes + markerBytes > maxBytes) {
        break;
      }
      outBytes += markerBytes;
      out.push(marker);
      continue;
    }
    if (outBytes + lineBytes + 1 > maxBytes) {
      truncated = true;
      break;
    }
    outBytes += lineBytes + 1;
    out.push(line);
  }
  if (truncated) {
    out.push("...");
    out.push(`[patch truncated at ${formatSize(maxBytes)}; the patch cannot be applied as-is. Use read to see the full file.]`);
  }
  return { patch: out.join("\n"), truncated };
}
