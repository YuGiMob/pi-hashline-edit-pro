import { describe, expect, it } from "vitest";
import {
  toggleAutoRead,
  cycleAutoReadWriteMode,
  cycleAutoReadAllMode,
  toggleAutoReadAllRequireGit,
  toggleAnchorGrep,
  toggleCopyMove,
  toggleReplaceMatch,
  toggleOutline,
  cycleReadOnDisabledModels,
  toggleRequirePath,
  toggleStrictInput,
  adjustDiffContextLines,
  readConfig,
  readConfigWithStatus,
  writeConfig,
  parseDisableOnModels,
  setDisableOnModels,
  setDisableOnModelsFromText,
  adjustUndoRetentionDays,
  normalizeUndoRetentionDays,
} from "../../src/config";
import { configRows } from "../../src/config-ui";
import { configPath } from "../../src/paths";
import { stat } from "fs/promises";
import { withTempDir } from "../support/fixtures";


describe("config - toggleAutoRead", () => {
  it("toggles from default true to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleAutoRead()).toBe(false);
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: false, anchorGrepEnabled: true });
      expect(await toggleAutoRead()).toBe(true);
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleAutoRead()).toBe(false);
      expect(await toggleAutoRead()).toBe(true);
      expect(await toggleAutoRead()).toBe(false);
      expect((await readConfig()).autoRead).toBe(false);
    });
  });
});

describe("config - toggleAnchorGrep", () => {
  it("toggles from default true to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleAnchorGrep()).toBe(false);
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      expect(await toggleAnchorGrep()).toBe(true);
      expect((await readConfig()).anchorGrepEnabled).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleAnchorGrep()).toBe(false);
      expect(await toggleAnchorGrep()).toBe(true);
      expect(await toggleAnchorGrep()).toBe(false);
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });

  it("toggleAutoRead preserves anchorGrepEnabled", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      await toggleAutoRead();
      const config = await readConfig();
      expect(config.autoRead).toBe(false);
      expect(config.anchorGrepEnabled).toBe(false);
    });
  });
});

describe("config - autoReadWrite", () => {
  it("defaults to full", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).autoReadWrite).toBe("full");
    });
  });

  it("cycles through full, summary, and off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await cycleAutoReadWriteMode()).toBe("summary");
      expect((await readConfig()).autoReadWrite).toBe("summary");
      expect(await cycleAutoReadWriteMode()).toBe("off");
      expect((await readConfig()).autoReadWrite).toBe("off");
      expect(await cycleAutoReadWriteMode()).toBe("full");
      expect((await readConfig()).autoReadWrite).toBe("full");
    });
  });

  it("reads a legacy autoRead false as write echo off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: false, anchorGrepEnabled: true });
      expect((await readConfig()).autoReadWrite).toBe("off");
    });
  });

  it("keeps an explicit summary with autoRead off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: false, autoReadWrite: "summary", anchorGrepEnabled: true });
      const config = await readConfig();
      expect(config.autoRead).toBe(false);
      expect(config.autoReadWrite).toBe("summary");
    });
  });
});

describe("config - toggleCopyMove", () => {
  it("toggles from default true to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleCopyMove()).toBe(false);
      expect((await readConfig()).copyMoveEnabled).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, copyMoveEnabled: false });
      expect(await toggleCopyMove()).toBe(true);
      expect((await readConfig()).copyMoveEnabled).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleCopyMove()).toBe(false);
      expect(await toggleCopyMove()).toBe(true);
      expect(await toggleCopyMove()).toBe(false);
      expect((await readConfig()).copyMoveEnabled).toBe(false);
    });
  });
});

describe("config - toggleReplaceMatch", () => {
  it("toggles from default true to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleReplaceMatch()).toBe(false);
      expect((await readConfig()).replaceMatchEnabled).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, replaceMatchEnabled: false });
      expect(await toggleReplaceMatch()).toBe(true);
      expect((await readConfig()).replaceMatchEnabled).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleReplaceMatch()).toBe(false);
      expect(await toggleReplaceMatch()).toBe(true);
      expect(await toggleReplaceMatch()).toBe(false);
      expect((await readConfig()).replaceMatchEnabled).toBe(false);
    });
  });
});

describe("config - cycleAutoReadAllMode", () => {
  it("defaults to off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).autoReadAll).toBe("off");
    });
  });

  it("cycles off to outline to full and back to off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await cycleAutoReadAllMode()).toBe("outline");
      expect((await readConfig()).autoReadAll).toBe("outline");
      expect(await cycleAutoReadAllMode()).toBe("full");
      expect((await readConfig()).autoReadAll).toBe("full");
      expect(await cycleAutoReadAllMode()).toBe("off");
      expect((await readConfig()).autoReadAll).toBe("off");
    });
  });

  it("reads the mode from the config file and maps legacy git modes", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, anchorGrepEnabled: true, autoReadAll: "git" }));
      const legacyGit = await readConfig();
      expect(legacyGit.autoReadAll).toBe("full");
      expect(legacyGit.autoReadAllRequireGit).toBe(true);
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, anchorGrepEnabled: true, autoReadAll: "outline(git)" }));
      const legacyOutlineGit = await readConfig();
      expect(legacyOutlineGit.autoReadAll).toBe("outline");
      expect(legacyOutlineGit.autoReadAllRequireGit).toBe(true);
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, anchorGrepEnabled: true, autoReadAll: "full" }));
      expect((await readConfig()).autoReadAllRequireGit).toBe(false);
    });
  });

  it("migrates legacy boolean config values", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, autoReadAll: true }));
      const legacyTrue = await readConfig();
      expect(legacyTrue.autoReadAll).toBe("full");
      expect(legacyTrue.autoReadAllRequireGit).toBe(false);
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, autoReadAll: "on" }));
      const legacyOn = await readConfig();
      expect(legacyOn.autoReadAll).toBe("full");
      expect(legacyOn.autoReadAllRequireGit).toBe(false);
    });
  });
});

describe("config - toggleAutoReadAllRequireGit", () => {
  it("defaults to true and toggles to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).autoReadAllRequireGit).toBe(true);
      expect(await toggleAutoReadAllRequireGit()).toBe(false);
      expect((await readConfig()).autoReadAllRequireGit).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, autoReadAllRequireGit: false });
      expect(await toggleAutoReadAllRequireGit()).toBe(true);
      expect((await readConfig()).autoReadAllRequireGit).toBe(true);
    });
  });
});

describe("config - toggleRequirePath", () => {
  it("toggles from default false to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleRequirePath()).toBe(true);
      expect((await readConfig()).requirePath).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, requirePath: true });
      expect(await toggleRequirePath()).toBe(false);
      expect((await readConfig()).requirePath).toBe(false);
    });
  });
});

describe("config - toggleStrictInput", () => {
  it("toggles from default false to true", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await toggleStrictInput()).toBe(true);
      expect((await readConfig()).strictInput).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      expect(await toggleStrictInput()).toBe(false);
      expect((await readConfig()).strictInput).toBe(false);
    });
  });
});

describe("config - readConfig / writeConfig", () => {
  it("writeConfig persists autoRead", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true });
      const config = await readConfig();
      expect(config.autoRead).toBe(true);
    });
  });

  it("ignores unknown config fields on read", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        pathJoin(configDir, "config.json"),
        JSON.stringify({ replaceMode: "bulk", autoRead: true }),
      );
      const config = await readConfig();
      expect(config.autoRead).toBe(true);
    });
  });
});

describe("config - atomic writes", () => {
  it("leaves no temp files behind after writeConfig", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true });
      const { readdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const entries = await readdir(pathJoin(dir, ".config", "pi-hashline-edit-pro"));
      expect(entries).toEqual(["config.json"]);
    });
  });
});

describe("config - readConfig defaults", () => {
  it("defaults to true when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("defaults copyMoveEnabled to true when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).copyMoveEnabled).toBe(true);
    });
  });

  it("defaults replaceMatchEnabled to true when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).replaceMatchEnabled).toBe(true);
    });
  });

  it("reads autoRead from the config file", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: false, anchorGrepEnabled: true });
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("defaults anchorGrepEnabled to true when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).anchorGrepEnabled).toBe(true);
    });
  });

  it("defaults anchorGrepEnabled to true when absent from an existing config file", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: false }));
      const config = await readConfig();
      expect(config.autoRead).toBe(false);
      expect(config.anchorGrepEnabled).toBe(true);
    });
  });

  it("reads anchorGrepEnabled from the config file", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });
});

describe("config - wrong-shape config", () => {
  it("falls back to defaults when config.json is not an object", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify([1, 2]));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(true);
      expect(config.autoRead).toBe(true);
    });
  });

  it("falls back to defaults when autoRead is not a boolean", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: "yes" }));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(true);
      expect(config.autoRead).toBe(true);
    });
  });

  it("uses the default when autoRead is omitted", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ requirePath: true }));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(false);
      expect(config.autoRead).toBe(true);
      expect(config.requirePath).toBe(true);
    });
  });
});

describe("config - diffContextLines", () => {
  it("defaults to 1 when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).diffContextLines).toBe(1);
    });
  });

  it("reads a stored value", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: 3 });
      expect((await readConfig()).diffContextLines).toBe(3);
    });
  });

  it("clamps out-of-range and non-numeric values", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: 99 });
      expect((await readConfig()).diffContextLines).toBe(10);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: -4 });
      expect((await readConfig()).diffContextLines).toBe(0);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: 2.7 });
      expect((await readConfig()).diffContextLines).toBe(2);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: "many" } as never);
      expect((await readConfig()).diffContextLines).toBe(1);
    });
  });

  it("adjusts up and down within bounds", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await adjustDiffContextLines(1)).toBe(2);
      expect(await adjustDiffContextLines(-1)).toBe(1);
      expect(await adjustDiffContextLines(-5)).toBe(0);
      expect(await adjustDiffContextLines(50)).toBe(10);
      expect((await readConfig()).diffContextLines).toBe(10);
    });
  });
});

describe("config - disableOnModels", () => {
  it("defaults to an empty list", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).disableOnModels).toEqual([]);
    });
  });

  it("parses arrays and comma-separated strings with trimming and dedupe", () => {
    expect(parseDisableOnModels([" OpenAI/* ", "openai/*", "", 42])).toEqual(["OpenAI/*"]);
    expect(parseDisableOnModels("openai/*, *gpt*,, *GPT*")).toEqual(["openai/*", "*gpt*"]);
    expect(parseDisableOnModels(undefined)).toEqual([]);
    expect(parseDisableOnModels(42)).toEqual([]);
  });

  it("persists globs through setDisableOnModels and its text form", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await setDisableOnModels([" openai/* ", "openai/*"])).toEqual(["openai/*"]);
      expect((await readConfig()).disableOnModels).toEqual(["openai/*"]);
      expect(await setDisableOnModelsFromText("*gpt*, openai/*")).toEqual(["*gpt*", "openai/*"]);
      expect((await readConfig()).disableOnModels).toEqual(["*gpt*", "openai/*"]);
    });
  });

  it("exposes the disable row with its globs", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await setDisableOnModels([]);
      const empty = configRows(await readConfig()).find((row) => row.key === "disableOnModels")!;
      expect(empty.label).toBe("Disable on models");
      expect(empty.entries).toEqual([]);
      expect(empty.enabled).toBe(false);
      await setDisableOnModels(["openai/*"]);
      const filled = configRows(await readConfig()).find((row) => row.key === "disableOnModels")!;
      expect(filled.entries).toEqual(["openai/*"]);
      expect(filled.enabled).toBe(true);
    });
  });
});

describe("config - readOnDisabledModels", () => {
  it("defaults to vanilla when no config file exists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).readOnDisabledModels).toBe("vanilla");
    });
  });

  it("reads a stored value", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, readOnDisabledModels: "remove" });
      expect((await readConfig()).readOnDisabledModels).toBe("remove");
    });
  });

  it("cycles the policy", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await cycleReadOnDisabledModels()).toBe("remove");
      expect((await readConfig()).readOnDisabledModels).toBe("remove");
      expect(await cycleReadOnDisabledModels()).toBe("vanilla");
      expect((await readConfig()).readOnDisabledModels).toBe("vanilla");
    });
  });

  it("migrates the legacy disableReadOnModels boolean", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, disableReadOnModels: false }));
      expect((await readConfig()).readOnDisabledModels).toBe("vanilla");
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, disableReadOnModels: true }));
      expect((await readConfig()).readOnDisabledModels).toBe("remove");
    });
  });

  it("exposes the row and follows the stored value", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      const vanilla = configRows(await readConfig()).find((row) => row.key === "readOnDisabledModels")!;
      expect(vanilla.label).toBe("Read on disabled models");
      expect(vanilla.mode).toBe("vanilla");
      expect(vanilla.enabled).toBe(true);
      expect(vanilla.cycle).toEqual(["remove", "vanilla"]);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, readOnDisabledModels: "remove" });
      const remove = configRows(await readConfig()).find((row) => row.key === "readOnDisabledModels")!;
      expect(remove.mode).toBe("remove");
      expect(remove.enabled).toBe(false);
    });
  });
});

async function withStaleLock(prefix: string, ageMs: number, run: (lockPath: string) => Promise<void>): Promise<void> {
  await withTempDir(prefix, async () => {
    const { mkdir, utimes } = await import("fs/promises");
    const lockPath = `${configPath()}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const stale = new Date(Date.now() - ageMs);
    await utimes(lockPath, stale, stale);
    await run(lockPath);
  });
}

describe("config - lock recovery", () => {
  it("recovers a crashed lock once it is stale and removes it after the write", async () => {
    await withStaleLock("pi-hashline-config-lock-", 6000, async (lockPath) => {
      expect(await toggleAutoRead()).toBe(false);
      await expect(stat(lockPath)).rejects.toThrow();
    });
  });

  it("recovers a crashed lock that is still fresh by waiting until it is stale", async () => {
    await withStaleLock("pi-hashline-config-lock-fresh-", 1000, async (lockPath) => {
      expect(await toggleAutoRead()).toBe(false);
      await expect(stat(lockPath)).rejects.toThrow();
    });
  });
});

describe("config - undoRetentionDays", () => {
  it("defaults to 30 and clamps stored values", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).undoRetentionDays).toBe(30);
      expect(normalizeUndoRetentionDays(99_999)).toBe(3650);
      expect(normalizeUndoRetentionDays(-4)).toBe(0);
      expect(normalizeUndoRetentionDays(2.7)).toBe(2);
      expect(normalizeUndoRetentionDays("many")).toBe(30);
    });
  });

  it("adjusts within bounds and persists", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await adjustUndoRetentionDays(5)).toBe(35);
      expect(await adjustUndoRetentionDays(-100)).toBe(0);
      expect(await adjustUndoRetentionDays(1)).toBe(1);
      expect((await readConfig()).undoRetentionDays).toBe(1);
    });
  });

  it("exposes the row", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      const row = configRows(await readConfig()).find((candidate) => candidate.key === "undoRetentionDays")!;
      expect(row.label).toBe("Undo retention");
      expect(row.group).toBe("State");
      expect(row.value).toBe(30);
    });
  });
});

describe("config - toggleOutline", () => {
  it("defaults to off and round-trips through multiple toggles", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).outlineEnabled).toBe(false);
      expect(await toggleOutline()).toBe(true);
      expect((await readConfig()).outlineEnabled).toBe(true);
      expect(await toggleOutline()).toBe(false);
      expect((await readConfig()).outlineEnabled).toBe(false);
    });
  });

  it("exposes the row", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      const row = configRows(await readConfig()).find((candidate) => candidate.key === "outlineEnabled")!;
      expect(row.label).toBe("Outline tool");
      expect(row.group).toBe("Tools");
      expect(row.enabled).toBe(false);
    });
  });
});
