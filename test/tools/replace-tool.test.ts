import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { editToolSchema, regReplace } from "../../src/replace";
import { makeFakePiRegistry, withTempFile, useTestHome } from "../support/fixtures";
const home = useTestHome();

describe("editToolSchema", () => {
  it("has path, remove_from, remove_to, and replacement_lines at top level", () => {
    const schema = editToolSchema as any;
    expect(schema.type).toBe("object");
    const props = schema.properties;
    expect(props.path).toBeDefined();
    expect(props.remove_from).toBeDefined();
    expect(props.remove_to).toBeDefined();
    expect(props.replacement_lines).toBeDefined();
    expect(props.changes).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("regReplace", () => {
  it("registers a tool named 'replace'", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("replace");
    expect(tool.parameters).toBe(editToolSchema);
  });

  it("prepareArguments normalizes file_path to path", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    const result = tool.prepareArguments({
      file_path: "test.txt",
      remove_from: "ATIm", remove_to: "BeSR",
      replacement_lines: ["new"],
    });
    expect(result.path).toBe("test.txt");
    expect(result.file_path).toBeUndefined();
  });



  it("replaces a single line via execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("replaces a range of lines via execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", home.testPath);

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          remove_from: hashes[1]!, remove_to: hashes[2]!,
          replacement_lines: ["BeSR", "DAfo"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");
    });
  });

  it("deletes a line via execute (empty content_lines)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 0 line(s), removed 1 line(s).");
    });
  });

  it("reports noop when content is unchanged", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["bbb"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("No changes made to sample.txt");
      expect(result.details.classification).toBe("noop");
    });
  });

  it("rejects stale anchors with [E_STALE_ANCHOR]", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");

      await expect(
        tool.execute(
          "e1",
          {
            path: "sample.txt",
            remove_from: "PyBY", remove_to: "PyBY",
            replacement_lines: ["x"],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("rejects deleting an entire non-empty file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\n", home.testPath);

      await expect(
        tool.execute(
          "e1",
          {
            path: "sample.txt",
            remove_from: hashes[0]!, remove_to: hashes[1]!,
            replacement_lines: [],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });

  it("rejects unknown fields at top level via schema validation", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      await expect(
        tool.execute(
          "e1",
          {
            path: "sample.txt",
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            replacement_lines: ["BeSR"],
            unknown_field: "bad",
          } as any,
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_BAD_SHAPE/);
    });
  });

  it("reports metrics with edits_attempted = 1", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details.metrics.edits_attempted).toBe(1);
      expect(result.details.metrics.classification).toBe("applied");
    });
  });

  it("preserves CRLF line endings", async () => {
    await withTempFile("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

      await tool.execute(
        "e1",
        {
          path: "crlf.txt",
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
    });
  });
});
