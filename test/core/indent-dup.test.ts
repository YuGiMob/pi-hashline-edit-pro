import { describe, expect, it } from "vitest";
import { lineHashes, resEdit, applyEdit } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("indentation difference in boundary auto-fix", () => {
  it("auto-fixes leading duplication when indentation matches exactly", async () => {
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["  foo", "  bar"] },
      ),
      undefined,
      hashes,
    );
    expect(result.content).toBe("  foo\n  bar\n  baz");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("auto-fixes leading duplication when both indentation and content match exactly", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["  foo", "  new"] },
      ),
      undefined,
      hashes,
    );
    expect(result.content).toBe("  foo\n  new\n  baz");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });
});
