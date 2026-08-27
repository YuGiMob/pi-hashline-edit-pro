import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import { buildNoop, buildChanged } from "../../src/replace-response";
import { lineHashes } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("buildNoop", () => {
  it("returns noop result with classification", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("No changes made to test.txt");
    expect(result.details.patch).toBe("");
    expect(result.details.classification).toBe("noop");
    expect(result.details.metrics!.edits_attempted).toBe(1);
  });

  it("includes noop edit details when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old" },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Replacement for ABC");
    expect(result.content[0].text).toContain("ABC");
  });

  it("includes warnings when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: ["Warning 1"],
    });
    expect(result.details.metrics!.warnings).toBe(1);
    expect(result.content[0].text).toContain("Warnings:");
    expect(result.content[0].text).toContain("Warning 1");
  });

  it("clips long currentContent in noop details", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old\n".repeat(300) },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Replacement for ABC");
    expect(result.content[0].text).not.toContain("old\n".repeat(300));
    expect(result.content[0].text).toContain("...");
  });
  it("notes boundary dedup removals in the noop message", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old" },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
      boundaryRemovedLines: 1,
    });
    expect(result.content[0].text).toContain("Boundary dedup removed 1 line(s) from the replacement");
    expect(result.content[0].text).toContain("Send the same edit again to apply it literally");
  });
  it("omits the dedup note when nothing was removed", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old" },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).not.toContain("Boundary dedup removed");
  });
});

describe("buildChanged", () => {
  it("returns applied result with diff and metrics", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Successfully replaced in test.txt");
    expect(output.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(output.details.metrics!.classification).toBe("applied");
    expect(output.details.metrics!.edits_attempted).toBe(1);
    expect(output.details.metrics!.changed_lines).toEqual({ first: 2, last: 2 });
  });

  it("includes a standard unified patch that round-trips", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    const patch = output.details.patch!;
    expect(patch).toContain("--- test.txt");
    expect(patch).toContain("+++ test.txt");
    expect(patch).toContain("@@");
    expect(patch).toContain("-bbb");
    expect(patch).toContain("+BBB");
    expect(applyPatch(original, patch)).toBe(result);
  });

  it("includes warnings when provided", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: ["Boundary duplication (leading)"],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Warnings:");
    expect(output.content[0].text).toContain("Boundary duplication (leading)");
  });

  it("shows empty file message when result is empty", async () => {
    const original = "aaa\nbbb\n";
    const result = "";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 1, lastChangedLine: 2, addedLines: 0, removedLines: 2 },
    });
    expect(output.content[0].text).toBe("File is empty. Use replace to insert content.");
  });

  it("computes added_lines and removed_lines from editMeta", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nCCC\nDDD\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 4, addedLines: 3, removedLines: 2 },
    });
    expect(output.details.metrics!.added_lines).toBe(3);
    expect(output.details.metrics!.removed_lines).toBe(2);
    expect(output.content[0].text).toContain("Added 3 line(s), removed 2 line(s).");
  });

  it("handles no changed lines gracefully", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nbbb\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, firstChangedLine: undefined, lastChangedLine: undefined, addedLines: 0, removedLines: 0 },
    });
    expect(output.details.metrics!.added_lines).toBe(0);
    expect(output.details.metrics!.removed_lines).toBe(0);
  });

  it("shows exactly one context line above and below the change in the diff", async () => {
    const original = "aaa\nbbb\nccc\nddd\neee\n";
    const result = "aaa\nbbb\nCCC\nddd\neee\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 3, lastChangedLine: 3, addedLines: 1, removedLines: 1 },
    });
    const diff = output.details.diff!;
    expect(diff).toContain("│bbb");
    expect(diff).toContain("│CCC");
    expect(diff).toContain("│ddd");
    expect(diff).not.toContain("│aaa");
    expect(diff).not.toContain("│eee");
  });
});
