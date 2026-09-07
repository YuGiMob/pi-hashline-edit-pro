import { describe, expect, it } from "vitest";
import { lineHashes, applyEdit, type HEdit } from "../../src/hashline";
import { useTestHome, withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

const home = useTestHome();

describe("stable hashing with duplicate content lines", () => {
  it("removing the first of two identical lines preserves the second line's hash", async () => {
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, home.testPath);

    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;
    expect(firstBraceHash).not.toBe(secondBraceHash);

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[0]! }, { hash: firstBraceHash }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, home.testPath);
    const newContent = result.content;
    expect(newContent).toBe("\nfunction b() {\n  return 2;\n}\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
    });

    expect(resultHashes[3]).toBe(secondBraceHash);
  });

  it("removing the second of two identical lines preserves the first line's hash", async () => {
    const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const hashes = await lineHashes(content, home.testPath);

    const firstBraceHash = hashes[2]!;
    const secondBraceHash = hashes[6]!;

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[4]! }, { hash: secondBraceHash }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, home.testPath);
    const newContent = result.content;
    expect(newContent).toBe("function a() {\n  return 1;\n}\n\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
    });

    expect(resultHashes[2]).toBe(firstBraceHash);
  });

  it("removing a unique line between two identical lines preserves both brace hashes", async () => {
    const content = "a\n}\nb\n}\nc\n}\nd\n";
    const hashes = await lineHashes(content, home.testPath);

    const brace1 = hashes[1]!;
    const brace2 = hashes[3]!;
    const brace3 = hashes[5]!;
    expect(new Set([brace1, brace2, brace3]).size).toBe(3);

    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[2]! }],
      content_lines: [],
    };

    const result = applyEdit(content, edit, undefined, hashes, home.testPath);
    const newContent = result.content;
    expect(newContent).toBe("a\n}\n}\nc\n}\nd\n");

    const resultHashes = await lineHashes(newContent, home.testPath, {
      content,
      hashes,
    });

    expect(resultHashes[1]).toBe(brace1);
    expect(resultHashes[2]).toBe(brace2);
    expect(resultHashes[4]).toBe(brace3);
  });

  it("end-to-end via tool: removing one of two identical lines preserves the correct hash", async () => {
    const file = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const firstBraceHash = extractHash(lines1.find((l) => l.includes("│}"))!);
      const braceLines = lines1.filter((l) => l.endsWith("│}"));
      expect(braceLines).toHaveLength(2);
      const secondBraceHash = extractHash(braceLines[1]!);
      expect(firstBraceHash).not.toBe(secondBraceHash);

      const line1Hash = extractHash(lines1.find((l) => l.includes("│function a()"))!);
      await editTool.execute(
        "e1",
        {
          remove_from: line1Hash,
          remove_to: firstBraceHash,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBrace = lines2.find((l) => l.endsWith("│}"))!;
      expect(survivingBrace).toBeTruthy();
      const survivingHash = extractHash(survivingBrace);
      expect(survivingHash).toBe(secondBraceHash);
    });
  });

  it("end-to-end via tool: interior duplicate line (not a boundary) keeps its hash", async () => {
    const file = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(2);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      expect(firstBHash).not.toBe(secondBHash);

      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);

      await editTool.execute(
        "e1",
        {
          remove_from: aHash,
          remove_to: cHash,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingB = lines2.find((l) => l.endsWith("│b"))!;
      expect(survivingB).toBeTruthy();
      const survivingHash = extractHash(survivingB);
      expect([firstBHash, secondBHash]).toContain(survivingHash);
    });
  });

  it("end-to-end via tool: sequential edits with interior duplicates preserves all surviving hashes", async () => {
    const file = "a\nb\nc\nb\nd\ne\nb\nf\n";
    await withTempFile("sample.ts", file, async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const read1 = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines1 = getText(read1).split("\n");

      const bLines = lines1.filter((l) => l.endsWith("│b"));
      expect(bLines).toHaveLength(3);
      const firstBHash = extractHash(bLines[0]!);
      const secondBHash = extractHash(bLines[1]!);
      const thirdBHash = extractHash(bLines[2]!);
      expect(new Set([firstBHash, secondBHash, thirdBHash]).size).toBe(3);

      const aHash = extractHash(lines1.find((l) => l.endsWith("│a"))!);
      const cHash = extractHash(lines1.find((l) => l.endsWith("│c"))!);
      const dHash = extractHash(lines1.find((l) => l.endsWith("│d"))!);
      const eHash = extractHash(lines1.find((l) => l.endsWith("│e"))!);

      await editTool.execute(
        "e1",
        {
          remove_from: aHash,
          remove_to: cHash,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      await editTool.execute(
        "e2",
        {
          remove_from: dHash,
          remove_to: eHash,
          replacement_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      const read2 = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines2 = getText(read2).split("\n");
      const survivingBLines = lines2.filter((l) => l.endsWith("│b"));
      expect(survivingBLines).toHaveLength(2);
      const survivingHashes = survivingBLines.map(extractHash);
      const survivingOriginal = survivingHashes.filter((hash) => [firstBHash, secondBHash, thirdBHash].includes(hash));
      expect(survivingOriginal.length).toBeGreaterThanOrEqual(2);
      expect(new Set(survivingHashes).size).toBe(2);
    });
  });
});
