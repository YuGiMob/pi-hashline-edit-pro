import { readFileSync } from "node:fs";
import { errCode } from "./utils";

export interface Guideline {
  id: string;
  text: string;
}

const GUIDELINE_IDS_BY_NAME: Record<string, readonly string[]> = {
  "read-guidelines.md": ["read-reread", "read-outline", "read-match-served"],
  "outline-guidelines.md": ["outline-first", "outline-span-start"],
  "replace-guidelines.md": ["replace-disjoint", "replace-deletion", "replace-single-line"],
  "replace-match-guidelines.md": ["replace-match-fragment", "replace-match-wide-range", "replace-match-whole-range", "replace-match-isolated"],
  "insert-guidelines.md": ["insert-blank-edges"],
  "copy-guidelines.md": ["copy-single-anchor"],
  "move-guidelines.md": ["move-same-place"],
  "transfer-guidelines.md": ["transfer-boundary-serving", "transfer-same-file", "transfer-cross-file", "transfer-batch-move"],
  "grep-guidelines.md": ["grep-literal"],
  "undo-last-change-guidelines.md": ["undo-single-level", "undo-write-clears", "undo-cross-file-move"],
};

export function loadP(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8").trim();
}

export function loadGuide(relativePath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(new URL(relativePath, import.meta.url), "utf-8");
  } catch (error) {
    if (errCode(error) === "ENOENT") {
      console.warn(`hashline: missing prompt file ${relativePath}; continuing without those guidelines`);
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

export function loadGuidelines(relativePath: string): Guideline[] {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const ids = GUIDELINE_IDS_BY_NAME[name];
  if (ids === undefined) throw new Error(`[E_REGISTRY] No guideline ids are registered for ${relativePath}.`);
  const texts = loadGuide(relativePath);
  if (texts.length === 0) return [];
  if (texts.length !== ids.length) {
    console.warn(`hashline: ${relativePath} holds ${texts.length} guideline(s) but declares ${ids.length}; gating may be wrong`);
  }
  return ids.flatMap((id, index) => {
    const text = texts[index];
    return text === undefined ? [] : [{ id, text }];
  });
}
