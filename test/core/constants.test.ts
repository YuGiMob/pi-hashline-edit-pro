import { describe, expect, it } from "vitest";
import {
	MAX_HASH_SOURCE_BYTES,
	MAX_GREP_LINE_BYTES,
	MAX_OVERSIZED_WARNING_LINES,
	SNIFF_BYTES,
} from "../../src/constants";

describe("constants", () => {
	it("MAX_HASH_SOURCE_BYTES is a positive number", () => {
		expect(MAX_HASH_SOURCE_BYTES).toBeGreaterThan(0);
		expect(typeof MAX_HASH_SOURCE_BYTES).toBe("number");
	});

	it("MAX_GREP_LINE_BYTES is a positive number", () => {
		expect(MAX_GREP_LINE_BYTES).toBeGreaterThan(0);
		expect(typeof MAX_GREP_LINE_BYTES).toBe("number");
	});

	it("MAX_OVERSIZED_WARNING_LINES is a positive number", () => {
		expect(MAX_OVERSIZED_WARNING_LINES).toBeGreaterThan(0);
		expect(typeof MAX_OVERSIZED_WARNING_LINES).toBe("number");
	});

	it("SNIFF_BYTES is a positive number", () => {
		expect(SNIFF_BYTES).toBeGreaterThan(0);
		expect(typeof SNIFF_BYTES).toBe("number");
	});
});
