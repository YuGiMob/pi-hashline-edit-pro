import { randomUUID } from "crypto";
import { constants } from "fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readlink,
	rename,
	rm,
	stat,
	writeFile,
} from "fs/promises";
import { dirname, join, parse, resolve, sep } from "path";
import { toCwd } from "./paths";
import { errCode } from "./utils";

export interface FileIdentity {
  dev: number;
  ino: number;
}

function sameIdentity(
  actual: Pick<Awaited<ReturnType<typeof stat>>, "dev" | "ino">,
  expected: FileIdentity,
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function pathChanged(path: string): Error {
  return new Error(`[E_PATH_CHANGED] Refusing to write ${path}: the target changed after it was read.`);
}

export async function resolveTarget(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resParts(
    currentPath: string,
    remainingParts: string[],
    symlinkDepth = 0,
  ): Promise<string> {
    if (symlinkDepth > 40) {
      const error = new Error(
        `Too many symbolic links while resolving ${path}`,
      ) as NodeJS.ErrnoException;
      error.code = "ELOOP";
      throw error;
    }
    if (remainingParts.length === 0) {
      return currentPath;
    }

    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart);

    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resParts(candidatePath, tail, symlinkDepth);
      }

      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(
          `Too many symbolic links while resolving ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);

      const linkTargetPath = resolve(
        dirname(candidatePath),
        await readlink(candidatePath),
      );
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resParts(parse(linkTargetPath).root, [
        ...targetParts,
        ...tail,
      ], symlinkDepth + 1);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }

  return resParts(root, parts);
}

const TEMP_PREFIX = ".tmp-";
const TEMP_UUID_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const sweptDirs = new Map<string, number>();

async function sweepStaleTemps(dir: string): Promise<void> {
  const sweepNow = Date.now();
  const lastSweep = sweptDirs.get(dir);
  if (lastSweep !== undefined && sweepNow - lastSweep < STALE_TEMP_MS) return;
  sweptDirs.set(dir, sweepNow);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (sweepNow - stats.mtimeMs > STALE_TEMP_MS) {
          await rm(tempPath, { force: true });
        }
      } catch {
      }
    }
  } catch {
  }
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}

export async function resolveInCwd(path: string, cwd: string): Promise<{ absolute: string; resolved: string }> {
  const absolute = toCwd(path, cwd);
  const resolved = await resolveTarget(absolute);
  return { absolute, resolved };
}
export async function writeAtomic(
  path: string,
  content: string,
  expectedIdentity?: FileIdentity,
): Promise<void> {
  const targetPath = await resolveTarget(path);

  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (expectedIdentity && (!existingStats || !sameIdentity(existingStats, expectedIdentity))) {
    throw pathChanged(path);
  }

  if (existingStats && existingStats.nlink > 1) {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(targetPath, constants.O_WRONLY | noFollow);
    try {
      const openedStats = await handle.stat();
      if (!sameIdentity(openedStats, existingStats)) throw pathChanged(path);
      await handle.writeFile(content, "utf-8");
      await handle.truncate(Buffer.byteLength(content, "utf-8"));
      try {
        await handle.chmod(existingStats.mode & 0o7777);
      } catch {}
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const dir = dirname(targetPath);
  await sweepStaleTemps(dir);
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(content, "utf-8");
    if (existingStats) {
      await tempHandle.chmod(existingStats.mode & 0o7777);
    }
    await tempHandle.sync();
  } catch (error: unknown) {
    try { await tempHandle.close(); } catch {}
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
  try {
    await tempHandle.close();
    try {
      const finalStats = await lstat(targetPath);
      if (!existingStats || finalStats.isSymbolicLink() || !sameIdentity(finalStats, existingStats)) {
        throw pathChanged(path);
      }
    } catch (error) {
      if (errCode(error) !== "ENOENT" || existingStats) throw error;
    }
    await rename(tempPath, targetPath);
    await syncDir(dir);
  } catch (error: unknown) {
    if (process.platform === "win32" && errCode(error) === "EPERM") {
      try {
        await writeFile(targetPath, content, "utf-8");
        return;
      } finally {
        try { await rm(tempPath, { force: true }); } catch {}
      }
    }
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}
