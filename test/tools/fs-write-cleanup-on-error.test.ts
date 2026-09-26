import { beforeEach, describe, expect, it, vi } from "vitest";


const rmMock = vi.fn(async () => undefined);
const handleCloseMock = vi.fn(async () => undefined);
const handleWriteFileMock = vi.fn(async () => undefined);
const handleChmodMock = vi.fn(async () => undefined);
const handleSyncMock = vi.fn(async () => undefined);
const openMock = vi.fn(async () => ({
  writeFile: handleWriteFileMock,
  chmod: handleChmodMock,
  sync: handleSyncMock,
  close: handleCloseMock,
}));
const renameMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100644, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readlink: readlinkMock,
  rename: renameMock,
  rm: rmMock,
  stat: statMock,
}));

describe("writeAtomic - temp file cleanup on write failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleWriteFileMock.mockResolvedValue(undefined);
    handleChmodMock.mockResolvedValue(undefined);
    handleCloseMock.mockResolvedValue(undefined);
    openMock.mockResolvedValue({
      writeFile: handleWriteFileMock,
      chmod: handleChmodMock,
      sync: handleSyncMock,
      close: handleCloseMock,
    });
    renameMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mode: 0o100644, nlink: 1 });
  });

  it("cleans up the temp file when writeFile on the temp handle fails", async () => {
    handleWriteFileMock.mockRejectedValue(new Error("write failed"));

    const { writeAtomic } = await import("../../src/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "write failed",
    );

    expect(rmMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
      { force: true },
    );
    expect(handleCloseMock).toHaveBeenCalled();
  });

  it("cleans up the temp file when chmod on the temp handle fails", async () => {
    handleChmodMock.mockRejectedValue(new Error("chmod failed"));

    const { writeAtomic } = await import("../../src/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "chmod failed",
    );

    expect(rmMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
      { force: true },
    );
    expect(handleCloseMock).toHaveBeenCalled();
  });

  it("does not call rm when writeFile and chmod succeed", async () => {
    const { writeAtomic } = await import("../../src/fs-write");

    await writeAtomic("/tmp/target.txt", "content");

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("ignores a chmod the filesystem does not support (WSL drvfs)", async () => {
    handleChmodMock.mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }));

    const { writeAtomic } = await import("../../src/fs-write");

    await writeAtomic("/tmp/target.txt", "content");

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(rmMock).not.toHaveBeenCalled();
  });
});

describe("writeAtomic - open failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates the error when open() fails (e.g. permissions)", async () => {
    openMock.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    const { writeAtomic } = await import("../../src/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "permission denied",
    );
  });
});
