import { constants } from "fs";
import { stat } from "fs/promises";
import { relative } from "path";
import { lineHashes } from "./hashline";
import { loadFileKindAndText, type LFile } from "./file-kind";
import { resolveTarget } from "./fs-write";
import { toCwd } from "./paths";
import { detectEnding, toLF, stripBOM, type LineEnding } from "./replace-diff";
import { abortIf, errCode, assertLineLimit } from "./utils";
import { valKind, valAccess } from "./validation";
import type { HashStore } from "./hash-store";
export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

export type SnapInfo = {
  snapshotId: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

function fmtSnapId(
  canonicalPath: string,
  info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
): string {
  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  const stats = await stat(canonicalPath);
  return {
    snapshotId: fmtSnapId(canonicalPath, stats),
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
  };
}

export async function safeSnapId(
  absolutePath: string,
  context: string,
): Promise<string | undefined> {
  try {
    return (await fileSnap(absolutePath)).snapshotId;
  } catch (error) {
    console.error(`[safeSnapId] ${context}: failed to stat "${absolutePath}" (code=${errCode(error) ?? "?"}):`, error);
    return undefined;
  }
}

export interface ReadNormOptions {
  signal?: AbortSignal;
  accessMode?: number;
  preloadedFile?: LFile;
  preloadedNorm?: NormFile;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
}

export async function readNormFile(
  path: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  const signal = options?.signal;
  const accessMode = options?.accessMode ?? constants.R_OK;

  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);

  abortIf(signal);
  const preloadedNorm = options?.preloadedNorm;
  if (preloadedNorm) return preloadedNorm;

  const file = options?.preloadedFile ?? (await loadFileKindAndText(resolvedPath, { maxLines: options?.maxLines, displayPath: path }));
  valKind(file, path);
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(file.text);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);

  if (options?.maxLines !== undefined) assertLineLimit(normalized, path, options.maxLines);

  const fileHashes = await lineHashes(normalized, resolvedPath, undefined, options?.store, options?.noPersist !== true);
  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}

export async function tryReadNormFile(
  absPath: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile | undefined> {
  try {
    const displayPath = relative(cwd, absPath).replace(/\\/g, "/") || absPath;
    const file = await loadFileKindAndText(absPath, { maxLines: options?.maxLines, displayPath });
    if (file.kind !== "text") return undefined;
    return await readNormFile(absPath, cwd, { ...options, preloadedFile: file });
  } catch (error) {
    const code = errCode(error);
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ELOOP") return undefined;
    if (error instanceof Error) {
      const msg = error.message;
      if (msg.startsWith("[E_FILE_TOO_LARGE]") || msg.startsWith("[E_NOT_FOUND]") || msg.startsWith("[E_ACCESS]") || msg.startsWith("[E_NOT_TEXT]")) return undefined;
    }
    throw error;
  }
}
