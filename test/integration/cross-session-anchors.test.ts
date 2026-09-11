import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { initRegistry } from "../../src/anchor-registry";
import { makeFakePiRegistry, withTempDir, getText, extractHash } from "../support/fixtures";

describe("cross-session anchor isolation", () => {
  it("rejects an anchor served in a previous session instead of editing the wrong file", async () => {
    await withTempDir("pi-hashline-xsession-", async (dir) => {
      await writeFile(join(dir, "fileA.txt"), "alpha\nbeta\ngamma\n");
      await writeFile(join(dir, "fileB.txt"), "one\ntwo\nthree\n");
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd: dir, ui: { notify() {} } } as any;
      const readTool = getTool("read");
      const editTool = getTool("replace");

      await initRegistry(join(dir, "session-one.json"));
      const readA = await readTool.execute("r1", { path: "fileA.txt" }, undefined, undefined, ctx);
      const anchorA = extractHash(getText(readA).split("\n").find((l: string) => l.includes("│beta"))!);

      await initRegistry(join(dir, "session-two.json"));
      const readB = await readTool.execute("r2", { path: "fileB.txt" }, undefined, undefined, ctx);
      const anchorB = extractHash(getText(readB).split("\n").find((l: string) => l.includes("│two"))!);
      expect(anchorB).not.toBe(anchorA);

      await expect(
        editTool.execute(
          "e1",
          { remove_from: anchorA, remove_to: anchorA, replacement_lines: ["HACKED"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);

      expect(await readFile(join(dir, "fileA.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(await readFile(join(dir, "fileB.txt"), "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });

  it("mints disjoint anchors for different files with identical content across sessions", async () => {
    await withTempDir("pi-hashline-xsession-", async (dir) => {
      await writeFile(join(dir, "shapeA.txt"), "alpha\nbeta\ngamma\n");
      await writeFile(join(dir, "shapeB.txt"), "alpha\nbeta\ngamma\n");
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd: dir, ui: { notify() {} } } as any;
      const readTool = getTool("read");

      await initRegistry(join(dir, "session-one.json"));
      const readOne = await readTool.execute("r1", { path: "shapeA.txt" }, undefined, undefined, ctx);
      const anchorsOne = getText(readOne).split("\n").map((l: string) => extractHash(l));

      await initRegistry(join(dir, "session-two.json"));
      const readTwo = await readTool.execute("r2", { path: "shapeB.txt" }, undefined, undefined, ctx);
      const anchorsTwo = getText(readTwo).split("\n").map((l: string) => extractHash(l));

      expect(anchorsTwo).not.toEqual(anchorsOne);
      expect(anchorsTwo.filter((a: string) => anchorsOne.includes(a))).toEqual([]);
    });
  });

  it("reuses anchors when two sessions read the same unchanged file", async () => {
    await withTempDir("pi-hashline-xsession-", async (dir) => {
      await writeFile(join(dir, "same.txt"), "alpha\nbeta\ngamma\n");
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd: dir, ui: { notify() {} } } as any;
      const readTool = getTool("read");

      await initRegistry(join(dir, "session-one.json"));
      const readOne = await readTool.execute("r1", { path: "same.txt" }, undefined, undefined, ctx);
      const anchorsOne = getText(readOne).split("\n").map((l: string) => extractHash(l));

      await initRegistry(join(dir, "session-two.json"));
      const readTwo = await readTool.execute("r2", { path: "same.txt" }, undefined, undefined, ctx);
      const anchorsTwo = getText(readTwo).split("\n").map((l: string) => extractHash(l));

      expect(anchorsTwo).toEqual(anchorsOne);
    });
  });
});
