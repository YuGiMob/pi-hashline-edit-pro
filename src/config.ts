import { readFile } from "fs/promises";
import { configPath } from "./paths";
import { errCode, isRec } from "./utils";
import { writeAtomic } from "./fs-write";

export interface Config {
  autoRead: boolean;
  anchorGrepEnabled: boolean;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true,
  anchorGrepEnabled: true
};

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  const autoRead = isRec(parsed) ? parsed.autoRead : undefined;
  if (typeof autoRead !== "boolean") {
    throw new Error("config.json must be an object with a boolean autoRead field");
  }
  const anchorGrepEnabled = isRec(parsed) ? parsed.anchorGrepEnabled : undefined;
  return {
    autoRead,
    anchorGrepEnabled: typeof anchorGrepEnabled === "boolean" ? anchorGrepEnabled : DEFAULT_CONFIG.anchorGrepEnabled,
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
