import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { initRegistry, resetRegistryForTests, servedForPath } from "../../src/anchor-registry";
import { cycleWriteEcho, readConfig } from "../../src/config";
import { makeFakePiRegistry, withTempDir } from "../support/fixtures";

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

async function writeConfigFile(cwd: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(cwd, ".config", "pi-hashline-edit-pro");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf-8");
}

async function autoReadAfterWrite(cwd: string, name: string, content: string): Promise<string | undefined> {
  await writeFile(join(cwd, name), content, "utf-8");
  const { pi, handlers } = makeFakePiRegistry();
  resetRegistryForTests();
  await initRegistry(undefined);
  register(pi);
  const ctx = { cwd, ui: { notify(): void {} } } as never;
  const sessionStart = handlers.get("session_start");
  if (sessionStart) await sessionStart({}, ctx);
  const handler = handlers.get("tool_result");
  const result = await handler!(
    {
      toolName: "write",
      toolCallId: "write-1",
      input: { path: name, content },
      content: [{ type: "text", text: `Successfully wrote ${content.length} bytes` }],
      details: undefined,
      isError: false,
    },
    ctx,
  );
  const blocks = (result?.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks[1]?.text;
}

describe("write echo - summary mode", () => {
  it("reports the line count instead of echoing a large file", async () => {
    await withTempDir("pi-hashline-write-echo-summary-", async (cwd) => {
      await writeConfigFile(cwd, { autoReadWrite: "summary" });

      const text = (await autoReadAfterWrite(cwd, "big.txt", numberedLines(500)))!;

      expect(text).toContain("--- Auto-read (hashline anchors) ---");
      expect(text).toContain("500 lines written.");
      expect(text).toContain("read the range you want to edit");
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(200);
      expect(text).not.toContain("│line 1");
      expect(text).not.toContain("│line 500");
    });
  });

  it("serves no rows, so the writer must read before editing", async () => {
    await withTempDir("pi-hashline-write-echo-summary-served-", async (cwd) => {
      await writeConfigFile(cwd, { autoReadWrite: "summary" });
      await autoReadAfterWrite(cwd, "big.txt", numberedLines(500));

      const served = servedForPath(join(cwd, "big.txt"));
      expect(served?.size ?? 0).toBe(0);
    });
  });

  it("summarises a small file too, and names a single line correctly", async () => {
    await withTempDir("pi-hashline-write-echo-summary-small-", async (cwd) => {
      await writeConfigFile(cwd, { autoReadWrite: "summary" });

      const many = (await autoReadAfterWrite(cwd, "small.txt", numberedLines(3)))!;
      const one = (await autoReadAfterWrite(cwd, "one.txt", "only one line"))!;

      expect(many).toContain("3 lines written.");
      expect(one).toContain("1 line written.");
      expect(many).not.toContain("│line 1");
    });
  });
});

describe("write echo - full mode", () => {
  it("echoes every line by default, as before the setting existed", async () => {
    await withTempDir("pi-hashline-write-echo-full-", async (cwd) => {
      const text = (await autoReadAfterWrite(cwd, "big.txt", numberedLines(500)))!;

      expect(text).toContain("│line 1");
      expect(text).toContain("│line 250");
      expect(text).toContain("│line 500");
      expect(text).not.toContain("lines written.");
    });
  });

  it("serves every echoed row", async () => {
    await withTempDir("pi-hashline-write-echo-full-served-", async (cwd) => {
      await autoReadAfterWrite(cwd, "big.txt", numberedLines(40));
      expect(servedForPath(join(cwd, "big.txt"))!.size).toBe(40);
    });
  });
});

describe("write echo - config", () => {
  it("defaults to full and ignores unknown values", async () => {
    await withTempDir("pi-hashline-write-echo-config-", async (cwd) => {
      expect((await readConfig()).autoReadWrite).toBe("full");

      await writeConfigFile(cwd, { autoReadWrite: "preview" });
      expect((await readConfig()).autoReadWrite).toBe("full");
    });
  });

  it("reads summary from the config file", async () => {
    await withTempDir("pi-hashline-write-echo-config-summary-", async (cwd) => {
      await writeConfigFile(cwd, { autoReadWrite: "summary" });
      expect((await readConfig()).autoReadWrite).toBe("summary");
    });
  });

  it("cycles between full and summary", async () => {
    await withTempDir("pi-hashline-write-echo-cycle-", async () => {
      expect(await cycleWriteEcho(1)).toBe("summary");
      expect((await readConfig()).autoReadWrite).toBe("summary");
      expect(await cycleWriteEcho(1)).toBe("full");
      expect((await readConfig()).autoReadWrite).toBe("full");
    });
  });
});
