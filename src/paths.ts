import { homedir } from "os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "path";


function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  return join(homeBase(), ".config");
}

export function configDir(): string {
  return join(configBase(), "pi-hashline-edit-pro");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function hashStorePath(): string {
  return join(configDir(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
  return join(configDir(), "hash-store.json");
}

export function sessionClaimsDir(): string {
  return join(configDir(), "sessions");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

function expand(filePath: string): string {
  const home = homeBase();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return home + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
