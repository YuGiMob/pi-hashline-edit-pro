import { randomUUID } from "crypto";
import {
	chmod,
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
  ): Promise<string> {
    if (remainingParts.length === 0) {
      return currentPath;
    }

    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart);

    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resParts(candidatePath, tail);
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
      ]);
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
const sweptDirs = new Set<string>();

async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (now - stats.mtimeMs > STALE_TEMP_MS) {
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

  if (existingStats && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    try {
      await chmod(targetPath, existingStats.mode & 0o7777);
    } catch {}
    try {
      const handle = await open(targetPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {}
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
