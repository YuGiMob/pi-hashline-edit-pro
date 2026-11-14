import { Type } from "typebox";
import { HASH_CLASS, HASH_SEP } from "./hashline/hash.ts";
import { ioErrorCode } from "./utils.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type AnchoredLine = {
	line: number;
	text: string;
	anchor: string;
	rendered: string;
};

export const anchoredLineSchema = Type.Object({
	line: Type.Integer(),
	text: Type.String(),
	anchor: Type.String(),
	rendered: Type.String(),
});

export type StructuredError = {
	ok: false;
	kind: "error";
	error: { code: string; message: string };
};

export const structuredErrorSchema = Type.Object({
	ok: Type.Literal(false),
	kind: Type.Literal("error"),
	error: Type.Object({
		code: Type.String(),
		message: Type.String(),
	}),
});

export type ReadTextResult = {
	ok: true;
	kind: "read";
	path: string;
	text: string;
	lines: AnchoredLine[];
	totalLines: number;
	startLine: number;
	nextOffset: number | null;
	truncated: boolean;
	blockedByLongLine: boolean;
	hadUtf8DecodeErrors: boolean;
	notices: string[];
};

export type ReadImageResult = {
	type: "image";
	data: string;
	mimeType: string;
	note: string;
};

export type ReadResult = ReadTextResult | ReadImageResult | string | StructuredError;

export const readResultSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		kind: Type.Literal("read"),
		path: Type.String(),
		text: Type.String(),
		lines: Type.Array(anchoredLineSchema),
		totalLines: Type.Integer(),
		startLine: Type.Integer(),
		nextOffset: Type.Union([Type.Integer(), Type.Null()]),
		truncated: Type.Boolean(),
		blockedByLongLine: Type.Boolean(),
		hadUtf8DecodeErrors: Type.Boolean(),
		notices: Type.Array(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
		note: Type.String(),
	}),
	Type.String(),
	structuredErrorSchema,
]);

export type OutlineStructured = {
	ok: true;
	kind: "outline";
	path: string;
	text: string;
	totalLines: number;
	depth: number;
	lines: AnchoredLine[];
	truncated: boolean;
	complete: boolean;
	notices: string[];
};

export type OutlineResult = OutlineStructured | string | StructuredError;

export const outlineResultSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		kind: Type.Literal("outline"),
		path: Type.String(),
		text: Type.String(),
		totalLines: Type.Integer(),
		depth: Type.Integer(),
		lines: Type.Array(anchoredLineSchema),
		truncated: Type.Boolean(),
		complete: Type.Boolean(),
		notices: Type.Array(Type.String()),
	}),
	Type.String(),
	structuredErrorSchema,
]);

export type EditVerb = "replaced" | "inserted" | "copied" | "moved" | "undone" | "edited";

export type EditStructured = {
	ok: true;
	kind: "edit";
	verb: EditVerb;
	classification: "applied" | "noop";
	path: string;
	text: string;
	diff: string;
	warnings: string[];
	hints: string[];
	firstChangedLine: number | null;
	anchors: AnchoredLine[];
	anchorsOmitted: boolean;
};

export type EditResult = EditStructured | StructuredError;

export const editResultSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		kind: Type.Literal("edit"),
		verb: Type.Union([
			Type.Literal("replaced"),
			Type.Literal("inserted"),
			Type.Literal("copied"),
			Type.Literal("moved"),
			Type.Literal("undone"),
			Type.Literal("edited"),
		]),
		classification: Type.Union([Type.Literal("applied"), Type.Literal("noop")]),
		path: Type.String(),
		text: Type.String(),
		diff: Type.String(),
		warnings: Type.Array(Type.String()),
		hints: Type.Array(Type.String()),
		firstChangedLine: Type.Union([Type.Integer(), Type.Null()]),
		anchors: Type.Array(anchoredLineSchema),
		anchorsOmitted: Type.Boolean(),
	}),
	structuredErrorSchema,
]);

export type GrepFileResult = {
	path: string;
	matchLines: number[];
	lines: AnchoredLine[];
	hadUtf8DecodeErrors: boolean;
};

export type GrepStructured = {
	ok: true;
	kind: "grep";
	text: string;
	matches: number;
	files: number;
	truncated: boolean;
	results: GrepFileResult[];
};

export type GrepResult = GrepStructured | StructuredError;

export const grepResultSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		kind: Type.Literal("grep"),
		text: Type.String(),
		matches: Type.Integer(),
		files: Type.Integer(),
		truncated: Type.Boolean(),
		results: Type.Array(
			Type.Object({
				path: Type.String(),
				matchLines: Type.Array(Type.Integer()),
				lines: Type.Array(anchoredLineSchema),
				hadUtf8DecodeErrors: Type.Boolean(),
			}),
		),
	}),
	structuredErrorSchema,
]);

export function anchoredLine(line: number, text: string, anchor: string): AnchoredLine {
	return { line, text, anchor, rendered: `${anchor}${HASH_SEP}${text}` };
}

const LIVE_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│(.*)$`);
const DIFF_TRUNCATION_MARKER = "[diff truncated at";
const ERROR_CODE_RE = /\[([EWH]_[A-Z0-9_]+)\]/;
const EDIT_VERBS: Record<string, EditVerb> = { replace: "replaced", replace_match: "replaced", insert: "inserted", copy: "copied", move: "moved", replaced: "replaced", inserted: "inserted", copied: "copied", moved: "moved", undone: "undone", edited: "edited" };

export function anchoredLinesFromDiff(diff: string, lineNumbers: readonly (number | null | undefined)[] | undefined): AnchoredLine[] {
	const rows = diff.split("\n");
	const lines: AnchoredLine[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < rows.length; index++) {
		const match = LIVE_DIFF_ROW_RE.exec(rows[index]!);
		if (!match) continue;
		const anchor = match[1]!;
		const line = lineNumbers?.[index];
		if (seen.has(anchor) || typeof line !== "number") continue;
		seen.add(anchor);
		lines.push(anchoredLine(line, match[2]!, anchor));
	}
	return lines;
}

export function diffAnchorsOmitted(diff: string): boolean {
	return diff.includes(DIFF_TRUNCATION_MARKER);
}

export function toEditVerb(verb: string | undefined): EditVerb {
	return verb !== undefined ? (EDIT_VERBS[verb] ?? "replaced") : "replaced";
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function structuredError(error: unknown): StructuredError {
	const message = messageOf(error);
	return { ok: false, kind: "error", error: { code: ERROR_CODE_RE.exec(message)?.[1] ?? ioErrorCode(error) ?? "E_TOOL", message } };
}

export type StructuredFailureResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	details: TDetails;
	structuredContent: StructuredError;
};

export function structuredFailure<TDetails>(error: unknown, details: TDetails): StructuredFailureResult<TDetails> {
	const structuredContent = structuredError(error);
	return {
		content: [{ type: "text", text: structuredContent.error.message }],
		isError: true,
		details,
		structuredContent,
	};
}

export async function withStructuredErrors<TDetails, TSuccess extends { details: TDetails }>(
	signal: AbortSignal | undefined,
	details: TDetails,
	run: () => Promise<TSuccess>,
): Promise<TSuccess | StructuredFailureResult<TDetails>> {
	try {
		return await run();
	} catch (error) {
		if (signal?.aborted) throw error;
		return structuredFailure(error, details);
	}
}

export function withStructuredText(content: unknown, text: string): Json | undefined {
	if (content === undefined) return undefined;
	if (content === null || typeof content !== "object" || Array.isArray(content)) return content as Json;
	return { ...(content as Record<string, Json>), text };
}
