import { describe, expect, it } from "vitest";
import {
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
  link,
  chmod,
  utimes,
  open,
  rename,
} from "fs/promises";
import { join } from "path";
import { resolveTarget, writeAtomic } from "../../src/fs-write";
import { withTempDir } from "../support/fixtures";


describe("resolveTarget", () => {
  it("resolves a simple path", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "a.txt");
      await writeFile(filePath, "hello");
      const resolved = await resolveTarget(filePath);
      expect(resolved).toBe(filePath);
    });
  });

  it.skipIf(process.platform === "win32")("resolves a path through a symlink", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const targetDir = join(dir, "target");
      const linkDir = join(dir, "link");
      await mkdir(targetDir);
      await symlink(targetDir, linkDir);
      const filePath = join(linkDir, "f.txt");
      await writeFile(join(targetDir, "f.txt"), "data");
      const resolved = await resolveTarget(filePath);
      expect(resolved).toBe(join(targetDir, "f.txt"));
    });
  });

  it.skipIf(process.platform === "win32")("resolves a chain of symlinks", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const real = join(dir, "real");
      const link1 = join(dir, "link1");
      const link2 = join(dir, "link2");
      await mkdir(real);
      await symlink(real, link1);
      await symlink(link1, link2);
      await writeFile(join(real, "x.txt"), "data");
      const resolved = await resolveTarget(join(link2, "x.txt"));
      expect(resolved).toBe(join(real, "x.txt"));
    });
  });

  it.skipIf(process.platform === "win32")("throws ELOOP on circular symlinks", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      await symlink(b, a);
      await symlink(a, b);
      await expect(resolveTarget(join(a, "x.txt"))).rejects.toThrow(
        /Too many symbolic links/,
      );
    });
  });

  it("returns the path with remaining parts when a component does not exist", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const missing = join(dir, "nonexistent", "sub", "file.txt");
      const resolved = await resolveTarget(missing);
      expect(resolved).toBe(missing);
    });
  });

  it("resolves an absolute path unchanged", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "data.txt");
      await writeFile(filePath, "x");
      const resolved = await resolveTarget(filePath);
      expect(resolved).toBe(filePath);
    });
  });
});

describe("writeAtomic", () => {
  it("writes content to a new file", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "new.txt");
      await writeAtomic(filePath, "hello world");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("hello world");
    });
  });

  it("overwrites an existing file", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "existing.txt");
      await writeFile(filePath, "old content");
      await writeAtomic(filePath, "new content");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("new content");
    });
  });

  it.skipIf(process.platform === "win32")("rejects a target swapped to a symlink after it was read", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const target = join(dir, "target.txt");
      const movedTarget = join(dir, "target-old.txt");
      const victim = join(dir, "victim.txt");
      await writeFile(target, "expected content");
      await writeFile(victim, "victim content");
      const before = await stat(target);
      await rename(target, movedTarget);
      await symlink(victim, target);

      await expect(
        writeAtomic(target, "attacker-controlled update", { dev: before.dev, ino: before.ino }),
      ).rejects.toThrow("[E_PATH_CHANGED]");
      expect(await readFile(victim, "utf-8")).toBe("victim content");
    });
  });

  it("overwrites a file held open for reading", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "held.txt");
      await writeFile(filePath, "old content");
      const handle = await open(filePath, "r");
      try {
        await writeAtomic(filePath, "new content");
      } finally {
        await handle.close();
      }
      expect(await readFile(filePath, "utf-8")).toBe("new content");
    });
  });

  it("preserves file permissions on overwrite", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "perm.txt");
      await writeFile(filePath, "original", { mode: 0o644 });
      await chmod(filePath, 0o644);
      const before = await stat(filePath);
      await writeAtomic(filePath, "updated");
      const after = await stat(filePath);
      expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    });
  });

  it.skipIf(process.platform === "win32")("writes to a file through a symlink", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const targetDir = join(dir, "real");
      const linkDir = join(dir, "link");
      await mkdir(targetDir);
      await symlink(targetDir, linkDir);
      const filePath = join(linkDir, "through.txt");
      await writeAtomic(filePath, "via symlink");
      const content = await readFile(join(targetDir, "through.txt"), "utf-8");
      expect(content).toBe("via symlink");
    });
  });

  it("writes to a hard-linked file in-place (nlink > 1)", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const original = join(dir, "original.txt");
      const hardlink = join(dir, "hardlink.txt");
      await writeFile(original, "shared content");
      await link(original, hardlink);
      await writeAtomic(original, "updated shared");
      const content1 = await readFile(original, "utf-8");
      const content2 = await readFile(hardlink, "utf-8");
      expect(content1).toBe("updated shared");
      expect(content2).toBe("updated shared");
    });
  });

  it("creates intermediate directories", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const nested = join(dir, "a", "b", "c", "nested.txt");
      await writeAtomic(nested, "deep");
      const content = await readFile(nested, "utf-8");
      expect(content).toBe("deep");
    });
  });

  it("writes empty content", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "empty.txt");
      await writeAtomic(filePath, "");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("");
    });
  });

  it("writes content with special characters", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const filePath = join(dir, "special.txt");
      const content = "line1\nline2\n  indented  \n\t\ttabbed\n";
      await writeAtomic(filePath, content);
      const read = await readFile(filePath, "utf-8");
      expect(read).toBe(content);
    });
  });

  it("sweeps only its own stale temp files, never user files with a .tmp- prefix", async () => {
    await withTempDir("fs-write-test-", async (dir) => {
      const userFile = join(dir, ".tmp-user-notes.txt");
      await writeFile(userFile, "precious");
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(userFile, stale, stale);
      const ownTemp = join(dir, ".tmp-12345678-1234-1234-1234-123456789abc");
      await writeFile(ownTemp, "stale temp");
      await utimes(ownTemp, stale, stale);

      const target = join(dir, "target.txt");
      await writeAtomic(target, "content");

      expect(await readFile(userFile, "utf-8")).toBe("precious");
      await expect(stat(ownTemp)).rejects.toThrow();
    });
  });
});
