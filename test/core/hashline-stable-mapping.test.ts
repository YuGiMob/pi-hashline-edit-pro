import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();


describe("mapStableHashes - identity and simple changes", () => {
  it("preserves all hashes when content is unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);

    const result = await lineHashes(content, home.testPath, {
      content,
      hashes,
    });

    expect(result).toEqual(hashes);
  });

  it("preserves hashes when appending lines at the end", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc\nd\ne";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[1]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result).toHaveLength(5);
    expect(result[3]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[4]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).not.toBe(oldHashes[0]);
    expect(result[4]).not.toBe(oldHashes[1]);
  });

  it("preserves hashes when prepending lines at the beginning", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "x\ny\nz\na\nb\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[2]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).toBe(oldHashes[0]);
    expect(result[4]).toBe(oldHashes[1]);
    expect(result[5]).toBe(oldHashes[2]);
  });

  it("preserves hashes when inserting lines in the middle", async () => {
    const oldContent = "a\nb\ne\nf";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc\nd\ne\nf";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[1]);
    expect(result[2]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[4]).toBe(oldHashes[2]);
    expect(result[5]).toBe(oldHashes[3]);
  });

  it("preserves hashes when deleting lines (no duplicates)", async () => {
    const oldContent = "a\nb\nc\nd\ne";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nc\ne";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[2]);
    expect(result[2]).toBe(oldHashes[4]);
    expect(result).toHaveLength(3);
  });

  it("preserves hashes when replacing a line with different content", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nX\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).not.toBe(oldHashes[1]);
  });
});

describe("mapStableHashes - multiple changes combined", () => {
  it("handles simultaneous insert, delete, and modify", async () => {
    const oldContent = "a\nb\nc\nd\ne";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nc\nx\nD\ne";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[2]);
    expect(result[2]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).not.toBe(oldHashes[3]);
    expect(result[4]).toBe(oldHashes[4]);
  });

  it("handles deleting the first and last lines", async () => {
    const oldContent = "a\nb\nc\nd";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "b\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(oldHashes[1]);
    expect(result[1]).toBe(oldHashes[2]);
  });

  it("handles replacing the entire content with completely different lines", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "x\ny\nz";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(3);
    for (const hash of result) {
      expect(oldHashes).not.toContain(hash);
    }
  });
});

describe("mapStableHashes - edge cases", () => {
  it("handles empty old content (starting from scratch)", async () => {
    const oldContent = "";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(3);
    for (const hash of result) {
      expect(hash).toMatch(/^[A-Za-z0-9]{4}$/);
    }
  });

  it("handles single-line old content becoming multi-line", async () => {
    const oldContent = "a";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[2]).toMatch(/^[A-Za-z0-9]{4}$/);
  });

  it("handles multi-line old content becoming single-line", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "b";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(oldHashes[1]);
  });

  it("handles content with only newlines", async () => {
    const oldContent = "\n\n\n";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "\n\n\n\n";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[1]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[3]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[3]).not.toBe(oldHashes[0]);
  });

  it("handles content with carriage returns (\\r\\n)", async () => {
    const oldContent = "a\r\nb\r\nc\r\n";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc\nd";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[1]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[3]).toMatch(/^[A-Za-z0-9]{4}$/);
  });
});

describe("mapStableHashes - removedHashes edge cases", () => {
  it("ignores removedHashes entries that don't exist in old content", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set(["ZZZ", "YYY"]),
    });

    expect(result).toEqual(oldHashes);
  });

  it("works correctly with empty removedHashes set", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nX\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set(),
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).not.toBe(oldHashes[1]);
  });

  it("works correctly with undefined removedHashes", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nX\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).not.toBe(oldHashes[1]);
  });

  it("removedHashes causes a different content match to be selected for duplicate lines", async () => {
    const oldContent = "a\nb\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const firstBHash = oldHashes[1]!;
    const secondBHash = oldHashes[2]!;
    expect(firstBHash).not.toBe(secondBHash);

    const newContent = "a\nb\nc";
    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([firstBHash]),
    });

    expect(result[1]).toBe(secondBHash);
  });

  it("removedHashes with all candidates removed reuses the first removed hash for identical re-insertion", async () => {
    const oldContent = "a\nb\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const firstBHash = oldHashes[1]!;
    const secondBHash = oldHashes[2]!;
    expect(firstBHash).not.toBe(secondBHash);

    const newContent = "a\nb\nc";
    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([firstBHash, secondBHash]),
    });

    expect(result[1]).toBe(firstBHash);
  });

  it("re-inserting identical text reuses the removed line's hash", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nX\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([oldHashes[0]!]),
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toMatch(/^[A-Za-z0-9_-]{4}$/);
    expect(result[1]).not.toBe(oldHashes[0]);
    expect(result[1]).not.toBe(oldHashes[1]);
    expect(result[1]).not.toBe(oldHashes[2]);
    expect(result[2]).toBe(oldHashes[2]);
  });

  it("removedHashes with duplicate lines and content-map miss on a different line", async () => {
    const oldContent = "a\nb\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const firstBHash = oldHashes[1]!;
    const secondBHash = oldHashes[2]!;

    const newContent = "a\nb\nX\nc";
    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([firstBHash]),
    });

    expect(result[1]).toBe(secondBHash);
    expect(result[2]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[2]).not.toBe(firstBHash);
    expect(result[2]).not.toBe(secondBHash);
    expect(result[3]).toBe(oldHashes[3]);
  });

  it("re-inserting identical text at the same position keeps its hash", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nX\nc";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set(oldHashes.slice(0, 2)),
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).not.toBe(oldHashes[0]);
    expect(result[1]).not.toBe(oldHashes[1]);
    expect(result[2]).toBe(oldHashes[2]);
  });

  it("an edited range never takes a hash from a line outside it", async () => {
    const oldContent = "alpha\nreturn {\n  foo\n}\nbeta\nreturn {\n  foo\n}\nomega\n";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    expect(oldHashes[1]).not.toBe(oldHashes[5]);

    const newContent = "alpha\nreturn {\n  foo\nNEW\n}\nbeta\nreturn {\n  foo\n}\nomega\n";
    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set(oldHashes.slice(1, 4)),
    });

    expect(result[1]).toBe(oldHashes[1]);
    expect(result[2]).toBe(oldHashes[2]);
    expect(result[4]).toBe(oldHashes[3]);
    expect(result[6]).toBe(oldHashes[5]);
    expect(result[7]).toBe(oldHashes[6]);
    expect(result[8]).toBe(oldHashes[7]);
    expect(result[5]).toBe(oldHashes[4]);
    expect(result[9]).toBe(oldHashes[8]);
  });

  it("does not reuse a removed anchor across trailing-whitespace variants", async () => {
    const oldContent = "a  \nb\na";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const spacedHash = oldHashes[0]!;
    const plainHash = oldHashes[2]!;

    const result = await lineHashes("a\na", home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([oldHashes[0]!, oldHashes[1]!]),
    });

    expect(result[1]).toBe(plainHash);
    expect(result[0]).not.toBe(spacedHash);
  });

  it("does not reuse a removed plain anchor onto a spaced line", async () => {
    const oldContent = "a\na  \nb";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const spacedHash = oldHashes[1]!;
    const plainHash = oldHashes[0]!;

    const result = await lineHashes("a  \na  ", home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([oldHashes[0]!, oldHashes[2]!]),
    });

    expect(result[1]).toBe(spacedHash);
    expect(result[0]).not.toBe(plainHash);
  });
});

describe("mapStableHashes - hash uniqueness guarantees", () => {
  it("produces unique hashes for all lines in the result", async () => {
    const oldContent = "a\nb\nc\nd\ne";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "x\na\nz\nc\ny\ne\nw";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it("reuses the same hash for lines with the same canonical form despite different trailing whitespace", async () => {
    const oldContent = "x  \ny";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "x\ny";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[1]);
  });
});

describe("mapStableHashes - ordering and position stability", () => {
  it("preserves hashes when lines are reordered", async () => {
    const oldContent = "a\nb\nc";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "c\na\nb";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[2]);
    expect(result[1]).toBe(oldHashes[0]);
    expect(result[2]).toBe(oldHashes[1]);
  });

  it("preserves hashes when a line appears multiple times in new content", async () => {
    const oldContent = "a\nb";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\na\nb";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(result[1]).not.toBe(oldHashes[0]);
    expect(result[2]).toBe(oldHashes[1]);
  });

  it("preserves hashes when a line appears fewer times in new content", async () => {
    const oldContent = "a\na\nb";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = "a\nb";

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result[0]).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(oldHashes.slice(0, 2)).toContain(result[0]);
    expect(result[1]).toBe(oldHashes[2]);
  });
});

describe("mapStableHashes - nearest-candidate selection", () => {
  it("prefers the nearest surviving candidate when closer ones are removed", async () => {
    const oldContent = "x\nx\nx\nx\nx";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const removedHashes = new Set(oldHashes.slice(1, 4));

    const result = await lineHashes("x\nx", home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(oldHashes[0]);
    expect(result[1]).toBe(oldHashes[4]);
  });

  it("breaks index ties toward the earlier line", async () => {
    const oldContent = "dup\ndup\ndup";
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const result = await lineHashes("dup", home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(oldHashes[0]);
  });

  it("reuses the first removed hash when every candidate is removed", async () => {
    const oldContent = "same\nsame";
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const removedHashes = new Set(oldHashes);

    const result = await lineHashes("same", home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(oldHashes[0]);
  });

  it("keeps uniqueness when interleaving duplicates and removed candidates", async () => {
    const oldContent = Array.from({ length: 2_000 }, (_, i) =>
      i % 2 === 0 ? "dup" : `u${i}`,
    ).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const removedHashes = new Set(
      oldHashes.filter((_, i) => i % 4 === 0),
    );

    const newLines = Array.from({ length: 1_500 }, (_, i) =>
      i % 2 === 0 ? "dup" : `n${i}`,
    );
    const result = await lineHashes(newLines.join("\n"), home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes,
    });

    expect(result).toHaveLength(1_500);
    expect(new Set(result).size).toBe(1_500);
    const reinserted = result.filter((hash) => removedHashes.has(hash));
    expect(reinserted).toHaveLength(250);
    const survivors = result.filter((hash) => !removedHashes.has(hash));
    expect(survivors).toHaveLength(1_250);
  }, 120_000);

  it("keeps an untouched line's hash when the replacement contains identical content nearer to its old position", async () => {
    const oldContent = ["a", "b", "c", "}", "d", "e"].join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const untouchedHash = oldHashes[3]!;
    const newContent = ["}", "x", "y", "z", "w", "v", "}", "d", "e"].join("\n");

    const result = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
      removedHashes: new Set([oldHashes[0]!, oldHashes[1]!, oldHashes[2]!]),
    });

    expect(result[6]).toBe(untouchedHash);
    expect(result[0]).not.toBe(untouchedHash);
  });
});
