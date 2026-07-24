import { describe, expect, it } from "vitest";
import { applyEdits, resEdits, _lineHashesPure } from "../../src/hashline";

describe("boundary duplication [W_DUP] warning", () => {
  it("emits [W_DUP] warning for trailing duplication (content_lines ends with surviving line)", () => {
    // Model replaces lines 1-2, content_lines last non-empty line "after" matches next surviving "after"
    const file = "before\nline1\nline2\nafter\n";
    const hashes = _lineHashesPure(file);

    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["new1", "new2", "after"] },
    ]));

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("ends with") && w.includes("after"))).toBe(true);
    // Content should NOT have been auto-fixed — the duplicate "after" stays
    expect(result.content).toContain("new2\nafter\nafter");
  });

  it("emits [W_DUP] warning for leading duplication (content_lines starts with preceding line)", () => {
    const file = "before\nline1\nline2\nafter\n";
    const hashes = _lineHashesPure(file);

    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["before", "new1", "new2"] },
    ]));

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("starts with") && w.includes("before"))).toBe(true);
    // Content should NOT have been auto-fixed — "before" stays duplicated
    expect(result.content).toContain("before\nbefore\nnew1");
  });

  it("does not emit [W_DUP] when there is no boundary match", () => {
    const file = "before\nline1\nline2\nafter\n";
    const hashes = _lineHashesPure(file);

    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["new1", "new2"] },
    ]));

    expect(result.warnings?.some(w => w.startsWith("[W_DUP]")) ?? false).toBe(false);
  });

  it("emits both trailing and leading [W_DUP] warnings when both boundaries match", () => {
    const file = "before\nline1\nline2\nafter\n";
    const hashes = _lineHashesPure(file);

    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[2]!], content_lines: ["before", "new1", "after"] },
    ]));

    const dupWarnings = result.warnings?.filter(w => w.startsWith("[W_DUP]")) ?? [];
    expect(dupWarnings).toHaveLength(2);
  });

  it("warns for trailing } (structural delimiter)", () => {
    // Two consecutive } at same indent — model includes one, next surviving is also }
    const file = "if (a) {\n  x();\n}\n}\n";
    const hashes = _lineHashesPure(file);

    // Replace x() line, model includes } for the if block
    // Next surviving line is also } (the outer closer) — warns
    const result = applyEdits(file, resEdits([
      { hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["  z();", "}"] },
    ]));

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.startsWith("[W_DUP]") && w.includes("}"))).toBe(true);
    // The } is kept (not silently stripped)
    expect(result.content).toContain("  z();\n}\n}\n}");
  });
});
