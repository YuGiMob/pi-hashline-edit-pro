import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	parseText,
	AnchorMismatchError,
	hashSource,
} from "../../src/hashline";
import { splitLines } from "../../src/utils";
import { useTestHome } from "../support/fixtures";
const home = useTestHome();

describe("strict hashline contract", () => {
	it("preserves internal spaces when hashing", async () => {
		const hashes = await lineHashes("a b", home.testPath);
		const hashes2 = await lineHashes("ab", home.testPath);
		expect(hashes[0]).not.toBe(hashes2[0]);
	});

	it("trims trailing spaces when hashing", async () => {
		const hashes = await lineHashes("value  ", home.testPath);
		const hashes2 = await lineHashes("value", home.testPath);
		expect(hashes[0]).toBe(hashes2[0]);
	});

	it("preserves explicit blank trailing line in array input", () => {
		expect(parseText(["alpha", ""])).toEqual(["alpha", ""]);
		expect(parseText(["alpha", "", ""])).toEqual(["alpha", "", ""]);
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
		const stale = {
      hash_bounds: [{ hash: "ZZZZ" }, { hash: "ZZZZ" }], content_lines: ["updated"],
    } as any;
		expect(() => applyEdit(content, stale)).toThrow(/stale anchor/);
	});
});

describe("perfect hashing", () => {
	it("returns one hash per line, indexed 0-based by line number", async () => {
		const hashes = await lineHashes("alpha\nbeta\ngamma", home.testPath);
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toMatch(/^[A-Za-z0-9]{3}$/);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9]{3}$/);
		expect(hashes[2]).toMatch(/^[A-Za-z0-9]{3}$/);
	});

	it("assigns different hashes to identical content at different positions", async () => {
		const file = [
			"import { foo } from 'bar';",
			"import { baz } from 'qux';",
			"import { foo } from 'bar';",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		expect(hashes[0]).not.toBe(hashes[2]);
		expect(hashes[0]).not.toBe(hashes[1]);
		expect(hashes[1]).not.toBe(hashes[2]);
	});

	it("assigns different hashes to symbol-only lines at different positions", async () => {
		const file = [
			"function a() {",
			"  return 1;",
			"}",
			"function b() {",
			"  return 2;",
			"}",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		expect(hashes[2]).not.toBe(hashes[5]);
	});

	it("lets the edit tool target a specific occurrence when content is duplicated", async () => {
		const file = [
			"const x = 1;",
			"const y = 2;",
			"const x = 1;",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		const result = applyEdit(file, { hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[2]! }], content_lines: ["const x = 999;"] });
    expect(result.content).toBe("const x = 1;\nconst y = 2;\nconst x = 999;");
	});

	it("stale-anchor error shows the file's current state for context", () => {
		const file = ["const x = 1;", "const y = 2;", "const x = 1;"].join("\n");
		const staleHash = "ZZZZ";
		let caught: Error | undefined;
		try {
			applyEdit(file, { hash_bounds: [{ hash: staleHash }, { hash: staleHash }], content_lines: ["X"] });
    } catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
		expect(caught!.message).toContain("Call read()");
	});

	it("rejects an ambiguous hash with [E_AMBIGUOUS_ANCHOR] (synthetic collision)", async () => {
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = await lineHashes(file, home.testPath);
		const forgedHashes = [...realHashes];
		forgedHashes[2] = realHashes[0]!;

		const sharedHash = realHashes[0]!;

		let caught: Error | undefined;
		try {
			applyEdit(
				file,
				{ hash_bounds: [{ hash: sharedHash }, { hash: sharedHash }], content_lines: ["X"] },
				undefined,
				forgedHashes,
			);
    } catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_AMBIGUOUS_ANCHOR/);
		expect(caught!.message).toMatch(/matches lines 1, 3/);
		expect(caught!.message).toContain(`${realHashes[0]!}│alpha`);
		expect(caught!.message).toContain(`${realHashes[0]!}│gamma`);
	});

	it("carries the candidate hashes of ambiguous feedback for serving", async () => {
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = await lineHashes(file, home.testPath);
		const forgedHashes = [...realHashes];
		forgedHashes[2] = realHashes[0]!;

		let caught: unknown;
		try {
			applyEdit(
				file,
				{ hash_bounds: [{ hash: realHashes[0]! }, { hash: realHashes[0]! }], content_lines: ["X"] },
				undefined,
				forgedHashes,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AnchorMismatchError);
		expect((caught as AnchorMismatchError).feedbackHashes).toContain(realHashes[0]!);
	});

	it("all hashes are unique for any file shape", async () => {
		const files = [
			"",
			"\n",
			"a",
			"a\n",
			"a\nb\nc",
			"a\nb\nc\n",
			"}\n}\n}\n}\n}",
			"import x\nimport y\nimport x",
			"a\n".repeat(1000),
			Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
		];
		for (const file of files) {
			const hashes = await lineHashes(file, home.testPath);
			const unique = new Set(hashes);
			expect(
				unique.size,
				`Failed for file with ${file.split("\n").length} lines`
			).toBe(hashes.length);
		}
	});

	it("hash array length matches line count for edge cases", async () => {
		const cases = ["", "\n", "a", "a\n", "a\nb\nc\n"];
		for (const file of cases) {
			const hashes = await lineHashes(file, home.testPath);
			expect(hashes).toHaveLength(splitLines(file).length);
		}
	});
});

describe("long-line hash source", () => {
	it("hashes a line longer than 500 bytes from its first 500 bytes", async () => {
		const head = "const data = '" + "x".repeat(600);
		const h1 = await lineHashes(head + "AAA';", home.testPath);
		const h2 = await lineHashes(head + "BBB';", home.testPath);
		expect(h1[0]).toBe(h2[0]);
	});

	it("still assigns unique anchors to long lines sharing the first 500 bytes", async () => {
		const head = "const a = '" + "x".repeat(600);
		const file = head + "AAA';\n" + head + "BBB';\n";
		const hashes = await lineHashes(file, home.testPath);
		expect(hashes[0]).not.toBe(hashes[1]);
	});

	it("keeps hashing lines under 500 bytes from the full line", async () => {
		const h1 = await lineHashes("const x = 'aaa';", home.testPath);
		const h2 = await lineHashes("const x = 'aab';", home.testPath);
		expect(h1[0]).not.toBe(h2[0]);
	});

	it("keeps the anchor of a long line whose tail changed outside the edited range", async () => {
		const head = "const data = '" + "x".repeat(600);
		const oldContent = `aaa\n${head}OLD_TAIL';\nccc\n`;
		const newContent = `aaa\n${head}NEW_TAIL';\nccc\n`;
		const oldHashes = await lineHashes(oldContent, home.testPath);
		const newHashes = await lineHashes(newContent, home.testPath, {
			content: oldContent,
			hashes: oldHashes,
			removedHashes: new Set([oldHashes[0]!]),
		});
		expect(newHashes[1]).toBe(oldHashes[1]);
		expect(newHashes[0]).toBe(oldHashes[0]);
		expect(newHashes[2]).toBe(oldHashes[2]);
	});

	it("truncates a multibyte line at a code-point boundary", async () => {
		const source = hashSource("😀".repeat(300));
		expect(Buffer.byteLength(source, "utf-8")).toBeLessThanOrEqual(500);
		expect(source.isWellFormed()).toBe(true);
	});

	it("hashes multibyte lines from the same 500-byte prefix", async () => {
		const head = "😀".repeat(125);
		const h1 = await lineHashes(head + "AAA';", home.testPath);
		const h2 = await lineHashes(head + "BBB';", home.testPath);
		expect(h1[0]).toBe(h2[0]);
	});
});
