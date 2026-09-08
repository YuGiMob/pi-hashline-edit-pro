import { readFile } from "fs/promises";
import { configPath } from "./paths";
import { errCode, isRec } from "./utils";
import { writeAtomic } from "./fs-write";

export interface Config {
  autoRead: boolean;
  anchorGrepEnabled: boolean;
  requirePath?: boolean;
  strictInput?: boolean;
  boundaryDedupEnabled?: boolean;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  anchorGrepEnabled: false,
  requirePath: false,
  strictInput: false,
  boundaryDedupEnabled: true
};

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  const autoRead = isRec(parsed) ? parsed.autoRead : undefined;
  if (typeof autoRead !== "boolean") {
    throw new Error("config.json must be an object with a boolean autoRead field");
  }
  const anchorGrepEnabled = isRec(parsed) ? parsed.anchorGrepEnabled : undefined;
  const requirePath = isRec(parsed) ? parsed.requirePath : undefined;
  const strictInput = isRec(parsed) ? parsed.strictInput : undefined;
  const boundaryDedupEnabled = isRec(parsed) ? parsed.boundaryDedupEnabled : undefined;
  return {
    autoRead,
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
    requirePath: typeof requirePath === "boolean" ? requirePath : DEFAULT_CONFIG.requirePath,
    strictInput: typeof strictInput === "boolean" ? strictInput : DEFAULT_CONFIG.strictInput,
    boundaryDedupEnabled: typeof boundaryDedupEnabled === "boolean" ? boundaryDedupEnabled : DEFAULT_CONFIG.boundaryDedupEnabled,
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

export async function toggleBoundaryDedup(): Promise<boolean> {
  const config = await readConfig();
  const enabled = config.boundaryDedupEnabled !== false;
  config.boundaryDedupEnabled = !enabled;
  await writeConfig(config);
  return !enabled;
}
