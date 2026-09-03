import { describe, expect, it } from "vitest";
import { parseText, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("ATIm");
		expect(ref).toEqual({ hash: "ATIm" });
	});

	it("rejects trailing content after the anchor", () => {
		expect(() => parseHashRef("ATIm:const x = 1;")).toThrow(
			/Expected a 4-char alphanumeric anchor/,
		);
	});

	it("rejects a full anchor│content line copied into remove_from/remove_to", () => {
		expect(() => parseHashRef("ATIm│const x = 1;")).toThrow(
			/use only the 4-char anchor, drop everything from "│" onward/,
		);
	});
	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		expect(() => parseHashRef(">>> ATIm")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: anchor only)", () => {
		expect(() => parseHashRef("+ATIm")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-ATIm")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-#ATIm")).toThrow(/E_BAD_REF/);
	});

	it("rejects - and _ anywhere in the anchor (not in the alphabet)", () => {
		expect(() => parseHashRef("-qka")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-_-_")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("----")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("Has_")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("Has-")).toThrow(/E_BAD_REF/);
	});

	it("rejects + as a hash body character (not in alphabet)", () => {
		expect(() => parseHashRef("+qka")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#+qka")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5Hasu")).toThrow(
			/Use the anchor alone/,
		);
	});

	it("rejects wrong-length anchors", () => {
		expect(() => parseHashRef("Ha")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("HasuX")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#HasuX")).toThrow(/E_BAD_REF/);
	});

	it("rejects anchors with invalid alphabet", () => {
		expect(() => parseHashRef("!@#")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("parseText", () => {
	it("rejects null with a clear error", () => {
		expect(() => parseText(null as unknown as string[])).toThrow(/^\[E_BAD_SHAPE\].*must be an array of strings/);
	});

	it("rejects a single string input with clear error (must use array)", () => {
		expect(() => parseText("a\nb" as unknown as string[])).toThrow(
			/must be an array of strings/,
		);
	});

	it("passes an array through as lines", () => {
		expect(parseText(["a", "b"])).toEqual(["a", "b"]);
	});

	it("returns [] for empty array (delete range)", () => {
		expect(parseText([])).toEqual([]);
	});

	it("treats a trailing empty element as an extra blank line", () => {
		expect(parseText(["a", "b", ""])).toEqual(["a", "b", ""]);
	});

	it("represents [\"\"] as one blank line", () => {
		expect(parseText([""])).toEqual([""]);
	});

	it("represents [\"\", \"\"] as two blank lines", () => {
		expect(parseText(["", ""])).toEqual(["", ""]);
	});

	it("splits elements containing embedded newlines and reports a warning", () => {
		const warnings: string[] = [];
		expect(parseText(["a\r\nb\rc"], warnings)).toEqual(["a", "b", "c"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/contained embedded newlines/);
	});

	it("does not warn when no element contains embedded newlines", () => {
		const warnings: string[] = [];
		parseText(["a", "b"], warnings);
		expect(warnings).toHaveLength(0);
	});

	it("preserves '# keep me' comment lines (no autocorrection)", () => {
		expect(parseText(["# keep me"])).toEqual(["# keep me"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(parseText(["+added"])).toEqual(["+added"]);
	});

	it("passes through diff-preview rows verbatim (marker stripping happens in applyEdit)", () => {
		expect(parseText(["+ATIm│foo", "+xYp│bar"])).toEqual(["+ATIm│foo", "+xYp│bar"]);
		expect(parseText([" ATIm│keep", "-10    old", " xYp│after"])).toEqual([" ATIm│keep", "-10    old", " xYp│after"]);
		expect(parseText([" ATIm│keep", "-   │old", " xYp│after"])).toEqual([" ATIm│keep", "-   │old", " xYp│after"]);
		expect(parseText(["-ATIm│old", "- ATIm│old"])).toEqual(["-ATIm│old", "- ATIm│old"]);
	});

	it("passes through numbered deletion rows as literal content", () => {
		expect(parseText(["-10    old"])).toEqual(["-10    old"]);
	});

	it("accepts literal minus-prefixed content that is not a diff row", () => {
		expect(parseText(["-   something", "-abc", "- old style"])).toEqual(["-   something", "-abc", "- old style"]);
	});
});

describe("parseText json-envelope autocorrect", () => {
	it("unwraps a JSON-array-wrapped element from a mis-serialized tool call and warns", () => {
		const warnings: string[] = [];
		expect(parseText(['["  "version": "2.8.4","].'], warnings)).toEqual(['  "version": "2.8.4",']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/JSON array syntax/);
	});

	it("leaves valid JSON array lines alone", () => {
		const warnings: string[] = [];
		expect(parseText(['["a", "b"]'], warnings)).toEqual(['["a", "b"]']);
		expect(warnings).toHaveLength(0);
	});

	it("leaves valid JSON array lines with a trailing dot alone when they parse", () => {
		const warnings: string[] = [];
		expect(parseText(['["a", "b"].'], warnings)).toEqual(['["a", "b"].']);
		expect(warnings).toHaveLength(0);
	});

	it("unwraps a single-string wrapper with a trailing dot and decodes escapes", () => {
		const warnings: string[] = [];
		expect(parseText(['["tab\\tend"].'], warnings)).toEqual(["tab\tend"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/JSON array syntax/);
	});

	it("unwraps a single-string wrapper without escapes", () => {
		const warnings: string[] = [];
		expect(parseText(['["hello"].'], warnings)).toEqual(["hello"]);
		expect(warnings).toHaveLength(1);
	});
});
