import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameMock = vi.fn(async () => undefined);
const writeFileMock = vi.fn(async () => undefined);
const rmMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100644, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false }));
const readlinkMock = vi.fn(async () => "");
const mkdirMock = vi.fn(async () => undefined);
const readdirMock = vi.fn(async () => []);
const openMock = vi.fn(async () => ({
  writeFile: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  sync: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("fs/promises", () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readdir: readdirMock,
  readlink: readlinkMock,
  rename: renameMock,
  rm: rmMock,
  stat: statMock,
  writeFile: writeFileMock,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(value: string): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

describe("writeConfig - windows EPERM fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mode: 0o100644, nlink: 1 });
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false });
    openMock.mockResolvedValue({
      writeFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("falls back to a direct write when rename fails with EPERM on windows", async () => {
    stubPlatform("win32");
    renameMock.mockRejectedValue(
      Object.assign(new Error("EPERM: file locked"), { code: "EPERM" }),
    );

    const { writeConfig } = await import("../../src/config");

    await writeConfig({ autoRead: true, anchorGrepEnabled: true });

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/config\.json$/),
      expect.stringContaining('"autoRead": true'),
      "utf-8",
    );
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
      { force: true },
    );
  });

  it("propagates non-EPERM rename failures on windows", async () => {
    stubPlatform("win32");
    renameMock.mockRejectedValue(
      Object.assign(new Error("EACCES: denied"), { code: "EACCES" }),
    );

    const { writeConfig } = await import("../../src/config");

    await expect(
      writeConfig({ autoRead: false, anchorGrepEnabled: true }),
    ).rejects.toThrow("EACCES");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("does not use the direct-write fallback on non-windows platforms", async () => {
    stubPlatform("linux");
    renameMock.mockRejectedValue(
      Object.assign(new Error("EPERM: denied"), { code: "EPERM" }),
    );

    const { writeConfig } = await import("../../src/config");

    await expect(
      writeConfig({ autoRead: false, anchorGrepEnabled: true }),
    ).rejects.toThrow("EPERM");
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
