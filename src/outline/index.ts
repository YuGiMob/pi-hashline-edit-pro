import { visLines } from "../utils.ts";
import { loadOutlineParser } from "./parsers.ts";
import { renderPreviewOutline, renderSymbolOutline, type OutlineRender } from "./render.ts";

export interface FileOutlineInput {
	displayPath: string;
	content: string;
	hashes: string[];
	maxRows?: number;
	maxDepth?: number;
	maxBytes?: number;
	previewHeadLines?: number;
	previewTailLines?: number;
}

export async function buildFileOutline(input: FileOutlineInput): Promise<OutlineRender> {
	const lines = visLines(input.content);
	const parser = await loadOutlineParser();
	const parsed = parser === undefined ? undefined : await parser.parse(input.displayPath, input.content);
	if (parsed !== undefined && parsed.symbols.length > 0) {
		const outline = renderSymbolOutline({
			displayPath: input.displayPath,
			languageName: parsed.languageName,
			totalLines: lines.length,
			hashes: input.hashes,
			lines,
			symbols: parsed.symbols,
			...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
			...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
			...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
		});
		return parsed.hasSyntaxErrors ? { ...outline, hasSyntaxErrors: true } : outline;
	}
	const preview = renderPreviewOutline({
		displayPath: input.displayPath,
		lines,
		hashes: input.hashes,
		...(input.previewHeadLines !== undefined ? { headLines: input.previewHeadLines } : {}),
		...(input.previewTailLines !== undefined ? { tailLines: input.previewTailLines } : {}),
		...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
	});
	if (lines.length === 0) return preview;
	return { ...preview, preview: parsed === undefined ? "unsupported" : "no-symbols", ...(parsed?.hasSyntaxErrors ? { hasSyntaxErrors: true } : {}) };
}

export { loadOutlineParser } from "./parsers.ts";
export { renderPreviewOutline, renderSymbolOutline } from "./render.ts";
export type { OutlineParse, OutlineParser, OutlineSymbol } from "./parsers.ts";
export type { OutlineRender, OutlineRow } from "./render.ts";
