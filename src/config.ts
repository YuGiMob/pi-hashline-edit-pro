import { readFile } from "fs/promises";
import { configPath } from "./paths";
import { errCode, isRec } from "./utils";
import { writeAtomic } from "./fs-write";

export type BoundaryDedupMode = "on" | "off" | "strict";

export interface Config {
  autoRead: boolean;
  anchorGrepEnabled: boolean;
  requirePath?: boolean;
  strictInput?: boolean;
  boundaryDedupMode?: BoundaryDedupMode;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  anchorGrepEnabled: true,
  requirePath: false,
  strictInput: false,
  boundaryDedupMode: "on"
};

const BOUNDARY_DEDUP_MODES: BoundaryDedupMode[] = ["on", "strict", "off"];

function parseBoundaryDedupMode(mode: unknown, legacy: unknown): BoundaryDedupMode {
  if (mode === "on" || mode === "strict" || mode === "off") return mode;
  if (legacy === true) return "on";
  if (legacy === false) return "off";
  return DEFAULT_CONFIG.boundaryDedupMode ?? "on";
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
  return {
    autoRead,
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
    requirePath: typeof requirePath === "boolean" ? requirePath : DEFAULT_CONFIG.requirePath,
    strictInput: typeof strictInput === "boolean" ? strictInput : DEFAULT_CONFIG.strictInput,
    boundaryDedupMode: parseBoundaryDedupMode(boundaryDedupMode, legacyBoundaryDedup),
  };
}


export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf-8");
    return parseConfig(content);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      console.error("Config file corrupted, using defaults:", error);
    }
    return { ...DEFAULT_CONFIG };
  }
}
export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}


export async function toggleAutoRead(): Promise<boolean> {
  const config = await readConfig();
  config.autoRead = !config.autoRead;
  await writeConfig(config);
  return config.autoRead;
}

export async function toggleAnchorGrep(): Promise<boolean> {
  const config = await readConfig();
  config.anchorGrepEnabled = !config.anchorGrepEnabled;
  await writeConfig(config);
  return config.anchorGrepEnabled;
}

export async function toggleRequirePath(): Promise<boolean> {
  const config = await readConfig();
  config.requirePath = !config.requirePath;
  await writeConfig(config);
  return config.requirePath;
}

export async function toggleStrictInput(): Promise<boolean> {
  const config = await readConfig();
  config.strictInput = !(config.strictInput === true);
  await writeConfig(config);
  return config.strictInput === true;
}

export async function cycleBoundaryDedupMode(): Promise<BoundaryDedupMode> {
  const config = await readConfig();
  const current = config.boundaryDedupMode ?? "on";
  const next = BOUNDARY_DEDUP_MODES[(BOUNDARY_DEDUP_MODES.indexOf(current) + 1) % BOUNDARY_DEDUP_MODES.length] ?? "on";
  config.boundaryDedupMode = next;
  await writeConfig(config);
  return next;
}
