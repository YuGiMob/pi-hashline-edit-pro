import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { lineHashes, resEdits, applyEdits } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("indentation difference in boundary warning", () => {
  it("warns on leading duplication when indentation matches exactly (duplicate kept)", async () => {
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  bar"] },
    ]));
    // Duplicate is kept (not auto-fixed) — "  foo" appears twice
    expect(result.content).toBe("  foo\n  foo\n  bar\n  baz");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with"))).toBe(true);
  });

  it("warns on leading duplication when both indentation and content match exactly (duplicate kept)", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  foo", "  new"] },
    ]));
    // Duplicate is kept
    expect(result.content).toBe("  foo\n  foo\n  new\n  baz");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with"))).toBe(true);
  });
});
