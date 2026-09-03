import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync } from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import register from "../../index";
import { makeFakePiRegistry, withHome } from "../support/fixtures";
import { shutdownHashStore } from "../../src/hash-store";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const isWindows = process.platform === "win32";

describe.skipIf(isRoot || isWindows)("permission errors", () => {
  let tempRoot: string;
  let tempDir: string;
  let restoreHome: (() => void) | undefined;

  beforeAll(() => {
    tempRoot = join(process.cwd(), ".tmp");
    mkdirSync(tempRoot, { recursive: true });
    tempDir = mkdtempSync(join(tempRoot, "pi-perm-test-"));
    restoreHome = withHome(tempDir);
  });

  afterAll(() => {
    shutdownHashStore();
    rmSync(tempDir, { recursive: true, force: true });
    restoreHome?.();
  });

  describe("read tool EACCES", () => {
    it("throws 'File is not readable' when file has no permissions", async () => {
      const filePath = join(tempDir, "unreadable.txt");
      writeFileSync(filePath, "secret content", "utf-8");
      chmodSync(filePath, 0o000);

      try {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const readTool = getTool("read");

        await expect(
          readTool.execute(
            "r1",
            { path: filePath },
            undefined,
            undefined,
            { cwd: tempDir } as any,
          ),
        ).rejects.toThrow("File is not readable");
      } finally {
        chmodSync(filePath, 0o644);
      }
    });
  });

  describe("edit tool EACCES", () => {
    it("throws 'File is not writable' when file has no permissions", async () => {
      const filePath = join(tempDir, "unwritable.txt");
      writeFileSync(filePath, "original content\n", "utf-8");
      chmodSync(filePath, 0o000);

      try {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("replace");

        await expect(
          editTool.execute(
            "e1",
            {
              path: filePath,
              remove_from: "Hasu", remove_to: "Hasu", replacement_lines: ["new content"],
            },
            undefined,
            undefined,
            { cwd: tempDir } as any,
          ),
        ).rejects.toThrow("File is not writable");
      } finally {
        chmodSync(filePath, 0o644);
      }
    });
  });
});
