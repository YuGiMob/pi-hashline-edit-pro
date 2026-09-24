import { afterAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import register from "../../index";
import { getSnapshot, loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { resolveTarget } from "../../src/fs-write";
import { closeHashStore, makeTempDir, makePiStub, rmRetry, withHome } from "../support/fixtures";

const restoreHome = withHome(process.env.HOME);

afterAll(restoreHome);

describe("auto-read after write persists the snapshot", () => {
  it("persists through readNormFile and survives a store reopen", async () => {
    const cwd = await makeTempDir("auto-read-persist-");
    try {
      const content = "hello\nworld\n";
      await writeFile(join(cwd, "test.txt"), content, "utf-8");
      const { pi, handlers } = makePiStub();
      register(pi);
      const handler = handlers.get("tool_result")!;

      const result = (await handler(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content },
          content: [{ type: "text", text: "written" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      )) as { content: Array<{ type: string; text: string }> };
      expect(result).toBeDefined();

      const shown = result.content[1]!.text;
      const shownAnchors = shown
        .split("\n")
        .map((row) => /^([A-Za-z]{4})│/.exec(row)?.[1])
        .filter((anchor): anchor is string => typeof anchor === "string");
      expect(shownAnchors).toHaveLength(2);

      const abs = await resolveTarget(join(cwd, "test.txt"));
      const store = await loadHashStore();
      expect(getSnapshot(store, abs, content)).toEqual(shownAnchors);

      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(getSnapshot(reopened, abs, content)).toEqual(shownAnchors);
    } finally {
      await closeHashStore();
      await rmRetry(cwd);
    }
  });
});
