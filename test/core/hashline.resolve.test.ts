import { describe, expect, it } from "vitest";
import {
	resEdit,
	type Anchor,
	type HTEdit,
} from "../../src/hashline";

describe("resEdit", () => {
	it("resolves replace with remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "wpDM", remove_to: "ukAB", replacement_lines: ["a", "b"] };
		const resolved = resEdit(edit);
		expect(resolved).toHaveProperty("hash_bounds");
		expect(resolved).toHaveProperty("content_lines");
	});

	it("resolves a 1-line replace (same anchor)", () => {
		const edit: HTEdit = { remove_from: "riBB", remove_to: "riBB", replacement_lines: ["new"] };
		const resolved = resEdit(edit);
		const r = resolved as {
			hash_bounds: [Anchor, Anchor];
      content_lines: string[];
		};
		expect(r.hash_bounds[0].hash).toBe("riBB");
		expect(r.hash_bounds[1].hash).toBe("riBB");
	});

	it("throws on replace with no remove_from/remove_to (E_BAD_SHAPE)", () => {
    const edit = { replacement_lines: ["new"] } as any;
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_SHAPE\]/);
	});

	it("throws on malformed remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "not-valid", remove_to: "not-valid", replacement_lines: ["x"] };
		expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
	});

  it("rejects a single string replacement_lines input", () => {
    const edit = {
      remove_from: "wpDM", remove_to: "wpDM",
      replacement_lines: "hello",
    } as unknown as HTEdit;
    expect(() => resEdit(edit)).toThrow(
      /must be an array of strings/i,
    );
  });

  it("passes replacement_lines through as content lines", () => {
    const edit = {
      remove_from: "wpDM", remove_to: "wpDM",
      replacement_lines: ["line1", "line2", ""],
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["line1", "line2", ""]);
  });

  it("splits elements with embedded newlines in replacement_lines", () => {
    const edit = {
      remove_from: "wpDM", remove_to: "wpDM",
      replacement_lines: ["a\r\nb", "c"],
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["a", "b", "c"]);
  });

	it("rejects null replacement_lines input", () => {
		const edit = {
			remove_from: "wpDM", remove_to: "wpDM",
      replacement_lines: null,
		} as unknown as HTEdit;
		expect(() => resEdit(edit)).toThrow(
      /must be an array of strings/i,
		);
	});

	it("rejects unknown fields", () => {
    const edit = { remove_from: "wpDM", remove_to: "wpDM", replacement_lines: ["x"], extra: true } as any;
		expect(() => resEdit(edit)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing replacement_lines", () => {
		const edit = { remove_from: "wpDM", remove_to: "wpDM" } as any;
		expect(() => resEdit(edit)).toThrow(
      /requires a "replacement_lines" array/i,
		);
	});

	it("strips an anchor│content row pasted into remove_from/remove_to with a warning", () => {
		const edit: HTEdit = { remove_from: "riBB│const x = 1;", remove_to: "riBB│const x = 1;", replacement_lines: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("riBB");
		expect(resolved.hash_bounds[1].hash).toBe("riBB");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatch(/^\[E_BAD_REF\]/);
		expect(warnings[0]).toContain('Stripped "anchor│" prefix');
		expect(warnings[0]).toContain("remove_from/remove_to entry");
	});

	it("strips diff-preview rows pasted into remove_from/remove_to with a warning", () => {
		const edit: HTEdit = { remove_from: "+riBB│const x = 1;", remove_to: "-riBB│const x = 1;", replacement_lines: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("riBB");
		expect(resolved.hash_bounds[1].hash).toBe("riBB");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("diff-preview marker");
		expect(warnings[1]).toContain('leading "-" marker');
	});

	it("leaves bare anchors untouched and emits no warning", () => {
		const edit: HTEdit = { remove_from: "riBB", remove_to: "riBB", replacement_lines: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("riBB");
		expect(warnings).toHaveLength(0);
	});

	it("still rejects rows without a leading hash", () => {
		const edit: HTEdit = { remove_from: "│const x = 1;", remove_to: "riBB", replacement_lines: ["new"] };
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_REF\]/);
	});
});
