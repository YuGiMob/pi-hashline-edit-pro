import { abortIf, rejectUnknownFields, firstNonEmptyIndex, lastNonEmptyIndex, clipLine, getCached } from "../utils";
import { HASH_SEP, HASH_RUN, stripRowPrefix, canon } from "./hash";
import { parseHashRef, parseText, type Anchor } from "./parse";
import { NEW_CONTENT_NOT_ARRAY_MSG, MAX_RANGE_STALE_LINES } from "../constants";

export type RAnchor = {
	line: number;
	hash: string;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
  content_lines: string[];
  hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
	context?: RAnchor;
}

export interface BDup {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	replacementLineIndex: number;
}

export interface AutoFix {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	removedLine: string;
	removedLineIndex: number;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
  replacement_lines: string[];
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
	if (hashMatches.length === 1) {
		return {
			line: hashMatches[0]!,
			hash: ref.hash,
		};
	}
	return { ref, kind: "ambiguous", candidates: hashMatches };
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
): { text: string; hashes: string[] } {
  assertAligned(fileLines, fileHashes, "fmtMismatch");

  const out: string[] = [];
  const hashes: string[] = [];
  const notFound = mismatches.filter((m) => m.kind === "not_found");
  const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

  const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
  if (notFound.length > 0) {
    out.push(
      `[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. The file changed since read. Call read() for fresh anchors.`
    );
    for (const m of notFound) {
      const ctx = m.context;
      if (!ctx) continue;
      const from = Math.max(1, ctx.line - 1);
      const to = Math.min(fileLines.length, ctx.line + 1);
      const rows: string[] = [];
      for (let ln = from; ln <= to; ln++) {
        hashes.push(fileHashes[ln - 1]!);
        rows.push(`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`);
      }
      out.push("");
      out.push(`  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`);
    }
  }
  if (ambiguous.length > 0) {
    if (out.length > 0) out.push("");
    out.push(
      `[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Call read() for fresh anchors.`
    );
    for (const m of ambiguous) {
      const sample = (m.candidates ?? []).slice(0, 5);
      const more =
        (m.candidates?.length ?? 0) > sample.length
          ? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
          : "";
      for (const line of sample) hashes.push(fileHashes[line - 1]!);
      const lines = sample
        .map((line) => {
          const content = clipLine(fileLines[line - 1] ?? "");
          return `    ${line}: ${fileHashes[line - 1]}│${content}`;
        })
        .join("\n");
        out.push(
          `  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
        );
    }
  }

  return { text: out.join("\n"), hashes };
}


const ITEM_KS = new Set(["replacement_lines", "remove_from", "remove_to"]);

function assertItem(edit: Record<string, unknown>): void {
  rejectUnknownFields(edit, ITEM_KS, "Edit", "The edit takes only { replacement_lines, remove_from, remove_to }.");

  if ("remove_from" in edit && typeof edit.remove_from !== "string") {
    throw new Error(
      `[E_BAD_SHAPE] Field "remove_from" must be an anchor string (3-char anchor).`,
    );
  }
  if ("remove_to" in edit && typeof edit.remove_to !== "string") {
    throw new Error(
      `[E_BAD_SHAPE] Field "remove_to" must be an anchor string (3-char anchor).`,
    );
  }
  if (!("replacement_lines" in edit)) {
    throw new Error(`[E_BAD_SHAPE] The edit requires a "replacement_lines" array (use [] to delete).`);
  }
  if (!Array.isArray(edit.replacement_lines) || edit.replacement_lines.some((line) => typeof line !== "string")) {
    throw new Error(NEW_CONTENT_NOT_ARRAY_MSG);
  }
  if (typeof edit.remove_from !== "string" || typeof edit.remove_to !== "string") {
    throw new Error(
      `[E_BAD_SHAPE] The edit requires "remove_from" and "remove_to" anchor strings (3-char anchors from read output).`,
    );
  }
}

export const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_RUN})│`);

export function stripAnchorRow(
	trimmed: string,
	entryLabel: string,
	warnings?: string[],
): string {
	const match = trimmed.match(ANCHOR_ROW_RE);
	if (!match) return trimmed;
	const marker =
		match[1] === "+"
			? "diff-preview marker"
			: match[1] === "-"
				? 'leading "-" marker'
				: '"anchor│" prefix';
	warnings?.push(`[E_BAD_REF] Stripped ${marker} from ${entryLabel} "${trimmed}".`);
	return match[2]!;
}

export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
  assertItem(edit as Record<string, unknown>);

  const replaceLines = parseText(edit.replacement_lines, warnings);
  const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
    return stripAnchorRow(ref.trim(), "remove_from/remove_to entry", warnings);
  }) as [string, string];
  return {
    content_lines: replaceLines,
    hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
  };
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

export function stripBarePrefixes(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	const fileHashSet = new Set(fileHashes);
	const stripped: { lineIndex: number; matched: boolean }[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const result = stripRowPrefix(line);
		if (result.kind !== "bare") return line;
		stripped.push({ lineIndex, matched: fileHashSet.has(result.hash ?? "") });
		return result.text;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((s) => `replacement_lines line ${s.lineIndex + 1}`)
		.join(", ");
	const matchedCount = stripped.filter((s) => s.matched).length;
	const guidance =
		matchedCount === 0
			? " Verify it was pasted from read output."
			: "";
	warnings.push(
		`[E_BARE_HASH_PREFIX] Stripped "anchor│" prefix from ${locations}.${guidance}`
	);
	return { ...edit, content_lines: contentLines };
}

export function stripDiffPrefixes(
	edit: HEdit,
	warnings: string[],
): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const result = stripRowPrefix(line);
		if (result.kind !== "plus" && result.kind !== "minus") return line;
		stripped.push(lineIndex);
		return result.text;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped.map((i) => `replacement_lines line ${i + 1}`).join(", ");
	warnings.push(
		`[E_INVALID_PATCH] Stripped diff-preview marker from ${locations}.`
	);
	return { ...edit, content_lines: contentLines };
}

export function swapReversedRanges(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
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
	warnings.push(
		`[E_BAD_OP] Autocorrected: remove_from/remove_to were reversed; swapped them.`
	);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

function trailingDups(
	contentLines: string[],
	fileLines: string[],
	endLine: number,
): BDup[] {
	const start = lastNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(start + 1, fileLines.length - endLine);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start - k] !== fileLines[endLine + k]) break;
		dups.push({ kind: "trailing", replacementLineIndex: start - k });
	}
	return dups;
}

function leadingDups(
	contentLines: string[],
	fileLines: string[],
	startLine: number,
): BDup[] {
	const start = firstNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(contentLines.length - start, startLine - 1);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start + k] !== fileLines[startLine - 2 - k]) break;
		dups.push({ kind: "leading", replacementLineIndex: start + k });
	}
	return dups;
}

function sectionIsUnique(
	canonLines: string[],
	start: number,
	length: number,
): boolean {
	let count = 0;
	for (let i = 0; i + length <= canonLines.length; i++) {
		let k = 0;
		while (k < length && canonLines[i + k] === canonLines[start + k]) k++;
		if (k < length) continue;
		count++;
		if (count > 1) return false;
	}
	return true;
}

function firstNewAfterDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	endLine: number,
): BDup[] {
	const firstNew = findNewEdge(contentLines, rangeLines, false);
	if (!firstNew) return [];
	const maxK = Math.min(contentLines.length - firstNew.index, canonLines.length - endLine);
	let runLen = 0;
	while (
		runLen < maxK &&
		canonLines[endLine + runLen]!.length > 0 &&
		canon(contentLines[firstNew.index + runLen]!) === canonLines[endLine + runLen]!
	) {
		runLen++;
	}
	if (runLen === 0 || !sectionIsUnique(canonLines, endLine, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({ kind: "first-new-after", replacementLineIndex: firstNew.index + k });
	}
	return dups;
}

function lastNewBeforeDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	startLine: number,
): BDup[] {
	const lastNew = findNewEdge(contentLines, rangeLines, true);
	if (!lastNew) return [];
	const maxK = Math.min(lastNew.index + 1, startLine - 1);
	let runLen = 0;
	while (
		runLen < maxK &&
		canonLines[startLine - 2 - runLen]!.length > 0 &&
		canon(contentLines[lastNew.index - runLen]!) === canonLines[startLine - 2 - runLen]!
	) {
		runLen++;
	}
	if (runLen === 0) return [];
	const sectionStart = startLine - 1 - runLen;
	if (!sectionIsUnique(canonLines, sectionStart, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({ kind: "last-new-before", replacementLineIndex: lastNew.index - k });
	}
	return dups;
}

function canonCounts(lines: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = canon(line);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

export function findNewEdge(
	contentLines: string[],
	rangeLines: string[],
	fromEnd: boolean,
): { index: number; line: string } | undefined {
	const multiset = canonCounts(rangeLines);
	const step = fromEnd ? -1 : 1;
	const start = fromEnd ? contentLines.length - 1 : 0;
	for (let i = start; i >= 0 && i < contentLines.length; i += step) {
		const line = contentLines[i]!;
		const key = canon(line);
		if (key.length === 0) continue;
		const count = multiset.get(key) ?? 0;
		if (count > 0) {
			multiset.set(key, count - 1);
		} else {
			return { index: i, line };
		}
	}
	return undefined;
}

export function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: RHEdit | undefined; mismatches: HMismatch[]; boundaryDups: BDup[] } {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryDups: BDup[] = [];

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
		return { resolved: undefined, mismatches, boundaryDups };
	}
	const endLine = endResolved.line;
	const rangeLines = fileLines.slice(startResolved.line - 1, endLine);
	const canonCache = new Map<string, string>();
	const canonLines = fileLines.map((line) => getCached(canonCache, line, canon));
	boundaryDups.push(
		...trailingDups(edit.content_lines, fileLines, endLine),
		...leadingDups(edit.content_lines, fileLines, startResolved.line),
		...firstNewAfterDups(edit.content_lines, rangeLines, canonLines, endLine),
		...lastNewBeforeDups(edit.content_lines, rangeLines, canonLines, startResolved.line),
	);

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
		boundaryDups,
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
		throw new AnchorMismatchError(feedback.text, feedback.hashes);
	}
	return resolved.hash_bounds[0].line;
}

export class RangeStaleError extends Error {
  readonly rangeHashes: string[];
  constructor(message: string, rangeHashes: string[]) {
    super(message);
    this.name = "RangeStaleError";
    this.rangeHashes = rangeHashes;
  }
}

export class AnchorMismatchError extends Error {
  readonly feedbackHashes: string[];
  constructor(message: string, feedbackHashes: string[]) {
    super(message);
    this.name = "AnchorMismatchError";
    this.feedbackHashes = feedbackHashes;
  }
}

export function assertRangeServed(
  resolved: RHEdit,
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlySet<string>,
  filePath?: string,
): void {
  assertAligned(fileLines, fileHashes, "assertRangeServed");
  const startLine = resolved.hash_bounds[0].line;
  const endLine = resolved.hash_bounds[1].line;
  const mismatchLines: number[] = [];
  for (let line = startLine; line <= endLine; line++) {
    if (!served.has(fileHashes[line - 1]!)) mismatchLines.push(line);
  }
  if (mismatchLines.length === 0) return;

  const rangeLength = endLine - startLine + 1;
  const shownLength = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const rows: string[] = [];
  const shownHashes: string[] = [];
  for (let line = startLine; line < startLine + shownLength; line++) {
    const hash = fileHashes[line - 1]!;
    shownHashes.push(hash);
    rows.push(fmtRow(hash, clipLine(fileLines[line - 1])));
  }
  const location = filePath ? ` in ${filePath}` : "";
  const first = mismatchLines[0]!;
  const mismatchText =
    mismatchLines.length === 1
      ? `Line ${first} of the replaced range (lines ${startLine}-${endLine})${location} does not match`
      : `${mismatchLines.length} of ${rangeLength} line(s) in the replaced range (lines ${startLine}-${endLine})${location} do not match`;
  const capHint =
    rangeLength > shownLength
      ? `\n\n[The range has ${rangeLength} lines; showing the first ${shownLength}. Call read() with offset=${startLine + shownLength} to see the rest.]`
      : "";
  const message =
    `[E_RANGE_STALE] ${mismatchText} what was shown. Nothing was modified. Current range with fresh anchors:\n\n${rows.join("\n")}${capHint}`;
  throw new RangeStaleError(message, shownHashes);
}

export { warnUnicodeEsc };
