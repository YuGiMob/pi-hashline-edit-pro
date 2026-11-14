import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RG_EVENT_BYTES, RG_TIMEOUT_MS } from "../../src/grep";
import { setupIntegrationTest, withTempDir, toolError, getText } from "../support/fixtures";

const state = vi.hoisted(() => ({
  mode: "exit" as "exit" | "spawn-error" | "hang" | "partial" | "oversized",
  oversizedBytes: 0,
  partialPath: undefined as string | undefined,
  child: null as { killed: boolean; kill(signal?: string): boolean } | null,
  onSpawn: null as (() => void) | null,
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
      if (state.mode === "oversized") setImmediate(() => this.emit("close", null));
      return true;
    }
  }
  return {
    ...actual,
    spawnSync: () => ({ status: 0, error: undefined }),
    spawn: () => {
      const child = new FakeChild();
      state.child = child;
      state.onSpawn?.();
      setImmediate(() => {
        if (state.mode === "spawn-error") {
          child.emit("error", new Error("spawn rg ENOENT"));
          return;
        }
        if (state.mode === "exit") {
          child.stderr.write("regex parse error: look-around is not supported\n");
          setImmediate(() => child.emit("close", 2));
        }
        if (state.mode === "partial") {
          const path = state.partialPath ?? "";
          child.stdout.write(`${JSON.stringify({ type: "match", data: { path: { text: path }, line_number: 1, submatches: [{ start: 0, end: 5 }] } })}\n`);
          child.stderr.write(`${path}: Permission denied (os error 13)\n`);
          setTimeout(() => child.emit("close", 2), 10);
        }
        if (state.mode === "oversized") {
          if (state.partialPath !== undefined) {
            child.stdout.write(`${JSON.stringify({ type: "match", data: { path: { text: state.partialPath }, line_number: 1, submatches: [{ start: 0, end: 5 }] } })}\n`);
          }
          setImmediate(() => {
            child.stdout.write(Buffer.alloc(state.oversizedBytes, 0x78));
            setImmediate(() => child.stdout.write("yy\n"));
          });
        }
      });
      return child;
    },
  };
});

function runGrep(dir: string, pattern: string): Promise<{ content: readonly unknown[]; isError?: boolean }> {
  const { ctx, getTool } = setupIntegrationTest(dir);
  return getTool("grep").execute("g1", { pattern, path: "sample.txt" }, undefined, undefined, ctx);
}

beforeEach(() => {
  state.mode = "exit";
  state.child = null;
  state.onSpawn = null;
  state.partialPath = undefined;
});

describe("grep ripgrep failure contract", () => {
  it("codes a spawn failure as [E_GREP_FAILED]", async () => {
    await withTempDir("grep-rg-spawn-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "spawn-error";
      expect(await toolError(() => runGrep(dir, "alpha"))).toMatch(
        /\[E_GREP_FAILED\] ripgrep could not start: spawn rg ENOENT/,
      );
    });
  });

  it("codes a non-zero exit as [E_GREP_FAILED] with ripgrep's stderr", async () => {
    await withTempDir("grep-rg-exit-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "exit";
      expect(await toolError(() => runGrep(dir, "alpha"))).toMatch(
        /\[E_GREP_FAILED\] ripgrep exited with code 2: regex parse error: look-around is not supported/,
      );
    });
  });

  it("keeps the matches of readable files when ripgrep reports an unreadable path", async () => {
    await withTempDir("grep-rg-partial-", async (dir) => {
      const sample = join(dir, "sample.txt");
      await writeFile(sample, "alpha\nbeta\n", "utf-8");
      state.mode = "partial";
      state.partialPath = sample;
      const { ctx, getTool } = setupIntegrationTest(dir);
      const result = await getTool("grep").execute("g1", { pattern: "alpha", path: "." }, undefined, undefined, ctx);
      const text = getText(result);
      expect(text).toContain("=== sample.txt ===");
      expect(text).toContain("alpha");
      expect(text).toContain("some paths could not be searched");
      expect(text).toContain("Permission denied");
      expect(result.isError).toBeFalsy();
    });
  });

  it("stops ripgrep at an event over the cap and keeps the matches read before it", async () => {
    await withTempDir("grep-rg-oversized-", async (dir) => {
      const sample = join(dir, "sample.txt");
      await writeFile(sample, "alpha\nbeta\n", "utf-8");
      state.mode = "oversized";
      state.oversizedBytes = MAX_RG_EVENT_BYTES;
      state.partialPath = sample;
      const { ctx, getTool } = setupIntegrationTest(dir);
      const result = await getTool("grep").execute("g1", { pattern: ".", path: "." }, undefined, undefined, ctx);
      const text = getText(result);
      expect(state.child?.killed).toBe(true);
      expect(text).toContain("=== sample.txt ===");
      expect(text).toContain("the search stopped there");
      expect(result.isError).toBeFalsy();
    });
  });

  it("reports an event over the cap when nothing else matched", async () => {
    await withTempDir("grep-rg-oversized-only-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "oversized";
      state.oversizedBytes = MAX_RG_EVENT_BYTES;
      const { ctx, getTool } = setupIntegrationTest(dir);
      const result = await getTool("grep").execute("g1", { pattern: ".", path: "sample.txt" }, undefined, undefined, ctx);
      const text = getText(result);
      expect(state.child?.killed).toBe(true);
      expect(text).toContain("No matches found.");
      expect(text).toContain("the search stopped there");
      expect(result.isError).toBeFalsy();
    });
  });

  it("codes a timeout as [E_GREP_TIMEOUT] and kills the child", async () => {
    await withTempDir("grep-rg-timeout-", async (dir) => {
      await writeFile(join(dir, "sample.txt"), "alpha\n", "utf-8");
      state.mode = "hang";
      const { ctx, getTool } = setupIntegrationTest(dir);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const spawned = new Promise<void>((resolve) => {
          state.onSpawn = resolve;
        });
        const pending = getTool("grep")
          .execute("g1", { pattern: "alpha", path: "sample.txt" }, undefined, undefined, ctx)
          .then((result: { content: readonly unknown[] }) => {
            const first = result.content[0] as { text?: string } | undefined;
            return first?.text ?? "";
          });
        await spawned;
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
