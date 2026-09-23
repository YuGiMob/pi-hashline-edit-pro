import { describe, expect, it } from "vitest";
import {
  toggleAutoRead,
  cycleAutoReadAllMode,
  toggleAnchorGrep,
  toggleRequirePath,
  toggleStrictInput,
  cycleBoundaryDedupMode,
  adjustDiffContextLines,
  readConfig,
  readConfigWithStatus,
  writeConfig,
} from "../../src/config";
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

describe("config - cycleAutoReadAllMode", () => {
  it("defaults to off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).autoReadAll).toBe("off");
    });
  });

  it("cycles off to on to git and back to off", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect(await cycleAutoReadAllMode()).toBe("on");
      expect((await readConfig()).autoReadAll).toBe("on");
      expect(await cycleAutoReadAllMode()).toBe("git");
      expect((await readConfig()).autoReadAll).toBe("git");
      expect(await cycleAutoReadAllMode()).toBe("off");
      expect((await readConfig()).autoReadAll).toBe("off");
    });
  });

  it("reads the mode from the config file", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, autoReadAll: "git" });
      expect((await readConfig()).autoReadAll).toBe("git");
    });
  });

  it("migrates legacy boolean config values", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: true, autoReadAll: true }));
      expect((await readConfig()).autoReadAll).toBe("on");
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

describe("config - cycleBoundaryDedupMode", () => {
  it("cycles off to on", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      expect((await readConfig()).boundaryDedupMode).toBe("off");
      expect(await cycleBoundaryDedupMode()).toBe("on");
      expect((await readConfig()).boundaryDedupMode).toBe("on");
    });
  });

  it("cycles strict to off to on", async () => {
    await withTempDir("pi-hashline-config-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "strict" });
      expect(await cycleBoundaryDedupMode()).toBe("off");
      expect(await cycleBoundaryDedupMode()).toBe("on");
      expect((await readConfig()).boundaryDedupMode).toBe("on");
    });
  });

  it("migrates legacy boolean config values", async () => {
    await withTempDir("pi-hashline-config-test-", async (dir) => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        pathJoin(configDir, "config.json"),
        JSON.stringify({ autoRead: true, boundaryDedupEnabled: false }),
      );
      expect((await readConfig()).boundaryDedupMode).toBe("off");
      await writeFile(
        pathJoin(configDir, "config.json"),
        JSON.stringify({ autoRead: true, boundaryDedupEnabled: true }),
      );
      expect((await readConfig()).boundaryDedupMode).toBe("on");
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
