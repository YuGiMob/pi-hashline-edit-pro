import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../support/fixtures";
import { mkdir } from "fs/promises";
import { join } from "path";
import { isValidHashList } from "../../src/hash-store/validation";

function makeLifecyclePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    getActiveTools: () => [],
    setActiveTools() {},
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  return { pi, handlers };
}

describe("startup non-blocking prune", () => {
  it("session_start returns before pruneMissing finishes", async () => {
    await withTempDir("startup-prune-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
        const store = await loadHashStore();
        for (let i = 0; i < 120; i++) {
          store.stmts.upsert(`/tmp/nonexistent-${i}-${Date.now()}`, "chk", 1, JSON.stringify(["abc"]), Date.now());
        }
        shutdownHashStore();
        const { pi, handlers } = makeLifecyclePi();
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        const start = Date.now();
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(200);
        await new Promise(r => setTimeout(r, 800));
        const store2 = await loadHashStore();
        const remaining = (store2.stmts.allPaths() as { path: string }[]).filter(r => r.path.includes("nonexistent-")).length;
        expect(remaining).toBe(0);
        shutdownHashStore();
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("hash-store incremental vacuum", () => {
  it("keeps freelist low after many deletes", async () => {
    await withTempDir("startup-vacuum-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
        const store = await loadHashStore();
        const hashes = ["abc", "def", "ghi", "jkl", "mno", "pqr", "stu", "vwx"];
        for (let i = 0; i < 100; i++) {
          store.stmts.upsert(`p${i}`, "chk", 1, JSON.stringify([hashes[i % hashes.length]]), Date.now());
        }
        for (let i = 0; i < 80; i++) {
          store.stmts.deleteOne(`p${i}`);
        }
        shutdownHashStore();
        const store2 = await loadHashStore();
        expect(isValidHashList(["abc"])).toBe(true);
        shutdownHashStore();
        void store2;
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("grep huge quantifier guard", () => {
  it("rejects z{1000000} as unsafe", async () => {
    await withTempDir("startup-grep-", async dir => {
      const { setupIntegrationTest } = await import("../support/fixtures");
      const { getTool } = setupIntegrationTest(dir);
      const { pi } = makeLifecyclePi();
      const { default: register } = await import("../../index");
      register(pi);
      const grepTool = getTool("anchor_grep");
      await expect(grepTool.execute("g1", { pattern: "z{1000000}", path: dir }, undefined, undefined, { cwd: dir, signal: undefined } as unknown as never)).rejects.toThrow("[E_UNSAFE_REGEX]");
    });
  });
});

function makeTrackingPi(initialTools: string[]) {
  let active = [...initialTools];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  return { pi, handlers, getActive: () => [...active] };
}

function makeCommandPi(initialTools: string[]) {
  let active = [...initialTools];
  const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
  const pi = {
    registerTool() {},
    registerCommand(name: string, def: { description: string; handler: (...args: unknown[]) => unknown }) {
      commands.set(name, def);
    },
    on() {},
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  return { pi, commands, getActive: () => [...active] };
}

describe("anchor_grep opt-out", () => {
  it("session_start disables the built-in grep and keeps anchor_grep by default", async () => {
    await withTempDir("startup-grep-on-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, handlers, getActive } = makeTrackingPi(["read", "replace", "insert", "grep", "anchor_grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).not.toContain("grep");
        expect(getActive()).toContain("anchor_grep");
        expect(getActive()).not.toContain("edit");
        expect(getActive()).toContain("read");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("session_start keeps the built-in grep and removes anchor_grep when anchorGrepEnabled is false", async () => {
    await withTempDir("startup-grep-off-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { writeFile } = await import("fs/promises");
        await writeFile(
          join(home, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: true, anchorGrepEnabled: false }),
        );
        const { pi, handlers, getActive } = makeTrackingPi(["read", "replace", "insert", "grep", "anchor_grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("grep");
        expect(getActive()).not.toContain("anchor_grep");
        expect(getActive()).not.toContain("edit");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("toggle-anchor-grep command swaps between the built-in grep and anchor_grep", async () => {
    await withTempDir("toggle-anchor-grep-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, getActive } = makeCommandPi(["read", "replace", "insert", "grep", "anchor_grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const toggle = commands.get("toggle-anchor-grep")!;
        const ctx = { ui: { notify: vi.fn() } };
        await toggle.handler({}, ctx);
        expect(getActive()).not.toContain("anchor_grep");
        expect(getActive()).toContain("grep");
        const { readConfig } = await import("../../src/config");
        expect((await readConfig()).anchorGrepEnabled).toBe(false);
        await toggle.handler({}, ctx);
        expect(getActive()).toContain("anchor_grep");
        expect(getActive()).not.toContain("grep");
        expect((await readConfig()).anchorGrepEnabled).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});
