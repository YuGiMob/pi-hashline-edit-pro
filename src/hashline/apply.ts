import { abortIf, splitLines } from "../utils";
import { _lineHashesPure } from "./hash";
import {
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	warnUnicodeEsc,
	fmtMismatchWithHashes,
	AnchorMismatchError,
	assertRangeServed,
	type RHEdit,
	type NEdit,
	type HEdit,
	type AutoFix,
	type BDup,
} from "./resolve";

type LIdx = {
	fileLines: string[];
	lineStarts: number[];
};

export function buildIdx(content: string): LIdx {
  const fileLines = splitLines(content);
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
	start: number;
	end: number;
	replacement: string;
};

type NoopSpan = {
	kind: "noop";
	loc: string;
	currentContent: string;
};
function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] A replace cannot empty a non-empty file. Use `write` to clear the file."
		);
	}
}

function resToSpan(
  edit: RHEdit,
  content: string,
  lineIndex: LIdx,
): RESpan | NoopSpan {
  const { fileLines, lineStarts } = lineIndex;

  const startLine = edit.hash_bounds[0].line;
  const endLine = edit.hash_bounds[1].line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.content_lines.length &&
    originalLines.every(
      (line, lineIndex) => line === edit.content_lines[lineIndex],
    )
  ) {
    return {
      kind: "noop",
      loc: edit.hash_bounds[0].hash,
      currentContent: originalLines.join("\n"),
    };
  }

  if (edit.content_lines.length > 0) {
    const lastReplacementLine = edit.content_lines[edit.content_lines.length - 1]!;
    const endsWithBlank = lastReplacementLine.length === 0;
    const endsAtEofWithoutNewline =
      endLine === fileLines.length && !content.endsWith("\n");
    const replacement = edit.content_lines.join("\n");
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
      replacement:
        endsAtEofWithoutNewline && endsWithBlank
          ? `${replacement}\n`
          : replacement,
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      kind: "replace",
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  if (content.endsWith("\n")) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: content.length,
      replacement: "",
    };
  }

  const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined;
  return {
    kind: "replace",
    start:
      prevLine !== undefined && prevLine.length === 0
        ? lineStarts[startLine - 1]!
        : Math.max(0, lineStarts[startLine - 1]! - 1),
    end: content.length,
    replacement: "",
  };
}

function assemble(
	content: string,
	span: RESpan,
	signal: AbortSignal | undefined,
): string {
	abortIf(signal);
	return content.slice(0, span.start) + span.replacement + content.slice(span.end);
}

export function applyEdit(
	content: string,
	edit: HEdit,
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	servedHashes?: ReadonlyMap<string, string>,
	skipBoundaryDedup?: boolean,
	): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdit?: NEdit;
	autoFixes?: AutoFix[];
} {
	abortIf(signal);

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? _lineHashesPure(content);
	const warnings: string[] = [];

	const rangeFixed = swapReversedRanges(edit, fileHashes, warnings);
	const prefixFixed = stripDiffPrefixes(
		stripBarePrefixes(rangeFixed, fileHashes, warnings),
		warnings,
	);

	const { resolved: initialResolved, mismatches, boundaryDups } = valEdit(
		prefixFixed,
		lineIndex.fileLines,
		fileHashes,
		warnings,
		signal,
	);
	if (mismatches.length || !initialResolved) {
		const feedback = fmtMismatchWithHashes(
			mismatches,
			lineIndex.fileLines,
			fileHashes,
			filePath,
		);
		throw new AnchorMismatchError(feedback.text, feedback.hashes, feedback.servedMap);
	}

	warnUnicodeEsc(prefixFixed, warnings);

	let resolved = initialResolved;
	let autoFixes: AutoFix[] | undefined;
	if (boundaryDups.length > 0 && !skipBoundaryDedup) {
		autoFixes = [];
		const correctedEdit: HEdit = {
			...prefixFixed,
			content_lines: [...prefixFixed.content_lines],
		};
		const seen = new Set<number>();
		const uniqueDups: BDup[] = [];
		for (const dup of boundaryDups) {
			if (seen.has(dup.replacementLineIndex)) continue;
			seen.add(dup.replacementLineIndex);
			uniqueDups.push(dup);
		}
		const dupsByIndex = uniqueDups.sort(
			(a, b) => b.replacementLineIndex - a.replacementLineIndex,
		);
		for (const dup of dupsByIndex) {
			const idx = dup.replacementLineIndex;
			if (idx < 0 || idx >= correctedEdit.content_lines.length) continue;
			const removed = correctedEdit.content_lines.splice(idx, 1)[0];
			autoFixes.push({ kind: dup.kind, removedLine: removed, removedLineIndex: idx });
		}
		const correctedResult = valEdit(
			correctedEdit,
			lineIndex.fileLines,
			fileHashes,
			warnings,
			signal,
		);
		if (correctedResult.mismatches.length || !correctedResult.resolved) {
			const feedback = fmtMismatchWithHashes(
				correctedResult.mismatches,
				lineIndex.fileLines,
				fileHashes,
				filePath,
			);
			throw new AnchorMismatchError(feedback.text, feedback.hashes, feedback.servedMap);
		}
		resolved = correctedResult.resolved;
	}

	if (servedHashes) {
		abortIf(signal);
		assertRangeServed(resolved, lineIndex.fileLines, fileHashes, servedHashes, filePath);
	}

	const spanResult = resToSpan(resolved, content, lineIndex);
	if (spanResult.kind === "noop") {
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
			...(warnings.length ? { warnings } : {}),
			...(autoFixes ? { autoFixes } : {}),
			noopEdit: { loc: spanResult.loc, currentContent: spanResult.currentContent },
		};
	}

	const result = assemble(content, spanResult, signal);
	assertNotEmpty(content, result);
	const range = changedRange(content, result);

	return {
		content: result,
		firstChangedLine: range?.firstChangedLine,
		lastChangedLine: range?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(autoFixes ? { autoFixes } : {}),
	};
}

export { fmtRegion, fmtRow } from "./resolve";
export function changedRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: splitLines(result).length,
		};
	}

	const originalLines = splitLines(original);
	const resultLines = splitLines(result);

	if (
		originalLines.length === resultLines.length &&
		originalLines.every((line, index) => line === resultLines[index])
	) {
		return null;
	}

	const minLen = Math.min(originalLines.length, resultLines.length);
	let first = 0;
	while (first < minLen && originalLines[first] === resultLines[first]) {
		first++;
	}
	let lastOrig = originalLines.length - 1;
	let lastRes = resultLines.length - 1;
	while (
		lastOrig >= first &&
		lastRes >= first &&
		originalLines[lastOrig] === resultLines[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}
	return {
		firstChangedLine: first + 1,
		lastChangedLine: Math.max(first, lastRes) + 1,
	};
}
