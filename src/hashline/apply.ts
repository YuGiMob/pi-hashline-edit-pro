import { abortIf, splitLines } from "../utils";
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
export function assertNotEmpty(originalContent: string, result: string): void {
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

export interface PlannedEdit {
  resolved: RHEdit;
  warnings: string[];
}


export function planEdit(
  content: string,
  edit: HEdit,
  precomputedHashes: string[],
  options?: {
    filePath?: string;
    servedHashes?: ReadonlyMap<string, string>;
    signal?: AbortSignal;
    baseFileLines?: string[];
  },
): PlannedEdit {
  const signal = options?.signal;
  abortIf(signal);
  const fileLines = options?.baseFileLines ?? splitLines(content);
  const lineIndex = { fileLines };
  const fileHashes = precomputedHashes;
  const warnings: string[] = [];

  const rangeFixed = swapReversedRanges(edit, fileHashes);
  const prefixFixed = stripDiffPrefixes(
    stripBarePrefixes(rangeFixed, warnings),
    warnings,
  );

  const { resolved: initialResolved, mismatches } = valEdit(
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
      options?.filePath,
    );
    throw new AnchorMismatchError(feedback.text, feedback.hashes, feedback.servedMap);
  }

  warnUnicodeEsc(prefixFixed, warnings);

  const resolved = initialResolved;

  if (options?.servedHashes) {
    abortIf(signal);
    assertRangeServed(resolved, lineIndex.fileLines, fileHashes, options.servedHashes, options?.filePath);
  }

  return {
    resolved,
    warnings,
  };
}
export function applyEdit(
	content: string,
	edit: HEdit,
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	servedHashes?: ReadonlyMap<string, string>,
	): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdit?: NEdit;
} {
  abortIf(signal);
  if (precomputedHashes === undefined) {
    throw new Error("[E_BAD_SHAPE] applyEdit requires the file's allocated anchors; derive them via lineHashes(content, path) first.");
  }
  const planned = planEdit(content, edit, precomputedHashes, { filePath, servedHashes, signal });
  const lineIndex = buildIdx(content);
  const warnings = planned.warnings;
  const resolved = planned.resolved;
	const spanResult = resToSpan(resolved, content, lineIndex);
	if (spanResult.kind === "noop") {
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
			...(warnings.length ? { warnings } : {}),
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
