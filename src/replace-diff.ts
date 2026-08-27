import * as Diff from "diff";
import { formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  _lineHashesPure,
  ANCHOR_LEN,
  HASH_SEP,
} from "./hashline";

export type LineEnding = "\r\n" | "\n" | "\r";

export function detectEnding(content: string): LineEnding {
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return content.indexOf("\r") >= 0 ? "\r" : "\n";
  }
  const crlfIdx = content.indexOf("\r\n");
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(
  text: string,
  ending: LineEnding,
): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
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

export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
  limits?: DiffLimits,
): { diff: string; firstChangedLine: number | undefined } {
  const effectiveNewHashes = newContentHashes ?? _lineHashesPure(newContent);
  const maxLineBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxLineBytes ?? DEFAULT_MAX_BYTES);
  const maxBytes = limits?.unlimited ? Number.POSITIVE_INFINITY : (limits?.maxBytes ?? DEFAULT_MAX_BYTES);

  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  let newLineNum = 1;
  let oldLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  let outBytes = 0;
  let stopped = false;
  let diffTruncated = false;

  const emitPlain = (line: string): void => {
    if (stopped) return;
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (outBytes + lineBytes > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += lineBytes;
    output.push(line);
  };

  const emitRow = (prefix: " " | "+" | "-", line: string, hash: string | undefined): void => {
    if (stopped) return;
    const full = fmtDiffLine(prefix, line, hash);
    const rowBytes = Buffer.byteLength(full, "utf-8");
    if (rowBytes > maxLineBytes) {
      const marker = `[Row is ${formatSize(rowBytes)}, exceeds ${formatSize(maxLineBytes)}; content not shown. Use read to see the full line.]`;
      emitPlain(fmtDiffLine(prefix, marker, hash));
      return;
    }
    if (outBytes + rowBytes + 1 > maxBytes) {
      stopped = true;
      diffTruncated = true;
      return;
    }
    outBytes += rowBytes + 1;
    output.push(full);
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
          emitRow("+", displayLines[k]!, hash);
          newLineNum++;
        } else {
          const hash = oldContentHashes?.[oldLineNum - 1];
          emitRow("-", displayLines[k]!, hash);
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
        emitPlain(" ...");
        newLineNum += skipStart;
        oldLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (stopped) break;
        if (isEllipsisMarker(line)) {
          emitPlain(" ...");
          newLineNum += skipMiddle;
          oldLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        emitRow(" ", line, hash);
        newLineNum++;
        oldLineNum++;
      }
      if (skipTail > 0) {
        emitPlain(" ...");
      }
    } else {
      newLineNum += displayLines.length;
      oldLineNum += displayLines.length;
    }
    lastWasChange = false;
  }

  if (diffTruncated) {
    output.push(" ...");
    output.push(`[diff truncated at ${formatSize(maxBytes)}; use read to see the rest.]`);
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export function genPatch(
  path: string,
  oldContent: string,
  newContent: string,
  limits?: DiffLimits,
): { patch: string; truncated: boolean } {
  const full = Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 4,
    headerOptions: Diff.FILE_HEADERS_ONLY,
  });
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
