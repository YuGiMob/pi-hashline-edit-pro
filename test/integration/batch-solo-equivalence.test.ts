import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { finalizeTurn, planAssistantMessage, resetBatchStateForTests } from "../../src/batch";
import { splitLines } from "../../src/utils";
import { assistantMessage, getText, makeFakePiRegistry, toolCall, withTempDir } from "../support/fixtures";
import register from "../../index";

interface EditSpec {
  kind: "replace" | "insert";
  start: number;
  end: number;
  lines: string[];
  direction?: "before" | "after";
}

const VOCAB = ["", "a", "b", "c", "}", "dup", "  spaced", "const x = 1;", "line with spaces", "// note"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

function randLine(rnd: () => number): string {
  return VOCAB[randInt(rnd, 0, VOCAB.length - 1)]!;
}

function randContent(rnd: () => number): string {
  const lines = Array.from({ length: randInt(rnd, 2, 8) }, () => randLine(rnd));
  const body = lines.join("\n");
  return rnd() < 0.5 ? body : `${body}\n`;
}

function randEdits(rnd: () => number, lineCount: number): EditSpec[] {
  const target = randInt(rnd, 2, 4);
  const edits: EditSpec[] = [];
  let cursor = lineCount;
  while (cursor >= 1 && edits.length < target) {
    if (rnd() < 0.2) {
      cursor -= 1;
      continue;
    }
    if (rnd() < 0.7) {
      const span = randInt(rnd, 1, Math.min(3, cursor));
      const start = cursor - span + 1;
      edits.push({
        kind: "replace",
        start,
        end: cursor,
        lines: Array.from({ length: randInt(rnd, 0, 3) }, () => randLine(rnd)),
      });
      cursor = start - 1;
      continue;
    }
    const direction = rnd() < 0.5 ? "before" : "after";
    edits.push({
      kind: "insert",
      start: cursor,
      end: cursor,
      direction,
      lines: Array.from({ length: randInt(rnd, 1, 2) }, () => randLine(rnd)),
    });
    if (rnd() < 0.3) {
      edits.push({
        kind: "insert",
        start: cursor,
        end: cursor,
        direction: direction === "before" ? "after" : "before",
        lines: Array.from({ length: randInt(rnd, 1, 2) }, () => randLine(rnd)),
      });
    }
    cursor -= 1;
  }
  return edits;
}

function projectedLineCount(baseCount: number, edits: EditSpec[]): number {
  let count = baseCount;
  for (const edit of edits) {
    count += edit.kind === "replace" ? edit.lines.length - (edit.end - edit.start + 1) : edit.lines.length;
  }
  return count;
}

function anchorsFromRead(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z]{4}│/.test(line))
    .map((line) => line.slice(0, 4));
}

function argsFor(edit: EditSpec, anchors: string[]): Record<string, unknown> {
  if (edit.kind === "replace") {
    return {
      remove_from: anchors[edit.start - 1]!,
      remove_to: anchors[edit.end - 1]!,
      replacement_lines: [...edit.lines],
    };
  }
  return { anchor: anchors[edit.start - 1]!, direction: edit.direction, lines: [...edit.lines] };
}

const FIXED_CASES: Array<{ id: string; content: string; edits: EditSpec[] }> = [
  {
    id: "trailing-blank",
    content: "a\n\n",
    edits: [
      { kind: "insert", start: 2, end: 2, direction: "after", lines: ["y"] },
      { kind: "replace", start: 1, end: 1, lines: ["X"] },
    ],
  },
  {
    id: "eof-delete-before-insert",
    content: "a\n\nb",
    edits: [
      { kind: "replace", start: 3, end: 3, lines: [] },
      { kind: "insert", start: 1, end: 1, direction: "after", lines: ["x"] },
    ],
  },
  {
    id: "blank-pair-and-expand",
    content: "a\nb\n",
    edits: [
      { kind: "insert", start: 2, end: 2, direction: "before", lines: [""] },
      { kind: "insert", start: 2, end: 2, direction: "after", lines: ["z", ""] },
      { kind: "replace", start: 1, end: 1, lines: ["a", "x"] },
    ],
  },
];

describe("batch vs solo equivalence", () => {
  it("produces byte-identical results to sequential solo edits for non-overlapping multi-edit messages", async () => {
    await withTempDir("pi-hashline-batch-solo-", async (dir) => {
      resetRegistryForTests();
      resetBatchStateForTests();
      await initRegistry(undefined);
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd: dir, ui: { notify() {} } } as any;
      const readTool = getTool("read");
      const replaceTool = getTool("replace");
      const insertTool = getTool("insert");
      const batchPath = join(dir, "batch.txt");
      const soloPath = join(dir, "solo.txt");

      const runCase = async (id: string, content: string, edits: EditSpec[]): Promise<void> => {
        await writeFile(batchPath, content, "utf-8");
        await writeFile(soloPath, content, "utf-8");
        const batchRead = await readTool.execute(`br-${id}`, { path: "batch.txt" }, undefined, undefined, ctx);
        const soloRead = await readTool.execute(`sr-${id}`, { path: "solo.txt" }, undefined, undefined, ctx);
        const batchAnchors = anchorsFromRead(getText(batchRead));
        const soloAnchors = anchorsFromRead(getText(soloRead));
        expect(batchAnchors, id).toHaveLength(splitLines(content).length);
        expect(soloAnchors, id).toHaveLength(splitLines(content).length);

        const calls = edits.map((edit, index) => toolCall(`b${id}-${index}`, edit.kind, argsFor(edit, batchAnchors)));
        await planAssistantMessage(assistantMessage(calls), dir);
        for (const call of calls) {
          const tool = call.name === "replace" ? replaceTool : insertTool;
          await tool.execute(call.id, call.arguments, undefined, undefined, ctx);
        }
        await finalizeTurn(calls.map((call) => call.id));

        for (let index = 0; index < edits.length; index += 1) {
          const edit = edits[index]!;
          const tool = edit.kind === "replace" ? replaceTool : insertTool;
          await tool.execute(`s${id}-${index}`, argsFor(edit, soloAnchors), undefined, undefined, ctx);
        }

        const batchResult = await readFile(batchPath, "utf-8");
        const soloResult = await readFile(soloPath, "utf-8");
        expect(soloResult, id).toBe(batchResult);
      };

      for (const fixed of FIXED_CASES) {
        await runCase(fixed.id, fixed.content, fixed.edits);
      }

      let compared = 0;
      for (let iter = 0; iter < 300 && compared < 120; iter += 1) {
        const rnd = mulberry32(iter * 2654435761 + 11);
        const content = randContent(rnd);
        const lineCount = splitLines(content).length;
        if (lineCount < 2) continue;
        const edits = randEdits(rnd, lineCount);
        if (edits.length < 2) continue;
        if (projectedLineCount(lineCount, edits) <= 0) continue;
        await runCase(`r${iter}`, content, edits);
        compared += 1;
      }
      expect(compared).toBeGreaterThanOrEqual(60);
    });
  }, 180_000);
});
