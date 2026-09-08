import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  toggleAutoRead,
  toggleAnchorGrep,
  readConfig,
  writeConfig,
} from "../../src/config";
import { getWritableTempRoot } from "../support/fixtures";
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-config-test-"));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('XDG_CONFIG_HOME', "");
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

describe("config - toggleAutoRead", () => {
  it("toggles from default true to false", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(false);
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: false, anchorGrepEnabled: true });
      expect(await toggleAutoRead()).toBe(true);
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(false);
      expect(await toggleAutoRead()).toBe(true);
      expect(await toggleAutoRead()).toBe(false);
      expect((await readConfig()).autoRead).toBe(false);
    });
  });
});

describe("config - toggleAnchorGrep", () => {
  it("toggles from default true to false", async () => {
    await withTempHome(async () => {
      expect(await toggleAnchorGrep()).toBe(false);
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });

  it("toggles from false back to true", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      expect(await toggleAnchorGrep()).toBe(true);
      expect((await readConfig()).anchorGrepEnabled).toBe(true);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleAnchorGrep()).toBe(false);
      expect(await toggleAnchorGrep()).toBe(true);
      expect(await toggleAnchorGrep()).toBe(false);
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });

  it("toggleAutoRead preserves anchorGrepEnabled", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      await toggleAutoRead();
      const config = await readConfig();
      expect(config.autoRead).toBe(false);
      expect(config.anchorGrepEnabled).toBe(false);
    });
  });
});

describe("config - readConfig / writeConfig", () => {
  it("writeConfig persists autoRead", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true });
      const config = await readConfig();
      expect(config.autoRead).toBe(true);
    });
  });

  it("ignores unknown config fields on read", async () => {
    await withTempHome(async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(tmpHome, ".config", "pi-hashline-edit-pro");
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
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true });
      const { readdir } = await import("fs/promises");
      const entries = await readdir(join(tmpHome, ".config", "pi-hashline-edit-pro"));
      expect(entries).toEqual(["config.json"]);
    });
  });
});

describe("config - readConfig defaults", () => {
  it("defaults to true when no config file exists", async () => {
    await withTempHome(async () => {
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("reads autoRead from the config file", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: false, anchorGrepEnabled: true });
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("defaults anchorGrepEnabled to true when no config file exists", async () => {
    await withTempHome(async () => {
      expect((await readConfig()).anchorGrepEnabled).toBe(true);
    });
  });

  it("defaults anchorGrepEnabled to true when absent from an existing config file", async () => {
    await withTempHome(async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: false }));
      const config = await readConfig();
      expect(config.autoRead).toBe(false);
      expect(config.anchorGrepEnabled).toBe(true);
    });
  });

  it("reads anchorGrepEnabled from the config file", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: false });
      expect((await readConfig()).anchorGrepEnabled).toBe(false);
    });
  });
});

describe("config - wrong-shape config", () => {
  it("falls back to defaults when config.json is not an object", async () => {
    await withTempHome(async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify([1, 2]));
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("falls back to defaults when autoRead is not a boolean", async () => {
    await withTempHome(async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(pathJoin(configDir, "config.json"), JSON.stringify({ autoRead: "yes" }));
      expect((await readConfig()).autoRead).toBe(true);
    });
  });
});
