import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile } from "fs/promises";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { makeFakePiRegistry, withTempFile, useTestHome, getText, extractHash } from "../support/fixtures";
import register from "../../index";

useTestHome();

beforeEach(async () => {
  await initRegistry(undefined);
});

afterEach(() => {
  resetRegistryForTests();
});

function setup(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { getTool, ctx: { cwd, ui: { notify() {} } } as any };
}

const BOM = "\uFEFF";

describe("UTF-8 BOM preservation", () => {
  it("keeps the BOM through a replace", async () => {
    await withTempFile("bom-replace.ts", `${BOM}aaa\nbbb\n`, async ({ cwd, path }) => {
      const { ctx, getTool } = setup(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const readResult = await readTool.execute("r1", { path: "bom-replace.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l) => l.includes("│bbb"))!);
      await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(`${BOM}aaa\nBBB\n`);
    });
  });

  it("keeps the BOM through an insert", async () => {
    await withTempFile("bom-insert.ts", `${BOM}aaa\nbbb\n`, async ({ cwd, path }) => {
      const { ctx, getTool } = setup(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");
      const readResult = await readTool.execute("r1", { path: "bom-insert.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l) => l.includes("│bbb"))!);
      await insertTool.execute(
        "i1",
        { anchor: bHash, direction: "after", lines: ["new"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(`${BOM}aaa\nbbb\nnew\n`);
    });
  });

  it("keeps the BOM through a replace and its undo", async () => {
    await withTempFile("bom-undo.ts", `${BOM}aaa\nbbb\n`, async ({ cwd, path }) => {
      const { ctx, getTool } = setup(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");
      const readResult = await readTool.execute("r1", { path: "bom-undo.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l) => l.includes("│bbb"))!);
      await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(`${BOM}aaa\nBBB\n`);
      await undoTool.execute("u1", { path: "bom-undo.ts" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe(`${BOM}aaa\nbbb\n`);
    });
  });

  it("keeps the BOM and CRLF endings through a replace", async () => {
    await withTempFile("bom-crlf.ts", `${BOM}aaa\r\nbbb\r\n`, async ({ cwd, path }) => {
      const { ctx, getTool } = setup(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const readResult = await readTool.execute("r1", { path: "bom-crlf.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l) => l.includes("│bbb"))!);
      await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe(`${BOM}aaa\r\nBBB\r\n`);
    });
  });
});
