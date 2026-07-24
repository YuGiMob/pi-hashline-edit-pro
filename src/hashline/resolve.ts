import { abortIf, rejectUnknownFields, lastNonEmpty, firstNonEmpty } from "../utils";
import { HL_BARE_PREFIX_RE } from "./hash";
import { parseHashRef, parseText, type Anchor } from "./parse";
import { CONTENT_LINES_NOT_STRING_MSG } from "../constants";

export type RAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_range_inclusive: [Anchor, Anchor] };
export type RHEdit = {
  content_lines: string[];
  hash_range_inclusive: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
}

export interface BDupWarn {
	kind: "trailing" | "leading";
	survivingLineContent: string;
	survivingLineIndex: number;
	replacementLineContent: string;
	editIndex: number;
}




export interface NEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

export type HTEdit = {
  content_lines: string[];
  hash_range_inclusive: [string, string];
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
			hashMatched: true,
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


export function fmtMismatch(
  mismatches: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath?: string,
): string {
  assertAligned(fileLines, fileHashes, "fmtMismatch");

  const out: string[] = [];
  const notFound = mismatches.filter((m) => m.kind === "not_found");
  const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

  const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
  if (notFound.length > 0) {
    out.push(
      `[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. The file content has changed since those anchors were read. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_range_inclusive of your next replace call.`
    );
  }
  if (ambiguous.length > 0) {
    if (out.length > 0) out.push("");
    out.push(
      `[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_range_inclusive of your next replace call.`
    );
    for (const m of ambiguous) {
      const sample = (m.candidates ?? []).slice(0, 5);
      const more =
        (m.candidates?.length ?? 0) > sample.length
          ? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
          : "";
      const lines = sample
        .map((line) => {
          const content = fileLines[line - 1] ?? "";
          return `    ${line}: ${fileHashes[line - 1]}│${content}`;
        })
        .join("\n");
        out.push(
          `  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
        );
    }
  }

  return out.join("\n");
}

const ITEM_KS = new Set(["content_lines", "hash_range_inclusive"]);

function isStrArr(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isStrPair(value: unknown): value is [string, string] {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((item) => typeof item === "string")
	);
}

function assertItem(edit: Record<string, unknown>, index: number): void {
  rejectUnknownFields(edit, ITEM_KS, `Edit ${index}`, "Each edit takes only { content_lines, hash_range_inclusive }.");

  if ("hash_range_inclusive" in edit && !isStrPair(edit.hash_range_inclusive)) {
    throw new Error(
      `[E_BAD_SHAPE] Edit ${index} field "hash_range_inclusive" must be a pair of anchor strings [start, end].`,
    );
  }
  if (!("content_lines" in edit)) {
    throw new Error(`[E_BAD_SHAPE] Edit ${index} requires a "content_lines" field. Provide the replacement lines (use [] to delete).`);
  }
  if ("content_lines" in edit && !isStrArr(edit.content_lines)) {
    const val = edit.content_lines;
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          edit.content_lines = parsed;
        } else {
          throw new Error(CONTENT_LINES_NOT_STRING_MSG);
        }
      } catch {
        throw new Error(CONTENT_LINES_NOT_STRING_MSG);
      }
    } else {
      throw new Error(`[E_BAD_SHAPE] Edit ${index} field "content_lines" must be a string array.`);
    }
  }
  if (!isStrPair(edit.hash_range_inclusive)) {
    throw new Error(
      `[E_BAD_SHAPE] Edit ${index} requires an "hash_range_inclusive" pair of anchor strings [start, end].`,
    );
  }
}

export function resEdits(edits: HTEdit[]): HEdit[] {
  const result: HEdit[] = [];
  for (const [index, edit] of edits.entries()) {
    assertItem(edit as Record<string, unknown>, index);

    const replaceLines = parseText(edit.content_lines);
    result.push({
      content_lines: replaceLines,
      hash_range_inclusive: [parseHashRef(edit.hash_range_inclusive[0]), parseHashRef(edit.hash_range_inclusive[1])],
    });
  }
  return result;
}

function warnUnicodeEsc(
  edits: HEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
      );
    }
  }
}

export function assertNoBarePrefix(
  edits: HEdit[],
  fileLines: string[],
  fileHashes: string[],
): void {
  const suspects: { line: string; hash: string; editIndex: number; lineIndex: number }[] = [];
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]!;
    for (let lineIndex = 0; lineIndex < edit.content_lines.length; lineIndex++) {
      const line = edit.content_lines[lineIndex]!;
      const match = line.match(HL_BARE_PREFIX_RE);
      if (match) suspects.push({ line, hash: match[1]!, editIndex, lineIndex });
    }
  }
  if (suspects.length === 0) return;
  const locations = suspects
    .map((s) => `edit ${s.editIndex}, content_lines[${s.lineIndex}]`)
    .join("; ");

  const fileHashSet = new Set(fileHashes);
  const matched = suspects.filter((s) => fileHashSet.has(s.hash));
  const matchedCount = matched.length;

  const exampleLine = `${suspects[0]!.hash}│${suspects[0]!.line}`;

  const linesHint =
    matchedCount === 0
      ? `None match file line hashes.`
      : `${matchedCount} match file line hashes — strong evidence the prefix was copied from read output.`;

  throw new Error(
    `[E_BARE_HASH_PREFIX] ${suspects.length} edit line(s) start with a hash-like prefix (${locations}). Example: ${JSON.stringify(exampleLine)}. ${linesHint} Remove the "HASH│" prefix from each affected content_lines entry; keep only the literal line content that appears after "│" in read output. Remember: content_lines uses file content only, hash_range_inclusive uses hash anchors.`
  );
}

export function descEdit(edit: RHEdit): string {
	return `replace ${edit.hash_range_inclusive[0].hash}-${edit.hash_range_inclusive[1].hash}`;
}


function checkBoundaryDup(
	adjacentLine: string | undefined,
	replacementEdge: string | undefined,
	kind: "trailing" | "leading",
	survivingLineIndex: number,
	editIndex: number,
): BDupWarn | null {
	if (
		adjacentLine === undefined ||
		replacementEdge === undefined ||
		replacementEdge.length === 0 ||
		replacementEdge !== adjacentLine
	) return null;
  return {
    kind,
    survivingLineContent: adjacentLine,
    survivingLineIndex,
    replacementLineContent: replacementEdge,
    editIndex,
  };
}


export function valEdits(
	edits: HEdit[],
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: RHEdit[]; mismatches: HMismatch[]; boundaryWarnings: BDupWarn[] } {
	assertAligned(fileLines, fileHashes, "valEdits");
	const resolved: RHEdit[] = [];
	const mismatches: HMismatch[] = [];
	const boundaryWarnings: BDupWarn[] = [];

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

	for (const edit of edits) {
		abortIf(signal);
		const startResolved = tryResolve(edit.hash_range_inclusive[0]);
		const endResolved = tryResolve(edit.hash_range_inclusive[1]);
		if (!startResolved || !endResolved) {
			continue;
		}
		if (startResolved.line > endResolved.line) {
			throw new Error(
				`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_range_inclusive[0].hash} and ${edit.hash_range_inclusive[1].hash}).`,
			);
		}
		const endLine = endResolved.line;
		const nextLine = fileLines[endLine];
		const replacementLastLine = lastNonEmpty(edit.content_lines);
		const trailing = checkBoundaryDup(nextLine, replacementLastLine, "trailing", endLine, resolved.length);
		if (trailing) boundaryWarnings.push(trailing);
		const prevLine = fileLines[startResolved.line - 2];
		const replacementFirstLine = firstNonEmpty(edit.content_lines);
		const leading = checkBoundaryDup(prevLine, replacementFirstLine, "leading", startResolved.line - 2, resolved.length);
		if (leading) boundaryWarnings.push(leading);
		resolved.push({
			content_lines: edit.content_lines,
			hash_range_inclusive: [startResolved, endResolved],
		});
	}

	return { resolved, mismatches, boundaryWarnings };
}

export { warnUnicodeEsc };