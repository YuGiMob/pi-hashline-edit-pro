import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { throwIfStrictInput } from "../../src/edit-common";
import { readConfig, writeConfig } from "../../src/config";
import { getWritableTempRoot } from "../support/fixtures";

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-edit-common-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

describe("throwIfStrictInput", () => {
  it("passes through warnings when strict input is off", async () => {
    await withTempHome(async () => {
      await expect(throwIfStrictInput(["[W_BAD_REF] stripped prefix"])).resolves.toBeUndefined();
      expect((await readConfig()).strictInput).toBe(false);
    });
  });

  it("rejects auto-fixable warnings when strict input is on", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      await expect(throwIfStrictInput(["[W_BAD_REF] stripped prefix"])).rejects.toThrow(
        "[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input",
      );
    });
  });

  it("ignores messages that are not auto-fix warnings", async () => {
    await withTempHome(async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      await expect(throwIfStrictInput(["plain message"])).resolves.toBeUndefined();
    });
  });
});
