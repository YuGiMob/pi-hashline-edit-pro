import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths";
import { errCode, isRec } from "./utils";
import { writeAtomic } from "./fs-write";
export type BoundaryDedupMode = "on" | "off" | "strict";
export type AutoReadAllMode = "off" | "on" | "git";
const AUTO_READ_ALL_MODES: AutoReadAllMode[] = ["off", "on", "git"];

export const DEFAULT_DIFF_CONTEXT_LINES = 1;
export const MIN_DIFF_CONTEXT_LINES = 0;
export const MAX_DIFF_CONTEXT_LINES = 10;

export interface Config {
  autoRead: boolean;
  anchorGrepEnabled: boolean;
  autoReadAll?: AutoReadAllMode;
  autoReadAllIgnore?: string[];
  requirePath?: boolean;
  strictInput?: boolean;
  boundaryDedupMode?: BoundaryDedupMode;
  diffContextLines?: number;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  anchorGrepEnabled: true,
  autoReadAll: "off",
  autoReadAllIgnore: [],
  requirePath: false,
  strictInput: false,
  boundaryDedupMode: "off",
  diffContextLines: DEFAULT_DIFF_CONTEXT_LINES
};

const BOUNDARY_DEDUP_MODES: BoundaryDedupMode[] = ["on", "strict", "off"];

function parseBoundaryDedupMode(mode: unknown, legacy: unknown): BoundaryDedupMode {
  if (mode === "on" || mode === "strict" || mode === "off") return mode;
  if (legacy === true) return "on";
  if (legacy === false) return "off";
  return DEFAULT_CONFIG.boundaryDedupMode ?? "off";
}

function parseAutoReadAllMode(value: unknown): AutoReadAllMode {
  if (value === "off" || value === "on" || value === "git") return value;
  if (value === true) return "on";
  if (value === false) return "off";
  return DEFAULT_CONFIG.autoReadAll ?? "off";
}

export function normalizeAutoReadAllIgnoreEntry(entry: string): string {
  return entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function parseAutoReadAllIgnore(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = normalizeAutoReadAllIgnoreEntry(item);
    if (cleaned.length === 0) continue;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(cleaned);
  }
  return out;
}

export function normalizeDiffContextLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DIFF_CONTEXT_LINES;
  const floored = Math.floor(value);
  if (floored < MIN_DIFF_CONTEXT_LINES) return MIN_DIFF_CONTEXT_LINES;
  if (floored > MAX_DIFF_CONTEXT_LINES) return MAX_DIFF_CONTEXT_LINES;
  return floored;
}

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  if (!isRec(parsed) || (parsed.autoRead !== undefined && typeof parsed.autoRead !== "boolean")) {
    throw new Error("config.json must be an object with a boolean autoRead field");
  }
  const autoRead = parsed.autoRead;
  const anchorGrepEnabled = parsed.anchorGrepEnabled;
  const autoReadAll = parsed.autoReadAll;
  const requirePath = parsed.requirePath;
  const strictInput = parsed.strictInput;
  const boundaryDedupMode = parsed.boundaryDedupMode;
  const legacyBoundaryDedup = parsed.boundaryDedupEnabled;
  const diffContextLines = parsed.diffContextLines;
  const autoReadAllIgnore = parsed.autoReadAllIgnore;
  return {
    autoRead: typeof autoRead === "boolean" ? autoRead : DEFAULT_CONFIG.autoRead,
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
    autoReadAll: parseAutoReadAllMode(autoReadAll),
    requirePath: typeof requirePath === "boolean" ? requirePath : DEFAULT_CONFIG.requirePath,
    strictInput: typeof strictInput === "boolean" ? strictInput : DEFAULT_CONFIG.strictInput,
    boundaryDedupMode: parseBoundaryDedupMode(boundaryDedupMode, legacyBoundaryDedup),
    diffContextLines: normalizeDiffContextLines(diffContextLines),
    autoReadAllIgnore: parseAutoReadAllIgnore(autoReadAllIgnore),
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


type ToggleKey = "autoRead" | "anchorGrepEnabled" | "requirePath" | "strictInput";

async function toggleFlag(key: ToggleKey): Promise<boolean> {
  const config = await updateConfig((c) => { c[key] = !(c[key] === true); });
  return config[key] === true;
}
export const toggleAutoRead = (): Promise<boolean> => toggleFlag("autoRead");
export const toggleAnchorGrep = (): Promise<boolean> => toggleFlag("anchorGrepEnabled");
export async function cycleAutoReadAllMode(): Promise<AutoReadAllMode> {
  let next: AutoReadAllMode = "off";
  await updateConfig((c) => {
    const current = c.autoReadAll ?? "off";
    next = AUTO_READ_ALL_MODES[(AUTO_READ_ALL_MODES.indexOf(current) + 1) % AUTO_READ_ALL_MODES.length] ?? "off";
    c.autoReadAll = next;
  });
  return next;
}
export const toggleRequirePath = (): Promise<boolean> => toggleFlag("requirePath");
export const toggleStrictInput = (): Promise<boolean> => toggleFlag("strictInput");
export async function cycleBoundaryDedupMode(): Promise<BoundaryDedupMode> {
  let next: BoundaryDedupMode = "off";
  await updateConfig((c) => {
    const current = c.boundaryDedupMode ?? "off";
    next = BOUNDARY_DEDUP_MODES[(BOUNDARY_DEDUP_MODES.indexOf(current) + 1) % BOUNDARY_DEDUP_MODES.length] ?? "off";
    c.boundaryDedupMode = next;
  });
  return next;
}
export async function getDiffContextLines(): Promise<number> {
  return normalizeDiffContextLines((await readConfig()).diffContextLines);
}
export async function adjustDiffContextLines(delta: number): Promise<number> {
  let next = DEFAULT_DIFF_CONTEXT_LINES;
  await updateConfig((c) => {
    next = normalizeDiffContextLines(normalizeDiffContextLines(c.diffContextLines) + delta);
    c.diffContextLines = next;
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
