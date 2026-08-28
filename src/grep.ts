import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, stat } from "fs/promises";
import { dirname, join, relative } from "path";
import { tryReadNormFile } from "./file-reader";
import { MAX_HASH_LINES, fmtRow, HASH_LEN, HASH_SEP } from "./hashline";
import { MAX_GREP_LINE_BYTES } from "./constants";
import { toCwd } from "./paths";
import { loadP, loadGuide } from "./prompts";
import { normReq } from "./payload-contract";
import { recordServedSafe } from "./served";
import { abortIf, errCode, isRec, makePrepareArguments, rejectUnknownFields, truncateToBytes, visLines } from "./utils";

const GREP_KS = new Set(["pattern", "path", "glob", "context", "ignoreCase", "literal", "limit"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".tmp", "coverage"]);
const MAX_SCAN_FILES = 4000;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface GrepReq {
  pattern: string;
  path?: string;
  glob?: string;
  context?: number;
  ignoreCase?: boolean;
  literal?: boolean;
  limit?: number;
}

export function assertGrepReq(request: unknown): asserts request is GrepReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Grep request must be an object.");
  }
  rejectUnknownFields(request, GREP_KS, "Grep request");
  if (typeof request.pattern !== "string" || request.pattern.length === 0) {
    throw new Error('[E_BAD_SHAPE] Grep request requires a non-empty "pattern" string.');
  }
  if (request.context !== undefined && (typeof request.context !== "number" || !Number.isInteger(request.context) || request.context < 0)) {
    throw new Error('[E_BAD_SHAPE] Grep request field "context" must be a non-negative integer.');
  }
  if (request.limit !== undefined && (typeof request.limit !== "number" || !Number.isInteger(request.limit) || request.limit < 1)) {
    throw new Error('[E_BAD_SHAPE] Grep request field "limit" must be a positive integer.');
  }
}

function buildRegex(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  try {
    return new RegExp(source, ignoreCase ? "ui" : "u");
  } catch {
    throw new Error(`[E_BAD_SHAPE] Invalid pattern: ${pattern}`);
  }
}

function globToRegex(glob: string): RegExp {
  if (glob.startsWith("/")) glob = glob.slice(1);
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          i += 1;
          source += "(?:.*\\/)?";
        } else {
          source += ".*";
        }
        continue;
      }
      source += ".*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

interface FileHit {
  path: string;
  displayPath: string;
  fileHashes: string[];
  rows: string[];
  hashes: string[];
  matchCount: number;
  totalMatchCount: number;
  fragmented: boolean[];
}

const GREP_ROW_OVERHEAD_BYTES = HASH_LEN + Buffer.byteLength(HASH_SEP, "utf-8");
const GREP_ROW_CONTENT_BYTES = MAX_GREP_LINE_BYTES - GREP_ROW_OVERHEAD_BYTES;

function snapCharBoundaries(line: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  if (s > 0 && s < line.length) {
    const c = line.charCodeAt(s);
    if (c >= 0xdc00 && c <= 0xdfff && line.charCodeAt(s - 1) >= 0xd800 && line.charCodeAt(s - 1) <= 0xdbff) s -= 1;
  }
  if (e > 0 && e < line.length) {
    const c = line.charCodeAt(e - 1);
    if (c >= 0xd800 && c <= 0xdbff && line.charCodeAt(e) >= 0xdc00 && line.charCodeAt(e) <= 0xdfff) e += 1;
  }
  return [s, e];
}

function grepMatchFragment(line: string, regex: RegExp): string {
  const m = regex.exec(line);
  const matchStart = m?.index ?? 0;
  const matchLen = m?.[0].length ?? 0;
  const budget = GREP_ROW_CONTENT_BYTES - 6;
  const half = Math.floor((budget - Math.min(matchLen, budget)) / 2);
  const [start, end] = snapCharBoundaries(line, Math.max(0, matchStart - half), Math.min(line.length, matchStart + matchLen + half));
  const content = truncateToBytes(line.slice(start, end), budget);
  const lead = start > 0 ? "..." : "";
  const tail = end < line.length ? "..." : "";
  return truncateToBytes(`${lead}${content}${tail}`, GREP_ROW_CONTENT_BYTES);
}

function grepHeadFragment(line: string): string {
  const head = truncateToBytes(line, GREP_ROW_CONTENT_BYTES - 3);
  return head.length < line.length ? `${head}...` : head;
}

interface ScanState {
  scanned: number;
  stopped: boolean;
}

async function walkFiles(
  root: string,
  state: ScanState,
  onFile: (absPath: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const queue: string[] = [root];
  let head = 0;
  while (head < queue.length && !state.stopped) {
    abortIf(signal);
    const dir = queue[head++]!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (let ei = 0; ei < entries.length; ei++) {
      if ((ei & 127) === 0) abortIf(signal);
      if (state.stopped) break;
      const entry = entries[ei]!;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
      } else if (entry.isFile()) {
        state.scanned += 1;
        if (state.scanned > MAX_SCAN_FILES) {
          state.stopped = true;
          break;
        }
        await onFile(full);
      }
    }
  }
}

async function searchFile(
  absPath: string,
  globRoot: string,
  cwd: string,
  regex: RegExp,
  globRegex: RegExp | undefined,
  context: number,
  maxMatches: number,
  signal?: AbortSignal,
): Promise<FileHit | undefined> {
  const displayPath = relative(cwd, absPath).replace(/\\/g, "/");
  if (globRegex) {
    const globPath = relative(globRoot, absPath).replace(/\\/g, "/");
    if (!globRegex.test(globPath) && !globRegex.test(displayPath)) return undefined;
  }
  const norm = await tryReadNormFile(absPath, cwd, { maxLines: MAX_HASH_LINES, noPersist: true, signal });
  if (!norm) return undefined;
  const lines = visLines(norm.normalized);
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0) abortIf(signal);
    if (i !== 0 && (i & 4095) === 0) await new Promise<void>((r) => setImmediate(r));
    if (regex.test(lines[i]!)) matchLines.push(i);
  }
  if (matchLines.length === 0) return undefined;
  const keptMatches = matchLines.length > maxMatches ? matchLines.slice(0, maxMatches) : matchLines;
  const shown = new Set<number>();
  for (const i of keptMatches) {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) shown.add(j);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const matchSet = new Set(matchLines);
  const rows: string[] = [];
  const hashes: string[] = [];
  const fragmented: boolean[] = [];
  for (const idx of sorted) {
    const hash = norm.fileHashes[idx]!;
    const line = lines[idx]!;
    const row = fmtRow(hash, line);
    if (Buffer.byteLength(row, "utf-8") > MAX_GREP_LINE_BYTES) {
      const content = matchSet.has(idx) ? grepMatchFragment(line, regex) : grepHeadFragment(line);
      rows.push(fmtRow(hash, content));
      hashes.push(hash);
      fragmented.push(true);
    } else {
      rows.push(row);
      hashes.push(hash);
      fragmented.push(false);
    }
  }
  return {
    path: norm.absolutePath,
    displayPath,
    fileHashes: norm.fileHashes,
    rows,
    hashes,
    matchCount: keptMatches.length,
    totalMatchCount: matchLines.length,
    fragmented,
  };
}

const grepToolSchema = Type.Object(
  {
    pattern: Type.String({
      description: "Search pattern (regex or literal string)",
    }),
    path: Type.Optional(
      Type.String({
        description: "Directory or file to search (default: current directory)",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        description: "Filter files by glob pattern; * matches across directories, e.g. '*.ts' or '**/*.spec.ts'. A leading / is ignored; the pattern may be relative to the search root or to the current directory.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description: "Case-insensitive search (default: false)",
      }),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description: "Treat pattern as literal string instead of regex (default: false)",
      }),
    ),
    context: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Number of lines to show before and after each match (default: 0)",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of matches to return (default: 100)",
      }),
    ),
  },
  { additionalProperties: false },
);

export function regGrep(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description: loadP("../prompts/grep.md"),
    promptSnippet: loadP("../prompts/grep-snippet.md"),
    promptGuidelines: loadGuide("../prompts/grep-guidelines.md"),
    prepareArguments: makePrepareArguments(),
    parameters: grepToolSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      assertGrepReq(canonical);
      const req = canonical;
      const regex = buildRegex(req.pattern, req.literal === true, req.ignoreCase === true);
      const context = req.context ?? 0;
      const limit = req.limit ?? 100;
      const globRegex = req.glob === undefined ? undefined : globToRegex(req.glob);
      const base = req.path ? toCwd(req.path, ctx.cwd) : ctx.cwd;
      abortIf(signal);
      let baseStat;
      try {
        baseStat = await stat(base);
      } catch (error) {
        if (errCode(error) === "ENOENT") {
          throw new Error(`[E_NOT_FOUND] File not found: ${req.path ?? ctx.cwd}`);
        }
        throw new Error(`[E_ACCESS] Cannot access path: ${req.path ?? ctx.cwd}`);
      }
      const globRoot = baseStat.isFile() ? dirname(base) : base;
      const state: ScanState = { scanned: 0, stopped: false };
      const files: string[] = [];
      if (baseStat.isFile()) {
        files.push(base);
      } else {
        await walkFiles(base, state, async (absPath) => {
          files.push(absPath);
        }, signal);
        files.sort(cmp);
      }
      const hits: FileHit[] = [];
      let matches = 0;
      let limitTruncated = false;
      let rowTruncated = false;
      let rowCount = 0;
      let byteCount = 0;
      let totalRows = 0;
      let totalBytes = 0;
      let truncatedBy: "lines" | "bytes" | null = null;
      let linesReplaced = 0;
      let countOnly = false;
      for (let f = 0; f < files.length; f++) {
        abortIf(signal);
        const absPath = files[f]!;
        if (countOnly) {
          const hit = await searchFile(absPath, globRoot, ctx.cwd, regex, globRegex, context, Number.MAX_SAFE_INTEGER, signal);
          if (!hit) continue;
          totalRows += hit.rows.length;
          for (const row of hit.rows) totalBytes += Buffer.byteLength(row, "utf-8") + 1;
          const remaining = limit - matches;
          if (remaining > 0) {
            matches += Math.min(hit.matchCount, remaining);
            if (hit.matchCount > remaining) limitTruncated = true;
          } else {
            limitTruncated = true;
          }
          continue;
        }
        const remaining = limit - matches;
        if (remaining <= 0) {
          limitTruncated = true;
          break;
        }
        const hit = await searchFile(absPath, globRoot, ctx.cwd, regex, globRegex, context, remaining, signal);
        if (!hit) continue;
        const keptRows: string[] = [];
        const keptHashes: string[] = [];
        for (let i = 0; i < hit.rows.length; i++) {
          const row = hit.rows[i]!;
          const rowBytes = Buffer.byteLength(row, "utf-8") + 1;
          if (rowCount >= DEFAULT_MAX_LINES || byteCount + rowBytes > DEFAULT_MAX_BYTES) {
            rowTruncated = true;
            if (truncatedBy === null) truncatedBy = byteCount + rowBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines";
            for (let j = i; j < hit.rows.length; j++) {
              totalRows += 1;
              totalBytes += Buffer.byteLength(hit.rows[j]!, "utf-8") + 1;
            }
            break;
          }
          keptRows.push(row);
          keptHashes.push(hit.hashes[i]);
          if (hit.fragmented[i]) linesReplaced += 1;
          rowCount += 1;
          byteCount += rowBytes;
          totalRows += 1;
          totalBytes += rowBytes;
        }
        if (hit.totalMatchCount > hit.matchCount) limitTruncated = true;
        matches += hit.matchCount;
        hits.push({ ...hit, rows: keptRows, hashes: keptHashes });
        if (rowTruncated) countOnly = true;
      }
      hits.sort((a, b) => cmp(a.displayPath, b.displayPath));
      for (const hit of hits) {
        await recordServedSafe(hit.path, hit.hashes, "grep", new Set(hit.fileHashes));
      }
      const blocks = hits
        .map((hit) => `=== ${hit.displayPath} ===\n${hit.rows.join("\n")}`)
        .join("\n");
      const notes: string[] = [];
      if (rowTruncated) notes.push(`[grep: output truncated at ${DEFAULT_MAX_LINES} rows or ${formatSize(DEFAULT_MAX_BYTES)}; refine the pattern to see more.]`);
      if (limitTruncated) notes.push(`[grep: showing first ${limit} matches; increase limit to see more.]`);
      if (state.stopped) notes.push(`[grep: scan cap of ${MAX_SCAN_FILES} files reached; results may be incomplete.]`);
      if (linesReplaced > 0) notes.push(`[grep: ${linesReplaced} line(s) exceed ${formatSize(MAX_GREP_LINE_BYTES)} and are shown as truncated fragments; use read to see the full lines.]`);
      const truncated = limitTruncated || rowTruncated;
      const truncation: TruncationResult | undefined = rowTruncated
        ? {
            content: blocks,
            truncated: true,
            truncatedBy,
            totalLines: totalRows,
            totalBytes,
            outputLines: rowCount,
            outputBytes: byteCount,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          }
        : undefined;
      const text = blocks.length > 0 ? `${blocks}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}` : "No matches found.";
      return {
        content: [{ type: "text", text }],
        details: {
          ...(truncation ? { truncation } : {}),
          ...(linesReplaced > 0 ? { linesTruncated: true as const } : {}),
          metrics: {
            matches,
            files: hits.length,
            truncated: truncated || state.stopped,
          },
        },
      };
    },
  });
}
