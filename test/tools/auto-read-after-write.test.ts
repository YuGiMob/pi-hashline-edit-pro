import { afterAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { shutdownHashStore } from "../../src/hash-store";
import { makeTempDir, withHome } from "../support/fixtures";

async function cleanupCwd(cwd: string): Promise<void> {
  shutdownHashStore();
  await rm(cwd, { recursive: true, force: true });
}

const restoreHome = withHome(process.env.HOME);

afterAll(restoreHome);

type ToolResultHandler = (
  event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    isError: boolean;
  },
  ctx: {
    cwd: string;
    signal?: AbortSignal;
  },
) => Promise<
  | {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      isError?: boolean;
    }
  | undefined
  | void
>;

function createTestPi() {
  let toolResultHandler: ToolResultHandler | undefined;
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const pi = {
    registerTool() {},
    registerCommand() {},
    getActiveTools: () => [],
    setActiveTools() {},
    on(event: string, handler: unknown) {
      if (event === "tool_result") {
        toolResultHandler = handler as ToolResultHandler;
      } else if (event === "session_start") {
        sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<unknown>;
      }
    },
  } as any;

  register(pi);

  return {
    pi,
    getToolResultHandler: () => toolResultHandler,
    getSessionStartHandler: () => sessionStartHandler,
  };
}

describe("auto-read after write", () => {
  it("triggers auto-read after a successful write by default", async () => {
    const cwd = await makeTempDir("auto-read-test-default-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello\nworld\n" },
          content: [{ type: "text", text: "Successfully wrote 12 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);
      expect(writeResult!.content![1]!.text!).toContain("--- Auto-read (hashline anchors) ---");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns nothing when auto-read is disabled via config", async () => {
    const cwd = await makeTempDir("auto-read-test-disabled-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    const configDir = join(cwd, ".config", "pi-hashline-edit-pro");
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ autoRead: false }), "utf-8");

      const { getToolResultHandler, getSessionStartHandler } = createTestPi();
      const sessionHandler = getSessionStartHandler();
      expect(sessionHandler).toBeDefined();
      await sessionHandler!({}, { cwd });

      const handler = getToolResultHandler();
      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello\nworld\n" },
          content: [{ type: "text", text: "Successfully wrote 12 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("registers the tool_result handler", async () => {
    const { getToolResultHandler } = createTestPi();
    const handler = getToolResultHandler();
    expect(handler).toBeDefined();
  });

  it("appends hashline read output after successful write when enabled", async () => {
    const cwd = await makeTempDir("auto-read-test-");
    await writeFile(join(cwd, "test.txt"), "hello\nworld\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();
      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello\nworld\n" },
          content: [{ type: "text", text: "Successfully wrote 12 bytes to test.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      expect(writeResult!.content).toHaveLength(2);

      expect(writeResult!.content![0]).toEqual({
        type: "text",
        text: "Successfully wrote 12 bytes to test.txt",
      });

      const autoReadText = writeResult!.content![1]!.text!;
      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");
      expect(autoReadText).toMatch(/[A-Za-z0-9]{4}│hello/);
      expect(autoReadText).toMatch(/[A-Za-z0-9]{4}│world/);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not trigger auto-read when write fails", async () => {
    const cwd = await makeTempDir("auto-read-test-fail-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "test.txt", content: "hello" },
          content: [{ type: "text", text: "Error: Permission denied" }],
          details: undefined,
          isError: true,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not trigger for non-write tools", async () => {
    const cwd = await makeTempDir("auto-read-test-nonwrite-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const readResult = await handler!(
        {
          toolName: "read",
          toolCallId: "read-1",
          input: { path: "test.txt" },
          content: [{ type: "text", text: "abc1│hello" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(readResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("handles missing path in write input gracefully", async () => {
    const cwd = await makeTempDir("auto-read-test-nopath-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { content: "hello" },
          content: [{ type: "text", text: "Successfully wrote 5 bytes" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns original write result when auto-read fails", async () => {
    const cwd = await makeTempDir("auto-read-test-autoreadfail-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "nonexistent/deeply/nested/file.txt", content: "hello" },
          content: [{ type: "text", text: "Successfully wrote 5 bytes to nonexistent/deeply/nested/file.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const content = (writeResult as { content: Array<{ type: string; text: string }> }).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({
        type: "text",
        text: "Successfully wrote 5 bytes to nonexistent/deeply/nested/file.txt",
      });
      expect(content[1].text).toContain("--- Auto-read failed:");
      expect(content[1].text).toContain("[E_NOT_FOUND]");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("includes hashline anchors in correct format", async () => {
    const cwd = await makeTempDir("auto-read-test-format-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const content = "function hello() {\n  return 'world';\n}\n";
      await writeFile(join(cwd, "code.ts"), content, "utf-8");
      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "code.ts", content },
          content: [{ type: "text", text: "Successfully wrote 38 bytes to code.ts" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      const lines = autoReadText.split("\n");
      const hashlinePattern = /^[A-Za-z0-9]{4}│/;

      const headerIndex = lines.findIndex((l) =>
        l.includes("--- Auto-read (hashline anchors) ---"),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);

      const contentLines = lines.slice(headerIndex + 1).filter((l) => l.length > 0);
      for (const line of contentLines) {
        expect(line).toMatch(hashlinePattern);
      }

      expect(autoReadText).toContain("function hello()");
      expect(autoReadText).toContain("return 'world'");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("handles large files with truncation", async () => {
    const cwd = await makeTempDir("auto-read-test-large-");

    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const largeContent = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      await writeFile(join(cwd, "large.txt"), largeContent, "utf-8");
      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "large.txt", content: largeContent },
          content: [{ type: "text", text: "Successfully wrote 1890 bytes to large.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const autoReadText = writeResult!.content![1]!.text!;

      expect(autoReadText).toContain("--- Auto-read (hashline anchors) ---");

      expect(autoReadText).toContain("line 1");

      expect(autoReadText).toMatch(/offset=\d+/);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("appends the empty-file anchor for empty files", async () => {
    const cwd = await makeTempDir("auto-read-test-empty-");
    await writeFile(join(cwd, "empty.txt"), "", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();
      expect(handler).toBeDefined();

      const writeResult = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "empty.txt", content: "" },
          content: [{ type: "text", text: "Successfully wrote 0 bytes to empty.txt" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(writeResult).toBeDefined();
      const text = (writeResult as { content: Array<{ type: string; text: string }> }).content[1].text;
      expect(text).toContain("--- Auto-read (hashline anchors) ---");
      expect(text).toContain("[File is empty. Use replace to insert content.]");
      expect(text).toMatch(/^[A-Za-z0-9]{4}│/m);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("replaces replace tool results with the diff and no anchors block", async () => {
    const cwd = await makeTempDir("auto-read-test-replace-");
    await writeFile(join(cwd, "replace.txt"), "alpha\nbeta\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const diff = " alpha\n-   │beta\n+BET│BETA";
      const replaceResult = await handler!(
        {
          toolName: "replace",
          toolCallId: "replace-1",
          input: { path: "replace.txt", remove_from: "abc", remove_to: "abc", replacement_lines: ["BETA"] },
          content: [{ type: "text", text: "Successfully replaced in replace.txt. Added 1 line(s), removed 1 line(s)." }],
          details: { diff, metrics: { classification: "applied" } },
          isError: false,
        },
        { cwd },
      );

      expect(replaceResult).toBeDefined();
      expect(replaceResult!.content).toHaveLength(1);
      expect(replaceResult!.content![0]!.text).toBe(diff);
      expect(replaceResult!.content![0]!.text).not.toContain("--- Auto-read");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("replaces undo_last_change tool results with the diff and no anchors block", async () => {
    const cwd = await makeTempDir("auto-read-test-undo-");
    await writeFile(join(cwd, "undo.txt"), "alpha\nbeta\n", "utf-8");
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const diff = " alpha\n-   │BETA\n+BET│beta";
      const undoResult = await handler!(
        {
          toolName: "undo_last_change",
          toolCallId: "undo-1",
          input: { path: "undo.txt" },
          content: [{ type: "text", text: "Undone last change on undo.txt." }],
          details: { diff, metrics: { classification: "applied" } },
          isError: false,
        },
        { cwd },
      );

      expect(undoResult).toBeDefined();
      expect(undoResult!.content).toHaveLength(1);
      expect(undoResult!.content![0]!.text).toBe(diff);
      expect(undoResult!.content![0]!.text).not.toContain("--- Auto-read");
    } finally {
      await cleanupCwd(cwd);
    }
  });
});

describe("auto-read after write - non-text files", () => {
  it("silently skips auto-read when the written file is binary", async () => {
    const cwd = await makeTempDir("auto-read-test-binary-");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(cwd, "image.png"), pngBytes);
    try {
      const { getToolResultHandler } = createTestPi();
      const handler = getToolResultHandler();

      const result = await handler!(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "image.png", content: "binary" },
          content: [{ type: "text", text: "Successfully wrote image.png" }],
          details: undefined,
          isError: false,
        },
        { cwd },
      );

      expect(result).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });
});
