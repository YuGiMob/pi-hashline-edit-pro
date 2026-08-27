import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	formatSize,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadFileKindAndText } from "./file-kind";
import { MAX_OVERSIZED_WARNING_LINES } from "./constants";
import { readNormFile, safeSnapId } from "./file-reader";
import { lineHashes, fmtRegion, fmtRow, HASH_SEP, MAX_HASH_LINES } from "./hashline";
import { toCwd } from "./paths";
import { abortIf, makePrepareArguments, visLines } from "./utils";
import { recordServedSafe } from "./served";
import { loadP, loadGuide } from "./prompts";
import { valAccess } from "./validation";

const R_DESC = loadP("../prompts/read.md");

const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
	return loadGuide("../prompts/read-guidelines.md");
}

function normPosInt(
	value: number | undefined,
	name: "offset" | "limit",
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
	maxLineBytes = DEFAULT_MAX_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number; servedHashes: string[] }> {
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
      const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
      const emptyLineHash = allHashes[0] ?? "";
      return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
				servedHashes: emptyLineHash ? [emptyLineHash] : [],
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines). Use replace to insert content.`,
			servedHashes: [],
		};
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			servedHashes: [],
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);
	const maxBytes = maxLineBytes;
	const rowSizes = selected.map((line, index) => ({
		lineNumber: startLine + index,
		bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
	}));
	if (rowSizes.some((row) => row.bytes > maxBytes)) {
		const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
		const rows = rowSizes.map((row, index) =>
			row.bytes > maxBytes
				? fmtRow(selectedHashes[index]!, `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`)
				: fmtRegion([selectedHashes[index]!], [selected[index]!]),
		);
		const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
		const shownRowCount = skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
		const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
		const servedHashes: string[] = [];
		for (let index = 0; index < Math.min(shownRowCount, rows.length); index++) {
			servedHashes.push(selectedHashes[index]!);
		}
		const listed = oversized.slice(0, MAX_OVERSIZED_WARNING_LINES);
		const hiddenCount = oversized.length - listed.length;
		const lineLabel = oversized.length === 1
			? `Line ${oversized[0]!.lineNumber}`
			: `Lines ${listed.map((row) => row.lineNumber).join(', ')}${hiddenCount > 0 ? `, ... (+${hiddenCount} more)` : ''}`;
		const verb = oversized.length === 1 ? 'exceeds' : 'exceed';
		const addresses = listed.map((row) => `${row.lineNumber}p`).join(';');
		const moreHint = hiddenCount > 0
			? ` ${hiddenCount} more oversized line(s). Use read with offset to inspect them.`
			: '';
		const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}${moreHint}]`;
		let preview = skippedTruncation.content;
		let nextOffset: number | undefined;
		if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
			nextOffset = lastShownLine + 1;
			preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
		} else {
			preview += `\n\n${warning}`;
		}
		return {
			text: preview,
			truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			servedHashes,
		};
	}

	const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });

	let preview = truncation.content;
	let nextOffset: number | undefined;
	const shownCount = truncation.content === "" ? 0 : truncation.content.split("\n").length;
	const servedHashes = selectedHashes.slice(0, shownCount);
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		nextOffset = endLineDisplay + 1;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		servedHashes,
	};
}

export function regRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: R_DESC,
		promptSnippet: R_SNIPPET,
		promptGuidelines: readGuide(),
		prepareArguments: makePrepareArguments(),
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path;
			const absolutePath = toCwd(rawPath, ctx.cwd);

			abortIf(signal);
			await valAccess(absolutePath, rawPath);

			abortIf(signal);
			const file = await loadFileKindAndText(absolutePath, { maxLines: MAX_HASH_LINES, displayPath: rawPath });
			if (file.kind === "image") {
				const builtinRead = createReadTool(ctx.cwd);
				const executeBuiltinRead = builtinRead.execute as unknown as (
					toolCallId: string,
					input: typeof params,
					abortSignal: typeof signal,
					onUpdate: typeof _onUpdate,
					context: typeof ctx,
				) => ReturnType<typeof builtinRead.execute>;
				return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
			}
      const { normalized, fileHashes, hadUtf8DecodeErrors, absolutePath: resolvedPath } = await readNormFile(
        rawPath, ctx.cwd, { signal, preloadedFile: file, maxLines: MAX_HASH_LINES },
      );
			const preview = await fmtReadPreview(
				normalized,
				{
					offset: params.offset,
					limit: params.limit,
				},
				fileHashes,
				resolvedPath,
			);
			await recordServedSafe(resolvedPath, preview.servedHashes, "read", new Set(fileHashes));
			const snapshotId = await safeSnapId(absolutePath, "read");
			const previewText =
				hadUtf8DecodeErrors
					? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
					: preview.text;

			return {
				content: [{ type: "text", text: previewText }],
				details: {
					truncation: preview.truncation,
					snapshotId,
					...(preview.nextOffset !== undefined
						? { nextOffset: preview.nextOffset }
						: {}),
					metrics: {
						truncated: !!preview.truncation,
						...(preview.nextOffset !== undefined
							? { next_offset: preview.nextOffset }
							: {}),
					},
				},
			};
		},
	});
}
