import { abortIf, rejectUnknownFields, clipLine, decodeStringArray, assertNoNul, isBlankLine } from "../utils.ts";
import { parseHashRef, parsePayloadText, parseTextWithSeparators, type Anchor, type ParsedText } from "./parse.ts";
import { HASH_SEP, stripRowPrefix, lineChecksum, type RowPrefixKind } from "./hash.ts";
import { HASH_RUN } from "./alphabet.ts";
import { NEW_CONTENT_NOT_ARRAY_MSG, NEW_CONTENT_NOT_STRING_MSG, MAX_RANGE_STALE_LINES } from "../constants.ts";
import type { LineEnding } from "../normalize.ts";

export type RAnchor = {
	line: number;
	hash: string;
};

export type HEdit = {
	content_lines: string[];
	hash_bounds: [Anchor, Anchor];
	content_separators?: (LineEnding | undefined)[];
};
export type RHEdit = {
  content_lines: string[];
  hash_bounds: [RAnchor, RAnchor];
  content_separators?: (LineEnding | undefined)[];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found";
	context?: RAnchor;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
  text: string[];
  remove_from: string;
  remove_to: string;
};

export type HTPayloadEdit = {
  text: string;
  remove_from: string;
  remove_to: string;
};

function resAnchorFromMap(
	ref: Anchor,
	hashIndex: Map<string, number[]>,
): RAnchor | HMismatch {
	const hashMatches = hashIndex.get(ref.hash);
	if (!hashMatches || hashMatches.length === 0) {
		return { ref, kind: "not_found" };
	}
	return {
		line: hashMatches[0]!,
		hash: ref.hash,
	};
}

function assertAligned(
	fileLines: string[],
	fileHashes: string[],
	ctx: string,
): void {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
}

export function fmtRow(hash: string, line: string): string {
	return `${hash}${HASH_SEP}${line}`;
}

export function fmtRegion(hashes: string[], lines: string[]): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines.map((line, index) => fmtRow(hashes[index]!, line)).join("\n");
}

export function fmtMismatchWithHashes(
  mismatches: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath?: string,
): { text: string; hashes: string[]; servedMap: Map<string, string> } {
  assertAligned(fileLines, fileHashes, "fmtMismatch");
  const out: string[] = [];
  const hashes: string[] = [];
  const servedMap = new Map<string, string>();
  const seen = new Set<string>();
  const notFound = mismatches.filter((mismatch) => {
    if (seen.has(mismatch.ref.hash)) return false;
    seen.add(mismatch.ref.hash);
    return true;
  });
  if (notFound.length > 0) {
    const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
    out.push(
      `[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. The file changed since read. Call read()${filePath ? ` on ${filePath}` : ""} for fresh anchors.`
    );
    for (const m of notFound) {
      const ctx = m.context;
      if (!ctx) continue;
      const from = Math.max(1, ctx.line - 1);
      const to = Math.min(fileLines.length, ctx.line + 1);
      const rows: string[] = [];
      for (let ln = from; ln <= to; ln++) {
        const h = fileHashes[ln - 1]!;
        const c = fileLines[ln - 1] ?? "";
        const shown = clipLine(c);
        if (shown === c) {
          hashes.push(h);
          servedMap.set(h, lineChecksum(c));
        }
        rows.push(`    ${ln}: ${h}│${shown}`);
      }
      out.push("");
      out.push(`  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`);
    }
  }
  return { text: out.join("\n"), hashes, servedMap };
}


const ITEM_KS = new Set(["text", "remove_from", "remove_to"]);

function assertBounds(edit: Record<string, unknown>): void {
	if ("remove_from" in edit && typeof edit.remove_from !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_from" must be an anchor string (5-char anchor).`,
		);
	}
	if ("remove_to" in edit && typeof edit.remove_to !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_to" must be an anchor string (5-char anchor).`,
		);
	}
	if (typeof edit.remove_from !== "string" || typeof edit.remove_to !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] The edit requires "remove_from" and "remove_to" anchor strings (5-char anchors from read output).`,
		);
	}
}

function assertItem(edit: Record<string, unknown>): void {
	rejectUnknownFields(edit, ITEM_KS, "Edit", "The edit takes only { text, remove_from, remove_to }.");
	assertBounds(edit);
	if (!("text" in edit)) {
		throw new Error(`[E_BAD_SHAPE] The edit requires a "text" array (use [] to delete).`);
	}
	if (!Array.isArray(edit.text) || edit.text.some((line) => typeof line !== "string")) {
		throw new Error(NEW_CONTENT_NOT_ARRAY_MSG);
	}
}

function assertPayloadItem(edit: Record<string, unknown>): void {
	rejectUnknownFields(edit, ITEM_KS, "Edit", "The edit takes only { text, remove_from, remove_to }.");
	assertBounds(edit);
	if (!("text" in edit)) {
		throw new Error(`[E_BAD_SHAPE] The edit requires a "text" string (use "" to delete).`);
	}
	if (typeof edit.text !== "string") {
		throw new Error(NEW_CONTENT_NOT_STRING_MSG);
	}
}

function resolveParsedEdit(removeFrom: string, removeTo: string, parsed: ParsedText, warnings?: string[]): HEdit {
	const replaceLines = parsed.lines;
	assertNoNul(replaceLines);
	const bounds = [removeFrom, removeTo].map((ref) => {
		return stripAnchorRow(ref.trim(), "remove_from/remove_to entry", warnings);
	}) as [string, string];
	return {
		content_lines: replaceLines,
		hash_bounds: [parseHashRef(bounds[0], warnings, "remove_from"), parseHashRef(bounds[1], warnings, "remove_to")],
		...(parsed.separators.some((separator) => separator !== undefined) ? { content_separators: parsed.separators } : {}),
	};
}

export const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_RUN})│`);

const NUMBERED_ANCHOR_ROW_RE = new RegExp(`^\\s*\\d+\\s*[:-]?\\s*│\\s*(${HASH_RUN})│`);

const PAREN_LINE_SUFFIX_RE = new RegExp(`^(${HASH_RUN})\\s*\\(\\s*(?:line|lines)\\s+\\d+(?:\\s*[-–—]\\s*\\d+)?\\s*\\)$`, "i");

export function stripAnchorRow(
	trimmed: string,
	entryLabel: string,
	warnings?: string[],
): string {
	const numbered = trimmed.match(NUMBERED_ANCHOR_ROW_RE);
	if (numbered) {
		warnings?.push(`[W_BAD_REF] Stripped line-numbered row from ${entryLabel} "${clipLine(trimmed, 48)}".`);
		return numbered[1]!;
	}
	const paren = trimmed.match(PAREN_LINE_SUFFIX_RE);
	if (paren) {
		warnings?.push(`[W_BAD_REF] Stripped "(line N)" suffix from ${entryLabel} "${clipLine(trimmed, 48)}".`);
		return paren[1]!;
	}
	const match = trimmed.match(ANCHOR_ROW_RE);
	if (!match) return trimmed;
	const marker =
		match[1] === "+"
			? "diff-preview marker"
			: match[1] === "-"
				? 'leading "-" marker'
				: '"anchor│" prefix';
  warnings?.push(`[W_BAD_REF] Stripped ${marker} from ${entryLabel} "${clipLine(trimmed, 48)}".`);
	return match[2]!;
}

export type HTextInput = {
  text: string | string[];
  remove_from: string;
  remove_to: string;
};

export function resEdit(edit: HTextInput, warnings?: string[]): HEdit {
	if (typeof edit.text === "string") {
		assertPayloadItem(edit as unknown as Record<string, unknown>);
		return resolveParsedEdit(edit.remove_from, edit.remove_to, parsePayloadText(edit.text), warnings);
	}
	assertItem(edit as Record<string, unknown>);
	const parsed = parseTextWithSeparators(decodeStringArray(edit.text, warnings) ?? edit.text);
	return resolveParsedEdit(edit.remove_from, edit.remove_to, parsed, warnings);
}

function warnUnicodeEsc(
  edit: HEdit,
  warnings: string[],
): void {
  if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
    warnings.push(
      "Detected literal \\uDDDD in edit content; no autocorrection applied.",
    );
  }
}

export interface StripWarningLocation {
	label: string;
	indexOffset: number;
}

function stripRowPrefixes(
	edit: HEdit,
	warnings: string[],
	kinds: RowPrefixKind[],
	code: string,
	marker: string,
	location: StripWarningLocation,
): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const result = stripRowPrefix(line);
		if (result.kind === null || !kinds.includes(result.kind)) return line;
		stripped.push(lineIndex);
		return result.text;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped.map((i) => `${location.label} line ${i + 1 + location.indexOffset}`).join(", ");
	warnings.push(`${code} Stripped ${marker} from ${locations}.`);
	return { ...edit, content_lines: contentLines };
}

const DEFAULT_STRIP_WARNING_LOCATION: StripWarningLocation = { label: "text", indexOffset: 0 };

export function stripBarePrefixes(edit: HEdit, warnings: string[], location: StripWarningLocation = DEFAULT_STRIP_WARNING_LOCATION): HEdit {
	return stripRowPrefixes(edit, warnings, ["bare"], "[W_BARE_HASH_PREFIX]", '"anchor│" prefix', location);
}

export function stripDiffPrefixes(edit: HEdit, warnings: string[], location: StripWarningLocation = DEFAULT_STRIP_WARNING_LOCATION): HEdit {
	return stripRowPrefixes(edit, warnings, ["plus", "minus"], "[W_INVALID_PATCH]", "diff-preview marker", location);
}

export function swapReversedRanges(
	edit: HEdit,
	fileHashes: string[],
	warnings?: string[],
): HEdit {
	const lineByHash = new Map<string, number>();
	for (let i = 0; i < fileHashes.length; i++) {
		lineByHash.set(fileHashes[i]!, i + 1);
	}
	const [startRef, endRef] = edit.hash_bounds;
	const startLine = lineByHash.get(startRef.hash);
	const endLine = lineByHash.get(endRef.hash);
	if (
		startLine === undefined ||
		endLine === undefined ||
		startLine <= endLine
	) {
		return edit;
	}
	warnings?.push(`[H_RANGE_REVERSED] "remove_from" refers to line ${startLine} after "remove_to" (line ${endLine}); lines ${endLine}-${startLine} were replaced in document order.`);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

export function preserveDeletionSeparators(edit: HEdit, fileLines: string[], fileHashes: string[]): HEdit {
	if (edit.content_lines.length > 0) return edit;
	const lineByHash = new Map<string, number>();
	for (let index = 0; index < fileHashes.length; index++) {
		const hash = fileHashes[index]!;
		if (!lineByHash.has(hash)) lineByHash.set(hash, index);
	}
	const fromLine = lineByHash.get(edit.hash_bounds[0].hash);
	const toLine = lineByHash.get(edit.hash_bounds[1].hash);
	if (fromLine === undefined || toLine === undefined) return edit;
	const rangeStart = Math.min(fromLine, toLine);
	const rangeEnd = Math.max(fromLine, toLine);
	let start = rangeStart;
	let end = rangeEnd;
	while (start <= end && isBlankLine(fileLines[start])) start += 1;
	while (end >= start && isBlankLine(fileLines[end])) end -= 1;
	if (start > end || (start === rangeStart && end === rangeEnd)) return edit;
	return { ...edit, hash_bounds: [{ hash: fileHashes[start]! }, { hash: fileHashes[end]! }] };
}

export function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: RHEdit | undefined; mismatches: HMismatch[] } {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];

	const hashIndex = new Map<string, number[]>();
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		const list = hashIndex.get(h) ?? [];
		list.push(i + 1);
		hashIndex.set(h, list);
	}

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, hashIndex);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);
	const startResolved = tryResolve(edit.hash_bounds[0]);
	const endResolved = tryResolve(edit.hash_bounds[1]);
	if (!startResolved || !endResolved) {
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[0]);
			if (startMismatch && startMismatch.kind === "not_found") startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[1]);
			if (endMismatch && endMismatch.kind === "not_found") endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches };
	}
	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
			...(edit.content_separators !== undefined ? { content_separators: edit.content_separators } : {}),
		},
		mismatches,
	};
}

export function resolveAnchorLine(
  ref: Anchor,
  fileLines: string[],
  fileHashes: string[],
  filePath?: string,
): number {
  const { resolved, mismatches } = valEdit(
    { hash_bounds: [ref, ref], content_lines: [] },
    fileLines,
    fileHashes,
    [],
    undefined,
  );
  if (mismatches.length > 0 || !resolved) {
    const feedback = fmtMismatchWithHashes(
      mismatches,
      fileLines,
      fileHashes,
      filePath,
    );
    throw new AnchorMismatchError(feedback.text, feedback.hashes, feedback.servedMap);
  }
  return resolved.hash_bounds[0].line;
}

export class RangeStaleError extends Error {
  readonly rangeHashes: string[];
  readonly rangeServedMap: Map<string, string>;
  constructor(message: string, rangeHashes: string[], rangeServedMap: Map<string, string>) {
    super(message);
    this.name = "RangeStaleError";
    this.rangeHashes = rangeHashes;
    this.rangeServedMap = rangeServedMap;
  }
}

export class AnchorMismatchError extends Error {
  readonly feedbackHashes: string[];
  readonly feedbackMap: Map<string, string>;
  constructor(message: string, feedbackHashes: string[], feedbackMap: Map<string, string>) {
    super(message);
    this.name = "AnchorMismatchError";
    this.feedbackHashes = feedbackHashes;
    this.feedbackMap = feedbackMap;
  }
}

export function assertRangeServed(
  resolved: RHEdit,
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlyMap<string, string> | undefined,
  filePath?: string,
): void {
  assertAligned(fileLines, fileHashes, "assertRangeServed");
  const startLine = resolved.hash_bounds[0].line;
  const endLine = resolved.hash_bounds[1].line;
  const mismatchLines: number[] = [];
  const deletion = resolved.content_lines.length === 0;
  for (let line = startLine; line <= endLine; line++) {
    const hash = fileHashes[line - 1]!;
    const content = fileLines[line - 1]!;
    const servedContent = served?.get(hash);
    if (servedContent === undefined && deletion && line !== startLine && line !== endLine) continue;
    if (servedContent === undefined || servedContent !== lineChecksum(content)) mismatchLines.push(line);
  }
  if (mismatchLines.length === 0) return;
  const rangeLength = endLine - startLine + 1;
  const shownLength = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const rows: string[] = [];
  const shownHashes: string[] = [];
  const shownMap = new Map<string, string>();
  const clippedLines: number[] = [];
  for (let line = startLine; line < startLine + shownLength; line++) {
    const hash = fileHashes[line - 1]!;
    const content = fileLines[line - 1]!;
    const shown = clipLine(content);
    rows.push(fmtRow(hash, shown));
    if (shown !== content) {
      clippedLines.push(line);
      continue;
    }
    shownHashes.push(hash);
    shownMap.set(hash, lineChecksum(content));
  }
  const location = filePath ? ` in ${filePath}` : "";
  const rangeDescription = `the replaced range (lines ${startLine}-${endLine})${location}`;
  const first = mismatchLines[0]!;
  const mismatchText = mismatchLines.length === 1
    ? `Line ${first} of ${rangeDescription} was never shown or changed on disk`
    : `${mismatchLines.length} of ${rangeLength} line(s) in ${rangeDescription} were never shown or changed on disk`;
  const capHint =
    rangeLength > shownLength
      ? `\n\n[The range has ${rangeLength} lines; showing the first ${shownLength}. Call read()${filePath ? ` on ${filePath}` : ""} with offset=${startLine + shownLength} to see the rest.]`
      : clippedLines.length > 0
        ? `\n\n[${clippedLines.length === 1 ? `Line ${clippedLines[0]} is` : `Lines ${clippedLines.join(", ")} are`} clipped above and not editable from here; call read()${filePath ? ` on ${filePath}` : ""} before editing.]`
        : "\n\nRetry with the fresh anchors above without a read.";
  const message =
    `[E_RANGE_STALE] ${mismatchText}. Current range with fresh anchors:\n\n${rows.join("\n")}${capHint}`;
  throw new RangeStaleError(message, shownHashes, shownMap);
}

export { warnUnicodeEsc };
