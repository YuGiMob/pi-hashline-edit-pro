import { describe, expect, it, vi } from "vitest";
import { configRowNavigator, withTempDir, makePiStub } from "../support/fixtures";
import { mkdir } from "fs/promises";
import { join } from "path";
import { isValidHashList } from "../../src/hash-store/validation";
import { readConfig } from "../../src/config";
import type { HashlineConfigOverlay } from "../../src/config-ui";

async function openConfigOverlay(commands: Map<string, { handler: (...args: unknown[]) => unknown }>, cwd: string, done: () => void = () => undefined): Promise<HashlineConfigOverlay> {
  const command = commands.get("hashline-config")!;
  let overlay: HashlineConfigOverlay | undefined;
  const theme = { fg: (_area: string, text: string) => text, bold: (text: string) => text };
  type OverlayFactory = (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Promise<HashlineConfigOverlay>;
  await command.handler({}, { cwd, hasUI: true, ui: { notify: vi.fn(), custom: async (factory: OverlayFactory) => { overlay = await factory({ requestRender: () => undefined }, theme, {}, done); } } });
  if (!overlay) throw new Error("hashline-config overlay was not created");
  return overlay;
}

async function waitForConfig(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for config write");
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
          store.stmts.upsert(`/tmp/nonexistent-${i}-${Date.now()}`, "chk", 1, JSON.stringify(["abc"]), "", Date.now());
        }
        shutdownHashStore();
        const { pi, handlers } = makePiStub();
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        const start = Date.now();
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(200);
        await new Promise(r => setTimeout(r, 800));
        const store2 = await loadHashStore();
        const remaining = (store2.stmts.snapshotPaths() as { path: string }[]).filter(r => r.path.includes("nonexistent-")).length;
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
        const hashes = ["atimx", "besrx", "dafox", "emnox", "hdtmx", "ifmsx", "meyox", "orcyx"];
        for (let i = 0; i < 100; i++) {
          store.stmts.upsert(`p${i}`, "chk", 1, JSON.stringify([hashes[i % hashes.length]]), "", Date.now());
        }
        for (let i = 0; i < 80; i++) {
          store.stmts.deleteOne(`p${i}`);
        }
        shutdownHashStore();
        const store2 = await loadHashStore();
        expect(isValidHashList(["atimx"])).toBe(true);
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

describe("grep huge quantifier", () => {
  it("accepts z{1000000} through ripgrep's linear engine", async () => {
    await withTempDir("startup-grep-", async dir => {
      const { setupIntegrationTest } = await import("../support/fixtures");
      const { getTool } = setupIntegrationTest(dir);
      const { pi } = makePiStub();
      const { default: register } = await import("../../index");
      register(pi);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "z{1000000}", path: dir }, undefined, undefined, { cwd: dir, signal: undefined } as unknown as never);
      expect(result.content[0]?.text).toBe("No matches found.");
    });
  });
});


describe("grep default", () => {
  it("session_start keeps the anchored grep by default", async () => {
    await withTempDir("startup-grep-on-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
        expect(getActive()).not.toContain("edit");
        expect(getActive()).toContain("read");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("session_start registers the anchored grep when anchorGrepEnabled is true", async () => {
    await withTempDir("startup-grep-off-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { writeFile } = await import("fs/promises");
        await writeFile(
          join(home, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: true, anchorGrepEnabled: true }),
        );
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
        expect(getActive()).not.toContain("edit");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("hashline-config swaps the anchored grep for pi's grep", async () => {
    await withTempDir("toggle-anchor-grep-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);
        select("anchorGrepEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).anchorGrepEnabled === false && !getTool("grep").promptSnippet.includes("anchor│content"));
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).not.toContain("anchor│content");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).anchorGrepEnabled === true && getTool("grep").promptSnippet.includes("anchor│content"));
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("hashline-config does not activate grep when it was not active", async () => {
    await withTempDir("toggle-anchor-grep-off-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).not.toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);
        select("anchorGrepEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).anchorGrepEnabled === false && !getTool("grep").promptSnippet.includes("anchor│content"));
        expect(getActive()).not.toContain("grep");
        expect(getTool("grep").promptSnippet).not.toContain("anchor│content");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).anchorGrepEnabled === true && getTool("grep").promptSnippet.includes("anchor│content"));
        expect(getActive()).not.toContain("grep");
        expect(getTool("grep").promptSnippet).toContain("anchor│content");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("codemode guideline refresh", () => {
  it("re-registers tools when codemode becomes active", async () => {
    await withTempDir("startup-codemode-", async (dir) => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        await handlers.get("session_start")!({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect((getTool("read").promptGuidelines as string[]).some((g) => g.includes("raw file content"))).toBe(false);

        pi.setActiveTools([...getActive(), "codemode"]);
        await handlers.get("before_agent_start")!({}, { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => [] } });
        expect((getTool("read").promptGuidelines as string[]).some((g) => g.includes("raw file content"))).toBe(true);
        expect((getTool("grep").promptGuidelines as string[]).some((g) => g.includes("results[].lines[]"))).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("copy/move default", () => {
  it("session_start keeps copy and move by default", async () => {
    await withTempDir("startup-copy-move-on-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "copy", "move", "grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("copy");
        expect(getActive()).toContain("move");
        expect(getActive()).not.toContain("edit");
        expect(getTool("undo_last_change").description).toContain("insert, copy, or move");
        expect(getTool("grep").description).toContain("anchor│content");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("session_start removes copy and move when copyMoveEnabled is false", async () => {
    await withTempDir("startup-copy-move-off-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { writeFile } = await import("fs/promises");
        await writeFile(
          join(home, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: true, anchorGrepEnabled: true, copyMoveEnabled: false }),
        );
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "copy", "move", "grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).not.toContain("copy");
        expect(getActive()).not.toContain("move");
        expect(getActive()).toContain("read");
        expect(getTool("undo_last_change").description).not.toContain("or move");
        expect(getTool("undo_last_change").description).not.toContain("copy");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("hashline-config toggles copy and move", async () => {
    await withTempDir("toggle-copy-move-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers, getActive } = makePiStub(["read", "replace", "insert", "copy", "move", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("copy");
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);
        select("copyMoveEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).copyMoveEnabled === false && !getActive().includes("copy") && !getActive().includes("move"));
        expect(getActive()).not.toContain("copy");
        expect(getActive()).not.toContain("move");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).copyMoveEnabled === true && getActive().includes("copy") && getActive().includes("move"));
        expect(getActive()).toContain("copy");
        expect(getActive()).toContain("move");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("replace_match default", () => {
  it("session_start keeps replace_match by default", async () => {
    await withTempDir("startup-replace-match-on-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "replace_match", "insert", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("replace_match");
        expect(getActive()).not.toContain("edit");
        expect(getTool("replace").description).toContain("use `replace_match` instead");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("session_start removes replace_match when replaceMatchEnabled is false", async () => {
    await withTempDir("startup-replace-match-off-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { writeFile } = await import("fs/promises");
        await writeFile(
          join(home, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: true, anchorGrepEnabled: true, replaceMatchEnabled: false }),
        );
        const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "replace_match", "insert", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).not.toContain("replace_match");
        expect(getActive()).toContain("read");
        expect(getTool("replace").description).not.toContain("replace_match");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("hashline-config toggles replace_match", async () => {
    await withTempDir("toggle-replace-match-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers, getActive } = makePiStub(["read", "replace", "replace_match", "insert", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("replace_match");
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);
        select("replaceMatchEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).replaceMatchEnabled === false && !getActive().includes("replace_match"));
        expect(getActive()).not.toContain("replace_match");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).replaceMatchEnabled === true && getActive().includes("replace_match"));
        expect(getActive()).toContain("replace_match");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("hashline-config overlay rendering", () => {
  it("renders the settings rows and closes on q", async () => {
    await withTempDir("config-render-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      vi.stubEnv("PI_HASHLINE_DEBUG", "1");
      try {
        const { pi, commands, handlers } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change", "edit"]);
        const { default: register } = await import("../../index");
        register(pi);
        const notify = vi.fn();
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
        let closed = false;
        const overlay = await openConfigOverlay(commands, dir, () => { closed = true; });
        const lines = overlay.render(60);
        expect(lines[0]).toBe(`╭${"─".repeat(58)}╮`);
        expect(lines[lines.length - 1]).toBe(`╰${"─".repeat(58)}╯`);
        expect(lines.some((line) => line.includes("Hashline Config"))).toBe(true);
        expect(lines.some((line) => line.includes("↑↓ navigate"))).toBe(true);
        expect(lines.filter((line) => line.includes("[x]")).length).toBe(5);
        expect(lines.filter((line) => line.includes("[ ]")).length).toBe(3);
        expect(lines.filter((line) => line.includes("[on]")).length).toBe(0);
        expect(lines.filter((line) => line.includes("[off]")).length).toBe(1);
        expect(lines.filter((line) => line.includes("[vanilla]")).length).toBe(1);
        overlay.handleInput("k");
        expect(overlay.render(60).find((line) => line.includes("Undo retention"))!).toContain("> ");
        overlay.handleInput("j");
        expect(overlay.render(60).find((line) => line.includes("[x] Post-edit diffs"))!).toContain("> ");
        overlay.invalidate();
        overlay.handleInput("q");
        expect(closed).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("toggles every setting from the overlay", async () => {
    await withTempDir("toggle-all-settings-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);

        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).autoRead === false);

        select("autoReadWrite");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).autoReadWrite === "summary");

        select("autoReadAll");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).autoReadAll === "outline");

        select("anchorGrepEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).anchorGrepEnabled === false);

        select("copyMoveEnabled");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).copyMoveEnabled === false);

        select("requirePath");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).requirePath === true);

        select("strictInput");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).strictInput === true);

        const config = await readConfig();
        expect(config.autoRead).toBe(false);
        expect(config.autoReadWrite).toBe("summary");
        expect(config.anchorGrepEnabled).toBe(false);
        expect(config.copyMoveEnabled).toBe(false);
        expect(config.autoReadAll).toBe("outline");
        expect(config.requirePath).toBe(true);
        expect(config.strictInput).toBe(true);
        expect(config.diffContextLines).toBe(1);
        expect(getActive()).toContain("grep");
        expect(getTool("grep").promptSnippet).not.toContain("anchor│content");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("adjusts diff context from the overlay only while auto-read is on", async () => {
    await withTempDir("diff-context-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const { pi, commands, handlers } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);

        select("diffContextLines");
        overlay.handleInput("+");
        await waitForConfig(async () => (await readConfig()).diffContextLines === 2);
        overlay.handleInput("-");
        await waitForConfig(async () => (await readConfig()).diffContextLines === 1);

        select("autoRead");
        overlay.handleInput(" ");
        await waitForConfig(async () => (await readConfig()).autoRead === false);
        await new Promise((resolve) => setTimeout(resolve, 250));
        select("diffContextLines");
        overlay.handleInput("+");
        overlay.handleInput("-");
        overlay.handleInput(" ");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await readConfig()).diffContextLines).toBe(1);
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });

  it("edits the disable on models list through the config command and applies it on the next turn", async () => {
    await withTempDir("model-gate-overlay-", async dir => {
      const home = join(dir, "home");
      await mkdir(join(home, ".config", "pi-hashline-edit-pro"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        const codex = { provider: "openai", id: "gpt-5.1-codex", api: "openai-codex-responses" };
        const { pi, commands, handlers, getActive } = makePiStub(["read", "replace", "insert", "copy", "move", "grep", "undo_last_change", "grep"]);
        const { default: register } = await import("../../index");
        register(pi);
        const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
        await sessionStart({}, { cwd: dir, model: codex, ui: { notify: vi.fn() } });
        expect(getActive()).toContain("read");
        const overlay = await openConfigOverlay(commands, dir);
        const select = configRowNavigator(overlay);
        select("disableOnModels");
        overlay.handleInput(" ");
        for (const char of "openai/*") overlay.handleInput(char);
        overlay.handleInput("\r");
        await waitForConfig(async () => (await readConfig()).disableOnModels?.[0] === "openai/*");
        expect((await readConfig()).disableOnModels).toEqual(["openai/*"]);
        const ctx = { cwd: dir, model: codex, hasUI: false, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => [] } };
        await waitForConfig(async () => {
          await handlers.get("before_agent_start")!({}, ctx);
          return !getActive().includes("replace");
        });
        expect(getActive()).toContain("read");
        expect(getActive()).toContain("grep");
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  });
});

describe("outline tool default", () => {
  async function withStartup(run: (cwd: string) => Promise<void>, config?: Record<string, unknown>): Promise<void> {
    await withTempDir("startup-outline-", async (dir) => {
      const home = join(dir, "home");
      const configDir = join(home, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      if (config !== undefined) {
        const { writeFile } = await import("fs/promises");
        await writeFile(join(configDir, "config.json"), JSON.stringify(config));
      }
      try {
        await run(dir);
      } finally {
        vi.unstubAllEnvs();
        const { shutdownHashStore } = await import("../../src/hash-store");
        shutdownHashStore();
      }
    });
  }

  it("session_start removes outline when outlineEnabled is off", async () => {
    await withStartup(async (dir) => {
      const { pi, handlers, getActive } = makePiStub(["read", "replace", "insert", "outline", "grep", "undo_last_change"]);
      const { default: register } = await import("../../index");
      register(pi);
      const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
      await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(getActive()).toContain("read");
      expect(getActive()).not.toContain("outline");
    });
  });

  it("session_start keeps outline when outlineEnabled is true", async () => {
    await withStartup(async (dir) => {
      const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
      const { default: register } = await import("../../index");
      register(pi);
      const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
      await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(getActive()).toContain("outline");
      expect(getTool("outline").promptSnippet).toContain("Map the symbols of a file or folder");
    }, { autoRead: true, anchorGrepEnabled: true, outlineEnabled: true });
  });

  it("keeps outline active when a codemode refresh re-registers the tools", async () => {
    await withStartup(async (dir) => {
      const { pi, handlers, getActive, getTool } = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
      const { default: register } = await import("../../index");
      register(pi);
      await handlers.get("session_start")!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(getActive()).toContain("outline");
      pi.setActiveTools([...getActive(), "codemode"]);
      await handlers.get("before_agent_start")!({}, { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => [] } });
      expect(getActive()).toContain("outline");
      expect((getTool("outline").promptGuidelines as string[]).some((guideline) => guideline.includes("anchors: true"))).toBe(true);
    }, { autoRead: true, anchorGrepEnabled: true, outlineEnabled: true });
  });

  it("hashline-config toggles the outline tool", async () => {
    await withStartup(async (dir) => {
      const { pi, commands, handlers, getActive } = makePiStub(["read", "replace", "insert", "outline", "grep", "undo_last_change"]);
      const { default: register } = await import("../../index");
      register(pi);
      const sessionStart = handlers.get("session_start") as (a: unknown, b: unknown) => Promise<void>;
      await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(getActive()).not.toContain("outline");
      const overlay = await openConfigOverlay(commands, dir);
      const select = configRowNavigator(overlay);
      select("outlineEnabled");
      overlay.handleInput(" ");
      await waitForConfig(async () => (await readConfig()).outlineEnabled === true && getActive().includes("outline"));
      expect(getActive()).toContain("outline");
      overlay.handleInput(" ");
      await waitForConfig(async () => (await readConfig()).outlineEnabled === false && !getActive().includes("outline"));
      expect(getActive()).not.toContain("outline");
    });
  });
});
