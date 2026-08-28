import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { getServed } from "../../src/served";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { toCwd } from "../../src/paths";
import { resolveTarget } from "../../src/fs-write";

async function servedFor(cwd: string, name: string): Promise<Map<string, string> | undefined> {
  const store = await loadHashStore();
  return getServed(store, await resolveTarget(toCwd(name, cwd)));
}

function feedbackRows(message: string): string[] {
  return message.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
}

describe("served-state range verification", () => {
  it("rejects an interior modification with valid boundaries, returning the current range with fresh anchors", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      let caught: Error | undefined;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_lines: ["a", "x", "d"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/E_RANGE_STALE/);
      expect(caught!.message).toContain("Nothing was modified");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");
      const rows = feedbackRows(caught!.message);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatch(/│a$/);
      expect(rows[1]).toMatch(/│B$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("retries successfully after a range-stale rejection without an intervening read", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      let feedback = "";
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_lines: ["a", "x", "d"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        feedback = (error as Error).message;
      }
      const rows = feedbackRows(feedback);
      const freshA = extractHash(rows[0]!);
      const freshD = extractHash(rows[rows.length - 1]!);

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: freshA, remove_to: freshD, replacement_lines: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("serves the context rows in E_STALE_ANCHOR feedback so a copied context hash edits immediately", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "A\nb\nC\nd\n", "utf-8");

      let staleError = "";
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_lines: ["x"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        staleError = (error as Error).message;
      }
      expect(staleError).toMatch(/E_STALE_ANCHOR/);
      expect(staleError).toContain("Current context around resolved anchor");

      const contextRow = staleError.split("\n").find((l: string) => /^  +[0-9]+: [A-Za-z0-9]{3}│C$/.test(l));
      expect(contextRow).toBeDefined();
      const contextHash = contextRow!.match(/([A-Za-z0-9]{3})│/)![1]!;

      const served = await servedFor(cwd, "sample.ts");
      expect(served!.has(contextHash)).toBe(true);

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: contextHash, remove_to: contextHash, replacement_lines: ["c"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");
    });
  });

  it("tolerates an out-of-range external modification", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│c"))!);

      await writeFile(path, "A\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: cHash, replacement_lines: ["x"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nx\nd\n");
    });
  });

  it("accepts an interior change-then-revert round-trip", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: dHash, replacement_lines: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("rejects when interior lines were never served (disjoint read windows)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const r2 = await readTool.execute("r2", { path: "sample.ts", offset: 5, limit: 2 }, undefined, undefined, ctx);
      const aHash = extractHash(getText(r1).split("\n").find((l: string) => l.includes("│a"))!);
      const fHash = extractHash(getText(r2).split("\n").find((l: string) => l.includes("│f"))!);

      let caught: Error | undefined;
      try {
        await editTool.execute(
          "e1",
          { path: "sample.ts", remove_from: aHash, remove_to: fHash, replacement_lines: ["x"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\nf\n");
      const rows = feedbackRows(caught!.message);
      expect(rows).toHaveLength(6);
      expect(rows[2]).toMatch(/│c$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("rejects when interior lines were never served (anchors from disjoint diff hunks)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const head = await readTool.execute("r1", { path: "sample.ts", limit: 3 }, undefined, undefined, ctx);
      const headLines = getText(head).split("\n");
      const aHash = extractHash(headLines.find((l: string) => l.includes("│a"))!);
      const first = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: aHash, replacement_lines: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toContain("Successfully replaced");

      const tail = await readTool.execute("r2", { path: "sample.ts", offset: 10, limit: 1 }, undefined, undefined, ctx);
      const jHash = extractHash(getText(tail).split("\n").find((l: string) => l.includes("│j"))!);
      const second = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: jHash, remove_to: jHash, replacement_lines: ["J"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.content[0].text).toContain("Successfully replaced");

      const firstDiff = (first.details as { diff?: string } | undefined)?.diff ?? "";
      const aHashAfter = extractHash(firstDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│A"))!).replace(/^[+ ]/, "");
      const secondDiff = (second.details as { diff?: string } | undefined)?.diff ?? "";
      const jHashAfter = extractHash(secondDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│J"))!).replace(/^[+ ]/, "");
      await expect(
        editTool.execute(
          "e3",
          { path: "sample.ts", remove_from: aHashAfter, remove_to: jHashAfter, replacement_lines: ["X"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n");
    });
  });

  it("applies within a served window while other lines were never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: aHash, remove_to: bHash, replacement_lines: ["x"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("x\nc\nd\ne\nf\n");
    });
  });

  it("applies without verification when the file was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", `${cwd}/sample.ts`);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
    });
  });

  it("records served state from read output", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const line of lines) {
        const hash = extractHash(line);
        if (/^[A-Za-z0-9]{3}$/.test(hash)) expect(served!.has(hash)).toBe(true);
      }
    });
  });

  it("records served state from the post-edit diff rows", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string } | undefined)?.diff ?? "";
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const row of diff.split("\n")) {
        const match = row.match(/^[+ ]([A-Za-z0-9]{3})│/);
        if (match) expect(served!.has(match[1]!)).toBe(true);
      }
    });
  });

  it("re-edits with original anchors after an undo (undo diff rows are served)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undo = getTool("undo_last_change");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const edited = await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.content[0].text).toContain("Undone last change");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");

      const retry = await editTool.execute(
        "e2",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");
    });
  });

  it("clears served state on write and re-serves via the auto-read block", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);

      const { writeFile: writeFileFs } = await import("fs/promises");
      await writeFileFs(`${cwd}/sample.ts`, "x\ny\nz\n", "utf-8");

      const writeEvent = {
        toolName: "write",
        isError: false,
        input: { path: "sample.ts" },
        content: [{ type: "text", text: "File written." }],
      };
      const { default: register } = await import("../../index");
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      const pi = {
        registerTool() {},
        registerCommand() {},
        getActiveTools: () => [],
        setActiveTools() {},
        on(event: string, handler: unknown) {
          handlers.set(event, handler as (event: unknown, ctx: unknown) => Promise<unknown>);
        },
      } as never;
      register(pi as never);
      await handlers.get("session_start")!({}, { cwd, ui: { notify() {} } });
      const result = await handlers.get("tool_result")!(writeEvent, { cwd });
      expect(result).toBeDefined();

      const servedAfterWrite = await servedFor(cwd, "sample.ts");
      expect(servedAfterWrite).toBeDefined();
      expect(servedAfterWrite!.has(aHash)).toBe(false);
      const servedText = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      for (const row of servedText.split("\n")) {
        const match = row.match(/^([A-Za-z0-9]{3})│/);
        if (match) expect(servedAfterWrite!.has(match[1]!)).toBe(true);
      }
      shutdownHashStore();
    });
  });

  it("rejects a re-edit with a pre-edit anchor after an external revert, then accepts the retry", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const bHash = extractHash(getText(readResult).split("\n").find((l: string) => l.includes("│b"))!);

      await editTool.execute(
        "e1",
        { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["B"] },
        undefined, undefined, ctx,
      );
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");

      let caught: Error | undefined;
      try {
        await editTool.execute(
          "e2",
          { path: "sample.ts", remove_from: bHash, remove_to: bHash, replacement_lines: ["B2"] },
          undefined, undefined, ctx,
        );
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/E_RANGE_STALE/);

      const rows = feedbackRows(caught!.message);
      const freshB = extractHash(rows.find((r: string) => r.endsWith("│b"))!);
      expect(freshB).toBe(bHash);

      const retry = await editTool.execute(
        "e3",
        { path: "sample.ts", remove_from: freshB, remove_to: freshB, replacement_lines: ["B2"] },
        undefined, undefined, ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB2\nc\nd\n");
    });
  });
});
