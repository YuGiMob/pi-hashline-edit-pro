import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  AUTO_READ_ALL_MAX_BUDGET_BYTES,
  AUTO_READ_ALL_MAX_FILE_BYTES,
  AUTO_READ_ALL_MAX_FILES,
  AUTO_READ_ALL_MIN_BUDGET_BYTES,
  SNIFF_BYTES,
} from "./constants";
import { normalizeAutoReadAllIgnoreEntry, type AutoReadAllMode } from "./config";
import { serveRows } from "./served";
import { readNormFile, safeSnapId } from "./file-reader";
import { resolveRgPath } from "./grep";
import { globToRegex } from "./glob";
import { MAX_HASH_LINES } from "./hashline";
import { fmtReadPreview } from "./read";
import { splitLines } from "./utils";
import { recordAutoReadAllComplete } from "./auto-read-all-state";

const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BYTES = 64 * 1024 * 1024;
const SCAN_CONCURRENCY = 32;
const SCAN_LIMIT_MULTIPLIER = 4;
const MAX_REPORTED_OMISSIONS = 50;
export const AUTO_READ_ALL_CHUNK_BYTES = 48 * 1024;

const HEADER =
  "[hashline auto-read-all] Every non-ignored project file is attached below as `=== path ===` then `anchor│content` rows with live anchors.\nEdit directly from the attachment with replace and insert; do not call read for files in [files complete: ...].\nFiles listed as omitted or not attached can be read normally.\nAnchors are case-sensitive and stay valid until their line is edited.";

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".jxl",
  ".png",
  ".psd",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

export const AUTO_READ_ALL_EXCLUDED_SEGMENTS = [
  "vendor",
  "node_modules",
  "bower_components",
  "third_party",
  "thirdparty",
  "jspm_packages",
  ".venv",
  "venv",
  "site-packages",
  "__pycache__",
  ".tox",
  ".gradle",
  ".terraform",
  "pods",
  "carthage",
  "deriveddata",
  "coreui",
  "coreui-icons",
];
export const AUTO_READ_ALL_EXCLUDED_NAMES = [
  "package-lock.json",
  "yarn.lock",
  "composer.lock",
  "gemfile.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
  "flake.lock",
  ".eslintcache",
];
const EXCLUDED_NAME_SET = new Set(AUTO_READ_ALL_EXCLUDED_NAMES);
const EXCLUDED_SEGMENT_SET = new Set(AUTO_READ_ALL_EXCLUDED_SEGMENTS);
function isExcludedBySegment(path: string): boolean {
  for (const segment of path.split("/")) {
    if (EXCLUDED_SEGMENT_SET.has(segment.toLowerCase())) return true;
  }
  return false;
}
function isExcludedByPattern(baseLower: string): boolean {
  if (baseLower.endsWith(".min.js") || baseLower.endsWith(".min.css") || baseLower.endsWith(".min.mjs")) return true;
  if (baseLower.endsWith("-min.js") || baseLower.endsWith("-min.css")) return true;
  if (baseLower.includes(".bundle.") || baseLower.includes(".chunk.")) return true;
  if (baseLower.endsWith(".umd.js")) return true;
  if (baseLower.endsWith(".map")) return true;
  if (baseLower.endsWith(".lock")) return true;
  if (baseLower.includes(".generated.") || baseLower.includes(".gen.")) return true;
  if (baseLower.endsWith("_pb2.py")) return true;
  if (baseLower.endsWith(".pb.go")) return true;
  if (baseLower.endsWith(".g.dart")) return true;
  if (baseLower.endsWith(".freezed.dart")) return true;
  if (baseLower.endsWith(".designer.cs")) return true;
  if (baseLower.endsWith(".g.cs")) return true;
  if (baseLower.endsWith(".snap")) return true;
  if (baseLower.startsWith("coreui-icons.")) return true;
  if (baseLower === "coreui.css") return true;
  return false;
}
export function normalizeAutoReadAllIgnoreList(entries: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry !== "string") continue;
    const cleaned = normalizeAutoReadAllIgnoreEntry(entry).toLowerCase();
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
const GLOB_CHARS_RE = /[*?[\]{}]/;
const GLOB_CACHE_LIMIT = 256;
const globRegexCache = new Map<string, RegExp | null>();

function globRegexFor(entry: string): RegExp | null {
  const cached = globRegexCache.get(entry);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = globToRegex(entry);
  } catch {
    compiled = null;
  }
  if (globRegexCache.size >= GLOB_CACHE_LIMIT) {
    const oldest = globRegexCache.keys().next().value;
    if (oldest !== undefined) globRegexCache.delete(oldest);
  }
  globRegexCache.set(entry, compiled);
  return compiled;
}

export function isExcludedByCustomIgnore(path: string, customIgnore: readonly string[]): boolean {
  if (customIgnore.length === 0) return false;
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] ?? "";
  for (const entry of customIgnore) {
    if (entry.length === 0) continue;
    if (GLOB_CHARS_RE.test(entry)) {
      const regex = globRegexFor(entry);
      if (regex !== null) {
        if (entry.includes("/") ? regex.test(lower) : regex.test(base)) return true;
        continue;
      }
    }
    if (!entry.includes("/")) {
      if (segments.includes(entry)) return true;
    } else if (lower === entry || lower.startsWith(entry + "/") || lower.includes("/" + entry + "/") || lower.endsWith("/" + entry)) return true;
  }
  return false;
}

const WALK_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".tmp",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

export type AutoReadAllSource = "git" | "rg" | "walk";

export interface AutoReadAllDiscovery {
  files: string[];
  source: AutoReadAllSource;
  discovered: number;
  skippedBinary: number;
  skippedLarge: number;
  skippedOther: number;
  skippedByName: number;
}

export interface AutoReadAllSection {
  file: string;
  text: string;
  totalLines: number;
  absolutePath: string;
}
export interface AutoReadAllInjection {
  text: string;
  files: number;
  bytes: number;
  omitted: string[];
  chunks: string[];
  completeFiles: number;
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolveResult) => {
    execFile(command, args, { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BYTES }, (error, stdout) => {
      if (error === null) {
        resolveResult({ stdout: stdout ?? "", code: 0 });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolveResult({ stdout: stdout ?? "", code });
    });
  });
}

async function listFromGit(cwd: string): Promise<string[] | undefined> {
  const result = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function listFromRg(cwd: string): Promise<string[] | undefined> {
  let rgPath: string;
  try {
    rgPath = await resolveRgPath();
  } catch {
    return undefined;
  }
  const result = await runCommand(rgPath, ["--files", "--hidden", "--no-require-git", "--glob", "!.git", "--null"], cwd);
  if (result.code === 1) return [];
  if (result.code !== 0) return undefined;
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function walkDir(dir: string, base: string, out: string[], customIgnore: readonly string[] = []): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_IGNORED_DIRS.has(entry.name) || EXCLUDED_SEGMENT_SET.has(entry.name.toLowerCase())) continue;
      if (customIgnore.length > 0 && isExcludedByCustomIgnore(toPosix(relative(base, full)), customIgnore)) continue;
      await walkDir(full, base, out, customIgnore);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(base, full)));
    }
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const base = baseNameOf(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

async function hasNulByte(path: string): Promise<boolean | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function forEachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

export async function discoverAutoReadAllFiles(cwd: string, mode: AutoReadAllMode = "on", ignoreDirs: readonly string[] = []): Promise<AutoReadAllDiscovery> {
  const customIgnore = normalizeAutoReadAllIgnoreList(ignoreDirs);
  let source: AutoReadAllSource = "git";
  let candidates = await listFromGit(cwd);
  if (candidates === undefined) {
    if (mode === "git") {
      return { files: [], source: "git", discovered: 0, skippedBinary: 0, skippedLarge: 0, skippedOther: 0, skippedByName: 0 };
    }
    candidates = await listFromRg(cwd);
    source = "rg";
  }
  if (candidates === undefined) {
    source = "walk";
    const walked: string[] = [];
    await walkDir(cwd, cwd, walked, customIgnore);
    candidates = walked;
  }

  const unique = [...new Set(candidates.map(toPosix))].sort();
  const includable: string[] = [];
  let skippedByName = 0;
  for (const file of unique) {
    const baseLower = baseNameOf(file).toLowerCase();
    if (EXCLUDED_NAME_SET.has(baseLower) || isExcludedBySegment(file) || isExcludedByPattern(baseLower) || isExcludedByCustomIgnore(file, customIgnore)) skippedByName += 1;
    else includable.push(file);
  }
  const scanWindow = includable.slice(0, AUTO_READ_ALL_MAX_FILES * SCAN_LIMIT_MULTIPLIER);
  const sized: string[] = [];
  let skippedBinary = 0;
  let skippedLarge = 0;
  let skippedOther = 0;

  await forEachLimit(scanWindow, SCAN_CONCURRENCY, async (file) => {
    let stats;
    try {
      stats = await lstat(resolve(cwd, file));
    } catch {
      skippedOther += 1;
      return;
    }
    if (!stats.isFile()) {
      skippedOther += 1;
      return;
    }
    if (stats.size > AUTO_READ_ALL_MAX_FILE_BYTES) {
      skippedLarge += 1;
      return;
    }
    if (IMAGE_EXTENSIONS.has(extensionOf(file))) {
      skippedBinary += 1;
      return;
    }
    sized.push(file);
  });

  const textual: string[] = [];
  await forEachLimit(sized, SCAN_CONCURRENCY, async (file) => {
    const nul = await hasNulByte(resolve(cwd, file));
    if (nul === undefined) skippedOther += 1;
    else if (nul) skippedBinary += 1;
    else textual.push(file);
  });
  textual.sort();
  const files = textual.slice(0, AUTO_READ_ALL_MAX_FILES);

  return { files, source, discovered: unique.length, skippedBinary, skippedLarge, skippedOther, skippedByName };
}

export function chunkAutoReadAllSections(sections: string[], maxBytes: number = AUTO_READ_ALL_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section, "utf-8") + 2;
    if (current.length > 0 && currentBytes + sectionBytes > maxBytes) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentBytes = 0;
    }
    current.push(section);
    currentBytes += sectionBytes;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

async function candidateFileBytes(cwd: string, file: string): Promise<number | undefined> {
  try {
    const stats = await lstat(resolve(cwd, file));
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

async function renderFile(file: string, cwd: string): Promise<AutoReadAllSection | undefined> {
  try {
    const { normalized, fileHashes, absolutePath } = await readNormFile(file, cwd, { maxLines: MAX_HASH_LINES });
    const preview = await fmtReadPreview(normalized, {}, fileHashes, absolutePath, AUTO_READ_ALL_MAX_BUDGET_BYTES, MAX_HASH_LINES);
    serveRows(absolutePath, fileHashes, splitLines(normalized), preview.servedHashes);
    const totalLines = fileHashes.length;
    return { file, text: `=== ${file} ===\n${preview.text}`, totalLines, absolutePath };
  } catch (error) {
    console.error(`Auto-read all: skipped ${file}:`, error);
    return undefined;
  }
}

function buildFooter(attached: number, discovery: AutoReadAllDiscovery, omitted: string[]): string {
  const notes: string[] = [];
  const beyondCap = Math.max(
    0,
    discovery.discovered - discovery.files.length - discovery.skippedBinary - discovery.skippedLarge - discovery.skippedOther - discovery.skippedByName,
  );
  if (beyondCap > 0) notes.push(`${beyondCap} file(s) beyond the ${AUTO_READ_ALL_MAX_FILES}-file cap skipped`);
  if (discovery.skippedBinary > 0) notes.push(`${discovery.skippedBinary} binary or image file(s) skipped`);
  if (discovery.skippedLarge > 0) notes.push(`${discovery.skippedLarge} file(s) over ${formatSize(AUTO_READ_ALL_MAX_FILE_BYTES)} skipped`);
  if (discovery.skippedOther > 0) notes.push(`${discovery.skippedOther} unreadable path(s) skipped`);
  if (discovery.skippedByName > 0) notes.push(`${discovery.skippedByName} file(s) skipped by vendor/name/pattern rules`);
  const listed = omitted.slice(0, MAX_REPORTED_OMISSIONS).join(", ");
  const more = omitted.length > MAX_REPORTED_OMISSIONS ? `, ... (+${omitted.length - MAX_REPORTED_OMISSIONS} more)` : "";
  const omissionNote = omitted.length > 0 ? ` Not attached: ${listed}${more}. Use read for those.` : "";
  const summary = notes.length > 0 ? notes.join("; ") + "." : "all discovered files attached.";
  return `[hashline auto-read-all: ${attached} file(s) attached from ${discovery.source}; ${summary}${omissionNote}]`;
}

export async function buildAutoReadAllInjection(cwd: string, budgetBytes: number, mode: AutoReadAllMode = "on", ignoreDirs: readonly string[] = [], sessionKey?: string): Promise<AutoReadAllInjection | undefined> {
  const discovery = await discoverAutoReadAllFiles(cwd, mode, ignoreDirs);
  if (discovery.files.length === 0) return undefined;
  const sections: AutoReadAllSection[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  let completeFiles = 0;
  for (const file of discovery.files) {
    if (sections.length > 0) {
      const size = await candidateFileBytes(cwd, file);
      if (size !== undefined && bytes + size > budgetBytes) {
        omitted.push(file);
        continue;
      }
    }
    const section = await renderFile(file, cwd);
    if (section === undefined) {
      omitted.push(file);
      continue;
    }
    const sectionBytes = Buffer.byteLength(section.text, "utf-8") + 1;
    if (sections.length > 0 && bytes + sectionBytes > budgetBytes) {
      omitted.push(file);
      continue;
    }
    sections.push(section);
    const snapshotId = await safeSnapId(section.absolutePath, "auto-read-all");
    if (snapshotId !== undefined) recordAutoReadAllComplete(sessionKey, section.absolutePath, snapshotId);
    bytes += sectionBytes;
    completeFiles += 1;
  }
  if (sections.length === 0) return undefined;
  const sectionTexts = sections.map((section) => section.text);
  const chunks = chunkAutoReadAllSections(sectionTexts);
  const coverage = `[coverage: ${completeFiles} complete]`;
  const completeNames = sections.map((section) => section.file);
  const machineList = `[files complete: ${JSON.stringify(completeNames)} omitted: ${JSON.stringify(omitted)}]`;
  const text = `${HEADER}\n\n${coverage}\n${machineList}\n\n${sectionTexts.join("\n\n")}\n\n${buildFooter(sections.length, discovery, omitted)}`;
  return { text, files: sections.length, bytes, omitted, chunks, completeFiles };
}

export function autoReadAllBudget(model: { contextWindow?: number } | undefined): number {
  const contextWindow = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 0;
  const fromContext = Math.floor(contextWindow * 1.5);
  return Math.min(AUTO_READ_ALL_MAX_BUDGET_BYTES, Math.max(AUTO_READ_ALL_MIN_BUDGET_BYTES, fromContext));
}
