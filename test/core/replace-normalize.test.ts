import { describe, expect, it } from "vitest";
import { normReq } from "../../src/payload-contract";

describe("normReq", () => {
	it("returns non-record input as-is", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq(42)).toBe(42);
		expect(normReq(undefined)).toBe(undefined);
	});

	it("returns object input unchanged when no normalization needed", () => {
		const input = {
			path: "src/main.ts",
			remove_from: "aB3", remove_to: "aB3",
			replacement_lines: ["new"],
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", remove_from: "AAA", remove_to: "BBB", replacement_lines: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", remove_from: "AAA", remove_to: "BBB", replacement_lines: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("original.txt");
	});

	it("ignores file_path when path is already a string", () => {
		const input = {
			path: "src/main.ts",
			file_path: "other.ts",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBe("other.ts");
	});

	it("preserves other fields", () => {
		const input = { path: "test.txt", remove_from: "AAA", remove_to: "BBB", replacement_lines: ["new"], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "AAA", remove_to: "BBB",
			replacement_lines: ["x"],
		};
		const originalFilePath = input.file_path;
		const originalNewContent = input.replacement_lines;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.replacement_lines).toBe(originalNewContent);
	});
});

describe("normReq - top-level shape", () => {
	it("keeps remove_from/remove_to and replacement_lines at top level", () => {
		const input = {
			path: "test.txt",
			remove_from: "AAA", remove_to: "BBB",
			replacement_lines: ["new line"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("AAA");
		expect(result.remove_to).toEqual("BBB");
		expect(result.replacement_lines).toEqual(["new line"]);
	});

	it("handles flat format with file_path alias", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "AAA", remove_to: "BBB",
			replacement_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.remove_from).toEqual("AAA");
		expect(result.remove_to).toEqual("BBB");
	});

	it("does not mutate the original flat-format input", () => {
		const input = {
			path: "test.txt",
			remove_from: "AAA", remove_to: "BBB",
			replacement_lines: ["new"],
		};
		const origFrom = input.remove_from;
		const origTo = input.remove_to;
		const origNc = input.replacement_lines;
		normReq(input);
		expect(input.remove_from).toBe(origFrom);
		expect(input.remove_to).toBe(origTo);
		expect(input.replacement_lines).toBe(origNc);
	});
});
