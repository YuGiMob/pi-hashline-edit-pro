import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { HASH_SEP } from "../hashline/index.ts";
import { clipLine } from "../utils.ts";
import type { OutlineSymbol } from "./parsers.ts";

const DEFAULT_MAX_ROWS = 400;
const DEFAULT_MAX_DEPTH = 6;
const PREVIEW_HEAD_LINES = 20;
const PREVIEW_TAIL_LINES = 10;
const PREVIEW_LINE_CHARS = 200;

function formatMoreLines(count: number): string {
	return `... (${count} more ${count === 1 ? "line" : "lines"})`;
}

export interface OutlineRow {
	line: number;
	anchor: string;
	text: string;
}

export interface OutlineRender {
	text: string;
	rows: OutlineRow[];
	servedHashes: string[];
	truncated: boolean;
	complete: boolean;
	preview?: "unsupported" | "no-symbols";
	hasSyntaxErrors?: boolean;
}

export interface SymbolOutlineInput {
	displayPath: string;
	languageName?: string;
	totalLines: number;
	hashes: string[];
	lines: string[];
	symbols: OutlineSymbol[];
	maxRows?: number;
	maxDepth?: number;
	maxBytes?: number;
}

export interface PreviewOutlineInput {
	displayPath: string;
	lines: string[];
	hashes: string[];
	headLines?: number;
	tailLines?: number;
	maxBytes?: number;
}

interface OutlineBudget {
	output: string[];
	rows: OutlineRow[];
	servedHashes: string[];
	maxRows: number;
	maxBytes: number;
	bytes: number;
	truncated: boolean;
	truncation?: "rows" | "bytes";
	skipped: number;
}

function startBudget(header: string, maxRows: number, maxBytes: number): OutlineBudget {
	return { output: [header], rows: [], servedHashes: [], maxRows, maxBytes, bytes: Buffer.byteLength(header, "utf-8") + 1, truncated: false, skipped: 0 };
}

function pushLine(budget: OutlineBudget, text: string): boolean {
	const size = Buffer.byteLength(text, "utf-8") + 1;
	if (budget.bytes + size > budget.maxBytes) return false;
	budget.bytes += size;
	budget.output.push(text);
	return true;
}

function markTruncated(budget: OutlineBudget, cause: "rows" | "bytes"): void {
	budget.truncated = true;
	if (budget.truncation === undefined) budget.truncation = cause;
}

function isComplete(budget: OutlineBudget): boolean {
	return !budget.truncated && budget.skipped === 0 && budget.servedHashes.length === budget.rows.length;
}

type EmitOutcome = "emitted" | "skipped" | "stopped";

function emitRow(budget: OutlineBudget, hashes: string[], lines: string[], line: number, text: string): EmitOutcome {
	const anchor = hashes[line - 1];
	if (anchor === undefined) {
		budget.skipped += 1;
		return "skipped";
	}
	if (budget.rows.length >= budget.maxRows) {
		markTruncated(budget, "rows");
		return "stopped";
	}
	if (!pushLine(budget, `${anchor}${HASH_SEP}${text}`)) {
		markTruncated(budget, "bytes");
		return "stopped";
	}
	budget.rows.push({ line, anchor, text });
	if (text === (lines[line - 1] ?? "")) budget.servedHashes.push(anchor);
	return "emitted";
}

function countSymbolRows(
	symbols: OutlineSymbol[],
	depth: number,
	maxDepth: number,
	hashes: string[],
	seenLines: Set<number>,
): number {
	let total = 0;
	for (const symbol of symbols) {
		const children = symbol.children ?? [];
		if (seenLines.has(symbol.startLine)) {
			if (children.length > 0 && depth < maxDepth) total += countSymbolRows(children, depth + 1, maxDepth, hashes, seenLines);
			continue;
		}
		seenLines.add(symbol.startLine);
		if (hashes[symbol.startLine - 1] !== undefined) total += 1;
		if (children.length === 0 || depth >= maxDepth) continue;
		total += countSymbolRows(children, depth + 1, maxDepth, hashes, seenLines);
	}
	return total;
}

export function renderSymbolOutline(input: SymbolOutlineInput): OutlineRender {
	const header = `=== ${input.displayPath}${input.languageName !== undefined ? ` (${input.languageName})` : ""} — ${input.totalLines} lines ===`;
	const budget = startBudget(header, input.maxRows ?? DEFAULT_MAX_ROWS, input.maxBytes ?? DEFAULT_MAX_BYTES);
	const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
	const seenLines = new Set<number>();

	const walk = (symbols: OutlineSymbol[], depth: number): boolean => {
		for (const symbol of symbols) {
			if (seenLines.has(symbol.startLine)) {
				const children = symbol.children ?? [];
				if (children.length > 0) {
					if (depth < maxDepth) {
						if (!walk(children, depth + 1)) return false;
					} else if (!pushLine(budget, `[${children.length} nested]`)) {
						markTruncated(budget, "bytes");
						return false;
					}
				}
				continue;
			}
			seenLines.add(symbol.startLine);
			const text = clipLine(input.lines[symbol.startLine - 1] ?? "", PREVIEW_LINE_CHARS);
			const outcome = emitRow(budget, input.hashes, input.lines, symbol.startLine, text);
			if (outcome === "stopped") return false;
			const span = symbol.endLine - symbol.startLine + 1;
			if (outcome === "emitted" && span > 1 && !pushLine(budget, `[limit ${span}]`)) {
				markTruncated(budget, "bytes");
				return false;
			}
			const children = symbol.children ?? [];
			if (children.length === 0) continue;
			if (depth >= maxDepth) {
				if (!pushLine(budget, `[${children.length} nested]`)) {
					markTruncated(budget, "bytes");
					return false;
				}
				continue;
			}
			if (!walk(children, depth + 1)) return false;
		}
		return true;
	};

	walk(input.symbols, 0);
	if (budget.truncated) {
		const remaining = countSymbolRows(input.symbols, 0, maxDepth, input.hashes, new Set<number>()) - budget.rows.length;
		const more = remaining > 0 ? ` (${remaining} more ${remaining === 1 ? "symbol" : "symbols"})` : "";
		const cause = budget.truncation === "rows" ? "row cap" : "byte budget";
		if (budget.rows.length === 0) {
			budget.output.push(more.length > 0
				? `...${more}; outline truncated by the ${cause} before the first row.`
				: `... (outline truncated by the ${cause} before the first row.)`);
		} else if (remaining > 0) {
			budget.output.push(`...${more}; read from the last shown anchor to continue.`);
		} else {
			budget.output.push(`... (outline truncated by the ${cause}; read from the last shown anchor to continue.)`);
		}
	}
	return { text: budget.output.join("\n"), rows: budget.rows, servedHashes: budget.servedHashes, truncated: budget.truncated, complete: isComplete(budget) };
}

export function renderPreviewOutline(input: PreviewOutlineInput): OutlineRender {
	const header = `=== ${input.displayPath} — ${input.lines.length} lines ===`;
	const budget = startBudget(header, Number.POSITIVE_INFINITY, input.maxBytes ?? DEFAULT_MAX_BYTES);
	if (input.lines.length === 0) {
		const anchor = input.hashes[0];
		if (anchor !== undefined) {
			const marker = `${anchor}${HASH_SEP}`;
			const note = "[File is empty. Use replace to insert content.]";
			if (pushLine(budget, marker)) {
				budget.rows.push({ line: 1, anchor, text: "" });
				budget.servedHashes.push(anchor);
				if (!pushLine(budget, note)) markTruncated(budget, "bytes");
			} else {
				markTruncated(budget, "bytes");
			}
		}
		return {
			text: budget.output.join("\n"),
			rows: budget.rows,
			servedHashes: budget.servedHashes,
			truncated: budget.truncated,
			complete: isComplete(budget),
		};
	}

	const head = Math.min(input.headLines ?? PREVIEW_HEAD_LINES, input.lines.length);
	const tail = Math.min(input.tailLines ?? PREVIEW_TAIL_LINES, input.lines.length - head);
	const attempt = (index: number): EmitOutcome => emitRow(budget, input.hashes, input.lines, index + 1, clipLine(input.lines[index] ?? "", PREVIEW_LINE_CHARS));

	for (let index = 0; index < head; index += 1) {
		if (attempt(index) === "stopped") break;
	}
	let middleIndex: number | undefined;
	if (!budget.truncated && head + tail < input.lines.length) {
		if (pushLine(budget, formatMoreLines(input.lines.length - head - tail))) middleIndex = budget.output.length - 1;
		else markTruncated(budget, "bytes");
	}
	if (!budget.truncated) {
		for (let index = input.lines.length - tail; index < input.lines.length; index += 1) {
			if (attempt(index) === "stopped") break;
		}
	}
	if (budget.truncated) {
		const remaining = input.lines.length - budget.rows.length;
		if (middleIndex !== undefined) budget.output.splice(middleIndex, 1);
		if (remaining > 0) budget.output.push(formatMoreLines(remaining));
	}
	return {
		text: budget.output.join("\n"),
		rows: budget.rows,
		servedHashes: budget.servedHashes,
		truncated: budget.truncated,
		complete: head + tail >= input.lines.length && isComplete(budget),
	};
}
