import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeRe = /\[(?:E|W)_[A-Z0-9_]+\]/g;

function collectCodes(dir: string): Set<string> {
  const codes = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const code of collectCodes(full)) codes.add(code);
    } else if (entry.name.endsWith(".ts")) {
      for (const match of readFileSync(full, "utf-8").matchAll(codeRe)) {
        codes.add(match[0]);
      }
    }
  }
  return codes;
}

const readmeCodes = new Set([
  ...readFileSync(join(root, "README.md"), "utf-8").matchAll(codeRe),
].map((match) => match[0]));
const srcCodes = collectCodes(join(root, "src"));

describe("error code contract", () => {
  it("documents every error code emitted by src in the README", () => {
    const undocumented = [...srcCodes].filter((code) => !readmeCodes.has(code)).sort();
    expect(undocumented).toEqual([]);
  });

  it("emits every error code documented in the README", () => {
    const phantom = [...readmeCodes].filter((code) => !srcCodes.has(code)).sort();
    expect(phantom).toEqual([]);
  });
});
