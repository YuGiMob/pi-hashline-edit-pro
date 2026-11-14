import { HASH_SEP, type NEdit } from "./hashline/index.ts";
import type { ReplaceDetails } from "./replace.ts";
import { genDiff, genPatch, type DiffSpan } from "./replace-diff.ts";
import { visLines, clipLine } from "./utils.ts";
import { annotateLiteralEscapeHints, dedupeLiteralEscapeHints, fidelityHints } from "./edit-fidelity.ts";
import { anchoredLine, anchoredLinesFromDiff, diffAnchorsOmitted, toEditVerb, type EditStructured, type EditVerb, type Json } from "./structured.ts";

export type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: ReplaceDetails;
	structuredContent?: Json;
};

export type RMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type RMeta = {
  editsAttempted: number;
  noopEditsCount: number;
  firstChangedLine?: number;
  lastChangedLine?: number;
  addedLines: number;
  removedLines: number;
};

export interface NoopInput {
	path: string;
	noopEdit: NEdit | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	warnings: string[] | undefined;
	verb?: EditVerb;
}

export interface SuccessInput {
  path: string;
  originalNormalized: string;
  originalHashes: string[];
  result: string;
  resultHashes: string[];
  warnings: string[] | undefined;
  snapshotId?: string;
  editMeta: RMeta;
  spans?: DiffSpan[];
}


export function buildMetrics(args: {
	classification: "applied" | "noop";
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): RMetrics {
	const metrics: RMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		classification: args.classification,
	};
	if (
		args.classification === "applied" &&
		args.firstChangedLine !== undefined &&
		args.lastChangedLine !== undefined
	) {
		metrics.changed_lines = {
			first: args.firstChangedLine,
			last: args.lastChangedLine,
		};
	}
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined)
		metrics.removed_lines = args.removedLines;
	return metrics;
}

function warnBlock(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

function hintBlock(hints: string[] | undefined): string {
	return hints?.length ? `\n\nHints:\n${hints.join("\n")}` : "";
}

function splitNotices(notices: string[] | undefined): { warnings: string[]; hints: string[] } {
	const warnings: string[] = [];
	const hints: string[] = [];
	for (const notice of notices ?? []) (notice.startsWith("[H_") ? hints : warnings).push(notice);
	return { warnings, hints };
}

export function buildNoop(input: NoopInput, noopNoun = "Replacement"): TResult {
	const {
		path,
		noopEdit,
		snapshotId,
		editMeta,
		warnings,
	} = input;

	const noopDetailsText = noopEdit
		? `${noopNoun} for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
		: "The edit produced identical content.";
	const { warnings: noticeWarnings, hints } = splitNotices(warnings);
	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warnBlock(noticeWarnings)}${hintBlock(hints)}`;
	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: noticeWarnings.length,
	});
	const structuredContent: EditStructured = {
		ok: true,
		kind: "edit",
		verb: input.verb ?? "replaced",
		classification: "noop",
		path,
		text,
		diff: "",
		warnings: [...noticeWarnings],
		hints: [...hints],
		firstChangedLine: null,
		anchors: [],
		anchorsOmitted: false,
	};

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			patch: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
      metrics,
      ...(noticeWarnings.length ? { warnings: [...noticeWarnings] } : {}),
      ...(hints.length ? { hints: [...hints] } : {}),
		},
		structuredContent,
	};
}

export function buildChanged(input: SuccessInput, verb = "replaced", diffContextLines = 1, fidelityOptions?: { separatorMoved?: boolean; indentHints?: boolean }): TResult {
  const { path, result, warnings, snapshotId, originalNormalized, originalHashes, editMeta, resultHashes, spans } = input;
  const resultLines = visLines(result);
  const diffResult = genDiff(originalNormalized, result, diffContextLines, resultHashes, originalHashes, undefined, spans);
  const addedLines = editMeta.addedLines;
  const removedLines = editMeta.removedLines;
  const fidelity = fidelityHints(originalNormalized, result, spans, originalHashes, {
    separatorMoved: fidelityOptions?.separatorMoved ?? (verb === "inserted" || verb === "edited"),
    indentHints: fidelityOptions?.indentHints ?? (verb !== "copied" && verb !== "moved"),
    resultHashes,
  });
  const { warnings: noticeWarnings, hints } = splitNotices(fidelity.length > 0 ? [...(warnings ?? []), ...fidelity] : warnings);
  const annotatedHints = annotateLiteralEscapeHints(hints, result, spans, resultHashes);
  const dedupedHints = dedupeLiteralEscapeHints(annotatedHints);
  const noticesBlock = `${warnBlock(noticeWarnings)}${hintBlock(dedupedHints)}`;
  const successPrefix = `Successfully ${verb} in ${path}.`;
  const lineSummary = addedLines > 0 || removedLines > 0
    ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
    : "";
  const emptyAnchor = resultHashes[0];
  const text = resultLines.length === 0
    ? emptyAnchor !== undefined
      ? `File is empty. Use replace on ${emptyAnchor}${HASH_SEP} to insert content.`
      : "File is empty. Use replace to insert content."
    : noticesBlock
      ? `${successPrefix}${lineSummary}${noticesBlock}`
      : `${successPrefix}${lineSummary}`;

  const metrics = buildMetrics({
    classification: "applied",
    editsAttempted: editMeta.editsAttempted,
    noopEditsCount: editMeta.noopEditsCount,
    warningsCount: noticeWarnings.length,
    firstChangedLine: editMeta.firstChangedLine,
    lastChangedLine: editMeta.lastChangedLine,
    addedLines,
    removedLines,
  });

  const patchResult = genPatch(path, originalNormalized, result);
	const anchors = resultLines.length === 0
		? (emptyAnchor !== undefined ? [anchoredLine(1, "", emptyAnchor)] : [])
		: anchoredLinesFromDiff(diffResult.diff, diffResult.lineNumbers);
	const anchorsOmitted = resultLines.length > 0 && (diffAnchorsOmitted(diffResult.diff) || (anchors.length === 0 && diffResult.diff.length === 0));
	const structuredContent: EditStructured = {
		ok: true,
		kind: "edit",
		verb: toEditVerb(verb),
		classification: "applied",
		path,
		text,
		diff: diffResult.diff,
		warnings: [...noticeWarnings],
		hints: [...dedupedHints],
		firstChangedLine: editMeta.firstChangedLine ?? diffResult.firstChangedLine ?? null,
		anchors,
		anchorsOmitted,
	};
  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      patch: patchResult.patch,
      ...(patchResult.truncated ? { patchTruncated: true as const } : {}),
      firstChangedLine:
        editMeta.firstChangedLine ?? diffResult.firstChangedLine,
      snapshotId,
      metrics,
      diffLineNumbers: diffResult.lineNumbers.map((line) => line ?? null),
      ...(noticeWarnings.length ? { warnings: [...noticeWarnings] } : {}),
      ...(dedupedHints.length ? { hints: [...dedupedHints] } : {}),
    },
    structuredContent,
  };
}
