/**
 * Parser dispatcher.
 *
 * Maps file extensions to the appropriate parser, maintaining a shared
 * tree-sitter parser manager for WASM-based grammars.
 */

import type { SymbolInfo } from "../types.ts";
import {
  detectLanguage,
  languageLabel,
  parseCode,
  parseFileImports,
  type ImportInfo,
} from "./manager.ts";

export { detectLanguage, languageLabel, parseFileImports };
export type { ImportInfo };

export interface ParseFileResult {
  symbols: SymbolInfo[];
  language: string | null;
  languageName: string;
  hasError?: boolean;
}

/**
 * Parse a source file's content and extract structural symbols.
 * Returns empty symbols array if language is unsupported or parsing fails.
 */
export async function parseSourceFile(
  filePath: string,
  content: string,
): Promise<ParseFileResult> {
  const lang = detectLanguage(filePath);

  if (!lang) {
    return { symbols: [], language: null, languageName: "Unknown" };
  }

  try {
    const { symbols, hasError } = await parseCode(lang, content);
    return { symbols, language: lang, languageName: languageLabel(lang), hasError };
  } catch (err) {
    console.warn(
      `[codebase-reader] Parse failed for ${filePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { symbols: [], language: lang, languageName: languageLabel(lang) };
  }
}

/**
 * Extract import statements from a source file.
 * Returns empty array if language is unsupported or parsing fails.
 */
export async function extractFileImports(
  filePath: string,
  content: string,
): Promise<ImportInfo[]> {
  const lang = detectLanguage(filePath);

  if (!lang) {
    return [];
  }

  try {
    return await parseFileImports(lang, content);
  } catch (err) {
    console.warn(
      `[codebase-reader] Import parse failed for ${filePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
