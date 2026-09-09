import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { writeConfig } from "../../src/config";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import {
  makeFakePiRegistry,
  setupIntegrationTest,
  withTempFile,
} from "../support/fixtures";
import register from "../../index";

function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantMessage(calls: Array<{ type: string; id: string; name: string; arguments: unknown }>) {
  return { role: "assistant", content: calls };
}

function anchorFor(readText: string, needle: string): string {
  return readText.split("\n").find((line) => line.includes(`│${needle}`))!.split("│")[0]!;
}

async function setupStrictTools(cwd: string) {
  resetRegistryForTests();
  resetBatchStateForTests();
  await initRegistry(undefined);
  const { pi, getTool, handlers } = makeFakePiRegistry();
  register(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { getTool, handlers, ctx };
}

async function readText(ctx: any, readTool: any): Promise<string> {
  const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
  return result.content[0].text as string;
}

async function captureFailure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("strict boundary dedup", () => {
  it("rejects a dedup-triggering edit without writing anything", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "strict" });
      const { ctx, getTool, readTool, editTool } = setupIntegrationTest(cwd);
      const bRef = anchorFor(await readText(ctx, readTool), "bbb");
      const failure = await captureFailure(() =>
        editTool.execute(
          "e1",
          { remove_from: bRef, remove_to: bRef, replacement_lines: ["X", "ccc"] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(failure).toContain("[E_BOUNDARY_STRICT]");
      expect(failure).toContain("replacement_lines line 2");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
      const undoTool = getTool("undo_last_change");
      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBe(true);
    });
  });

  it("applies a clean edit in strict mode", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "strict" });
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const bRef = anchorFor(await readText(ctx, readTool), "bbb");
      const result = await editTool.execute(
        "e1",
        { remove_from: bRef, remove_to: bRef, replacement_lines: ["X"] },
        undefined,
        undefined,
        ctx,
      );
      expect((result.content[0] as { text: string }).text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("aaa\nX\nccc\n");
    });
  });

  it("applies literally in off mode", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "off" });
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const bRef = anchorFor(await readText(ctx, readTool), "bbb");
      const result = await editTool.execute(
        "e1",
        { remove_from: bRef, remove_to: bRef, replacement_lines: ["X", "ccc"] },
        undefined,
        undefined,
        ctx,
      );
      expect((result.content[0] as { text: string }).text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("aaa\nX\nccc\nccc\n");
    });
  });

  it("aborts a batch when a member trips strict dedup", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, boundaryDedupMode: "strict" });
      const { getTool, handlers, ctx } = await setupStrictTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = await readText(ctx, readTool);
      const aRef = anchorFor(text, "aaa");
      const bRef = anchorFor(text, "bbb");
      const message = assistantMessage([
        toolCall("f1", "replace", { remove_from: aRef, remove_to: aRef, replacement_lines: ["AAA"] }),
        toolCall("f2", "replace", { remove_from: bRef, remove_to: bRef, replacement_lines: ["X", "ccc"] }),
      ]);
      await (handlers.get("message_end")!({ type: "message_end", message }, ctx) as Promise<unknown>);
      const first = await editTool.execute(
        "f1",
        { remove_from: aRef, remove_to: aRef, replacement_lines: ["AAA"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toBe("In batch");
      const failure = await captureFailure(() =>
        editTool.execute(
          "f2",
          { remove_from: bRef, remove_to: bRef, replacement_lines: ["X", "ccc"] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(failure).toContain("[E_BOUNDARY_STRICT]");
      expect(failure).toContain("edit #2");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });
});
