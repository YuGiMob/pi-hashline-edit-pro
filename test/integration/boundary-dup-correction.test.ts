import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

describe("boundary duplication auto-fix", () => {
  it("trailing }: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text1 = getText(read1);
      const lines1 = text1.split("\n");

      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);

      await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line3Hash,
          replacement_lines: [`  const y = 2;`, `  return y;`, `}`],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n");
    });
  });

  it("reports accurate added-line counts when the boundary-dup fix removes a line", async () => {
    const file = "function foo() {\n  const x = 1;\n  return x;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const x = 1;"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  return x;"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line3Hash,
          replacement_lines: [`  const y = 2;`, `  return y;`, `}`],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");
      expect(editResult.content[0].text).not.toContain("Added 3 line(s)");
      expect(editResult.details?.metrics?.added_lines).toBe(2);
      expect(editResult.details?.metrics?.removed_lines).toBe(2);

      const content = await readFile(path, "utf-8");
      expect(content).toBe("function foo() {\n  const y = 2;\n  return y;\n}\n");
    });
  });

  it("trailing });: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = 'app.get("/api", (req, res) => {\n  const data = fetchData();\n  res.json(data);\n});\n';
    await withTempFile("server.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "server.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│  const data"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  res.json"))!);

      await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line3Hash,
          replacement_lines: [`  const result = processData();`, `  res.json(result);`, `});`],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe('app.get("/api", (req, res) => {\n  const result = processData();\n  res.json(result);\n});\n');
    });
  });

  it("leading: auto-fix strips duplicate, file is correct after one edit", async () => {
    const file = "before();\nif (ok) {\n  run();\n}\nafter();\n";
    await withTempFile("logic.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "logic.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const line2Hash = extractHash(lines1.find(l => l.includes("│if (ok)"))!);
      const line3Hash = extractHash(lines1.find(l => l.includes("│  run();"))!);

      await editTool.execute(
        "e1",
        {
          remove_from: line2Hash, remove_to: line3Hash,
          replacement_lines: [`before();`, `if (ok) {`, `  runSafe();`],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("before();\nif (ok) {\n  runSafe();\n}\nafter();\n");
    });
  });

  it("trailing } with multiple identical lines: auto-fix preserves correct hash", async () => {
    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nif (c) {\n  z();\n}\n";
    await withTempFile("multi.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const line4Hash = extractHash(lines1.find(l => l.includes("│if (b)"))!);
      const line5Hash = extractHash(lines1.find(l => l.includes("│  y();"))!);

      const braceLines1 = lines1.filter(l => l.endsWith("│}"));
      expect(braceLines1.length).toBe(3);
      const survivingBraceHash = extractHash(braceLines1[1]!);

      await editTool.execute(
        "e1",
        {
          remove_from: line4Hash, remove_to: line5Hash,
          replacement_lines: [`if (b) {`, `  yNew();`, `}`],
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const braceLines2 = lines2.filter(l => l.endsWith("│}"));
      expect(braceLines2.length).toBe(3);

      const matchingBraces = braceLines2.filter(l => extractHash(l) === survivingBraceHash);
      expect(matchingBraces.length).toBe(1);
      const survivingIndex = braceLines2.findIndex(l => extractHash(l) === survivingBraceHash);
      expect(survivingIndex).toBe(1);
    });
  });

  it("4th } before edit range: auto-fix strips duplicate, edit becomes noop", async () => {
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

      const edit1 = await editTool.execute(
        "e1",
        {
          remove_from: fooHash, remove_to: barHash, replacement_lines: [`foo();`, `bar();`, `}`],
        },
        undefined,
        undefined,
        ctx,
      );

      const edit1Text = getText(edit1);
      expect(edit1Text).toContain("No changes made");
      expect(edit1Text).toContain("noop");

      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe(file);
    });
  });
});

describe("new-line boundary duplication (auto-fix)", () => {
  it("strips a new line duplicating a unique line after the range", async () => {
    const file = [
      "export class WorkflowEditorOverlay {",
      "  private activeTab = 0;",
      "  private confirmingClose = false;",
      "",
      "  constructor() {",
      "    this.activeTab = 0;",
      "  }",
      "}",
    ].join("\n") + "\n";
    await withTempFile("overlay.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "overlay.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const classHash = extractHash(lines1.find((l) => l.includes("│export class WorkflowEditorOverlay"))!);
      const blankHash = extractHash(lines1.find((l) => l.endsWith("│"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: classHash, remove_to: blankHash,
          replacement_lines: [
            "export class WorkflowEditorOverlay {",
            "  private activeTab = 0;",
            "  private confirmingClose = false;",
            "",
            "  constructor() {",
            "  }",
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      const constructorCount = content.split("\n").filter((l) => l.includes("constructor()")).length;
      expect(constructorCount).toBe(1);
    });
  });

  it("strips a new line duplicating a unique line before the range (noop)", async () => {
    const file = "foo();\nbar();\nbaz();\n";
    await withTempFile("reorder.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "reorder.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const barHash = extractHash(lines1.find((l) => l.includes("│bar();"))!);
      const bazHash = extractHash(lines1.find((l) => l.includes("│baz();"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: barHash, remove_to: bazHash,
          replacement_lines: ["bar();", "baz();", "foo();"],
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("No changes made");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("foo();\nbar();\nbaz();\n");
    });
  });

  it("does not strip new-line duplicates when the adjacent line is not unique", async () => {
    const file = [
      "if (a) {",
      "  x();",
      "}",
      "if (b) {",
      "  y();",
      "}",
    ].join("\n") + "\n";
    await withTempFile("multi.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "multi.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const bHash = extractHash(lines1.find((l) => l.includes("│if (b)"))!);
      const yHash = extractHash(lines1.find((l) => l.includes("│  y();"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: bHash, remove_to: yHash,
          replacement_lines: ["if (b) {", "  yNew();", "}"],
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n");
    });
  });

  it("does not strip when the first new line differs from the line after the range", async () => {
    const file = "a\nb\nc\nd\n";
    await withTempFile("plain.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "plain.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const aHash = extractHash(lines1.find((l) => l.includes("│a"))!);
      const bHash = extractHash(lines1.find((l) => l.includes("│b"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: aHash, remove_to: bHash,
          replacement_lines: ["a", "b", "X"],
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).not.toContain("[E_BOUNDARY_DUP]");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nX\nc\nd\n");
    });
  });
});
describe("multi-line boundary duplication runs (auto-fix)", () => {
  it("strips a run of new lines duplicating unique lines after the range", async () => {
    const file = [
      `import { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
      `import { ScrollableTabContent } from "./scrollable";`,
      `import { StatsTabContent } from "./stats";`,
      `import { TabbedOverlay } from "./overlay";`,
      `import { formatTokens } from "./tokens";`,
      `export function main() {}`,
    ].join("\n") + "\n";
    await withTempFile("imports.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "imports.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const piHash = extractHash(lines1.find((l) => l.includes("│import { ExtensionAPI }"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: piHash, remove_to: piHash,
          replacement_lines: [
            `import { ScrollableTabContent } from "./scrollable";`,
            `import { StatsTabContent } from "./stats";`,
            `import { TabbedOverlay } from "./overlay";`,
            `import { formatTokens } from "./tokens";`,
            `type SessionEntry = { id: string };`,
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).toContain("Added 1 line(s), removed 1 line(s).");
      expect(editResult.details?.metrics?.added_lines).toBe(1);

      const content = await readFile(path, "utf-8");
      const scrollableCount = content.split("\n").filter((l) => l.includes("ScrollableTabContent")).length;
      const statsCount = content.split("\n").filter((l) => l.includes("StatsTabContent")).length;
      const overlayCount = content.split("\n").filter((l) => l.includes("TabbedOverlay")).length;
      const tokensCount = content.split("\n").filter((l) => l.includes("formatTokens")).length;
      expect(scrollableCount).toBe(1);
      expect(statsCount).toBe(1);
      expect(overlayCount).toBe(1);
      expect(tokensCount).toBe(1);
      expect(content).toContain("type SessionEntry = { id: string };");
    });
  });

  it("strips a run of trailing closing braces matching consecutive lines after the range", async () => {
    const file = "function a() {\n  const x = 1;\n}\n}\nafter();\n";
    await withTempFile("nested.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "nested.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const bodyHash = extractHash(lines1.find((l) => l.includes("│  const x = 1;"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: bodyHash, remove_to: bodyHash,
          replacement_lines: ["  const x = 2;", "}", "}"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Added 1 line(s), removed 1 line(s).");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("function a() {\n  const x = 2;\n}\n}\nafter();\n");
    });
  });

  it("strips a run of new lines duplicating unique lines before the range", async () => {
    const file = "before1();\nbefore2();\ntarget();\nafter();\n";
    await withTempFile("before-run.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "before-run.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const targetHash = extractHash(lines1.find((l) => l.includes("│target();"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: targetHash, remove_to: targetHash,
          replacement_lines: ["NEW();", "before1();", "before2();"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Added 1 line(s), removed 1 line(s).");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("before1();\nbefore2();\nNEW();\nafter();\n");
    });
  });

  it("strips a run of leading lines duplicating consecutive lines before the range", async () => {
    const file = "a\nb\nc\ntarget\nafter\n";
    await withTempFile("leading-run.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "leading-run.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const targetHash = extractHash(lines1.find((l) => l.includes("│target"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: targetHash, remove_to: targetHash,
          replacement_lines: ["c", "b", "a", "X"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Successfully replaced");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nc\nX\nafter\n");
    });
  });

  it("does not strip a file-order prefix copy from before the range", async () => {
    const file = "a\nb\nc\ntarget\nafter\n";
    await withTempFile("prefix-copy.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "prefix-copy.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const targetHash = extractHash(lines1.find((l) => l.includes("│target"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: targetHash, remove_to: targetHash,
          replacement_lines: ["a", "b", "c", "X"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Added 4 line(s), removed 1 line(s).");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("a\nb\nc\na\nb\nc\nX\nafter\n");
    });
  });

  it("strips a single line flagged by both edge checks exactly once", async () => {
    const file = "X\ntarget\nX\n";
    await withTempFile("both-edges.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "both-edges.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const targetHash = extractHash(lines1.find((l) => l.includes("│target"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: targetHash, remove_to: targetHash,
          replacement_lines: ["X"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Successfully replaced");
      expect(getText(editResult)).toContain("Added 0 line(s), removed 1 line(s).");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("X\nX\n");
    });
  });
});

describe("section-unique boundary duplication (auto-fix)", () => {
  it("strips a re-included block ending in a repeated brace after the range", async () => {
    const file = "import a\n\nexport interface Foo {\n  x: number;\n}\nexport function main() {}\n";
    await withTempFile("iface.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "iface.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const blankHash = extractHash(lines1.find((l) => l.endsWith("│"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: blankHash, remove_to: blankHash,
          replacement_lines: ["export interface Foo {", "  x: number;", "}", "", "export function main2() {}"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Successfully replaced");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("import a\n\nexport function main2() {}\nexport interface Foo {\n  x: number;\n}\nexport function main() {}\n");
      expect(content.split("\n").filter((l) => l.includes("export interface Foo")).length).toBe(1);
      expect(content).not.toContain("\n}\n}\n");
    });
  });

  it("strips a re-included block ending in a repeated brace before the range", async () => {
    const file = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\ntarget\n";
    await withTempFile("pre-block.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "pre-block.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const targetHash = extractHash(lines1.find((l) => l.includes("│target"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: targetHash, remove_to: targetHash,
          replacement_lines: ["NEW", "if (b) {", "  y();", "}"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Successfully replaced");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("if (a) {\n  x();\n}\nif (b) {\n  y();\n}\nNEW\n");
    });
  });

  it("does not strip when the re-included section repeats elsewhere in the file", async () => {
    const file = "Y\nZ\nX\nY\nZ\n";
    await withTempFile("repeat.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "repeat.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const xHash = extractHash(lines1.find((l) => l.includes("│X"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: xHash, remove_to: xHash,
          replacement_lines: ["X", "Y", "Z"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(editResult)).toContain("Successfully replaced");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("Y\nZ\nX\nY\nZ\nY\nZ\n");
    });
  });
});

describe("whitespace-only lines next to empty lines (regression)", () => {
  it("inserts a whitespace-only line before the range next to a unique empty line", async () => {
    const file = "\nsecond\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const secondHash = extractHash(lines1.find((l) => l.includes("│second"))!);
      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: secondHash, remove_to: secondHash,
          replacement_lines: ["   ", "second"],
        },
        undefined, undefined, ctx,
      );
      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(text).toContain("Added 2 line(s), removed 1 line(s).");
      expect(await readFile(path, "utf-8")).toBe("\n   \nsecond\n");
    });
  });

  it("inserts a whitespace-only line after the range next to a unique empty line", async () => {
    const file = "second\n";
    await withTempFile("sample.ts", file, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");
      const secondHash = extractHash(lines1.find((l) => l.includes("│second"))!);
      const editResult = await editTool.execute(
        "e1",
        {
          remove_from: secondHash, remove_to: secondHash,
          replacement_lines: ["second", "   "],
        },
        undefined, undefined, ctx,
      );
      const text = getText(editResult);
      expect(text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("second\n   \n");
    });
  });
});
