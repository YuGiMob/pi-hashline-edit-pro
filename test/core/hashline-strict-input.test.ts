import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	resEdit,
	type HTEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit input validation", () => {
	it("strips bare HASH| prefix in content with warning", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdit: HTEdit = { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: [`${hashes[0]!}│FOO`] };
    const result = applyEdit(file, resEdit(toolEdit));
		expect(result.content).toBe("FOO\nbar");
		expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
		expect(result.warnings?.[0]).toMatch(/replacement_lines line 1/);
	});

	it("rejects a single string replacement_lines before patch-prefix validation", () => {
		const toolEdit: HTEdit = {
      remove_from: "ZZZ",
      remove_to: "ZZZ", replacement_lines: "+ZZZ:foo",
    } as unknown as HTEdit;
    expect(() => resEdit(toolEdit)).toThrow(
      /must be an array of strings/i,
    );
	});

	it("passes through numbered deletion rows as literal content", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_lines: ["-1    foo"] };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["-1    foo"]);
	});

	it("accepts plain literal content unchanged", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_lines: ["bar"] };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_lines: ["# keep me"] };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("strips a bare prefix that matches an existing file line hash", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`${betaHash}│### heading`, `real content`] },
    hashes);
    expect(result.content).toBe("### heading\nreal content\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
    expect(result.warnings?.[0]).not.toMatch(/Verify/);
	});

	it("strips a bare prefix whose hash exists in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`${gammaHash}│text`] },
    hashes);
    expect(result.content).toBe("text\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
	});

	it("strips bare prefixes even when the hash is not in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["ZZZ│one", "ZZP│two"] },
    hashes);
    expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
    expect(result.warnings?.[0]).toMatch(/Verify it was pasted from read output/);
	});

	it("reports the replacement_lines line for each stripped line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["ZZZ│one", "real", "ZZP│two"] },
    hashes);
    expect(result.content).toBe("one\nreal\ntwo\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/replacement_lines line 1, replacement_lines line 3/);
	});

	it("keeps indentation after the separator while dropping leading prefix whitespace", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`  ${hashes[1]!}│  indented`] },
    hashes);
    expect(result.content).toBe("  indented\nbeta\ngamma\ndelta");
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["TS: TypeScript"] },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["# heading"] },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("strips prefixes from long lines without truncation", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const longLine = `${betaHash}│${"y".repeat(500)}`;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [longLine] },
    hashes);
    expect(result.content).toContain("y".repeat(500));
    expect(result.content).not.toContain("│");
	});
});

describe("diff preview rows copied into content", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("strips +HASH│ addition rows with warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`+${hashes[1]!}│### heading`, `real content`] },
    hashes);
		expect(result.content).toBe("### heading\nreal content\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
		expect(result.warnings?.[0]).toMatch(/replacement_lines line 1/);
	});

	it("strips -HASH│ and -   │ deletion rows with warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`-${hashes[1]!}│one`, `-   │two`] },
    hashes);
		expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/replacement_lines line 1, replacement_lines line 2/);
	});

	it("leaves numbered deletion rows as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["-1    foo"] },
    hashes);
		expect(result.content).toBe("-1    foo\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves plain +x / -x unified-diff lines as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["+added", "-removed"] },
    hashes);
		expect(result.content).toBe("+added\n-removed\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});
});

describe("diff-prefix false-positive guards (tightened shapes)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("leaves literal '+ HASH│' content with a space after the plus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`+ ${hashes[1]!}│one`] },
    hashes);
		expect(result.content).toBe(`+ ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '- HASH│' content with a space after the minus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`- ${hashes[1]!}│one`] },
    hashes);
		expect(result.content).toBe(`- ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '+ abc│' / '- xyz│' lines untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: ["+ abc│def", "- xyz│uvw"] },
    hashes);
		expect(result.content).toBe("+ abc│def\n- xyz│uvw\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("still strips exact +HASH│ rows without a space", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`+${hashes[1]!}│one`] },
    hashes);
		expect(result.content).toBe("one\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
	});

	it("still strips exact -HASH│ and -   │ rows", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_lines: [`-${hashes[1]!}│one`, `-   │two`] },
    hashes);
		expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
	});
});

describe("truncated hash prefixes copied into content (issue #27)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("strips a 2-char prefix copied from read output", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["L3│                        }"] },
			hashes);
		expect(result.content).toBe("                        }\nbeta\ngamma\ndelta");
		expect(result.content).not.toContain("│");
		expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
		expect(result.warnings?.[0]).toMatch(/Verify it was pasted from read output/);
	});

	it("strips a 1-char prefix pasted from read output", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["a│one"] },
			hashes);
		expect(result.content).toBe("one\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
	});

	it("strips truncated +HASH│ and -HASH│ diff rows with warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["+L3│one", "-L3│two"] },
			hashes);
		expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
	});

	it("strips a 4-char prefix pasted from read output", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["abcd│literal"] },
			hashes);
		expect(result.content).toBe("literal\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
		expect(result.warnings?.[0]).toMatch(/Verify it was pasted from read output/);
	});

	it("leaves a 7-char run before the separator as literal content", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["abcdefg│literal"] },
			hashes);
		expect(result.content).toBe("abcdefg│literal\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves a run followed by a space before the separator untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
			{ remove_from: anchor,
			remove_to: anchor, replacement_lines: ["L3 │literal"] },
			hashes);
		expect(result.content).toBe("L3 │literal\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("strips a truncated row prefix pasted into remove_from/remove_to", () => {
		const warnings: string[] = [];
		expect(() =>
			resEdit(
				{ remove_from: "L3│   }", remove_to: "L3│   }", replacement_lines: ["x"] },
				warnings,
			),
		).toThrow(/E_BAD_REF/);
		expect(warnings[0]).toMatch(/Stripped "anchor│" prefix/);
	});
});
