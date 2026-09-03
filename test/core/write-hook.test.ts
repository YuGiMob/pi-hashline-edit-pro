import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { initHasher } from "../../src/hashline";
import { findServedHashEcho, findEditHashEcho, servedHashEchoDenial, registerWriteHook } from "../../src/write-hook";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { recordServed } from "../../src/served";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-writehook-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

describe("write-hook findServedHashEcho", () => {
  it("returns undefined when served set is empty", () => {
    expect(findServedHashEcho("ATIm│hello\n", new Set())).toBeUndefined();
  });
  it("returns undefined when no line matches served hash", () => {
    expect(findServedHashEcho("ATIm│hello\n", new Set(["xY9"]))).toBeUndefined();
  });
  it("returns first matching line and hash", () => {
    const served = new Set(["ATIm", "ioor"]);
    const content = "zzz\nioor│second\nHasu│third\n";
    const result = findServedHashEcho(content, served);
    expect(result).toEqual({ line: 2, hash: "ioor" });
  });
  it("matches hash at start of line only", () => {
    const served = new Set(["ATIm"]);
    expect(findServedHashEcho(" xx ATIm│hello\n", served)).toBeUndefined();
    expect(findServedHashEcho("ATIm│hello\n", served)).toEqual({ line: 1, hash: "ATIm" });
  });
  it("handles empty content", () => {
    expect(findServedHashEcho("", new Set(["ATIm"]))).toBeUndefined();
  });
});

describe("write-hook findEditHashEcho", () => {
  it("returns undefined for empty served", () => {
    expect(findEditHashEcho(["ATIm│hello"], new Set())).toBeUndefined();
  });
  it("returns matching entry from lines array", () => {
    const served = new Set(["BeSR"]);
    expect(findEditHashEcho(["zzz", "BeSR│hi", "ATIm│bye"], served)).toEqual({ line: 2, hash: "BeSR" });
  });
  it("returns undefined when no match", () => {
    expect(findEditHashEcho(["ATIm│hello"], new Set(["xY9"]))).toBeUndefined();
  });
});

describe("write-hook servedHashEchoDenial", () => {
  it("returns undefined when no served record exists", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-no-served-"));
      try {
        const result = await servedHashEchoDenial("test.txt", "ATIm│hello\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns undefined when served exists but content has no echo", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-no-echo-"));
      try {
        const filePath = join(dir, "test.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map([["ATIm", "ATIm"]]));
        const result = await servedHashEchoDenial("test.txt", "clean content\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns denial string when content contains served hash", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-echo-"));
      try {
        const filePath = join(dir, "test.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map([["ATIm", "ATIm"]]));
        const result = await servedHashEchoDenial("test.txt", "ATIm│copied\n", dir);
        expect(result).toContain("[E_WRITE_HASH_ECHO]");
        expect(result).toContain("ATIm│");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("throws when signal is aborted before resolve", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-abort-"));
      try {
        const controller = new AbortController();
        controller.abort();
        await expect(servedHashEchoDenial("test.txt", "ATIm│hello\n", dir, controller.signal)).rejects.toThrow("Operation aborted");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns undefined when file has empty served set", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-empty-set-"));
      try {
        const filePath = join(dir, "empty.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map());
        const result = await servedHashEchoDenial("empty.txt", "ATIm│hello\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("write-hook registerWriteHook", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    return {
      pi: {
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      handlers,
    };
  }
  it("registers tool_call handler", () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    expect(handlers.has("tool_call")).toBe(true);
  });
  it("ignores non-write tool calls", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const result = await handler({ toolName: "read", input: { path: "a.txt", content: "hello" } }, { cwd: "/tmp", signal: undefined });
    expect(result).toBeUndefined();
  });
  it("ignores write with non-string path or content", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    expect(await handler({ toolName: "write", input: { path: 123, content: "hello" } }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
    expect(await handler({ toolName: "write", input: { path: "a.txt", content: 123 } }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
    expect(await handler({ toolName: "write", input: null }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
  });
  it("blocks write when echo is detected", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-block-"));
      try {
        const filePath = join(dir, "blocked.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map([["ATIm", "ATIm"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { path: "blocked.txt", content: "ATIm│echo\n" } }, { cwd: dir, signal: undefined });
        expect(result).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("[E_WRITE_HASH_ECHO]") }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("allows write when no echo", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-allow-"));
      try {
        const filePath = join(dir, "allowed.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map([["ATIm", "ATIm"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { path: "allowed.txt", content: "clean\n" } }, { cwd: dir, signal: undefined });
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("handles file_path alias", async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-alias-"));
      try {
        const filePath = join(dir, "alias.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        const store = await loadHashStore();
        recordServed(store, filePath, new Map([["ATIm", "ATIm"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { file_path: "alias.txt", content: "ATIm│echo\n" } }, { cwd: dir, signal: undefined });
        expect(result).toEqual(expect.objectContaining({ block: true }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("swallows store failures and allows write", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const result = await handler({ toolName: "write", input: { path: "missing.txt", content: "ATIm│hello\n" } }, { cwd: "/nonexistent_xyz", signal: undefined });
    expect(result).toBeUndefined();
  });
  it("rethrows abort errors", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const controller = new AbortController();
    controller.abort();
    await expect(handler({ toolName: "write", input: { path: "a.txt", content: "hello" } }, { cwd: "/tmp", signal: controller.signal })).rejects.toThrow("Operation aborted");
  });
});
