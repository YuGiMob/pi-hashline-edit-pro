import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  toggleAutoRead,
  toggleAnchorGrep,
  toggleRequirePath,
  toggleStrictInput,
  cycleBoundaryDedupMode,
  adjustDiffContextLines,
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

describe("config - toggleRequirePath", () => {
  it("toggles from default false to true", async () => {
    await withTempHome(async () => {
      expect(await toggleRequirePath()).toBe(true);
      expect((await readConfig()).requirePath).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, requirePath: true });
      expect(await toggleRequirePath()).toBe(false);
      expect((await readConfig()).requirePath).toBe(false);
    });
  });
});

describe("config - toggleStrictInput", () => {
  it("toggles from default false to true", async () => {
    await withTempHome(async () => {
      expect(await toggleStrictInput()).toBe(true);
      expect((await readConfig()).strictInput).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      expect(await toggleStrictInput()).toBe(false);
      expect((await readConfig()).strictInput).toBe(false);
    });
  });
});

describe("config - cycleBoundaryDedupMode", () => {
  it("cycles on to strict", async () => {
    await withTempHome(async () => {
      expect(await cycleBoundaryDedupMode()).toBe("strict");
      expect((await readConfig()).boundaryDedupMode).toBe("strict");
    });
  });

  it("cycles strict to off to on", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "strict" });
      expect(await cycleBoundaryDedupMode()).toBe("off");
      expect(await cycleBoundaryDedupMode()).toBe("on");
      expect((await readConfig()).boundaryDedupMode).toBe("on");
    });
  });

  it("migrates legacy boolean config values", async () => {
    await withTempHome(async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const { join: pathJoin } = await import("path");
      const configDir = pathJoin(tmpHome, ".config", "pi-hashline-edit-pro");
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

describe("config - diffContextLines", () => {
  it("defaults to 1 when no config file exists", async () => {
    await withTempHome(async () => {
      expect((await readConfig()).diffContextLines).toBe(1);
    });
  });

  it("reads a stored value", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, diffContextLines: 3 });
      expect((await readConfig()).diffContextLines).toBe(3);
    });
  });

  it("clamps out-of-range and non-numeric values", async () => {
    await withTempHome(async () => {
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
    await withTempHome(async () => {
      expect(await adjustDiffContextLines(1)).toBe(2);
      expect(await adjustDiffContextLines(-1)).toBe(1);
      expect(await adjustDiffContextLines(-5)).toBe(0);
      expect(await adjustDiffContextLines(50)).toBe(10);
      expect((await readConfig()).diffContextLines).toBe(10);
    });
  });
});
