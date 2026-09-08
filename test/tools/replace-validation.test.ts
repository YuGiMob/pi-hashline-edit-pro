import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/replace";
import { useTestHome } from "../support/fixtures";

useTestHome();

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("allows an optional path hint for require-path mode", () => {
    expect(() => assertReq({ path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] }))
      .not.toThrow();
  });

	it("throws for a passed file_path", () => {
		expect(() => assertReq({ file_path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws when replacement_lines present but no remove_from/remove_to", () => {
    expect(() => assertReq({ replacement_lines: ["a"] }))
      .toThrow(/remove_from/);
  });

  it("throws when remove_from/remove_to present but no replacement_lines", () => {
    expect(() => assertReq({ remove_from: "ATIm", remove_to: "BeSR" }))
      .toThrow(/replacement_lines/);
  });

  it("throws when neither edit field is present", () => {
    expect(() => assertReq({}))
      .toThrow(/remove_from/);
  });

  it("accepts the top-level edit shape", () => {
    expect(() => assertReq({
      remove_from: "ATIm", remove_to: "BeSR",
      replacement_lines: ["new"],
    })).not.toThrow();
  });

	it("throws for request without edits", () => {
		expect(() => assertReq({})).toThrow("[E_BAD_SHAPE]");
	});
});

describe("anchor validation order", () => {
	it("rejects malformed anchors before any file I/O", async () => {
		const tool = buildToolDef();
		await expect(
			tool.execute(
				"e1",
				{
					remove_from: "abc", remove_to: "abc",
					replacement_lines: ["x"],
				},
				undefined,
				undefined,
				{ cwd: "/tmp" } as any,
			),
		).rejects.toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("prepareArguments normalization", () => {
	it("passes through non-record input unchanged", () => {
		const tool = buildToolDef();
		expect(tool.prepareArguments!(null)).toBe(null);
		expect(tool.prepareArguments!("raw")).toBe("raw");
	});

	it("passes replacement_lines through as an array", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			remove_from: "ATIm", remove_to: "BeSR",
			replacement_lines: ["line1", "line2"],
		}) as Record<string, unknown>;
		expect(prepared.replacement_lines).toEqual(["line1", "line2"]);
	});
});
