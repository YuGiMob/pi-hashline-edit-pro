import { describe, expect, it } from "vitest";
import { loadP, loadGuide } from "../../src/prompts";
describe("loadP", () => {
	it("loads a prompt file", () => {
		const prompt = loadP("../prompts/read-snippet.md");
		expect(prompt).toBeTruthy();
		expect(typeof prompt).toBe("string");
	});

	it("trims whitespace", () => {
		const prompt = loadP("../prompts/read-snippet.md");
		expect(prompt).toBe(prompt.trim());
	});

	it("loads prompt without template variables", () => {
		const prompt = loadP("../prompts/read.md");
		expect(prompt).toBeTruthy();
		expect(prompt).toContain("anchor│content");
	});

	it("handles missing replacements gracefully", () => {
		const prompt = loadP("../prompts/read.md");
		expect(prompt).toBeTruthy();
	});

	it("loads read.md without template variables (condensed description no longer needs DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES)", () => {
		const raw = loadP("../prompts/read.md");
		expect(raw).toContain("anchor│content");
		expect(raw).not.toContain("{{");
	});
});

describe("loadGuide", () => {
	it("loads guidelines as array", () => {
		const guidelines = loadGuide("../prompts/read-guidelines.md");
		expect(Array.isArray(guidelines)).toBe(true);
		expect(guidelines.length).toBeGreaterThan(0);
	});

	it("filters lines starting with dash", () => {
		const guidelines = loadGuide("../prompts/read-guidelines.md");
		for (const guideline of guidelines) {
			expect(guideline).not.toMatch(/^- /);
		}
	});

	it("returns non-empty strings", () => {
		const guidelines = loadGuide("../prompts/read-guidelines.md");
		for (const guideline of guidelines) {
			expect(guideline.length).toBeGreaterThan(0);
		}
	});
});
