import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import {
  withTempFile,
  setupIntegrationTest,
  getText,
  anchorFor,
  assistantMessage,
  toolCall,
} from "../support/fixtures";

function liveAnchor(diff: string, needle: string): string | undefined {
  for (const row of diff.split("\n")) {
    if (!(row.startsWith("+") || row.startsWith(" "))) continue;
    const match = /^[+ ]([A-Za-z]{4})│/.exec(row);
    if (!match) continue;
    const sep = row.indexOf("│");
    if (row.slice(sep + 1) === needle) return match[1];
  }
  return undefined;
}

describe("multiple insert anchors", () => {
  it("batched inserts on several different lines preserve every anchor line", async () => {
    await withTempFile("multi-insert.txt", "aaa\nbbb\nccc\nddd\neee\n", async ({ cwd }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "multi-insert.txt" }, undefined, undefined, ctx));
      const aHash = anchorFor(text, "aaa");
      const bHash = anchorFor(text, "bbb");
      const cHash = anchorFor(text, "ccc");
      const dHash = anchorFor(text, "ddd");
      const eHash = anchorFor(text, "eee");
      const bArgs = { anchor: bHash, direction: "before", lines: ["x-b"] };
      const cArgs = { anchor: cHash, direction: "after", lines: ["x-c1", "x-c2"] };
      const eArgs = { anchor: eHash, direction: "before", lines: ["x-e"] };
      await handlers.get("message_end")!(
        {
          type: "message_end",
          message: assistantMessage([
            toolCall("i1", "insert", bArgs),
            toolCall("i2", "insert", cArgs),
            toolCall("i3", "insert", eArgs),
          ]),
        },
        ctx,
      );
      const insertTool = getTool("insert");
      await insertTool.execute("i1", bArgs, undefined, undefined, ctx);
      await insertTool.execute("i2", cArgs, undefined, undefined, ctx);
      const last = await insertTool.execute("i3", eArgs, undefined, undefined, ctx);
      const diff = (last.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "bbb")).toBe(bHash);
      expect(liveAnchor(diff, "ccc")).toBe(cHash);
      expect(liveAnchor(diff, "eee")).toBe(eHash);
      expect(liveAnchor(diff, "aaa")).toBe(aHash);
      expect(liveAnchor(diff, "ddd")).toBe(dHash);
      expect(await readFile(join(cwd, "multi-insert.txt"), "utf-8")).toBe(
        "aaa\nx-b\nbbb\nccc\nx-c1\nx-c2\nddd\nx-e\neee\n",
      );
      const followUps = [
        { hash: bHash, line: "bbb", replacement: "BBB" },
        { hash: cHash, line: "ccc", replacement: "CCC" },
        { hash: eHash, line: "eee", replacement: "EEE" },
        { hash: aHash, line: "aaa", replacement: "AAA" },
        { hash: dHash, line: "ddd", replacement: "DDD" },
      ];
      for (const followUp of followUps) {
        const ok = await getTool("replace").execute(
          `e-${followUp.line}`,
          {
            remove_from: followUp.hash,
            remove_to: followUp.hash,
            replacement_lines: [followUp.replacement],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(ok.content[0].text).toContain("Successfully replaced");
      }
      expect(await readFile(join(cwd, "multi-insert.txt"), "utf-8")).toBe(
        "AAA\nx-b\nBBB\nCCC\nx-c1\nx-c2\nDDD\nx-e\nEEE\n",
      );
    });
  });

  it("keeps insert anchors while a batched replace churns only the replaced line", async () => {
    await withTempFile("multi-mixed.txt", "aaa\nbbb\nccc\nddd\neee\n", async ({ cwd }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "multi-mixed.txt" }, undefined, undefined, ctx));
      const bHash = anchorFor(text, "bbb");
      const dHash = anchorFor(text, "ddd");
      const eHash = anchorFor(text, "eee");
      const bArgs = { anchor: bHash, direction: "before", lines: ["x"] };
      const rArgs = { remove_from: dHash, remove_to: dHash, replacement_lines: ["DDD"] };
      const eArgs = { anchor: eHash, direction: "before", lines: ["y"] };
      await handlers.get("message_end")!(
        {
          type: "message_end",
          message: assistantMessage([
            toolCall("i1", "insert", bArgs),
            toolCall("r1", "replace", rArgs),
            toolCall("i2", "insert", eArgs),
          ]),
        },
        ctx,
      );
      const insertTool = getTool("insert");
      await insertTool.execute("i1", bArgs, undefined, undefined, ctx);
      await getTool("replace").execute("r1", rArgs, undefined, undefined, ctx);
      const last = await insertTool.execute("i2", eArgs, undefined, undefined, ctx);
      const diff = (last.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "bbb")).toBe(bHash);
      expect(liveAnchor(diff, "eee")).toBe(eHash);
      expect(liveAnchor(diff, "DDD")).not.toBe(dHash);
      expect(await readFile(join(cwd, "multi-mixed.txt"), "utf-8")).toBe("aaa\nx\nbbb\nccc\nDDD\ny\neee\n");
      const okB = await getTool("replace").execute(
        "e-b",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(okB.content[0].text).toContain("Successfully replaced");
      const okE = await getTool("replace").execute(
        "e-e",
        { remove_from: eHash, remove_to: eHash, replacement_lines: ["EEE"] },
        undefined,
        undefined,
        ctx,
      );
      expect(okE.content[0].text).toContain("Successfully replaced");
      await expect(
        getTool("replace").execute(
          "e-d",
          { remove_from: dHash, remove_to: dHash, replacement_lines: ["DDD2"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("maps multiple carry spans on different lines positionally", async () => {
    await withTempFile("multi-map.txt", "x", async ({ cwd }) => {
      resetRegistryForTests();
      await initRegistry(undefined);
      const base = "aaa\nbbb\nccc\nddd\neee\n";
      const path = join(cwd, "multi-map.txt");
      const baseHashes = await lineHashes(base, path);
      const moved = "aaa\nxxx\nbbb\nccc\nddd\nyyy\neee\n";
      const mapped = await lineHashes(moved, path, {
        content: base,
        hashes: baseHashes,
        spans: [
          { start: 1, end: 1, replacementCount: 2, carry: 1 },
          { start: 3, end: 3, replacementCount: 2, carry: 0 },
        ],
      });
      expect(mapped[0]).toBe(baseHashes[0]);
      expect(mapped[1]).not.toBe(baseHashes[1]);
      expect(mapped[2]).toBe(baseHashes[1]);
      expect(mapped[3]).toBe(baseHashes[2]);
      expect(mapped[4]).toBe(baseHashes[3]);
      expect(mapped[5]).not.toBe(baseHashes[3]);
      expect(mapped[6]).toBe(baseHashes[4]);
    });
  });
});
