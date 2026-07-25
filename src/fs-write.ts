import { randomUUID } from "crypto";
import {
	lstat,
	mkdir,
	open,
	readlink,
	rename,
	rm,
	stat,
	writeFile,
	copyFile,
} from "fs/promises";
import { dirname, join, parse, resolve, sep } from "path";
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
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(content, "utf-8");
    if (existingStats) {
      await tempHandle.chmod(existingStats.mode & 0o7777);
    }
  } catch (error: unknown) {
    await tempHandle.close();
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
  try {
    await tempHandle.close();
    await rename(tempPath, targetPath);
  } catch (error: unknown) {
    if (errCode(error) === "EXDEV") {
      try {
        await tempHandle.close();
        await copyFile(tempPath, targetPath);
        await rm(tempPath, { force: true });
        return;
      } catch {
        try { await rm(tempPath, { force: true }); } catch {}
        throw error;
      }
    }
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
