import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide, loadP } from "../../src/prompts";
import { withReadPrompts, withReplacePrompts, withInsertPrompts, DEFAULT_EDIT_FLAGS } from "../../src/edit-common";
import { regRead } from "../../src/read";
import { makeFakePiRegistry } from "../support/fixtures";

const replaceBase = {
  description: loadP("../prompts/replace.md"),
  snippet: loadP("../prompts/replace-snippet.md"),
  guidelines: loadGuide("../prompts/replace-guidelines.md"),
};

const insertBase = {
  description: loadP("../prompts/insert.md"),
  snippet: loadP("../prompts/insert-snippet.md"),
  guidelines: loadGuide("../prompts/insert-guidelines.md"),
};

const readBase = {
  description: loadP("../prompts/read.md"),
  snippet: loadP("../prompts/read-snippet.md"),
  guidelines: loadGuide("../prompts/read-guidelines.md"),
};

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const replacePrompt = readFileSync(
  new URL("../../prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("declares the tool purpose", () => {
    expect(replacePrompt).toMatch(/Replace a range of lines \(or a single line\) in a text file.*anchors/);
  });
});

const readPrompt = readFileSync(
  new URL("../../prompts/read.md", import.meta.url),
  "utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
  it("declares the HASH|content output format", () => {
    expect(readPrompt).toMatch(/anchor│content/);
    expect(readPrompt).toMatch(/4-character/);
  });

  it("specifies the alphanumeric anchor alphabet", () => {
    expect(readPrompt).toMatch(/4-character/);
    expect(readPrompt).toContain("alphanumeric");
  });

  it("documents pagination support", () => {
    expect(readPrompt).toContain("offset/limit");
  });

  it("documents file-kind handling", () => {
    expect(readPrompt).toMatch(/Images/);
    expect(readPrompt).toMatch(/binary/i);
    expect(readPrompt).toMatch(/directory/);
  });
});

describe("prompt guidelines", () => {
  it("replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("remove_from");
    expect(content).toContain("remove_to");
    expect(content).toContain("replacement_lines");
    expect(content).not.toContain("hash_bounds");
    expect(content).not.toContain("new_content");
    expect(content).not.toContain("{{");
  });

  it("loadGuide returns an array of guidelines", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md");
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);
  });

  it("read-guidelines.md keeps the re-read note inline", () => {
    const content = readFileSync(
      new URL("../../prompts/read-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("call again after an edit");
    expect(content).not.toContain("{{AUTO_READ_NOTE}}");
  });
  it("undo-last-change-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/undo-last-change-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("{{");
  });
});

describe("read tool guidelines", () => {
  it("always includes the re-read note for fresh anchors after edits", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi);
    const tool = getTool("read");
    const guidelines = tool.promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("call again after an edit"))).toBe(true);
    expect(guidelines.some((g) => g.includes("call before `replace`"))).toBe(true);
  });
});

describe("prompt file packaging", () => {
  it("every loadP/loadGuide reference resolves to a prompt file shipped in the package", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("prompts");
    expect(pkg.files).toContain("src");

    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    let refs = 0;
    for (const file of collectTsFiles(srcDir)) {
      const content = readFileSync(file, "utf-8");
      for (const match of content.matchAll(/load(?:P|Guide)\("((?:\.\.\/)+prompts\/[^"]+)"\)/g)) {
        refs++;
        const promptPath = match[1]!;
        expect(existsSync(resolve(dirname(file), promptPath))).toBe(true);
      }
    }
    expect(refs).toBeGreaterThan(0);
  });
});

describe("edit prompt flag variants", () => {
  it("withReplacePrompts adds the require-path contract", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true });
    expect(result.description).toContain("Also give `path` matching the file the anchors were served for");
    expect(result.snippet).toContain("; include `path` (required)");
    expect(result.guidelines.some((g) => g.includes("include `path` matching the file the anchors were served for"))).toBe(true);
  });

  it("withReplacePrompts adds the strict-input notice", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, strictInput: true });
    expect(result.description).toContain("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
    expect(result.guidelines.some((g) => g.includes("strict-input is on"))).toBe(true);
  });

  it("withReplacePrompts adds the boundary-dedup-off notice", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, boundaryDedupEnabled: false });
    expect(result.description).toContain("Boundary dedup is off: edits apply literally.");
    expect(result.guidelines.some((g) => g.includes("boundary dedup is off"))).toBe(true);
  });

  it("withReplacePrompts drops the diff-follow hint when auto-read is off", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(result.description).not.toContain("Anchor follow-up edits on the `+anchor│`");
    expect(result.guidelines.some((g) => g.includes("one batch per file per turn; verify each result"))).toBe(true);
  });

  it("withInsertPrompts adds the require-path and strict-input notices", () => {
    const result = withInsertPrompts(insertBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.description).toContain("Also give `path` matching the file the anchor was served for");
    expect(result.snippet).toContain("; include `path` (required)");
    expect(result.guidelines.some((g) => g.startsWith("`insert`: include `path`"))).toBe(true);
    expect(result.description).toContain("Strict-input mode is on");
    expect(result.guidelines.some((g) => g.includes("strict-input is on"))).toBe(true);
  });

  it("withReadPrompts keeps guidelines unchanged when auto-read is on", () => {
    const result = withReadPrompts(readBase, DEFAULT_EDIT_FLAGS);
    expect(result.description).toBe(readBase.description);
    expect(result.snippet).toBe(readBase.snippet);
    expect(result.guidelines).toEqual(readBase.guidelines);
  });

  it("withReadPrompts rewrites the re-read note when auto-read is off", () => {
    const result = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(result.guidelines.some((g) => g === "`read`: call again after an edit when you need anchors you lack.")).toBe(true);
  });
});
