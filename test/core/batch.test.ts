import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { batchMemberFor, finalizeTurn, planAssistantMessage, resetBatchStateForTests } from "../../src/batch";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantMessage(calls: Array<{ type: string; id: string; name: string; arguments: unknown }>) {
  return { role: "assistant", content: calls };
}

describe("planAssistantMessage", () => {
  it("ignores non-assistant messages", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        { role: "user", content: "hello" },
        cwd,
      );
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("c2", "replace", { remove_from: hashes[1], remove_to: hashes[1], replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")?.display).toBe(1);
      resetBatchStateForTests();
      expect(batchMemberFor("c1")).toBeUndefined();
    });
  });

  it("leaves single edits unbatched", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")).toBeUndefined();
    });
  });

  it("groups same-file edits into one batch with order and last markers", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("c2", "replace", { remove_from: hashes[2], remove_to: hashes[2], replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")).toMatchObject({ display: 1, total: 1, order: 1, size: 2, last: false });
      expect(batchMemberFor("c2")).toMatchObject({ display: 1, total: 1, order: 2, size: 2, last: true });
    });
  });

  it("creates one batch per file in first-appearance order", async () => {
    await withTempFile("a.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const second = join(cwd, "b.txt");
      await writeFile(second, "mmm\nnnn\n", "utf-8");
      setupIntegrationTest(cwd);
      const hashesA = await lineHashes("aaa\nbbb\n", path);
      const hashesB = await lineHashes("mmm\nnnn\n", second);
      await planAssistantMessage(
        assistantMessage([
          toolCall("a1", "replace", { remove_from: hashesA[0], remove_to: hashesA[0], replacement_lines: ["x"] }),
          toolCall("b1", "replace", { remove_from: hashesB[0], remove_to: hashesB[0], replacement_lines: ["y"] }),
          toolCall("a2", "replace", { remove_from: hashesA[1], remove_to: hashesA[1], replacement_lines: ["z"] }),
          toolCall("b2", "insert", { anchor: hashesB[1], direction: "after", lines: ["w"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("a1")).toMatchObject({ display: 1, total: 2, order: 1, size: 2, last: false });
      expect(batchMemberFor("a2")).toMatchObject({ display: 1, total: 2, order: 2, size: 2, last: true });
      expect(batchMemberFor("b1")).toMatchObject({ display: 2, total: 2, order: 1, size: 2, last: false });
      expect(batchMemberFor("b2")).toMatchObject({ display: 2, total: 2, order: 2, size: 2, last: true });
    });
  });

  it("leaves lone-file edits solo while batching the repeated file", async () => {
    await withTempFile("a.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const second = join(cwd, "b.txt");
      await writeFile(second, "mmm\n", "utf-8");
      setupIntegrationTest(cwd);
      const hashesA = await lineHashes("aaa\nbbb\n", path);
      const hashesB = await lineHashes("mmm\n", second);
      await planAssistantMessage(
        assistantMessage([
          toolCall("a1", "replace", { remove_from: hashesA[0], remove_to: hashesA[0], replacement_lines: ["x"] }),
          toolCall("b1", "replace", { remove_from: hashesB[0], remove_to: hashesB[0], replacement_lines: ["y"] }),
          toolCall("a2", "replace", { remove_from: hashesA[1], remove_to: hashesA[1], replacement_lines: ["z"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("b1")).toBeUndefined();
      expect(batchMemberFor("a1")?.display).toBe(1);
      expect(batchMemberFor("a2")?.last).toBe(true);
    });
  });

  it("excludes unresolvable anchors from batches", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("c2", "replace", { remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")).toBeUndefined();
      expect(batchMemberFor("c2")).toBeUndefined();
    });
  });

  it("honors requirePath when grouping", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(cwd, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, requirePath: true }),
        "utf-8",
      );
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { path: "sample.txt", remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("c2", "replace", { path: "sample.txt", remove_from: hashes[1], remove_to: hashes[1], replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")?.display).toBe(1);
      expect(batchMemberFor("c2")?.last).toBe(true);
      resetBatchStateForTests();
      await planAssistantMessage(
        assistantMessage([
          toolCall("d1", "replace", { path: "sample.txt", remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("d2", "replace", { path: "other.txt", remove_from: hashes[1], remove_to: hashes[1], replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("d1")).toBeUndefined();
      expect(batchMemberFor("d2")).toBeUndefined();
    });
  });

  it("finalizeTurn clears only the finished turn batches", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      await planAssistantMessage(
        assistantMessage([
          toolCall("c1", "replace", { remove_from: hashes[0], remove_to: hashes[0], replacement_lines: ["x"] }),
          toolCall("c2", "replace", { remove_from: hashes[1], remove_to: hashes[1], replacement_lines: ["y"] }),
        ]),
        cwd,
      );
      expect(batchMemberFor("c1")).toBeDefined();
      await finalizeTurn(["c1", "c2"]);
      expect(batchMemberFor("c1")).toBeUndefined();
      expect(batchMemberFor("c2")).toBeUndefined();
    });
  });
});
