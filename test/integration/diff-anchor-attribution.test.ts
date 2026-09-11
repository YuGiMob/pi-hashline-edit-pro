import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, extractHash } from "../support/fixtures";

function minusAnchors(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("-")) continue;
    const match = /^-([A-Za-z0-9]{4})│/.exec(line);
    out.push(match ? match[1]! : "(blank)");
  }
  return out;
}

function liveAnchors(diff: string): Set<string> {
  const live = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") && !line.startsWith(" ")) continue;
    const match = /^[+ ]([A-Za-z0-9]{4})│/.exec(line);
    if (match) live.add(match[1]!);
  }
  return live;
}

describe("diff anchor attribution on duplicate lines", () => {
  it("prints true removed anchors on - rows with no live string shared", async () => {
    await withTempFile("odd-ide.txt", "alpha one\n  }\nbeta two\n  }\ngamma three\n  }\ndelta four", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead: any = await readTool.execute("r1", { path: "odd-ide.txt" }, undefined, undefined, ctx);
      const text1: string = firstRead.content[0].text;
      const dupRows = text1.split("\n").filter((line: string) => line.includes("│  }"));
      expect(dupRows).toHaveLength(3);
      const D2 = extractHash(dupRows[1]!);
      const D3 = extractHash(dupRows[2]!);
      const gammaRow = text1.split("\n").find((line: string) => line.includes("│gamma three"))!;
      const G = extractHash(gammaRow);
      const raw = await readFile(path, "utf-8");
      const prepend = Array.from({ length: 6 }, (_, index) => `IDE line ${index + 1}`).join("\n") + "\n";
      await writeFile(path, prepend + raw, "utf-8");
      const editResult: any = await editTool.execute("e1", { remove_from: D2, remove_to: G, replacement_lines: ["REPLACED"] }, undefined, undefined, ctx);
      const diff: string = editResult.details?.diff ?? "";
      expect(diff.length).toBeGreaterThan(0);
      const removed = minusAnchors(diff);
      const live = liveAnchors(diff);
      const shared = removed.filter((anchor) => anchor !== "(blank)" && live.has(anchor));
      expect(shared).toEqual([]);
      expect(removed).toContain(D2);
      expect(removed).toContain(G);
      expect(diff.split("\n").find((line) => line.startsWith("-") && line.includes(D3))).toBeUndefined();
      await expect(editTool.execute("e-dead", { remove_from: D2, remove_to: D2, replacement_lines: ["VIA_DEAD"] }, undefined, undefined, ctx)).rejects.toThrow(/E_STALE_ANCHOR/);
      const survivorEdit: any = await editTool.execute("e-live", { remove_from: D3, remove_to: D3, replacement_lines: ["VIA_SURVIVOR"] }, undefined, undefined, ctx);
      expect(survivorEdit.content[0].text).toContain("Successfully replaced");
      const finalContent = await readFile(path, "utf-8");
      expect(finalContent).toContain("REPLACED");
      expect(finalContent).toContain("VIA_SURVIVOR");
    });
  });

  it("keeps batch diffs anchored to true spans across duplicate runs", async () => {
    await withTempFile("dup-batch.txt", "top\n  }\nmid-a\n  }\nmid-b\n  }\nbottom", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const firstRead: any = await readTool.execute("r1", { path: "dup-batch.txt" }, undefined, undefined, ctx);
      expect(firstRead.content[0].text.split("\n").filter((line: string) => line.includes("│  }"))).toHaveLength(3);
    });
  });
});
