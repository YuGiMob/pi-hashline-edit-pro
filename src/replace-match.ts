import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { execPipeline, noteAnchorError, previewFromPipe, previewError, type ReplaceDetails } from "./replace";
import { commitEdit } from "./commit";
import { readNormFile, type NormFile } from "./file-reader";
import { fmtRegion, MAX_HASH_LINES, parseHashRef, planEdit, preserveDeletionSeparators, resEdit, resolveAnchorLine, stripAnchorRow, type Anchor } from "./hashline";
import { servedForPath, withAnchorSession } from "./anchor-registry";
import { batchMemberFor, executeBatchMember, noteBatchFailure, registerBatchPlanner, type BatchMemberPlan, type BatchPlannerInput } from "./batch";
import { loadP, loadGuidelines } from "./prompts";
import {
  assertReplaceMatchReq,
  buildReplaceMatchToolSchema,
  getReplaceMatchInput,
  normReq,
  replacementFragment,
  singleLineMatch,
  type ReplaceMatchReq,
} from "./payload-contract";
import { literalEscapeHints, makePrepareArguments, splitLines } from "./utils";
import { type LineEnding } from "./normalize";
import { MAX_RANGE_STALE_LINES } from "./constants";
import { formatCharEscape, isFidelitySensitiveChar } from "./edit-fidelity";
import {
  assertBoundaryLinesServed,
  DEFAULT_EDIT_FLAGS,
  editRenderResultWrapper,
  editToolBase,
  queuedEdit,
  resolveEditTargetWithRequirement,
  throwIfStrictInput,
  tryResolveEditTarget,
  trustRangeServed,
  withReplaceMatchPrompts,
  type EditToolFlags,
} from "./edit-common";
import { makeRenderCall, type RPreview, type RRState } from "./replace-render";
import { editResultSchema, withStructuredErrors } from "./structured";
import { notIsolatedMessage, scanMatchRange } from "./match-isolation";

interface MatchRefs {
  from: Anchor;
  to: Anchor;
}

export interface MatchPlan {
  editParams: { remove_from: string; remove_to: string; text: string };
  contentSeparators: (LineEnding | undefined)[];
  servedOverride?: ReadonlyMap<string, string>;
}

function linesToPayloadText(lines: string[]): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return lines[lines.length - 1] === "" ? `${joined}\n` : joined;
}

function fileInheritedEndings(lineCount: number): (LineEnding | undefined)[] {
  return new Array<LineEnding | undefined>(lineCount).fill(undefined);
}

const NEAR_MISS_MIN_MATCH_CHARS = 20;
const NEAR_MISS_MATCH_RATIO = 0.8;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let suffix = 0;
  while (suffix < limit && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return suffix;
}

function charAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(index)!);
}

function codePointStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff ? index - 1 : index;
}

function describeChar(char: string | undefined): string {
  if (char === undefined) return "the end of the text";
  const codePoint = char.codePointAt(0)!;
  return isFidelitySensitiveChar(char) || codePoint > 0x7e ? `"${formatCharEscape(char)}"` : JSON.stringify(char);
}

function nearMissDetail(matchText: string, lineText: string, line: number): string | undefined {
  if (matchText.length < NEAR_MISS_MIN_MATCH_CHARS) return undefined;
  const prefix = commonPrefixLength(matchText, lineText);
  const suffix = commonSuffixLength(matchText, lineText, prefix);
  const comparable = Math.min(matchText.length, lineText.length);
  if (prefix + suffix < Math.floor(comparable * NEAR_MISS_MATCH_RATIO)) return undefined;
  const fileStart = codePointStart(lineText, prefix);
  const matchStart = codePointStart(matchText, prefix);
  const column = [...lineText.slice(0, fileStart)].length + 1;
  return `the first mismatch is at line ${line}, col ${column}: the file has ${describeChar(charAt(lineText, fileStart))} where match has ${describeChar(charAt(matchText, matchStart))}.`;
}

function formatMatchRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function notFoundMessage(displayPath: string, start: number, end: number, fileHashes: string[], fileLines: string[], rangeText: string, matchText: string): string {
  const rangeLength = end - start + 1;
  const shownCount = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const shown = fmtRegion(fileHashes.slice(start - 1, start - 1 + shownCount), fileLines.slice(start - 1, start - 1 + shownCount));
  const more = rangeLength > shownCount ? `\n[The range has ${rangeLength} lines; showing the first ${shownCount}. Call read with offset=${start + shownCount} to see the rest.]` : "";
  const nearMiss = start === end ? nearMissDetail(matchText, rangeText, start) : undefined;
  const advice = nearMiss !== undefined
    ? `${nearMiss} That looks like a retyped copy of the line; send only the fragment that changes (copy it from the served row), or use replace with the same anchor.`
    : "Copy only the fragment that changes from the served row (a trailing line break is accepted and dropped) and retry; for a whole-line rewrite use replace with the same anchors.";
  return `[E_SUBSTRING_NOT_FOUND] "match" was not found in ${formatMatchRange(start, end)} of ${displayPath}. Current rows:\n\n${shown}${more}\n\n${advice}`;
}

export function parseMatchAnchors(req: ReplaceMatchReq): { refs: MatchRefs; warnings: string[] } {
  const warnings: string[] = [];
  const from = stripAnchorRow(req.replace_from.trim(), "replace_from entry", warnings);
  const to = stripAnchorRow(req.replace_to.trim(), "replace_to entry", warnings);
  return { refs: { from: parseHashRef(from, warnings, "replace_from"), to: parseHashRef(to, warnings, "replace_to") }, warnings };
}

function replacementLinesFor(raw: string): string[] {
  const fragment = replacementFragment(raw);
  return fragment.length === 0 ? [""] : fragment.split("\n");
}

function replaceInLine(
  line: string,
  matchText: string,
  replacementLines: readonly string[],
): string[] {
  const lines: string[] = [""];
  let cursor = 0;
  let replaced = false;
  for (;;) {
    const found = line.indexOf(matchText, cursor);
    if (found < 0) break;
    lines[lines.length - 1] += line.slice(cursor, found) + replacementLines[0]!;
    for (let index = 1; index < replacementLines.length; index++) lines.push(replacementLines[index]!);
    cursor = found + matchText.length;
    replaced = true;
  }
  if (!replaced) return [line];
  lines[lines.length - 1] += line.slice(cursor);
  return lines;
}

export function buildReplaceMatchEdit(
  req: ReplaceMatchReq,
  refs: MatchRefs,
  preload: NormFile,
  displayPath: string,
  served?: ReadonlyMap<string, string>,
): MatchPlan {
  const matchText = singleLineMatch(req.match);
  const fragmentLines = replacementLinesFor(req.replacement);
  const fileLines = splitLines(preload.normalized);
  const fromLine = resolveAnchorLine(refs.from, fileLines, preload.fileHashes, displayPath);
  const toLine = resolveAnchorLine(refs.to, fileLines, preload.fileHashes, displayPath);
  const start = Math.min(fromLine, toLine);
  const end = Math.max(fromLine, toLine);
  assertBoundaryLinesServed(fileLines, preload.fileHashes, served, start, end, displayPath);
  const rangeLines = fileLines.slice(start - 1, end);
  const scan = scanMatchRange({
    lines: rangeLines,
    anchors: preload.fileHashes.slice(start - 1, end),
    matchText,
    firstLine: start,
  });
  if (scan.occurrences === 0) {
    throw new Error(notFoundMessage(displayPath, start, end, preload.fileHashes, fileLines, linesToPayloadText(rangeLines), matchText));
  }
  if (req.allowEmbeddedMatch !== true && scan.violations.length > 0) {
    throw new Error(notIsolatedMessage({ matchText, displayPath, startLine: start, endLine: end, scan }));
  }
  const replacementLines: string[] = [];
  for (const line of rangeLines) replacementLines.push(...replaceInLine(line, matchText, fragmentLines));
  const replacement = linesToPayloadText(replacementLines);
  const startRef = fromLine <= toLine ? refs.from : refs.to;
  const endRef = fromLine <= toLine ? refs.to : refs.from;
  const servedOverride = trustRangeServed(fileLines, preload.fileHashes, served, start, end);
  return {
    editParams: {
      remove_from: startRef.hash,
      remove_to: endRef.hash,
      text: replacement,
    },
    contentSeparators: fileInheritedEndings(replacementLines.length),
    ...(servedOverride !== undefined ? { servedOverride } : {}),
  };
}

function planReplaceMatchBatchMember(input: BatchPlannerInput): BatchMemberPlan {
  const req = normReq(input.member.args, "replace");
  assertReplaceMatchReq(req);
  const { refs, warnings } = parseMatchAnchors(req);
  const hints = [...literalEscapeHints([req.match], "match"), ...literalEscapeHints([req.replacement], "replacement")];
  const preload = { normalized: input.base.content, fileHashes: input.base.hashes } as NormFile;
  const matchPlan = buildReplaceMatchEdit(req, refs, preload, input.displayPath, input.served);
  const resWarnings: string[] = [];
  const hedit = resEdit(matchPlan.editParams, resWarnings);
  const effectiveHedit = preserveDeletionSeparators(hedit, input.base.baseLines, input.base.hashes);
  const planned = planEdit(input.base.content, effectiveHedit, input.base.hashes, {
    filePath: input.displayPath,
    servedHashes: matchPlan.servedOverride ?? input.served,
    signal: input.signal,
    baseFileLines: input.base.baseLines,
  });
  return {
    hedit,
    warnings: [...warnings, ...hints, ...resWarnings],
    contentSeparators: matchPlan.contentSeparators,
    planned,
    foldedLines: 0,
  };
}

registerBatchPlanner("replace_match", planReplaceMatchBatchMember);

export async function replaceMatchPreview(request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized = normReq(request, "replace");
    assertReplaceMatchReq(normalized);
    const req = normalized;
    const { refs, warnings } = parseMatchAnchors(req);
    await throwIfStrictInput(warnings);
    const targetPath = await resolveEditTargetWithRequirement({
      removeFrom: req.replace_from,
      removeTo: req.replace_to,
      providedPath: req.path,
      cwd,
    });
    const preload = await readNormFile(targetPath, cwd, {
      accessMode: constants.R_OK,
      maxLines: MAX_HASH_LINES,
      noPersist: true,
      allocation: "shadow",
      signal,
    });
    const plan = buildReplaceMatchEdit(req, refs, preload, targetPath, servedForPath(preload.absolutePath));
    const pipe = await execPipeline(targetPath, plan.editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      served: plan.servedOverride,
      endingOverrides: plan.contentSeparators,
      signal,
    });
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

type ReplaceMatchToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildReplaceMatchToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): ReplaceMatchToolDef {
  const prompted = withReplaceMatchPrompts({
    description: loadP("../tool-prompts/replace-match.md"),
    snippet: loadP("../tool-prompts/replace-match-snippet.md"),
    guidelines: loadGuidelines("../tool-prompts/replace-match-guidelines.md"),
  }, flags);
  return {
    name: "replace_match",
    label: "Replace Match",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    prepareArguments: makePrepareArguments("replace"),
    parameters: buildReplaceMatchToolSchema(flags.requirePath),
    outputSchema: editResultSchema,
    renderCall: makeRenderCall(replaceMatchPreview, {
      getInput: getReplaceMatchInput,
      toolName: "replace_match",
      resolveTarget: (input) => (typeof input.replace_from === "string" ? tryResolveEditTarget(input.replace_from, input.replace_to) : undefined),
    }),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, { diff: "" }, () => withAnchorSession(ctx, async () => {
        const normalized = normReq(params, "replace");
        assertReplaceMatchReq(normalized);
        const req = normalized;
        const member = batchMemberFor(_toolCallId);
        let refs: MatchRefs;
        let warnings: string[];
        try {
          ({ refs, warnings } = parseMatchAnchors(req));
          if (member === undefined) await throwIfStrictInput(warnings);
        } catch (error) {
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        const hints = [...literalEscapeHints([req.match], "match"), ...literalEscapeHints([req.replacement], "replacement")];
        const targetPath = await resolveEditTargetWithRequirement({
          removeFrom: req.replace_from,
          removeTo: req.replace_to,
          providedPath: req.path,
          cwd: ctx.cwd,
          anchorTarget: member?.target,
        }).catch((error: unknown) => {
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          if (member) {
            return executeBatchMember({ member, targetPath, mutationTargetPath, cwd: ctx.cwd, signal });
          }
          const preload = await readNormFile(targetPath, ctx.cwd, {
            signal,
            accessMode: constants.R_OK | constants.W_OK,
            maxLines: MAX_HASH_LINES,
          });
          let plan: MatchPlan;
          try {
            plan = buildReplaceMatchEdit(req, refs, preload, targetPath, servedForPath(preload.absolutePath));
          } catch (error) {
            await noteAnchorError(mutationTargetPath, error);
            throw error;
          }
          const pipe = await execPipeline(targetPath, plan.editParams, ctx.cwd, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            preloadedNorm: preload,
            served: plan.servedOverride,
            endingOverrides: plan.contentSeparators,
          });
          return commitEdit(pipe, {
            path: pipe.path,
            absolutePath,
            mutationTargetPath,
            editAnchors: [plan.editParams.remove_from, plan.editParams.remove_to],
            prefixWarnings: [...warnings, ...hints],
            signal,
            verb: "replaced",
            noopNoun: "Replacement",
          });
        });
      }));
    },
  };
}

export function regReplaceMatch(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildReplaceMatchToolDef(flags));
}
