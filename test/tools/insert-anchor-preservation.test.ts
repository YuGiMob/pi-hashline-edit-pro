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

describe("insert anchor preservation", () => {
  it("solo insert-before preserves the anchor line's anchor", async () => {
    await withTempFile("solo-before.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "solo-before.txt" }, undefined, undefined, ctx));
      const bHash = anchorFor(text, "bbb");
      const result = await getTool("insert").execute(
        "i1",
        { anchor: bHash, direction: "before", lines: ["xxx"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "bbb")).toBe(bHash);
      const ok = await getTool("replace").execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.content[0].text).toContain("Successfully replaced");
      expect(await readFile(join(cwd, "solo-before.txt"), "utf-8")).toBe("aaa\nxxx\nBBB\nccc\n");
    });
  });

  it("batched insert-before preserves the anchor line's anchor", async () => {
    await withTempFile("batch-before.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "batch-before.txt" }, undefined, undefined, ctx));
      const bHash = anchorFor(text, "bbb");
      const cHash = anchorFor(text, "ccc");
      const message = assistantMessage([
        toolCall("i1", "insert", { anchor: bHash, direction: "before", lines: ["xxx"] }),
        toolCall("i2", "insert", { anchor: cHash, direction: "after", lines: ["yyy"] }),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);
      const insertTool = getTool("insert");
      await insertTool.execute("i1", { anchor: bHash, direction: "before", lines: ["xxx"] }, undefined, undefined, ctx);
      const second = await insertTool.execute(
        "i2",
        { anchor: cHash, direction: "after", lines: ["yyy"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (second.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "bbb")).toBe(bHash);
      const ok = await getTool("replace").execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.content[0].text).toContain("Successfully replaced");
      expect(await readFile(join(cwd, "batch-before.txt"), "utf-8")).toBe("aaa\nxxx\nBBB\nccc\nyyy\n");
    });
  });

  it("merged before+after pair preserves the anchor line's anchor", async () => {
    await withTempFile("merged.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "merged.txt" }, undefined, undefined, ctx));
      const twoHash = anchorFor(text, "two");
      const message = assistantMessage([
        toolCall("m1", "insert", { anchor: twoHash, direction: "before", lines: ["ONE-A"] }),
        toolCall("m2", "insert", { anchor: twoHash, direction: "after", lines: ["TWO-A"] }),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);
      const insertTool = getTool("insert");
      await insertTool.execute("m1", { anchor: twoHash, direction: "before", lines: ["ONE-A"] }, undefined, undefined, ctx);
      const second = await insertTool.execute(
        "m2",
        { anchor: twoHash, direction: "after", lines: ["TWO-A"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (second.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "two")).toBe(twoHash);
      const ok = await getTool("replace").execute(
        "e1",
        { remove_from: twoHash, remove_to: twoHash, replacement_lines: ["TWO"] },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.content[0].text).toContain("Successfully replaced");
      expect(await readFile(join(cwd, "merged.txt"), "utf-8")).toBe("one\nONE-A\nTWO\nTWO-A\nthree\n");
    });
  });

  it("carry wins over positional duplicate reuse in the mapping", async () => {
    await withTempFile("dup-map.txt", "x", async ({ cwd }) => {
      resetRegistryForTests();
      await initRegistry(undefined);
      const base = "aaa\nbbb\nccc\n";
      const path = join(cwd, "dup-map.txt");
      const baseHashes = await lineHashes(base, path);
      const inserted = "aaa\nbbb\nbbb\nccc\n";
      const mapped = await lineHashes(inserted, path, {
        content: base,
        hashes: baseHashes,
        spans: [{ start: 1, end: 1, replacementCount: 2, carry: 1 }],
      });
      expect(mapped[1]).not.toBe(baseHashes[1]);
      expect(mapped[2]).toBe(baseHashes[1]);
      expect(mapped[3]).toBe(baseHashes[2]);
    });
  });

  it("empty-file seed still frees the empty-line anchor", async () => {
    await withTempFile("seed.txt", "", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "seed.txt" }, undefined, undefined, ctx));
      const emptyHash = text.split("\n")[0]!.split("│")[0]!;
      const result = await getTool("insert").execute(
        "i1",
        { anchor: emptyHash, direction: "after", lines: ["first", "second"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "first")).not.toBe(emptyHash);
      expect(liveAnchor(diff, "second")).not.toBe(emptyHash);
      const ok = await getTool("replace").execute(
        "e1",
        { remove_from: liveAnchor(diff, "first")!, remove_to: liveAnchor(diff, "second")!, replacement_lines: ["only"] },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.content[0].text).toContain("Successfully replaced");
      expect(await readFile(join(cwd, "seed.txt"), "utf-8")).toBe("only");
    });
  });

  it("replace still churns the changed line and keeps neighbors", async () => {
    await withTempFile("replace.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "replace.txt" }, undefined, undefined, ctx));
      const aHash = anchorFor(text, "aaa");
      const bHash = anchorFor(text, "bbb");
      const cHash = anchorFor(text, "ccc");
      const result = await getTool("replace").execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, replacement_lines: ["BBB"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(liveAnchor(diff, "BBB")).not.toBe(bHash);
      expect(liveAnchor(diff, "aaa")).toBe(aHash);
      expect(liveAnchor(diff, "ccc")).toBe(cHash);
    });
  });
});
