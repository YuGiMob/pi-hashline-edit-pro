import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stat } from "fs/promises";
import { dirname, join, relative } from "path";
import { spawn, spawnSync } from "child_process";
import { createInterface } from "readline";
import { tryReadNormFile } from "./file-reader";
import { MAX_HASH_LINES, fmtRow, HASH_LEN, HASH_SEP } from "./hashline";
import { MAX_GREP_LINE_BYTES } from "./constants";
import { toCwd } from "./paths";
import { loadP, loadGuide } from "./prompts";
import { normReq } from "./payload-contract";
import { recordServedSafe, buildServedMap } from "./served";
import { abortIf, errCode, isRec, makePrepareArguments, rejectUnknownFields, truncateToBytes, visLines } from "./utils";

const GREP_KS = new Set(["pattern", "path", "glob", "context", "ignoreCase", "literal", "limit"]);

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
  if (!literal) assertSafeRegex(pattern);
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  try {
    return new RegExp(source, ignoreCase ? "ui" : "u");
  } catch {
    throw new Error(`[E_BAD_SHAPE] Invalid pattern: ${pattern}`);
  }
}

interface RegexGroupRisk {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

function unsafeRegex(pattern: string): never {
  throw new Error(
    `[E_UNSAFE_REGEX] Refusing potentially exponential regex: ${pattern}. Use literal: true or simplify the expression.`,
  );
}

function assertSafeRegex(pattern: string): void {
  if (pattern.length > 4096) unsafeRegex(pattern);
  const groups: RegexGroupRisk[] = [];
  let inClass = false;
  let escaped = false;
  let variableQuantifiers = 0;
  let lastAtom: { groupRisky: boolean; quantified: boolean } | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      if (!inClass && (/[1-9]/.test(ch) || (ch === "k" && pattern[i + 1] === "<"))) {
        unsafeRegex(pattern);
      }
      escaped = false;
      lastAtom = { groupRisky: false, quantified: false };
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
        lastAtom = { groupRisky: false, quantified: false };
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      lastAtom = undefined;
      continue;
    }
    if (ch === ")") {
      const group = groups.pop();
      if (group) {
        lastAtom = {
          groupRisky: group.hasQuantifier || group.hasAlternation,
          quantified: false,
        };
      }
      continue;
    }
    if (ch === "|") {
      const group = groups.at(-1);
      if (group) group.hasAlternation = true;
      lastAtom = undefined;
      continue;
    }
    let quantifierLength = 0;
    if (ch === "*" || ch === "+" || ch === "?") {
      quantifierLength = 1;
    } else if (ch === "{") {
      quantifierLength = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i))?.[0].length ?? 0;
    }
    if (ch === "{" && quantifierLength > 0) {
      const quant = pattern.slice(i, i + quantifierLength);
      const m = /^\{(\d+)/.exec(quant);
      if (m && Number(m[1]) > 1000) unsafeRegex(pattern);
    }
    if (quantifierLength > 0 && lastAtom) {
      if (ch === "?" && lastAtom.quantified) continue;
      const variable = ch !== "{" || pattern.slice(i, i + quantifierLength).includes(",");
      if (variable && ++variableQuantifiers > 1) unsafeRegex(pattern);
      if (lastAtom.groupRisky) unsafeRegex(pattern);
      const group = groups.at(-1);
      if (group) group.hasQuantifier = true;
      lastAtom.quantified = true;
      i += quantifierLength - 1;
      continue;
    }
    lastAtom = { groupRisky: false, quantified: false };
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
  fileLines: string[];
  rows: string[];
  hashes: string[];
  lineNumbers: number[];
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

function makeHitFromIndices(
  norm: { normalized: string; fileHashes: string[]; absolutePath: string },
  displayPath: string,
  matchIndices: number[],
  context: number,
  regex: RegExp | undefined,
  totalMatchCount: number,
  keptMatchCount: number,
): FileHit {
  const lines = visLines(norm.normalized);
  const shown = new Set<number>();
  const kept = matchIndices.slice(0, keptMatchCount);
  for (const i of kept) {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) shown.add(j);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const matchSet = new Set(matchIndices);
  const rows: string[] = [];
  const hashes: string[] = [];
  const lineNumbers: number[] = [];
  const fragmented: boolean[] = [];
  for (const idx of sorted) {
    const hash = norm.fileHashes[idx]!;
    const line = lines[idx]!;
    const row = fmtRow(hash, line);
    if (Buffer.byteLength(row, "utf-8") > MAX_GREP_LINE_BYTES) {
      const content = matchSet.has(idx) && regex ? grepMatchFragment(line, regex) : grepHeadFragment(line);
      rows.push(fmtRow(hash, content));
      hashes.push(hash);
      lineNumbers.push(idx + 1);
      fragmented.push(true);
    } else {
      rows.push(row);
      hashes.push(hash);
      lineNumbers.push(idx + 1);
      fragmented.push(false);
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
  };
}

async function resolveRgPath(): Promise<string> {
  try {
    const r = spawnSync("rg", ["--version"], { stdio: "pipe" });
    if (!r.error && r.status === 0) return "rg";
  } catch {}
  try {
    const { homedir } = await import("os");
    const { existsSync } = await import("fs");
    const home = process.env.HOME ?? homedir();
    const base = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
    const bin = join(base, "bin", process.platform === "win32" ? "rg.exe" : "rg");
    if (existsSync(bin)) {
      const r = spawnSync(bin, ["--version"], { stdio: "pipe" });
      if (!r.error && r.status === 0) return bin;
    }
  } catch {}
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const { dirname } = await import("path");
    const piDir = dirname(pkgPath);
    const toolsManagerPath = join(piDir, "dist/utils/tools-manager.js");
    const mod = await import("file://" + toolsManagerPath);
    if (mod.ensureTool) {
      const p = await mod.ensureTool("rg", true);
      if (p) return p;
    }
  } catch {}
  throw new Error("[E_ACCESS] ripgrep (rg) is required for grep but was not found. Install ripgrep or ensure pi can download it to ~/.pi/agent/bin.");
}

async function collectRgMatches(
  rgPath: string,
  pattern: string,
  searchPath: string,
  req: GrepReq,
  signal?: AbortSignal,
): Promise<Map<string, number[]>> {
  const args = ["--json", "--line-number", "--color=never", "--hidden", "--glob", "!.git"];
  if (req.ignoreCase) args.push("--ignore-case");
  if (req.literal) args.push("--fixed-strings");
  args.push("--", pattern, searchPath);
  const result = new Map<string, number[]>();
  return await new Promise<Map<string, number[]>>((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let timedOut = false;
    const rgTimeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGKILL");
      reject(new Error("rg timeout"));
    }, 10000);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const onAbort = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(rgTimeout);
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number } };
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
            abs = filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath) ? filePath : join(searchPath, filePath);
          } catch {
            abs = filePath;
          }
          const list = result.get(abs) ?? [];
          list.push(lineNumber);
          result.set(abs, list);
        }
      }
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) return;
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      if (code !== 0 && code !== 1) {
        const msg = stderr.trim() || `ripgrep exited with code ${code}`;
        reject(new Error(msg));
        return;
      }
      resolve(result);
    });
  });
}

function gutterWidthFor(numbers: number[]): number {
  let max = 0;
  for (const n of numbers) if (n > max) max = n;
  return String(max || 1).length;
}

function displayRowsForHit(hit: FileHit): string[] {
  const width = gutterWidthFor(hit.lineNumbers);
  return hit.rows.map((row, i) => {
    const n = hit.lineNumbers[i]!;
    const padded = String(n).padStart(width, " ");
    return `${padded} │ ${row}`;
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
        description: "Maximum number of matched lines to return",
      }),
    ),
  },
  { additionalProperties: false },
);

export function regGrep(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "anchor_grep",
    label: "Anchor Grep",
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
      const globRegex = req.glob === undefined ? undefined : globToRegex(req.glob);
      const validatedRegex = buildRegex(req.pattern, req.literal === true, req.ignoreCase === true);
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
      const rgMatches = await collectRgMatches(rgPath, req.pattern, base, req, signal);
      const sortedFiles = [...rgMatches.keys()].sort(cmp);
      for (let f = 0; f < sortedFiles.length; f++) {
        abortIf(signal);
        const absPath = sortedFiles[f]!;
        const allNums = rgMatches.get(absPath) ?? [];
        const totalForFile = allNums.length;
        const sortedNums = [...allNums].sort((a, b) => a - b);
        const indices = sortedNums.map((n) => n - 1).filter((n) => n >= 0);
        if (countOnly) {
          if (globRegex) {
            const displayPath = relative(ctx.cwd, absPath).replace(/\\/g, "/");
            const globPath = relative(globRoot, absPath).replace(/\\/g, "/");
            if (!globRegex.test(globPath) && !globRegex.test(displayPath)) continue;
          }
          const norm = await tryReadNormFile(absPath, ctx.cwd, { maxLines: MAX_HASH_LINES, noPersist: true, signal });
          if (!norm) continue;
          const hit = makeHitFromIndices(norm, relative(ctx.cwd, absPath).replace(/\\/g, "/"), indices, context, validatedRegex, totalForFile, indices.length);
          const display = displayRowsForHit(hit);
          totalRows += display.length;
          for (const r of display) totalBytes += Buffer.byteLength(r, "utf-8") + 1;
          const remaining = limit - matches;
          if (remaining > 0) {
            const add = Math.min(hit.matchCount, remaining);
            matches += add;
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
        if (globRegex) {
          const displayPath = relative(ctx.cwd, absPath).replace(/\\/g, "/");
          const globPath = relative(globRoot, absPath).replace(/\\/g, "/");
          if (!globRegex.test(globPath) && !globRegex.test(displayPath)) continue;
        }
        const norm = await tryReadNormFile(absPath, ctx.cwd, { maxLines: MAX_HASH_LINES, noPersist: true, signal });
        if (!norm) continue;
        const hit = makeHitFromIndices(norm, relative(ctx.cwd, absPath).replace(/\\/g, "/"), indices, context, validatedRegex, totalForFile, Math.min(totalForFile, remaining));
        if (!hit) continue;
        const display = displayRowsForHit(hit);
        const keptRows: string[] = [];
        const keptHashes: string[] = [];
        const keptLineNumbers: number[] = [];
        const keptFragmented: boolean[] = [];
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
          if (hit.fragmented[i]) linesReplaced += 1;
          rowCount += 1;
          byteCount += rowBytes;
          totalRows += 1;
          totalBytes += rowBytes;
        }
        if (hit.totalMatchCount > hit.matchCount) limitTruncated = true;
        matches += hit.matchCount;
        const displayHit: FileHit = { ...hit, rows: keptRows, hashes: keptHashes, lineNumbers: keptLineNumbers, fragmented: keptFragmented };
        hits.push(displayHit);
        if (rowTruncated) countOnly = true;
      }
      hits.sort((a, b) => cmp(a.displayPath, b.displayPath));
      for (const hit of hits) {
        const servedMap = buildServedMap(hit.fileHashes, hit.fileLines, hit.hashes);
        await recordServedSafe(hit.path, servedMap, "anchor_grep", new Set(hit.fileHashes));
      }
      const blocks = hits
        .map((hit) => `=== ${hit.displayPath} ===\n${hit.rows.join("\n")}`)
        .join("\n");
      const notes: string[] = [];
      if (rowTruncated) notes.push(`[grep: output truncated at ${DEFAULT_MAX_LINES} rows or ${formatSize(DEFAULT_MAX_BYTES)}; refine the pattern to see more.]`);
      if (limitTruncated) notes.push(`[grep: showing first ${limit} matches; increase limit to see more.]`);
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
            truncated,
          },
        },
      };
    },
  });
}
