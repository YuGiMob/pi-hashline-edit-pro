import { mkdir, readFile, rename, rm, stat } from "fs/promises";
import { dirname } from "path";
import { configPath } from "./paths";
import { errCode, isRec } from "./utils";
import { writeAtomic } from "./fs-write";
export type BoundaryDedupMode = "on" | "off" | "strict";

export const DEFAULT_DIFF_CONTEXT_LINES = 1;
export const MIN_DIFF_CONTEXT_LINES = 0;
export const MAX_DIFF_CONTEXT_LINES = 10;

export interface Config {
  autoRead: boolean;
  anchorGrepEnabled: boolean;
  requirePath?: boolean;
  strictInput?: boolean;
  boundaryDedupMode?: BoundaryDedupMode;
  diffContextLines?: number;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  anchorGrepEnabled: true,
  requirePath: false,
  strictInput: false,
  boundaryDedupMode: "on",
  diffContextLines: DEFAULT_DIFF_CONTEXT_LINES
};

const BOUNDARY_DEDUP_MODES: BoundaryDedupMode[] = ["on", "strict", "off"];

function parseBoundaryDedupMode(mode: unknown, legacy: unknown): BoundaryDedupMode {
  if (mode === "on" || mode === "strict" || mode === "off") return mode;
  if (legacy === true) return "on";
  if (legacy === false) return "off";
  return DEFAULT_CONFIG.boundaryDedupMode ?? "on";
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
  const autoRead = isRec(parsed) ? parsed.autoRead : undefined;
  if (typeof autoRead !== "boolean") {
    throw new Error("config.json must be an object with a boolean autoRead field");
  }
  const anchorGrepEnabled = isRec(parsed) ? parsed.anchorGrepEnabled : undefined;
  const requirePath = isRec(parsed) ? parsed.requirePath : undefined;
  const strictInput = isRec(parsed) ? parsed.strictInput : undefined;
  const boundaryDedupMode = isRec(parsed) ? parsed.boundaryDedupMode : undefined;
  const legacyBoundaryDedup = isRec(parsed) ? parsed.boundaryDedupEnabled : undefined;
  const diffContextLines = isRec(parsed) ? parsed.diffContextLines : undefined;
  return {
    autoRead,
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
    requirePath: typeof requirePath === "boolean" ? requirePath : DEFAULT_CONFIG.requirePath,
    strictInput: typeof strictInput === "boolean" ? strictInput : DEFAULT_CONFIG.strictInput,
    boundaryDedupMode: parseBoundaryDedupMode(boundaryDedupMode, legacyBoundaryDedup),
    diffContextLines: normalizeDiffContextLines(diffContextLines),
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
const CONFIG_LOCK_RETRIES = 80;
const CONFIG_LOCK_DELAY_MS = 25;
const CONFIG_LOCK_STALE_MS = 5000;
async function acquireConfigLock(lockPath: string): Promise<void> {
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch { }
  for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return;
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
    }
  }
  throw new Error(`[E_ACCESS] Could not acquire config lock: ${lockPath}`);
}
async function releaseConfigLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch { }
}
export async function updateConfig(mut: (config: Config) => void): Promise<Config> {
  const cfgPath = configPath();
  const lockPath = `${cfgPath}.lock`;
  await acquireConfigLock(lockPath);
  try {
    const config = await readConfig();
    mut(config);
    await writeConfig(config);
    return config;
  } finally {
    await releaseConfigLock(lockPath);
  }
}
export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}


export async function toggleAutoRead(): Promise<boolean> {
  const config = await updateConfig((c) => { c.autoRead = !c.autoRead; });
  return config.autoRead;
}
export async function toggleAnchorGrep(): Promise<boolean> {
  const config = await updateConfig((c) => { c.anchorGrepEnabled = !c.anchorGrepEnabled; });
  return config.anchorGrepEnabled;
}
export async function toggleRequirePath(): Promise<boolean> {
  const config = await updateConfig((c) => { c.requirePath = !c.requirePath; });
  return config.requirePath === true;
}
export async function toggleStrictInput(): Promise<boolean> {
  const config = await updateConfig((c) => { c.strictInput = !(c.strictInput === true); });
  return config.strictInput === true;
}
export async function cycleBoundaryDedupMode(): Promise<BoundaryDedupMode> {
  let next: BoundaryDedupMode = "on";
  await updateConfig((c) => {
    const current = c.boundaryDedupMode ?? "on";
    next = BOUNDARY_DEDUP_MODES[(BOUNDARY_DEDUP_MODES.indexOf(current) + 1) % BOUNDARY_DEDUP_MODES.length] ?? "on";
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
