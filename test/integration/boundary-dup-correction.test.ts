import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("boundary duplication [W_DUP] warning (no auto-fix)", () => {
  it("trailing }: warns, duplicate kept in file", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text1 = getText(read1);
      const lines1 = text1.split("\n");

      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["  const y = 2;", "  return y;", "}"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const resultText = getText(result);
      // Should NOT be a noop — the edit applied
      expect(resultText).not.toContain("No changes made");
      // Warning should be present
      expect(resultText).toMatch(/\[W_DUP\]/);
      expect(resultText).toMatch(/ends with/);

      // File has a duplicate } (not silently stripped)
      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n}\n");
    });
  });

  it("trailing });: warns, duplicate kept in file", async () => {
    const file = 'app.get("/api", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});\n';
    await withTempFile("server.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "server.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const data"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  res.json"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "server.ts",
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["  const result = processData();", "  res.json(result);", "});"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const resultText = getText(result);
      expect(resultText).toMatch(/\[W_DUP\]/);

      const content = await readFile(path, "utf-8");
      expect(content).toBe('app.get("/api", (req, res) => {\n  const result = processData();\n  res.json(result);\n});\n});\n');
    });
  });

  it("leading: warns, duplicate kept in file", async () => {
    const file = "before();\nif (ok) {\n  run();\n}\nafter();\n";
    await withTempFile("logic.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  run();"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "logic.ts",
          changes: [{
            hash_range_inclusive: [line2Hash, line3Hash],
            content_lines: ["before();", "if (ok) {", "  runSafe();"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const resultText = getText(result);
      expect(resultText).toMatch(/\[W_DUP\]/);

      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("trailing } with multiple identical lines: warns, duplicate kept", async () => {
    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nif (c) {\n  z();\n}\n";
    await withTempFile("multi.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line4Hash = extractHash(lines1.find(l => l.includes("│if (b)"))!);
      const line5Hash = extractHash(lines1.find(l => l.includes("│  y();"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "multi.ts",
          changes: [{
            hash_range_inclusive: [line4Hash, line5Hash],
            content_lines: ["if (b) {", "  yNew();", "}"],
          }],
        },
        undefined,
        undefined,
        ctx,
      );

      const resultText = getText(result);
      expect(resultText).toMatch(/\[W_DUP\]/);

      // The duplicate } is kept — file now has extra }
      const content = await readFile(path, "utf-8");
      expect(content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n}\nif (c) {\n  z();\n}\n");
    });
  });

  it("4th } before edit range: warns, duplicate kept (no longer a noop)", async () => {
    const file = [
      "if (a) {", "  x();", "}",
      "if (b) {", "  y();", "}",
      "if (c) {", "  z();", "}",
      "foo();",
      "bar();",
      "}",
    ].join("\n") + "\n";
    await withTempFile("fourth.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "fourth.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const fooHash = extractHash(lines1.find(l => l.includes("│foo();"))!);
      const barHash = extractHash(lines1.find(l => l.includes("│bar();"))!);

      const result = await editTool.execute(
        "e1",
        {
          path: "fourth.ts",
          changes: [{ hash_range_inclusive: [fooHash, barHash], content_lines: ["foo();", "bar();", "}"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      const resultText = getText(result);
      // Should NOT be a noop — the edit applied (duplicate } kept)
      expect(resultText).not.toContain("No changes made");
      expect(resultText).toMatch(/\[W_DUP\]/);

      // File has an extra } (not silently stripped) — the duplicate stays
      const content = await readFile(path, "utf-8");
      // Original ends with ...bar();\n}\n
      // After edit: ...bar();\n}\n}\n (duplicate } kept, original } still there)
      expect(content.endsWith("bar();\n}\n}\n")).toBe(true);
    });
  });
});
