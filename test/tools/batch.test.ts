import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import register from "../../index";
import { updateConfig, writeConfig } from "../../src/config";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import { makeFakePiRegistry, withTempDir, withTempFile, toolCall, assistantMessage, anchorFor } from "../support/fixtures";
function withHostCoercion(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const coerced = structuredClone(args);
  Value.Convert(schema as never, coerced);
  return coerced;
}

async function setupBatchTools(cwd: string) {
  resetRegistryForTests();
  resetBatchStateForTests();
  await initRegistry(undefined);
  await updateConfig((config) => {
    config.boundaryDedupMode = "on";
  });
  const { pi, getTool, handlers } = makeFakePiRegistry();
  register(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { getTool, handlers, ctx };
}

describe("same-turn edit batches", () => {
  it("defers intermediate diffs and returns one combined diff with one undo", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");

      const message = assistantMessage([
        toolCall("b1", "replace", { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }),
        toolCall("b2", "replace", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "b1",
        { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");
      expect(first.details.batch?.aborted).toBeUndefined();

      const second = await editTool.execute(
        "b2",
        { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] },
        undefined,
        undefined,
        ctx,
      );
      const combined = second.content[0].text as string;
      expect(combined).toContain("Batch 1: 2 edits applied as one commit");
      expect(second.details.diff).toContain("BETA");
      expect(second.details.diff).toContain("GAMMA");
      expect(second.details.metrics.edits_attempted).toBe(2);
      expect(second.details.metrics.classification).toBe("applied");
      expect(second.details.batch).toMatchObject({ id: 1, size: 2, last: true });
      expect(second.details.diff.startsWith("batch 1:\n")).toBe(true);
      expect(combined.startsWith("batch 1:\n")).toBe(true);

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\nGAMMA\ndelta\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "b1" }, { toolCallId: "b2" }] },
        ctx,
      ) as Promise<unknown>);

      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect((undone.content[0] as { text: string }).text).toContain("Undone last change");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\n");

      const secondUndo = await undoTool.execute("u2", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(secondUndo.isError).toBe(true);
      expect((secondUndo.content[0] as { text: string }).text).toContain("No undo history");
    });
  });

  it("decodes stringified array text for batched members", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");

      const firstArgs = { remove_from: betaRef, remove_to: betaRef, replacement_lines: ['["B1", "B2",]'] };
      const secondArgs = { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] };
      const message = assistantMessage([
        toolCall("b1", "replace", firstArgs),
        toolCall("b2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("b1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("b2", secondArgs, undefined, undefined, ctx);
      expect(second.details.metrics.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("alpha\nB1\nB2\nGAMMA\ndelta\n");
    });
  });

  it("batches mixed replace and insert calls on one file", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const insertTool = getTool("insert");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const oneRef = anchorFor(text, "one");
      const threeRef = anchorFor(text, "three");

      const message = assistantMessage([
        toolCall("m1", "replace", { remove_from: oneRef, remove_to: oneRef, replacement_lines: ["ONE"] }),
        toolCall("m2", "insert", { anchor: threeRef, direction: "before", lines: ["TWO-AND-A-HALF"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "m1",
        { remove_from: oneRef, remove_to: oneRef, replacement_lines: ["ONE"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      const second = await insertTool.execute(
        "m2",
        { anchor: threeRef, direction: "before", lines: ["TWO-AND-A-HALF"] },
        undefined,
        undefined,
        ctx,
      );
      const combined = second.content[0].text as string;
      expect(combined).toContain("Batch 1: 2 edits applied as one commit");
      expect(second.details.diff).toContain("ONE");
      expect(second.details.diff).toContain("TWO-AND-A-HALF");
      expect(second.details.diff.startsWith("batch 1:\n")).toBe(true);
      expect(combined.startsWith("batch 1:\n")).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("ONE\ntwo\nTWO-AND-A-HALF\nthree\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "m1" }, { toolCallId: "m2" }] },
        ctx,
      ) as Promise<unknown>);

      const undoTool = getTool("undo_last_change");
      await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });

  it("applies one insert before and one insert after the same anchor as one batch", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const insertTool = getTool("insert");
      const undoTool = getTool("undo_last_change");

      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const oneRef = anchorFor(text, "one");
      const twoRef = anchorFor(text, "two");
      const replaceArgs = { remove_from: oneRef, remove_to: oneRef, replacement_lines: ["ONE"] };
      const beforeArgs = { anchor: twoRef, direction: "before", lines: ["ONE-A"] };
      const afterArgs = { anchor: twoRef, direction: "after", lines: ["TWO-A"] };
      const message = assistantMessage([
        toolCall("q1", "replace", replaceArgs),
        toolCall("q2", "insert", beforeArgs),
        toolCall("q3", "insert", afterArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      await editTool.execute("q1", replaceArgs, undefined, undefined, ctx);
      await insertTool.execute("q2", beforeArgs, undefined, undefined, ctx);
      const last = await insertTool.execute("q3", afterArgs, undefined, undefined, ctx);
      expect(last.content[0].text).toContain("Batch 1: 3 edits applied as one commit");
      expect(last.details.metrics.edits_attempted).toBe(3);
      expect(last.details.metrics.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("ONE\nONE-A\ntwo\nTWO-A\nthree\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "q1" }, { toolCallId: "q2" }, { toolCallId: "q3" }] },
        ctx,
      ) as Promise<unknown>);

      await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });

  it("composes a same-anchor insert pair regardless of member execution order", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");

      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const twoRef = anchorFor(text, "two");
      const beforeArgs = { anchor: twoRef, direction: "before", lines: ["ONE-A"] };
      const afterArgs = { anchor: twoRef, direction: "after", lines: ["TWO-A"] };
      const message = assistantMessage([
        toolCall("s1", "insert", afterArgs),
        toolCall("s2", "insert", beforeArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await insertTool.execute("s1", afterArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");
      const last = await insertTool.execute("s2", beforeArgs, undefined, undefined, ctx);
      expect(last.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("one\nONE-A\ntwo\nTWO-A\nthree\n");
    });
  });

  it("rejects two same-direction inserts on one anchor as an overlap", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");

      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const twoRef = anchorFor(text, "two");
      const firstArgs = { anchor: twoRef, direction: "before", lines: ["A"] };
      const secondArgs = { anchor: twoRef, direction: "before", lines: ["B"] };
      const message = assistantMessage([
        toolCall("t1", "insert", firstArgs),
        toolCall("t2", "insert", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await insertTool.execute("t1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");
      let failure = "";
      try {
        await insertTool.execute("t2", secondArgs, undefined, undefined, ctx);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_BATCH_OVERLAP]");
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });

  it("treats a before and after pair on an empty file as an overlap", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");

      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const emptyRef = text.split("\n")[0]!.split("│")[0]!;
      const beforeArgs = { anchor: emptyRef, direction: "before", lines: ["A"] };
      const afterArgs = { anchor: emptyRef, direction: "after", lines: ["B"] };
      const message = assistantMessage([
        toolCall("e1", "insert", beforeArgs),
        toolCall("e2", "insert", afterArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await insertTool.execute("e1", beforeArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");
      let failure = "";
      try {
        await insertTool.execute("e2", afterArgs, undefined, undefined, ctx);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_BATCH_OVERLAP]");
      expect(await readFile(path, "utf-8")).toBe("");
    });
  });

  it("numbers one batch per file when several files batch", async () => {
    await withTempDir("batch-multi-", async (dir) => {
      const { getTool, handlers, ctx } = await setupBatchTools(dir);
      await writeFile(join(dir, "a.txt"), "a1\na2\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "b1\nb2\n", "utf-8");
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const readA = await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
      const readB = await readTool.execute("r2", { path: "b.txt" }, undefined, undefined, ctx);
      const a1Ref = anchorFor(readA.content[0].text as string, "a1");
      const a2Ref = anchorFor(readA.content[0].text as string, "a2");
      const b1Ref = anchorFor(readB.content[0].text as string, "b1");
      const b2Ref = anchorFor(readB.content[0].text as string, "b2");

      const message = assistantMessage([
        toolCall("a1", "replace", { remove_from: a1Ref, remove_to: a1Ref, replacement_lines: ["A1"] }),
        toolCall("b1", "replace", { remove_from: b1Ref, remove_to: b1Ref, replacement_lines: ["B1"] }),
        toolCall("a2", "replace", { remove_from: a2Ref, remove_to: a2Ref, replacement_lines: ["A2"] }),
        toolCall("b2", "replace", { remove_from: b2Ref, remove_to: b2Ref, replacement_lines: ["B2"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const firstA = await editTool.execute(
        "a1",
        { remove_from: a1Ref, remove_to: a1Ref, replacement_lines: ["A1"] },
        undefined,
        undefined,
        ctx,
      );
      expect(firstA.content[0].text).toBe("In batch 1");

      const firstB = await editTool.execute(
        "b1",
        { remove_from: b1Ref, remove_to: b1Ref, replacement_lines: ["B1"] },
        undefined,
        undefined,
        ctx,
      );
      expect(firstB.content[0].text).toBe("In batch 2");
      const lastB = await editTool.execute(
        "b2",
        { remove_from: b2Ref, remove_to: b2Ref, replacement_lines: ["B2"] },
        undefined,
        undefined,
        ctx,
      );
      expect(lastB.content[0].text).toContain("Batch 2: 2 edits applied as one commit");
      expect(lastB.details.diff).toContain("B1");
      expect(lastB.details.diff).toContain("B2");
      expect(lastB.details.diff.startsWith("batch 2:\n")).toBe(true);
      expect((lastB.content[0].text as string).startsWith("batch 2:\n")).toBe(true);
      expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("B1\nB2\n");

      const lastA = await editTool.execute(
        "a2",
        { remove_from: a2Ref, remove_to: a2Ref, replacement_lines: ["A2"] },
        undefined,
        undefined,
        ctx,
      );
      const combined = lastA.content[0].text as string;
      expect(combined).toContain("Batch 1: 2 edits applied as one commit");
      expect(lastA.details.diff).toContain("A1");
      expect(lastA.details.diff).toContain("A2");
      expect(lastA.details.diff).not.toContain("B1");
      expect(lastA.details.diff.startsWith("batch 1:\n")).toBe(true);
      expect(combined.startsWith("batch 1:\n")).toBe(true);
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A1\nA2\n");
      await (handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "a1" }, { toolCallId: "b1" }, { toolCallId: "a2" }, { toolCallId: "b2" }] }, ctx) as Promise<unknown>);
    });
  });

  it("leaves single edits untouched and preserves the tool_result placeholder", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const ref = anchorFor(firstRead.content[0].text as string, "aaa");
      const solo = await editTool.execute(
        "solo",
        { remove_from: ref, remove_to: ref, replacement_lines: ["AAA"] },
        undefined,
        undefined,
        ctx,
      );
      expect(solo.content[0].text).toContain("Successfully replaced in sample.txt");

      const toolResult = handlers.get("tool_result")!;
      const skipped = await toolResult(
        {
          type: "tool_result",
          toolName: "replace",
          toolCallId: "b1",
          input: {},
          content: [{ type: "text", text: "In batch 1" }],
          details: { diff: "", metrics: { classification: "applied" }, batch: { id: 1, size: 2, last: false } },
          isError: false,
        },
        ctx,
      );
      expect(skipped).toBeUndefined();
    });
  });

  it("reports an insert-only batch as inserted", async () => {
    await withTempFile("sample.txt", "one\ntwo\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const oneRef = anchorFor(text, "one");
      const twoRef = anchorFor(text, "two");

      const message = assistantMessage([
        toolCall("i1", "insert", { anchor: oneRef, direction: "after", lines: ["ONE-A"] }),
        toolCall("i2", "insert", { anchor: twoRef, direction: "after", lines: ["TWO-A"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await insertTool.execute(
        "i1",
        { anchor: oneRef, direction: "after", lines: ["ONE-A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      const second = await insertTool.execute(
        "i2",
        { anchor: twoRef, direction: "after", lines: ["TWO-A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.content[0].text).toContain("Successfully inserted in sample.txt");
      expect(second.details.diff).toContain("ONE-A");
      expect(second.details.diff).toContain("TWO-A");
      expect(second.details.diff.startsWith("batch 1:\n")).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("one\nONE-A\ntwo\nTWO-A\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "i1" }, { toolCallId: "i2" }] },
        ctx,
      ) as Promise<unknown>);

      const undoTool = getTool("undo_last_change");
      await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\n");
    });
  });

  it("collapses an all-noop batch without touching undo history", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aaaRef = anchorFor(text, "aaa");
      const bbbRef = anchorFor(text, "bbb");

      const message = assistantMessage([
        toolCall("n1", "replace", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["aaa"] }),
        toolCall("n2", "replace", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["bbb"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "n1",
        { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["aaa"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute(
        "n2",
        { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["bbb"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.details.metrics.classification).toBe("noop");
      expect(second.details.batch).toMatchObject({ id: 1, size: 2, last: true });
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "n1" }, { toolCallId: "n2" }] },
        ctx,
      ) as Promise<unknown>);

      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBe(true);
      expect((undone.content[0] as { text: string }).text).toContain("No undo history");
    });
  });

  it("rejects overlapping ranges without writing anything", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const bRef = anchorFor(text, "b");

      const message = assistantMessage([
        toolCall("f1", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: ["B"] }),
        toolCall("f2", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: ["B2"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "f1",
        { remove_from: bRef, remove_to: bRef, replacement_lines: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      let failure = "";
      try {
        await editTool.execute(
          "f2",
          { remove_from: bRef, remove_to: bRef, replacement_lines: ["B2"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_BATCH_OVERLAP]");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "f1" }, { toolCallId: "f2" }] },
        ctx,
      ) as Promise<unknown>);

      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBe(true);
      expect((undone.content[0] as { text: string }).text).toContain("No undo history");
    });
  });

  it("restores the prior undo record when a batch nets to no change", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const insertTool = getTool("insert");
      const undoTool = getTool("undo_last_change");

      const soloRead = await readTool.execute("r0", { path: "sample.txt" }, undefined, undefined, ctx);
      const soloRef = anchorFor(soloRead.content[0].text as string, "c");
      await editTool.execute(
        "solo",
        { remove_from: soloRef, remove_to: soloRef, replacement_lines: ["C"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("a\nb\nC\n");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aRef = anchorFor(text, "a");
      const bRef = anchorFor(text, "b");

      const message = assistantMessage([
        toolCall("z1", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: [] }),
        toolCall("z2", "insert", { anchor: aRef, direction: "after", lines: ["b"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      await editTool.execute(
        "z1",
        { remove_from: bRef, remove_to: bRef, replacement_lines: [] },
        undefined,
        undefined,
        ctx,
      );
      const second = await insertTool.execute(
        "z2",
        { anchor: aRef, direction: "after", lines: ["b"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.details.metrics.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nC\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "z1" }, { toolCallId: "z2" }] },
        ctx,
      ) as Promise<unknown>);

      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect((undone.content[0] as { text: string }).text).toContain("Undone last change");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("reports a dedup-cut noop member when the batch nets to no change", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const insertTool = getTool("insert");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const aRef = anchorFor(text, "a");
      const bRef = anchorFor(text, "b");
      const cRef = anchorFor(text, "c");

      const firstArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: [] };
      const insertArgs = { anchor: aRef, direction: "after", lines: ["b"] };
      const thirdArgs = { remove_from: cRef, remove_to: cRef, replacement_lines: ["b", "c"] };
      const message = assistantMessage([
        toolCall("y1", "replace", firstArgs),
        toolCall("y2", "insert", insertArgs),
        toolCall("y3", "replace", thirdArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      await editTool.execute("y1", firstArgs, undefined, undefined, ctx);
      await insertTool.execute("y2", insertArgs, undefined, undefined, ctx);
      const third = await editTool.execute("y3", thirdArgs, undefined, undefined, ctx);
      expect(third.details.metrics.classification).toBe("noop");
      expect(third.details.warnings).toEqual(["Boundary dedup: edit #3 produced no change (1 line not added again)."]);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "y1" }, { toolCallId: "y2" }, { toolCallId: "y3" }] },
        ctx,
      ) as Promise<unknown>);

      const resent = await editTool.execute("y3b", thirdArgs, undefined, undefined, ctx);
      expect(resent.details.metrics.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("fails fast on later calls after the first call fails", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aRef = anchorFor(text, "a");
      const bRef = anchorFor(text, "b");

      const message = assistantMessage([
        toolCall("g1", "replace", { remove_from: aRef, remove_to: aRef, replacement_lines: null }),
        toolCall("g2", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: ["B"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      let firstFailure = "";
      try {
        await editTool.execute(
          "g1",
          { remove_from: aRef, remove_to: aRef, replacement_lines: null },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
      expect(firstFailure).toContain("[E_BAD_SHAPE]");

      let secondFailure = "";
      try {
        await editTool.execute(
          "g2",
          { remove_from: bRef, remove_to: bRef, replacement_lines: ["B"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        secondFailure = error instanceof Error ? error.message : String(error);
      }
      expect(secondFailure).toContain("[E_OP_ABORTED]");
      expect(secondFailure).toContain("[E_BAD_SHAPE]");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "g1" }, { toolCallId: "g2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("aborts the batch when the file changes mid-turn", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aRef = anchorFor(text, "a");
      const cRef = anchorFor(text, "c");

      const message = assistantMessage([
        toolCall("h1", "replace", { remove_from: aRef, remove_to: aRef, replacement_lines: ["A"] }),
        toolCall("h2", "replace", { remove_from: cRef, remove_to: cRef, replacement_lines: ["C"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "h1",
        { remove_from: aRef, remove_to: aRef, replacement_lines: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      await writeFile(path, "a\nb\nEXTERNAL\n", "utf-8");

      let failure = "";
      try {
        await editTool.execute(
          "h2",
          { remove_from: cRef, remove_to: cRef, replacement_lines: ["C"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_OP_ABORTED]");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nEXTERNAL\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "h1" }, { toolCallId: "h2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("rejects the whole batch in strict-input mode", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(cwd, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, strictInput: true }),
        "utf-8",
      );
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aaaRef = anchorFor(text, "aaa");
      const bbbRef = anchorFor(text, "bbb");

      const message = assistantMessage([
        toolCall("s1", "replace", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: [`${aaaRef}│AAA`] }),
        toolCall("s2", "replace", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "s1",
        { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: [`${aaaRef}│AAA`] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      let failure = "";
      try {
        await editTool.execute(
          "s2",
          { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("Strict-input mode");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "s1" }, { toolCallId: "s2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("refuses a batch that would empty the file", async () => {
    await withTempFile("sample.txt", "a\nb\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aRef = anchorFor(text, "a");
      const bRef = anchorFor(text, "b");

      const message = assistantMessage([
        toolCall("e1", "replace", { remove_from: aRef, remove_to: aRef, replacement_lines: [] }),
        toolCall("e2", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: [] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute(
        "e1",
        { remove_from: aRef, remove_to: aRef, replacement_lines: [] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch 1");

      let failure = "";
      try {
        await editTool.execute(
          "e2",
          { remove_from: bRef, remove_to: bRef, replacement_lines: [] },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_WOULD_EMPTY]");
      expect(await readFile(path, "utf-8")).toBe("a\nb\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "e1" }, { toolCallId: "e2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("fails later calls fast after an earlier call fails", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const aRef = anchorFor(text, "a");
      const cRef = anchorFor(text, "c");
      const dRef = anchorFor(text, "d");
      await writeFile(path, "A2\nb\nc\nd\n", "utf-8");

      const message = assistantMessage([
        toolCall("t1", "replace", { remove_from: aRef, remove_to: aRef, replacement_lines: ["A"] }),
        toolCall("t2", "replace", { remove_from: cRef, remove_to: cRef, replacement_lines: ["C"] }),
        toolCall("t3", "replace", { remove_from: dRef, remove_to: dRef, replacement_lines: ["D"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const runCall = async (id: string, ref: string, line: string): Promise<string> => {
        try {
          await editTool.execute(
            id,
            { remove_from: ref, remove_to: ref, replacement_lines: [line] },
            undefined,
            undefined,
            ctx,
          );
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      expect(await runCall("t1", aRef, "A")).toContain("[E_STALE_ANCHOR]");
      expect(await runCall("t2", cRef, "C")).toContain("[E_OP_ABORTED]");
      expect(await runCall("t3", dRef, "D")).toContain("[E_OP_ABORTED]");
      expect(await readFile(path, "utf-8")).toBe("A2\nb\nc\nd\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "t1" }, { toolCallId: "t2" }, { toolCallId: "t3" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("reports dedup-cut noops in an all-noop batch", async () => {
    await withTempFile("sample.txt", "x\ny\nz\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const firstRead = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text as string;
      const xRef = anchorFor(text, "x");
      const yRef = anchorFor(text, "y");

      const message = assistantMessage([
        toolCall("p1", "replace", { remove_from: xRef, remove_to: xRef, replacement_lines: ["x", "y"] }),
        toolCall("p2", "replace", { remove_from: yRef, remove_to: yRef, replacement_lines: ["y", "z"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      await editTool.execute(
        "p1",
        { remove_from: xRef, remove_to: xRef, replacement_lines: ["x", "y"] },
        undefined,
        undefined,
        ctx,
      );
      const second = await editTool.execute(
        "p2",
        { remove_from: yRef, remove_to: yRef, replacement_lines: ["y", "z"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.details.metrics.classification).toBe("noop");
      expect(second.content[0].text).toContain("Boundary dedup: edits #1, #2 produced no change (2 lines not added again).");
      expect(await readFile(path, "utf-8")).toBe("x\ny\nz\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "p1" }, { toolCallId: "p2" }] },
        ctx,
      ) as Promise<unknown>);

      const resent = await editTool.execute(
        "solo-resend",
        { remove_from: yRef, remove_to: yRef, replacement_lines: ["y", "z"] },
        undefined,
        undefined,
        ctx,
      );
      expect(resent.details.metrics.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("x\ny\nz\n");
    });
  });

  it("applies a batch whose member sent replacement_lines as a string after host coercion", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");

      const firstArgs = { remove_from: betaRef, remove_to: betaRef, replacement_lines: "BETA\nBETA2" };
      const secondArgs = { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] };
      const message = assistantMessage([
        toolCall("c1", "replace", firstArgs),
        toolCall("c2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("c1", withHostCoercion(editTool.parameters, firstArgs), undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("c2", secondArgs, undefined, undefined, ctx);
      expect(second.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(second.details.diff).toContain("BETA2");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\nBETA2\nGAMMA\ndelta\n");
    });
  });

  it("applies a batch whose member sent a method-chained stringified array", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");

      const firstArgs = { remove_from: betaRef, remove_to: betaRef, replacement_lines: '["BETA"].map(s => s)' };
      const secondArgs = { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] };
      const message = assistantMessage([
        toolCall("m1", "replace", firstArgs),
        toolCall("m2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("m1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("m2", secondArgs, undefined, undefined, ctx);
      expect(second.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(second.details.diff).toContain("BETA");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\nGAMMA\ndelta\n");
    });
  });

  it("applies a batch whose insert member sent lines as a string after host coercion", async () => {
    await withTempFile("sample.txt", "one\ntwo\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const insertTool = getTool("insert");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const oneRef = anchorFor(text, "one");
      const twoRef = anchorFor(text, "two");

      const insertArgs = { anchor: oneRef, direction: "after", lines: "ONE-A\nONE-B" };
      const editArgs = { remove_from: twoRef, remove_to: twoRef, replacement_lines: ["TWO"] };
      const message = assistantMessage([
        toolCall("n1", "insert", insertArgs),
        toolCall("n2", "replace", editArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await insertTool.execute("n1", withHostCoercion(insertTool.parameters, insertArgs), undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("n2", editArgs, undefined, undefined, ctx);
      expect(second.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("one\nONE-A\nONE-B\nTWO\n");
    });
  });

  it("names the planned member that never executed and its error code", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const aRef = anchorFor(text, "a");
      const bRef = anchorFor(text, "b");
      const cRef = anchorFor(text, "c");

      const firstArgs = { remove_from: aRef, remove_to: aRef, replacement_lines: ["A"] };
      const skippedArgs = { anchor: bRef, direction: "sideways", lines: ["B2"] };
      const lastArgs = { remove_from: cRef, remove_to: cRef, replacement_lines: ["C"] };
      const message = assistantMessage([
        toolCall("x1", "replace", firstArgs),
        toolCall("x2", "insert", skippedArgs),
        toolCall("x3", "replace", lastArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("x1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      let failure = "";
      try {
        await editTool.execute("x3", lastArgs, undefined, undefined, ctx);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toBe("[E_OP_ABORTED] Batch 1 aborted: [insert] Call Nr 2 errored [E_BAD_SHAPE]");
      expect(first.details.batch).toMatchObject({ aborted: true, abortMessage: failure });
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("aborts siblings with the failing call and code when a member's anchors went stale", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const firstArgs = { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["B"] };
      const secondArgs = { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["G"] };
      const message = assistantMessage([
        toolCall("g1", "replace", firstArgs),
        toolCall("g2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      let firstFailure = "";
      try {
        await editTool.execute("g1", firstArgs, undefined, undefined, ctx);
      } catch (error) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
      expect(firstFailure).toMatch(/^\[E_STALE_ANCHOR\]/);
      expect(firstFailure).toContain("Aborts batch 1.");

      let secondFailure = "";
      try {
        await editTool.execute("g2", secondArgs, undefined, undefined, ctx);
      } catch (error) {
        secondFailure = error instanceof Error ? error.message : String(error);
      }
      expect(secondFailure).toBe("[E_OP_ABORTED] Batch 1 aborted: [replace] Call Nr 1 errored [E_STALE_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("shows the dedup rows the batch warning references", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const bRef = anchorFor(text, "b");
      const cRef = anchorFor(text, "c");

      const firstArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: ["a", "B"] };
      const secondArgs = { remove_from: cRef, remove_to: cRef, replacement_lines: ["X", "d"] };
      const message = assistantMessage([
        toolCall("w1", "replace", firstArgs),
        toolCall("w2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("w1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("w2", secondArgs, undefined, undefined, ctx);
      expect(second.content[0].text).toContain("Boundary dedup: 2 lines not added again (see dedup│ rows).");
      const rows = second.details.diff.split("\n");
      const aboveIdx = rows.findIndex((row: string) => row.startsWith("dedup│a"));
      const bIdx = rows.findIndex((row: string) => row.startsWith("-") && row.endsWith("│b"));
      const xIdx = rows.findIndex((row: string) => row.startsWith("+") && row.endsWith("│X"));
      const belowIdx = rows.findIndex((row: string) => row.startsWith("dedup│d"));
      expect(aboveIdx).toBe(bIdx - 1);
      expect(belowIdx).toBe(xIdx + 1);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nX\nd\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "w1" }, { toolCallId: "w2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });

  it("reports a dedup-cut noop member without dedup rows", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const bRef = anchorFor(text, "b");
      const dRef = anchorFor(text, "d");

      const firstArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: ["a", "b", "c"] };
      const secondArgs = { remove_from: dRef, remove_to: dRef, replacement_lines: ["D"] };
      const message = assistantMessage([
        toolCall("z1", "replace", firstArgs),
        toolCall("z2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("z1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("z2", secondArgs, undefined, undefined, ctx);
      expect(second.details.diff).not.toContain("dedup│");
      expect(second.details.warnings).toEqual(["Boundary dedup: edit #1 produced no change (2 lines not added again)."]);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nD\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "z1" }, { toolCallId: "z2" }] },
        ctx,
      ) as Promise<unknown>);

      const resent = await editTool.execute("z1b", firstArgs, undefined, undefined, ctx);
      expect(resent.details.metrics.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nD\n");
    });
  });

  it("renders an aborted batch member as aborted on re-render", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const bRef = anchorFor(text, "b");

      const firstArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: ["B"] };
      const secondArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: ["B2"] };
      const message = assistantMessage([
        toolCall("v1a", "replace", firstArgs),
        toolCall("v1b", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("v1a", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const theme = { fg: (_name: string, row: string) => row, bold: (row: string) => row };
      const context = { toolCallId: "v1a", lastComponent: undefined, state: {}, expanded: false, isError: false };
      const pending = (editTool.renderResult!(first, { isPartial: false }, theme, context) as any);
      expect(pending.text).toBe("In batch 1");

      let failure = "";
      try {
        await editTool.execute("v1b", secondArgs, undefined, undefined, ctx);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain("[E_BATCH_OVERLAP]");

      const aborted = (editTool.renderResult!(first, { isPartial: false }, theme, context) as any);
      expect(aborted.text).toContain("[E_OP_ABORTED] Batch 1 aborted.");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "v1a" }, { toolCallId: "v1b" }] },
        ctx,
      ) as Promise<unknown>);
      const later = (editTool.renderResult!(first, { isPartial: false }, theme, context) as any);
      expect(later.text).toContain("[E_OP_ABORTED] Batch 1 aborted.");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("names the failing call and its error code in the abort message", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const aRef = anchorFor(text, "a");
      const cRef = anchorFor(text, "c");

      await writeFile(path, "a\nB\nc\n", "utf-8");

      const firstArgs = { remove_from: aRef, remove_to: cRef, replacement_lines: ["X"] };
      const lastArgs = { remove_from: cRef, remove_to: cRef, replacement_lines: ["C"] };
      const message = assistantMessage([
        toolCall("s1", "replace", firstArgs),
        toolCall("s2", "replace", lastArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      let firstFailure = "";
      try {
        await editTool.execute("s1", firstArgs, undefined, undefined, ctx);
      } catch (error) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
      expect(firstFailure).toContain("Current range with fresh anchors");

      let secondFailure = "";
      try {
        await editTool.execute("s2", lastArgs, undefined, undefined, ctx);
      } catch (error) {
        secondFailure = error instanceof Error ? error.message : String(error);
      }
      expect(secondFailure).toBe("[E_OP_ABORTED] Batch 1 aborted: [replace] Call Nr 1 errored [E_RANGE_STALE]");
      expect(secondFailure).not.toContain("Current range with fresh anchors");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");

      await (handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "s1" }, { toolCallId: "s2" }] },
        ctx,
      ) as Promise<unknown>);
    });
  });
  it("applies batch replacements literally when boundary dedup is off", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupBatchTools(cwd);
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "off" });
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = (await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).content[0].text as string;
      const bRef = anchorFor(text, "b");
      const cRef = anchorFor(text, "c");

      const firstArgs = { remove_from: bRef, remove_to: bRef, replacement_lines: ["a", "B"] };
      const secondArgs = { remove_from: cRef, remove_to: cRef, replacement_lines: ["X", "d"] };
      const message = assistantMessage([
        toolCall("o1", "replace", firstArgs),
        toolCall("o2", "replace", secondArgs),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);

      const first = await editTool.execute("o1", firstArgs, undefined, undefined, ctx);
      expect(first.content[0].text).toBe("In batch 1");

      const second = await editTool.execute("o2", secondArgs, undefined, undefined, ctx);
      expect(second.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(second.details.warnings).toBeUndefined();
      expect(second.details.diff).not.toContain("dedup│");
      expect(await readFile(path, "utf-8")).toBe("a\na\nB\nX\nd\nd\n");
    });
  });
});
