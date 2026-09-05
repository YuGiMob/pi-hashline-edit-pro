import { formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { NEdit } from "./hashline";
import { HASH_SEP } from "./hashline";
import type { ReplaceDetails } from "./replace";
import { genDiff, genPatch } from "./replace-diff";
import { visLines, clipLine } from "./utils";
import { DEDUP_ANCHOR } from "./constants";

export type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: ReplaceDetails;
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
	boundaryRemovedLines?: number;
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
  boundaryDedupAbove?: string[];
  boundaryDedupBelow?: string[];
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

export function buildNoop(input: NoopInput, noopNoun = "Replacement"): TResult {
	const {
		path,
		noopEdit,
		snapshotId,
		editMeta,
		warnings,
		boundaryRemovedLines,
	} = input;

	const noopDetailsText = noopEdit
		? `${noopNoun} for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
		: "The edit produced identical content.";
	const dedupNote =
		boundaryRemovedLines !== undefined && boundaryRemovedLines > 0
			? `\nBoundary dedup removed ${boundaryRemovedLines} line(s); resend the same edit to apply it literally.`
			: "";

	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${dedupNote}${warnBlock(warnings)}`;

	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			patch: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
			metrics,
		},
	};
}
export function fmtDedupRow(line: string): string {
  const row = `${DEDUP_ANCHOR}${HASH_SEP}${line}`;
  if (Buffer.byteLength(row, "utf-8") <= DEFAULT_MAX_BYTES) return row;
  const size = formatSize(Buffer.byteLength(row, "utf-8"));
  const limit = formatSize(DEFAULT_MAX_BYTES);
  return `${DEDUP_ANCHOR}${HASH_SEP}[Row is ${size}, exceeds ${limit}; content not shown. Use read to see the full line.]`;
}

export function isDedupRow(line: string): boolean {
  return line.startsWith(`${DEDUP_ANCHOR}${HASH_SEP}`);
}

export function isChangeRow(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

export function withDedupRows(diff: string, lineNumbers: (number | undefined)[], above: string[] | undefined, below: string[] | undefined): { diff: string; lineNumbers: (number | undefined)[] } {
  const top = (above ?? []).map(fmtDedupRow);
  const bottom = (below ?? []).map(fmtDedupRow);
  if (top.length === 0 && bottom.length === 0) return { diff, lineNumbers };
  if (diff.length === 0) return { diff: [...top, ...bottom].join("\n"), lineNumbers: [...lineNumbers, ...[...top, ...bottom].map(() => undefined)] };
  const lines = diff.split("\n");
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isChangeRow(lines[i]!)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { diff: `${diff}\n${[...top, ...bottom].join("\n")}`, lineNumbers: [...lineNumbers, ...[...top, ...bottom].map(() => undefined)] };
  const out = [...lines];
  const nums = [...lineNumbers];
  out.splice(last + 1, 0, ...bottom);
  nums.splice(last + 1, 0, ...bottom.map(() => undefined));
  out.splice(first, 0, ...top);
  nums.splice(first, 0, ...top.map(() => undefined));
  return { diff: out.join("\n"), lineNumbers: nums };
}

export function buildChanged(input: SuccessInput, verb = "replaced"): TResult {
  const { path, result, warnings, snapshotId, originalNormalized, originalHashes, editMeta, resultHashes, boundaryDedupAbove, boundaryDedupBelow } = input;
  const resultLines = visLines(result);
  const baseDiff = genDiff(originalNormalized, result, 1, resultHashes, originalHashes);
  const diffResult = withDedupRows(baseDiff.diff, baseDiff.lineNumbers, boundaryDedupAbove, boundaryDedupBelow);
  const addedLines = editMeta.addedLines;
  const removedLines = editMeta.removedLines;
  const warningsBlock = warnBlock(warnings);
  const successPrefix = `Successfully ${verb} in ${path}.`;
  const lineSummary = addedLines > 0 || removedLines > 0
    ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
    : "";
  const text = resultLines.length === 0
    ? "File is empty. Use replace to insert content."
    : warningsBlock
      ? `${successPrefix}${lineSummary}${warningsBlock}`
      : `${successPrefix}${lineSummary}`;

  const metrics = buildMetrics({
    classification: "applied",
    editsAttempted: editMeta.editsAttempted,
    noopEditsCount: editMeta.noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    firstChangedLine: editMeta.firstChangedLine,
    lastChangedLine: editMeta.lastChangedLine,
    addedLines,
    removedLines,
  });

  const patchResult = genPatch(path, originalNormalized, result);
  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      patch: patchResult.patch,
      ...(patchResult.truncated ? { patchTruncated: true as const } : {}),
      firstChangedLine:
        editMeta.firstChangedLine ?? baseDiff.firstChangedLine,
      snapshotId,
      metrics,
      diffLineNumbers: diffResult.lineNumbers,
    },
  };
}
