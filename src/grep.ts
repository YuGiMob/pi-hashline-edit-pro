import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createGrepToolDefinition, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tryReadNormFile } from "./file-reader";
import { globToRegex } from "./glob";
import { MAX_HASH_LINES, fmtRow, HASH_LEN, HASH_SEP, HASH_CLASS } from "./hashline";
import { ANCHOR_POOL_EXHAUSTED_PREFIX, MAX_GREP_LINE_BYTES } from "./constants";
import { toCwd, toDisplayPath } from "./paths";
import { loadP, loadGuidelines } from "./prompts";
import { normReq } from "./payload-contract";
import { DEFAULT_EDIT_FLAGS, withGrepPrompts, type EditToolFlags } from "./edit-common";
import { abortIf, clipLine, errCode, isRec, makePrepareArguments, rejectUnknownFields, truncateToBytes, visLines, gutterWidth } from "./utils";
import type { LineEnding } from "./normalize";
import { withAnchorSession, formatAnchorReclaimNotice, takeReclaimedPaths } from "./anchor-registry";
import { serveRows } from "./served";
import { Text } from "@earendil-works/pi-tui";
import { expandHint, getResultText, reuseText, type CallT, type FgT } from "./replace-render";
import { anchoredLine, grepResultSchema, withStructuredErrors, type GrepStructured } from "./structured";
export const RG_TIMEOUT_MS = 10_000;
export const MAX_RG_EVENT_BYTES = 16 * 1024 * 1024;

const GREP_KS = new Set(["pattern", "path", "glob", "context", "ignoreCase", "literal", "limit"]);

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPoolExhaustedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(ANCHOR_POOL_EXHAUSTED_PREFIX);
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

function compileGrepGlob(glob: string): RegExp {
  try {
    return globToRegex(glob);
  } catch {
    throw new Error(`[E_BAD_SHAPE] Invalid glob pattern: ${glob}. Fix the bracket or brace syntax, or search without glob.`);
  }
}

function regexSource(pattern: string, literal: boolean): string {
  return literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
}

interface RgMatchLine {
  line: number;
  start: number;
  end: number;
}

interface FileHit {
  path: string;
  displayPath: string;
  fileHashes: string[];
  fileLines: string[];
  rows: string[];
  hashes: string[];
  lineNumbers: number[];
  matchCount: number;
  totalMatchCount: number;
  fragmented: boolean[];
  texts: string[];
  matchLines: number[];
  hadUtf8DecodeErrors: boolean;
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

function byteOffsetToCharIndex(line: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const char of line) {
    if (bytes >= byteOffset) return index;
    const codePoint = char.codePointAt(0)!;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    index += char.length;
  }
  return index;
}

function grepMatchFragment(line: string, startByte: number, endByte: number): string {
  const budget = GREP_ROW_CONTENT_BYTES - 6;
  const matchStart = byteOffsetToCharIndex(line, startByte);
  const matchLen = Math.max(0, byteOffsetToCharIndex(line, endByte) - matchStart);
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

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && index + 1 < text.length) starts.push(index + 1);
  }
  return starts;
}

function physicalStartsOf(text: string, separators: readonly LineEnding[]): number[] {
  const starts = [0];
  let separatorIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    const separator = separators[separatorIndex] ?? "\n";
    separatorIndex += 1;
    if (separator === "\n" || separator === "\r\n") starts.push(index + 1);
  }
  return starts;
}

function lineIndexOf(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (starts[mid]! <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

function toNormalizedMatches(
  norm: { normalized: string; endingSeparators: readonly LineEnding[] },
  matches: RgMatchLine[],
): RgMatchLine[] {
  if (!norm.endingSeparators.includes("\r")) return matches;
  const text = norm.normalized;
  const starts = lineStartsOf(text);
  const physical = physicalStartsOf(text, norm.endingSeparators);
  const lines = visLines(text);
  return matches.map((match) => {
    const base = physical[match.line - 1] ?? 0;
    const physicalLine = text.slice(base, physical[match.line] ?? text.length);
    const position = base + byteOffsetToCharIndex(physicalLine, match.start);
    const index = lineIndexOf(starts, position);
    const lineText = lines[index] ?? "";
    const columnStart = Math.min(position - starts[index]!, lineText.length);
    const columnEnd = Math.min(base + byteOffsetToCharIndex(physicalLine, match.end) - starts[index]!, lineText.length);
    return {
      line: index + 1,
      start: Buffer.byteLength(lineText.slice(0, columnStart), "utf-8"),
      end: Buffer.byteLength(lineText.slice(0, Math.max(columnStart, columnEnd)), "utf-8"),
    };
  });
}

function makeHitFromIndices(
  norm: { normalized: string; fileHashes: string[]; absolutePath: string; hadUtf8DecodeErrors: boolean },
  displayPath: string,
  matches: RgMatchLine[],
  context: number,
  totalMatchCount: number,
  keptMatchCount: number,
): FileHit {
  const lines = visLines(norm.normalized);
  const shown = new Set<number>();
  const kept = matches.slice(0, keptMatchCount);
  for (const match of kept) {
    const lineIndex = match.line - 1;
    for (let j = Math.max(0, lineIndex - context); j <= Math.min(lines.length - 1, lineIndex + context); j++) shown.add(j);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const matchByLine = new Map<number, RgMatchLine>();
  for (const match of matches) matchByLine.set(match.line - 1, match);
  const rows: string[] = [];
  const hashes: string[] = [];
  const lineNumbers: number[] = [];
  const fragmented: boolean[] = [];
  const texts: string[] = [];
  for (const idx of sorted) {
    const hash = norm.fileHashes[idx]!;
    const line = lines[idx]!;
    const row = fmtRow(hash, line);
    if (Buffer.byteLength(row, "utf-8") > MAX_GREP_LINE_BYTES) {
      const match = matchByLine.get(idx);
      const content = match !== undefined ? grepMatchFragment(line, match.start, match.end) : grepHeadFragment(line);
      rows.push(fmtRow(hash, content));
      hashes.push(hash);
      lineNumbers.push(idx + 1);
      fragmented.push(true);
      texts.push(content);
    } else {
      rows.push(row);
      hashes.push(hash);
      lineNumbers.push(idx + 1);
      fragmented.push(false);
      texts.push(line);
    }
  }
  return {
    path: norm.absolutePath,
    displayPath,
    fileHashes: norm.fileHashes,
    fileLines: lines,
    rows,
    hashes,
    lineNumbers,
    matchCount: kept.length,
    totalMatchCount,
    fragmented,
    texts,
    matchLines: kept.map((match) => match.line),
    hadUtf8DecodeErrors: norm.hadUtf8DecodeErrors,
  };
}

let cachedRgPath: string | undefined;

export async function resolveRgPath(): Promise<string> {
  if (cachedRgPath !== undefined) return cachedRgPath;
  try {
    const r = spawnSync("rg", ["--version"], { stdio: "pipe" });
    if (!r.error && r.status === 0) { cachedRgPath = "rg"; return "rg"; }
  } catch {}
  try {
    const { homedir } = await import("node:os");
    const { existsSync } = await import("node:fs");
    const home = process.env.HOME ?? homedir();
    const base = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
    const bin = join(base, "bin", process.platform === "win32" ? "rg.exe" : "rg");
    if (existsSync(bin)) {
      const r = spawnSync(bin, ["--version"], { stdio: "pipe" });
      if (!r.error && r.status === 0) { cachedRgPath = bin; return bin; }
    }
  } catch {}
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const piDir = dirname(pkgPath);
    const toolsManagerPath = join(piDir, "dist/utils/tools-manager.js");
    const mod = await import(pathToFileURL(toolsManagerPath).href);
    if (mod.ensureTool) {
      const p = await mod.ensureTool("rg", true);
      if (p) { cachedRgPath = p; return p; }
    }
  } catch {}
  throw new Error("[E_ACCESS] ripgrep (rg) is required for grep but was not found. Install ripgrep or ensure pi can download it to ~/.pi/agent/bin.");
}

async function insideGitRepo(start: string): Promise<boolean> {
  let current = start;
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

interface RgSearch {
  matches: Map<string, RgMatchLine[]>;
  skipped?: string;
}

async function collectRgMatches(
  rgPath: string,
  pattern: string,
  searchPath: string,
  req: GrepReq,
  signal: AbortSignal | undefined,
  repoRooted: boolean,
): Promise<RgSearch> {
  const args = ["--json", "--line-number", "--color=never", "--hidden", "--crlf", "--glob", "!.git"];
  if (!repoRooted) args.push("--no-require-git");
  const wanted = req.limit ?? 100;
  args.push("--max-count", String(wanted + 1));
  if (typeof req.glob === "string" && req.glob.length > 0) {
    const stripped = req.glob.startsWith("/") ? req.glob.slice(1) : req.glob;
    if (!stripped.includes("/")) args.push("--glob", stripped);
  }
  if (req.ignoreCase) args.push("--ignore-case");
  if (req.literal) args.push("--fixed-strings");
  args.push("--", pattern, searchPath);
  const result = new Map<string, RgMatchLine[]>();
  return await new Promise<RgSearch>((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversized = false;
    let stderr = "";
    let timedOut = false;
    const rgTimeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGKILL");
      reject(new Error(`[E_GREP_TIMEOUT] ripgrep timed out after ${RG_TIMEOUT_MS}ms. Narrow the path or pattern and retry.`));
    }, RG_TIMEOUT_MS);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const onAbort = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(rgTimeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; submatches?: Array<{ start?: number; end?: number }> } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "match") {
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (typeof filePath === "string" && typeof lineNumber === "number") {
          let abs: string;
          try {
            abs = isAbsolute(filePath) || win32.isAbsolute(filePath) ? filePath : join(searchPath, filePath);
          } catch {
            abs = filePath;
          }
          const submatch = event.data?.submatches?.[0];
          const start = typeof submatch?.start === "number" ? submatch.start : 0;
          const end = typeof submatch?.end === "number" ? submatch.end : start;
          const list = result.get(abs) ?? [];
          list.push({ line: lineNumber, start, end });
          result.set(abs, list);
        }
      }
    };
    const overflow = (bytes: number): boolean => {
      if (bytes <= MAX_RG_EVENT_BYTES) return false;
      oversized = true;
      pending = [];
      if (!child.killed) child.kill("SIGKILL");
      return true;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (oversized) return;
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        if (overflow(pendingBytes + nl - start)) return;
        pending.push(chunk.subarray(start, nl));
        onLine(Buffer.concat(pending).toString("utf8"));
        pending = [];
        pendingBytes = 0;
        start = nl + 1;
      }
      pendingBytes += chunk.length - start;
      if (overflow(pendingBytes)) return;
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    child.on("error", (error) => {
      cleanup();
      if (rgPath === cachedRgPath) cachedRgPath = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      reject(new Error(`[E_GREP_FAILED] ripgrep could not start: ${clipLine(detail)}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) return;
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      if (oversized) {
        resolve({ matches: result, skipped: `ripgrep reported one match line over ${formatSize(MAX_RG_EVENT_BYTES)} (a broad pattern such as "." on a long one-line file), so the search stopped there; narrow the pattern or the path` });
        return;
      }
      if (code !== 0 && code !== 1) {
        const detail = clipLine(stderr.trim(), 300);
        if (result.size === 0) {
          reject(new Error(detail
            ? `[E_GREP_FAILED] ripgrep exited with code ${code}: ${detail}`
            : `[E_GREP_FAILED] ripgrep exited with code ${code}.`));
          return;
        }
        resolve({ matches: result, ...(detail ? { skipped: detail } : {}) });
        return;
      }
      resolve({ matches: result });
    });
  });
}


function displayRowsForHit(hit: FileHit): string[] {
  const matched = new Set(hit.matchLines);
  const width = gutterWidth(hit.lineNumbers.reduce((m, n) => (n > m ? n : m), 0), hit.lineNumbers.length);
  return hit.rows.map((row, index) => {
    const lineNumber = hit.lineNumbers[index]!;
    return `${String(lineNumber).padStart(width)}${matched.has(lineNumber) ? ":" : "-"}${HASH_SEP} ${row}`;
  });
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
        description: "Filter files by glob; `*` crosses directories, e.g. `*.ts`. A leading `/` is ignored; relative to the search root or cwd.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description: "Case-insensitive search",
      }),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description: "Treat pattern as literal text instead of regex",
      }),
    ),
    context: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Lines of context before and after each match",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of matched lines to return (default 100)",
      }),
    ),
  },
  { additionalProperties: true },
);


const GREP_PREVIEW_LINES = 16;
const GREP_PREVIEW_LINES_EXPANDED = 40;

export function fmtGrepCall(args: { pattern?: unknown; path?: unknown; glob?: unknown; literal?: unknown; ignoreCase?: unknown; context?: unknown; limit?: unknown } | undefined, theme: CallT): string {
  const pattern = typeof args?.pattern === "string" && args.pattern.length > 0 ? theme.fg("accent", args.pattern) : theme.fg("toolOutput", "...");
  const qualifiers: string[] = [];
  if (typeof args?.path === "string" && args.path.length > 0) qualifiers.push(args.path);
  if (typeof args?.glob === "string" && args.glob.length > 0) qualifiers.push(args.glob);
  if (args?.literal === true) qualifiers.push("literal");
  if (args?.ignoreCase === true) qualifiers.push("case-insensitive");
  if (typeof args?.context === "number") qualifiers.push(`context ${args.context}`);
  if (typeof args?.limit === "number") qualifiers.push(`limit ${args.limit}`);
  let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${pattern}`;
  if (qualifiers.length > 0) text += ` ${theme.fg("dim", qualifiers.join(" "))}`;
  return text;
}

function highlightRegex(args: unknown): RegExp | undefined {
  if (!isRec(args) || typeof args.pattern !== "string" || args.pattern.length === 0) return undefined;
  try {
    return new RegExp(regexSource(args.pattern, args.literal === true), args.ignoreCase === true ? "giu" : "gu");
  } catch {
    return undefined;
  }
}

function highlightMatches(text: string, regex: RegExp, theme: FgT): string {
  let out = "";
  let last = 0;
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(text);
    if (!match || match[0].length === 0) break;
    out += text.slice(last, match.index) + theme.fg("accent", match[0]);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

const ANCHORED_ROW_RE = new RegExp(`^${HASH_CLASS}${HASH_SEP}`);
const GREP_GUTTER_RE = /^\s*\d+(?: │ |[:-]│ )/;

function highlightHitRow(row: string, highlight: RegExp, theme: FgT): string {
  const anchored = row.match(ANCHORED_ROW_RE);
  if (!anchored) return highlightMatches(row, highlight, theme);
  return anchored[0] + highlightMatches(row.slice(anchored[0].length), highlight, theme);
}

function styleGrepLine(line: string, highlight: RegExp | undefined, theme: FgT): string {
  if (line.startsWith("=== ")) return theme.fg("accent", line);
  if (line.startsWith("[grep:") || line.startsWith("... ")) return theme.fg("dim", line);
  if (!highlight) return line;
  const gutter = GREP_GUTTER_RE.exec(line);
  if (gutter === null) return highlightHitRow(line, highlight, theme);
  const cut = gutter[0].length;
  return line.slice(0, cut) + highlightHitRow(line.slice(cut), highlight, theme);
}

export function renderGrepResult(result: { content?: Array<{ type: string; text?: string }> }, options: { isPartial: boolean; expanded?: boolean } | boolean, theme: FgT, context: any): Text {
  const isPartial = typeof options === "boolean" ? options : options.isPartial;
  const expanded = typeof options === "boolean" ? context.expanded === true : options.expanded === true || context.expanded === true;
  if (isPartial) return reuseText(context, theme.fg("warning", "Searching..."));
  const raw = getResultText(result);
  if (context.isError) return raw ? reuseText(context, `\n${theme.fg("error", raw)}`) : new Text("", 0, 0);
  if (!raw) return new Text("", 0, 0);
  const maxLines = expanded ? GREP_PREVIEW_LINES_EXPANDED : GREP_PREVIEW_LINES;
  const lines = raw.split("\n");
  const highlight = highlightRegex((context as { args?: unknown }).args);
  const shown = lines.slice(0, maxLines).map((line) => styleGrepLine(line, highlight, theme));
  if (lines.length > maxLines) shown.push(theme.fg("muted", `... ${lines.length - maxLines} more grep lines (${expandHint()})`));
  return reuseText(context, shown.join("\n"));
}
export function regGrep(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  const prompted = withGrepPrompts({
    description: loadP("../tool-prompts/grep.md"),
    snippet: loadP("../tool-prompts/grep-snippet.md"),
    guidelines: loadGuidelines("../tool-prompts/grep-guidelines.md"),
  }, flags);
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    prepareArguments: makePrepareArguments(),
    parameters: grepToolSchema,
    outputSchema: grepResultSchema,
    executionMode: "sequential",
    renderCall(args: any, theme: CallT, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(fmtGrepCall(args as { pattern?: unknown; path?: unknown } | undefined, theme));
      return text;
    },
    renderResult(result, opts, theme, context) {
      return renderGrepResult(result as never, opts as { isPartial: boolean; expanded?: boolean }, theme as never, context as never);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, {}, () => withAnchorSession(ctx, async () => {
        const canonical = normReq(params);
        assertGrepReq(canonical);
        const req = canonical;
        const context = req.context ?? 0;
        const limit = req.limit ?? 100;
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
        const globRegex = req.glob === undefined ? undefined : compileGrepGlob(req.glob);
        const matchesGlob = (absPath: string): boolean => {
          if (globRegex === undefined) return true;
          const displayPath = toDisplayPath(ctx.cwd, absPath);
          const globPath = toDisplayPath(globRoot, absPath);
          return globRegex.test(globPath) || globRegex.test(displayPath);
        };
        const rgPath = await resolveRgPath();
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
        let poolSkipped = 0;
        const makeGrepReader = (allocation: "real" | "shadow") => async (absPath: string) => {
          try {
            return await tryReadNormFile(absPath, ctx.cwd, { maxLines: MAX_HASH_LINES, noPersist: true, allocation, signal });
          } catch (error) {
            if (!isPoolExhaustedError(error)) throw error;
            poolSkipped += 1;
            return undefined;
          }
        };
        const readGrepFile = makeGrepReader("real");
        const readGrepFileShadow = makeGrepReader("shadow");
        const repoRooted = await insideGitRepo(globRoot);
        const rgSearch = await collectRgMatches(rgPath, req.pattern, base, req, signal, repoRooted);
        const rgMatches = rgSearch.matches;
        const sortedFiles = [...rgMatches.keys()].sort(cmp);
        for (let f = 0; f < sortedFiles.length; f++) {
          abortIf(signal);
          const absPath = sortedFiles[f]!;
          const fileMatches = [...(rgMatches.get(absPath) ?? [])].sort((a, b) => a.line - b.line);
          const totalForFile = fileMatches.length;
          if (countOnly) {
            if (!matchesGlob(absPath)) continue;
            const norm = await readGrepFileShadow(absPath);
            if (!norm) continue;
            const hit = makeHitFromIndices(norm, toDisplayPath(ctx.cwd, absPath), toNormalizedMatches(norm, fileMatches), context, totalForFile, fileMatches.length);
            const display = displayRowsForHit(hit);
            totalRows += display.length;
            for (const r of display) totalBytes += Buffer.byteLength(r, "utf-8") + 1;
            const remainingCountOnly = limit - matches;
            if (remainingCountOnly > 0) {
              const add = Math.min(hit.matchCount, remainingCountOnly);
              matches += add;
              if (hit.matchCount > remainingCountOnly) limitTruncated = true;
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
          if (!matchesGlob(absPath)) continue;
          const norm = await readGrepFile(absPath);
          if (!norm) continue;
          const hit = makeHitFromIndices(norm, toDisplayPath(ctx.cwd, absPath), toNormalizedMatches(norm, fileMatches), context, totalForFile, Math.min(totalForFile, remaining));
          const display = displayRowsForHit(hit);
          const keptRows: string[] = [];
          const keptHashes: string[] = [];
          const keptLineNumbers: number[] = [];
          const keptFragmented: boolean[] = [];
          const keptTexts: string[] = [];
          for (let i = 0; i < display.length; i++) {
            const row = display[i]!;
            const rowBytes = Buffer.byteLength(row, "utf-8") + 1;
            if (rowCount >= DEFAULT_MAX_LINES || byteCount + rowBytes > DEFAULT_MAX_BYTES) {
              rowTruncated = true;
              if (truncatedBy === null) truncatedBy = byteCount + rowBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines";
              for (let j = i; j < display.length; j++) {
                totalRows += 1;
                totalBytes += Buffer.byteLength(display[j]!, "utf-8") + 1;
              }
              break;
            }
            keptRows.push(row);
            keptHashes.push(hit.hashes[i]!);
            keptLineNumbers.push(hit.lineNumbers[i]!);
            keptFragmented.push(hit.fragmented[i]!);
            keptTexts.push(hit.texts[i]!);
            if (hit.fragmented[i]) linesReplaced += 1;
            rowCount += 1;
            byteCount += rowBytes;
            totalRows += 1;
            totalBytes += rowBytes;
          }
          if (hit.totalMatchCount > hit.matchCount) limitTruncated = true;
          matches += hit.matchCount;
          const displayHit: FileHit = { ...hit, rows: keptRows, hashes: keptHashes, lineNumbers: keptLineNumbers, fragmented: keptFragmented, texts: keptTexts };
          hits.push(displayHit);
          if (rowTruncated) countOnly = true;
        }
        hits.sort((a, b) => cmp(a.displayPath, b.displayPath));
        for (const hit of hits) {
          serveRows(hit.path, hit.fileHashes, hit.fileLines, hit.hashes);
        }
        const blocks = hits
          .map((hit) => `=== ${hit.displayPath} ===\n${hit.rows.join("\n")}`)
          .join("\n");
        const notes: string[] = [];
        const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
        if (reclaimNotice !== undefined) notes.push(reclaimNotice);
        if (rowTruncated) notes.push(`[grep: output truncated at ${DEFAULT_MAX_LINES} rows or ${formatSize(DEFAULT_MAX_BYTES)}; refine the pattern to see more.]`);
        if (limitTruncated) notes.push(`[grep: showing first ${limit} matches; increase limit to see more.]`);
        if (linesReplaced > 0) notes.push(`[grep: ${linesReplaced} line(s) exceed ${formatSize(MAX_GREP_LINE_BYTES)} and are shown as truncated fragments; use read to see the full lines.]`);
        if (poolSkipped > 0) notes.push(`[grep: ${poolSkipped} file(s) skipped because the session's anchor pool is exhausted; narrow the search.]`);
        if (rgSearch.skipped !== undefined) notes.push(`[grep: some paths could not be searched, so these results are partial: ${rgSearch.skipped}]`);
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
        const text = blocks.length > 0
          ? `${blocks}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`
          : notes.length > 0
            ? `No matches found.\n${notes.join("\n")}`
            : "No matches found.";
        const structuredContent: GrepStructured = {
          ok: true,
          kind: "grep",
          text,
          matches,
          files: hits.length,
          truncated,
          results: hits.map((hit) => ({
            path: hit.displayPath,
            matchLines: [...hit.matchLines],
            lines: hit.hashes.map((anchor, index) => anchoredLine(hit.lineNumbers[index]!, hit.texts[index]!, anchor)),
            hadUtf8DecodeErrors: hit.hadUtf8DecodeErrors,
          })),
        };
        return {
          content: [{ type: "text", text }],
          details: {
            ...(truncation ? { truncation } : {}),
            ...(linesReplaced > 0 ? { linesTruncated: true as const } : {}),
            metrics: {
              matches,
              files: hits.length,
              truncated,
            },
          },
          structuredContent,
        };
      }));
    },
  });
}

export function regVanillaGrep(pi: ExtensionAPI, cwd: string): void {
  pi.registerTool(createGrepToolDefinition(cwd));
}
