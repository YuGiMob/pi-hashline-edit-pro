import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RG_TIMEOUT_MS } from "../../src/grep";
import { setupIntegrationTest, withTempDir } from "../support/fixtures";

const state = vi.hoisted(() => ({
  mode: "exit" as "exit" | "spawn-error" | "hang",
  child: null as { killed: boolean; kill(signal?: string): boolean } | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    kill(_signal?: string): boolean {
      this.killed = true;
      return true;
    }
  }
  return {
    ...actual,
    spawnSync: () => ({ status: 0, error: undefined }),
    spawn: () => {
      const child = new FakeChild();
      state.child = child;
      setImmediate(() => {
        if (state.mode === "spawn-error") {
          child.emit("error", new Error("spawn rg ENOENT"));
          return;
        }
        if (state.mode === "exit") {
          child.stderr.write("regex parse error: look-around is not supported\n");
          setImmediate(() => child.emit("close", 2));
        }
      });
      return child;
    },
  };
});

function runGrep(dir: string, pattern: string): Promise<unknown> {
  const { ctx, getTool } = setupIntegrationTest(dir);
  return getTool("anchor_grep").execute("g1", { pattern, path: "sample.txt" }, undefined, undefined, ctx);
}

beforeEach(() => {
  state.mode = "exit";
  state.child = null;
});

describe("anchor_grep ripgrep failure contract", () => {
  it("codes a spawn failure as [E_GREP_FAILED]", async () => {
    await withTempDir("grep-rg-spawn-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "spawn-error";
      await expect(runGrep(dir, "alpha")).rejects.toThrow(
        /\[E_GREP_FAILED\] ripgrep could not start: spawn rg ENOENT/,
      );
    });
  });

  it("codes a non-zero exit as [E_GREP_FAILED] with ripgrep's stderr", async () => {
    await withTempDir("grep-rg-exit-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "exit";
      await expect(runGrep(dir, "alpha")).rejects.toThrow(
        /\[E_GREP_FAILED\] ripgrep exited with code 2: regex parse error: look-around is not supported/,
      );
    });
  });

  it("codes a timeout as [E_GREP_TIMEOUT] and kills the child", async () => {
    await withTempDir("grep-rg-timeout-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "hang";
      const { ctx, getTool } = setupIntegrationTest(dir);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = getTool("anchor_grep")
          .execute("g1", { pattern: "alpha", path: "sample.txt" }, undefined, undefined, ctx)
          .then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
        for (let attempt = 0; attempt < 400 && state.child === null; attempt += 1) {
          await vi.advanceTimersByTimeAsync(5);
        }
        expect(state.child).not.toBeNull();
        await vi.advanceTimersByTimeAsync(RG_TIMEOUT_MS);
        expect(await pending).toContain("[E_GREP_TIMEOUT]");
        expect(state.child?.killed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
