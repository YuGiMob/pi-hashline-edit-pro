import { abortIf, visLines, lastNonEmptyIndex, firstNonEmptyIndex } from "../utils";
import { _lineHashesPure, HASH_SEP } from "./hash";
import {
	valEdits,
	assertNoBarePrefix,
	warnUnicodeEsc,
	fmtMismatch,
	descEdit,
	type RHEdit,
	type NEdit,
	type HEdit,
	type BDupWarn,
	type AutoFix,
} from "./resolve";

type LIdx = {
	fileLines: string[];
	lineStarts: number[];
};

export function buildIdx(content: string): LIdx {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
	};
};

type RESpan = {
	kind: "replace";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
};

function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit. Use `write` if you need to clear the file."
		);
	}
}

function throwConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}.`
	);
}

function resToSpan(
  edit: RHEdit,
  index: number,
  content: string,
  lineIndex: LIdx,
  noopEdits: NEdit[],
): RESpan | null {
  const { fileLines, lineStarts } = lineIndex;

  const startLine = edit.hash_range_inclusive[0].line;
  const endLine = edit.hash_range_inclusive[1].line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.content_lines.length &&
    originalLines.every(
      (line, lineIndex) => line === edit.content_lines[lineIndex],
    )
  ) {
    noopEdits.push({
      editIndex: index,
      loc: edit.hash_range_inclusive[0].hash,
      currentContent: originalLines.join("\n"),
    });
    return null;
  }

  const label = descEdit(edit);

  if (edit.content_lines.length > 0) {
    return {
      kind: "replace",
      index,
      label,
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
      replacement: edit.content_lines.join("\n"),
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      kind: "replace",
      index,
      label,
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      kind: "replace",
      index,
      label,
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  return {
    kind: "replace",
    index,
    label,
    start: Math.max(0, lineStarts[startLine - 1]! - 1),
    end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
    replacement: "",
  };
}

function assertNoConflict(spans: RESpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < spans.length;
			rightIndex++
		) {
			const right = spans[rightIndex]!;

			if (left.start < right.end && right.start < left.end) {
				throwConflict(
					left,
					right,
					"overlap on the same original line range",
				);
			}
		}
	}
}

function resSpans(
	edits: RHEdit[],
	content: string,
	lineIndex: LIdx,
	noopEdits: NEdit[],
	signal: AbortSignal | undefined,
): RESpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: RESpan[] = [];
	for (const [index, edit] of edits.entries()) {
	abortIf(signal);
		const span = resToSpan(
			edit,
			index,
			content,
			lineIndex,
			noopEdits,
		);
		if (!span) {
			continue;
		}

		const spanKey =
				`replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflict(resolvedSpans);
	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		return left.index - right.index;
	});
}

function assemble(
	content: string,
	spans: RESpan[],
	signal: AbortSignal | undefined,
): string {
	let result = content;
	for (const span of spans) {
		abortIf(signal);
		result =
			result.slice(0, span.start) + span.replacement + result.slice(span.end);
	}
	return result;
}

export function fmtBoundaryWarning(params: {
	kind: "trailing" | "leading";
	survivingContent: string;
	matchIndex: number;
	resultLines: string[];
	resultHashes: string[];
}): string {
	const header =
		params.kind === "trailing"
			? "Boundary duplication (trailing): the last replacement line duplicated the next line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there."
			: "Boundary duplication (leading): the first replacement line duplicated the previous line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there.";

	let pairStart = -1;
	let bestDist = Infinity;
	for (let i = 0; i < params.resultLines.length - 1; i++) {
		if (
			params.resultLines[i] === params.survivingContent &&
			params.resultLines[i + 1] === params.survivingContent
		) {
			const dist = Math.abs(i - params.matchIndex);
			if (dist < bestDist) {
				bestDist = dist;
				pairStart = i;
			}
		}
	}
	if (pairStart < 0) pairStart = params.matchIndex;

	const winStart = Math.max(0, pairStart - 2);
	const winEnd = Math.min(params.resultLines.length - 1, pairStart + 3);

	const rows: string[] = [];
	for (let i = winStart; i <= winEnd; i++) {
		rows.push(`${params.resultHashes[i]}${HASH_SEP}${params.resultLines[i]}`);
	}
	return `${header}\n\n${rows.join("\n")}`;
}

export function applyEdits(
	content: string,
	edits: HEdit[],
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NEdit[];
	autoFixes?: AutoFix[];
} {
	abortIf(signal);
	if (!edits.length)
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
		};

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? _lineHashesPure(content);
	const noopEdits: NEdit[] = [];
	const warnings: string[] = [];

	const { resolved: initialResolved, mismatches, boundaryWarnings } = valEdits(
		edits,
		lineIndex.fileLines,
		fileHashes,
		signal,
	);
	if (mismatches.length) {
		throw new Error(
			fmtMismatch(mismatches, lineIndex.fileLines, fileHashes, filePath),
		);
	}

	assertNoBarePrefix(edits, lineIndex.fileLines, fileHashes);
	warnUnicodeEsc(edits, warnings);

	let resolved = initialResolved;
	let autoFixes: AutoFix[] | undefined;
	if (boundaryWarnings.length > 0) {
		autoFixes = [];
		const correctedEdits: HEdit[] = edits.map(e => ({
			...e,
			content_lines: [...e.content_lines],
		}));
		for (const bw of boundaryWarnings) {
			const edit = correctedEdits[bw.editIndex];
			if (!edit) continue;
			if (bw.kind === "trailing") {
				const idx = lastNonEmptyIndex(edit.content_lines);
				if (idx >= 0) {
					const removed = edit.content_lines.splice(idx, 1)[0];
					autoFixes.push({ kind: "trailing", editIndex: bw.editIndex, removedLine: removed });
				}
			} else {
				const idx = firstNonEmptyIndex(edit.content_lines);
				if (idx >= 0) {
					const removed = edit.content_lines.splice(idx, 1)[0];
					autoFixes.push({ kind: "leading", editIndex: bw.editIndex, removedLine: removed });
				}
			}
		}
		const correctedResult = valEdits(
			correctedEdits,
			lineIndex.fileLines,
			fileHashes,
			signal,
		);
		if (correctedResult.mismatches.length) {
			throw new Error(
				fmtMismatch(correctedResult.mismatches, lineIndex.fileLines, fileHashes, filePath),
			);
		}
		resolved = correctedResult.resolved;
	}

	const orderedSpans = resSpans(
		resolved,
		content,
		lineIndex,
		noopEdits,
		signal,
	);

	const result = assemble(content, orderedSpans, signal);
	assertNotEmpty(content, result);
	const range = changedRange(content, result);

	return {
		content: result,
		firstChangedLine: range?.firstChangedLine,
		lastChangedLine: range?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
		...(autoFixes ? { autoFixes } : {}),
	};
}

export function fmtRegion(
	hashes: string[],
	lines: string[],
): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines
		.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`)
		.join("\n");
}

export function changedRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: visLines(result).length,
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: visLines(original).length + 1,
			lastChangedLine: visLines(result).length,
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (
		lastOrig >= firstDiff &&
		lastRes >= firstDiff &&
		original[lastOrig] === result[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}

	function idxToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = idxToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : visLines(result).length;
	} else if (
		firstDiff === 0 &&
		original.length > 0 &&
		result.endsWith(original)
	) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = idxToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}
