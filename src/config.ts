import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";
import { errCode, isRec } from "./utils.ts";
import { writeAtomic } from "./fs-write.ts";
export type AutoReadAllMode = "off" | "outline" | "full";
const AUTO_READ_ALL_MODES: AutoReadAllMode[] = ["off", "outline", "full"];

export type AutoReadWriteMode = "full" | "summary" | "off";
const AUTO_READ_WRITE_MODES: AutoReadWriteMode[] = ["full", "summary", "off"];

export type ReadOnDisabledModels = "remove" | "vanilla";
const READ_ON_DISABLED_MODELS: ReadOnDisabledModels[] = ["remove", "vanilla"];

export const DEFAULT_DIFF_CONTEXT_LINES = 1;
export const MIN_DIFF_CONTEXT_LINES = 0;
export const MAX_DIFF_CONTEXT_LINES = 10;
export const DEFAULT_UNDO_RETENTION_DAYS = 30;
export const MIN_UNDO_RETENTION_DAYS = 0;
export const MAX_UNDO_RETENTION_DAYS = 3650;

export interface Config {
  autoRead: boolean;
  autoReadWrite?: AutoReadWriteMode;
  anchorGrepEnabled: boolean;
  copyMoveEnabled?: boolean;
  replaceMatchEnabled?: boolean;
  outlineEnabled?: boolean;
  autoReadAll?: AutoReadAllMode;
  autoReadAllRequireGit?: boolean;
  autoReadAllIgnore?: string[];
  requirePath?: boolean;
  strictInput?: boolean;
  diffContextLines?: number;
  disableOnModels?: string[];
  readOnDisabledModels?: ReadOnDisabledModels;
  undoRetentionDays?: number;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  autoReadWrite: "full",
  anchorGrepEnabled: true,
  copyMoveEnabled: true,
  replaceMatchEnabled: true,
  outlineEnabled: false,
  autoReadAll: "off",
  autoReadAllRequireGit: true,
  autoReadAllIgnore: [],
  requirePath: false,
  strictInput: false,
  diffContextLines: DEFAULT_DIFF_CONTEXT_LINES,
  disableOnModels: [],
  readOnDisabledModels: "vanilla",
  undoRetentionDays: DEFAULT_UNDO_RETENTION_DAYS,
};

function parseAutoReadAllMode(value: unknown): AutoReadAllMode {
  if (value === "off" || value === "outline" || value === "full") return value;
  if (value === "outline(git)") return "outline";
  if (value === "git") return "full";
  if (value === "on" || value === true) return "full";
  if (value === false) return "off";
  return DEFAULT_CONFIG.autoReadAll ?? "off";
}

function parseAutoReadWriteMode(value: unknown, legacyAutoRead: unknown): AutoReadWriteMode {
  if (value === "full" || value === "summary" || value === "off") return value;
  if (value === "on" || value === true) return "full";
  if (value === false) return "off";
  if (legacyAutoRead === false) return "off";
  return DEFAULT_CONFIG.autoReadWrite ?? "full";
}

function parseAutoReadAllRequireGit(value: unknown, legacyMode: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (legacyMode === "git" || legacyMode === "outline(git)") return true;
  if (legacyMode === "full" || legacyMode === "outline" || legacyMode === "on" || legacyMode === true) return false;
  return DEFAULT_CONFIG.autoReadAllRequireGit ?? true;
}

function parseReadOnDisabledModels(value: unknown, legacy: unknown): ReadOnDisabledModels {
  if (value === "remove" || value === "vanilla") return value;
  if (typeof legacy === "boolean") return legacy ? "remove" : "vanilla";
  return DEFAULT_CONFIG.readOnDisabledModels ?? "vanilla";
}

export function normalizeAutoReadAllIgnoreEntry(entry: string): string {
  return entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function parseStringList(value: unknown, normalize: (entry: string) => string): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = normalize(item);
    if (cleaned.length === 0) continue;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(cleaned);
  }
  return out;
}

export function parseAutoReadAllIgnore(value: unknown): string[] {
  return parseStringList(value, normalizeAutoReadAllIgnoreEntry);
}

export function parseDisableOnModels(value: unknown): string[] {
  return parseStringList(value, (entry) => entry.trim());
}

export function normalizeDiffContextLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DIFF_CONTEXT_LINES;
  const floored = Math.floor(value);
  if (floored < MIN_DIFF_CONTEXT_LINES) return MIN_DIFF_CONTEXT_LINES;
  if (floored > MAX_DIFF_CONTEXT_LINES) return MAX_DIFF_CONTEXT_LINES;
  return floored;
}

export function normalizeUndoRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_UNDO_RETENTION_DAYS;
  const floored = Math.floor(value);
  if (floored < MIN_UNDO_RETENTION_DAYS) return MIN_UNDO_RETENTION_DAYS;
  if (floored > MAX_UNDO_RETENTION_DAYS) return MAX_UNDO_RETENTION_DAYS;
  return floored;
}

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  if (!isRec(parsed) || (parsed.autoRead !== undefined && typeof parsed.autoRead !== "boolean")) {
    throw new Error("config.json must be an object with a boolean autoRead field");
  }
  const autoRead = parsed.autoRead;
  const autoReadWrite = parsed.autoReadWrite;
  const anchorGrepEnabled = parsed.anchorGrepEnabled;
  const copyMoveEnabled = parsed.copyMoveEnabled;
  const replaceMatchEnabled = parsed.replaceMatchEnabled;
  const outlineEnabled = parsed.outlineEnabled;
  const autoReadAll = parsed.autoReadAll;
  const autoReadAllRequireGit = parsed.autoReadAllRequireGit;
  const requirePath = parsed.requirePath;
  const strictInput = parsed.strictInput;
  const diffContextLines = parsed.diffContextLines;
  const autoReadAllIgnore = parsed.autoReadAllIgnore;
  const disableOnModels = parsed.disableOnModels;
  const readOnDisabledModels = parsed.readOnDisabledModels;
  const undoRetentionDays = parsed.undoRetentionDays;
  const legacyDisableReadOnModels = parsed.disableReadOnModels;
  return {
    autoRead: typeof autoRead === "boolean" ? autoRead : DEFAULT_CONFIG.autoRead,
    autoReadWrite: parseAutoReadWriteMode(autoReadWrite, autoRead),
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
    copyMoveEnabled: typeof copyMoveEnabled === "boolean" ? copyMoveEnabled : DEFAULT_CONFIG.copyMoveEnabled,
    replaceMatchEnabled: typeof replaceMatchEnabled === "boolean" ? replaceMatchEnabled : DEFAULT_CONFIG.replaceMatchEnabled,
    outlineEnabled: typeof outlineEnabled === "boolean" ? outlineEnabled : DEFAULT_CONFIG.outlineEnabled,
    autoReadAll: parseAutoReadAllMode(autoReadAll),
    autoReadAllRequireGit: parseAutoReadAllRequireGit(autoReadAllRequireGit, autoReadAll),
    requirePath: typeof requirePath === "boolean" ? requirePath : DEFAULT_CONFIG.requirePath,
    strictInput: typeof strictInput === "boolean" ? strictInput : DEFAULT_CONFIG.strictInput,
    diffContextLines: normalizeDiffContextLines(diffContextLines),
    autoReadAllIgnore: parseAutoReadAllIgnore(autoReadAllIgnore),
    disableOnModels: parseDisableOnModels(disableOnModels),
    readOnDisabledModels: parseReadOnDisabledModels(readOnDisabledModels, legacyDisableReadOnModels),
    undoRetentionDays: normalizeUndoRetentionDays(undoRetentionDays),
  };
}

async function loadConfigFile(): Promise<{ config: Config; corrupted: boolean }> {
  let content: string;
  try {
    content = await readFile(configPath(), "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return { config: { ...DEFAULT_CONFIG }, corrupted: false };
    console.error("Config file unreadable, using defaults:", error);
    return { config: { ...DEFAULT_CONFIG }, corrupted: false };
  }
  try {
    return { config: parseConfig(content), corrupted: false };
  } catch (error: unknown) {
    try {
      const badPath = configPath();
      await rename(badPath, `${badPath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    } catch { }
    console.error("Config file corrupted, quarantined, using defaults:", error);
    return { config: { ...DEFAULT_CONFIG }, corrupted: true };
  }
}
export async function readConfig(): Promise<Config> {
  return (await loadConfigFile()).config;
}
export async function readConfigWithStatus(): Promise<{ config: Config; corrupted: boolean }> {
  return loadConfigFile();
}
const CONFIG_LOCK_DELAY_MS = 25;
const CONFIG_LOCK_STALE_MS = 5000;
const CONFIG_LOCK_RETRIES = Math.ceil(CONFIG_LOCK_STALE_MS / CONFIG_LOCK_DELAY_MS) * 2;

interface ConfigLock {
  path: string;
  dev: number;
  ino: number;
}

async function acquireConfigLock(lockPath: string): Promise<ConfigLock> {
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch { }
  for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (errCode(error) === "ENOENT") {
        try {
          await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
        } catch { }
        continue;
      }
      if (errCode(error) !== "EEXIST") throw error;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > CONFIG_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { }
      await new Promise<void>((r) => setTimeout(r, CONFIG_LOCK_DELAY_MS));
      continue;
    }
    try {
      const st = await stat(lockPath);
      return { path: lockPath, dev: st.dev, ino: st.ino };
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch { }
      }
      continue;
    }
  }
  throw new Error(`[E_ACCESS] Could not acquire config lock: ${lockPath}`);
}
async function releaseConfigLock(lock: ConfigLock): Promise<void> {
  try {
    const st = await stat(lock.path);
    if (st.dev !== lock.dev || st.ino !== lock.ino) return;
  } catch {
    return;
  }
  try {
    await rm(lock.path, { recursive: true, force: true });
  } catch { }
}
export async function updateConfig(mut: (config: Config) => void): Promise<Config> {
  const cfgPath = configPath();
  const lockPath = `${cfgPath}.lock`;
  const lock = await acquireConfigLock(lockPath);
  try {
    const config = await readConfig();
    mut(config);
    await writeConfig(config);
    return config;
  } finally {
    await releaseConfigLock(lock);
  }
}
export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}


type ToggleKey = "autoRead" | "autoReadAllRequireGit" | "anchorGrepEnabled" | "copyMoveEnabled" | "replaceMatchEnabled" | "outlineEnabled" | "requirePath" | "strictInput";

async function toggleFlag(key: ToggleKey): Promise<boolean> {
  const config = await updateConfig((c) => { c[key] = !(c[key] === true); });
  return config[key] === true;
}
export const toggleAutoRead = (): Promise<boolean> => toggleFlag("autoRead");
export const toggleAutoReadAllRequireGit = (): Promise<boolean> => toggleFlag("autoReadAllRequireGit");
export const toggleAnchorGrep = (): Promise<boolean> => toggleFlag("anchorGrepEnabled");
export const toggleCopyMove = (): Promise<boolean> => toggleFlag("copyMoveEnabled");
export const toggleReplaceMatch = (): Promise<boolean> => toggleFlag("replaceMatchEnabled");
export const toggleOutline = (): Promise<boolean> => toggleFlag("outlineEnabled");
function steppedIndex(length: number, index: number, delta: number): number {
  return ((index + delta) % length + length) % length;
}

export async function cycleReadOnDisabledModels(delta = 1): Promise<ReadOnDisabledModels> {
  let next: ReadOnDisabledModels = "vanilla";
  await updateConfig((c) => {
    const current = c.readOnDisabledModels ?? "vanilla";
    next = READ_ON_DISABLED_MODELS[steppedIndex(READ_ON_DISABLED_MODELS.length, READ_ON_DISABLED_MODELS.indexOf(current), delta)] ?? "remove";
    c.readOnDisabledModels = next;
  });
  return next;
}
export async function cycleAutoReadAllMode(delta = 1): Promise<AutoReadAllMode> {
  let next: AutoReadAllMode = "off";
  await updateConfig((c) => {
    const current = c.autoReadAll ?? "off";
    next = AUTO_READ_ALL_MODES[steppedIndex(AUTO_READ_ALL_MODES.length, AUTO_READ_ALL_MODES.indexOf(current), delta)] ?? "off";
    c.autoReadAll = next;
  });
  return next;
}

export async function cycleAutoReadWriteMode(delta = 1): Promise<AutoReadWriteMode> {
  let next: AutoReadWriteMode = "full";
  await updateConfig((c) => {
    const current = c.autoReadWrite ?? "full";
    next = AUTO_READ_WRITE_MODES[steppedIndex(AUTO_READ_WRITE_MODES.length, AUTO_READ_WRITE_MODES.indexOf(current), delta)] ?? "full";
    c.autoReadWrite = next;
  });
  return next;
}

export const toggleRequirePath = (): Promise<boolean> => toggleFlag("requirePath");
export const toggleStrictInput = (): Promise<boolean> => toggleFlag("strictInput");
export async function getDiffContextLines(): Promise<number> {
  return normalizeDiffContextLines((await readConfig()).diffContextLines);
}
export async function getUndoRetentionDays(): Promise<number> {
  return normalizeUndoRetentionDays((await readConfig()).undoRetentionDays);
}
export async function adjustDiffContextLines(delta: number): Promise<number> {
  let next = DEFAULT_DIFF_CONTEXT_LINES;
  await updateConfig((c) => {
    next = normalizeDiffContextLines(normalizeDiffContextLines(c.diffContextLines) + delta);
    c.diffContextLines = next;
  });
  return next;
}
export async function adjustUndoRetentionDays(delta: number): Promise<number> {
  let next = DEFAULT_UNDO_RETENTION_DAYS;
  await updateConfig((c) => {
    next = normalizeUndoRetentionDays(normalizeUndoRetentionDays(c.undoRetentionDays) + delta);
    c.undoRetentionDays = next;
  });
  return next;
}
export async function setAutoReadAllIgnore(dirs: string[]): Promise<string[]> {
  let next: string[] = [];
  await updateConfig((c) => {
    next = parseAutoReadAllIgnore(dirs);
    c.autoReadAllIgnore = next;
  });
  return next;
}
export async function setAutoReadAllIgnoreFromText(text: string): Promise<string[]> {
  return setAutoReadAllIgnore(text.split(","));
}
export async function setDisableOnModels(patterns: string[]): Promise<string[]> {
  let next: string[] = [];
  await updateConfig((c) => {
    next = parseDisableOnModels(patterns);
    c.disableOnModels = next;
  });
  return next;
}
export async function setDisableOnModelsFromText(text: string): Promise<string[]> {
  return setDisableOnModels(text.split(","));
}
