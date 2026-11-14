import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import {
  genDiff,
  type DiffSpan,
  type LineEnding,
} from "./replace-diff.ts";
import { readNormFile, type NormFile } from "./file-reader.ts";
import { editToolSchema, buildEditToolSchema, type ReqParams, type RawReqParams, assertReq, normReq } from "./payload-contract.ts";
import { isRec, literalEscapeHints, makePrepareArguments, splitLines } from "./utils.ts";
import { editResultSchema, withStructuredErrors } from "./structured.ts";
import { loadP, loadGuidelines } from "./prompts.ts";
import { type FileIdentity } from "./fs-write.ts";
import { applyEdit,
  lineHashes,
  planEdit,
  resEdit,
  preserveDeletionSeparators,
  MAX_HASH_LINES,
  RangeStaleError,
  AnchorMismatchError,
  type HEdit,
  type NEdit,
  type StripWarningLocation,
} from "./hashline/index.ts";
import { type RMetrics } from "./replace-response.ts";
import {
  type RPreview,
  type RRState,
} from "./replace-render.ts";
import { loadHashStore, type HashStore } from "./hash-store.ts";
import { adoptAnchors, servedForPath, withAnchorSession } from "./anchor-registry.ts";
import { resolveTarget } from "./fs-write.ts";
import { toCwd, toDisplayPath } from "./paths.ts";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper, resolveEditTargetWithRequirement, throwIfStrictInput, withReplacePrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common.ts";
import { commitEdit } from "./commit.ts";
import { batchMemberFor, executeBatchMember, noteBatchFailure, registerBatchPlanner, type BatchMemberPlan, type BatchPlannerInput } from "./batch.ts";

export { editToolSchema, type ReqParams, assertReq };

export type ReplaceDetails = {
  diff: string;
  patch?: string;
  patchTruncated?: boolean;
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
  diffLineNumbers?: (number | null)[];
  warnings?: string[];
  hints?: string[];
  batch?: { id: number; size: number; last: boolean; total: number; aborted?: boolean; abortMessage?: string };
};

export interface PipelineResult {
  path: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  originalSeparators: LineEnding[];
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  noopEdit?: NEdit;
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
  identity: FileIdentity;
  spans?: DiffSpan[];
  contentSeparators?: (LineEnding | undefined)[];
}


export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
  preloadedNorm?: NormFile;
  served?: ReadonlyMap<string, string>;
  stripWarning?: StripWarningLocation;
  endingOverrides?: (LineEnding | undefined)[];
  preserveDeletionSeparators?: boolean;
  anchorCarry?: number;
}

export function hashSpan(hashes: string[], from: string, to: string): [number, number] | undefined {
  const a = hashes.indexOf(from);
  const b = hashes.indexOf(to);
  if (a < 0 || b < 0) return undefined;
  return [Math.min(a, b), Math.max(a, b)];
}

export function spanForEdit(originalHashes: string[], from: string, to: string, resultContent: string): DiffSpan | undefined {
  const span = hashSpan(originalHashes, from, to);
  if (!span) return undefined;
  const replacementCount = splitLines(resultContent).length - (originalHashes.length - (span[1] - span[0] + 1));
  return { start: span[0], end: span[1], replacementCount };
}
export async function noteAnchorError(absolutePath: string, error: unknown, noPersist?: boolean): Promise<void> {
  if (noPersist === true) return;
  if (error instanceof RangeStaleError) {
    adoptAnchors(absolutePath, error.rangeServedMap);
  } else if (error instanceof AnchorMismatchError) {
    adoptAnchors(absolutePath, error.feedbackMap);
  }
}

function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  const span = hashSpan(originalHashes, edit.hash_bounds[0].hash, edit.hash_bounds[1].hash);
  const totalRemovedLines = span ? span[1] - span[0] + 1 : 0;
  return {
    totalAddedLines: edit.content_lines.length,
    totalRemovedLines,
  };
}
export function buildReplaceHEdit(params: RawReqParams): { edit: HEdit; warnings: string[] } {
  const editWarnings: string[] = [];
  const anchors = { remove_from: params.remove_from, remove_to: params.remove_to };
  const edit = resEdit({ ...anchors, text: params.text }, editWarnings);
  return { edit, warnings: editWarnings };
}

function planReplaceBatchMember(input: BatchPlannerInput): BatchMemberPlan {
  const req = normReq(input.member.args, "remove");
  assertReq(req);
  const literalEscapes = literalEscapeHints([req.text], "text");
  const built = buildReplaceHEdit(req);
  const effectiveHedit = preserveDeletionSeparators(built.edit, input.base.baseLines, input.base.hashes);
  const planned = planEdit(input.base.content, effectiveHedit, input.base.hashes, {
    filePath: input.displayPath,
    servedHashes: input.served,
    signal: input.signal,
    baseFileLines: input.base.baseLines,
  });
  return {
    hedit: built.edit,
    warnings: [...literalEscapes, ...built.warnings],
    planned,
    foldedLines: 0,
  };
}

registerBatchPlanner("replace", planReplaceBatchMember);

function withEndingOverrides(edit: HEdit, overrides: (LineEnding | undefined)[] | undefined): HEdit {
  if (overrides === undefined) return edit;
  const length = Math.max(edit.content_separators?.length ?? 0, overrides.length);
  const separators: (LineEnding | undefined)[] = new Array(length);
  for (let index = 0; index < length; index++) {
    separators[index] = index < overrides.length ? overrides[index] : edit.content_separators?.[index];
  }
  if (separators.every((ending) => ending === undefined)) {
    return edit.content_separators === undefined ? edit : { ...edit, content_separators: undefined };
  }
  return { ...edit, content_separators: separators };
}

export async function execPipeline(
  targetPath: string,
  params: RawReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {

  const { edit, warnings: editWarnings } = buildReplaceHEdit(params);
  const anchoredEdit = withEndingOverrides(edit, options?.endingOverrides);
  const hashStore = options?.store ?? await loadHashStore();
  const preResolvedPath = await resolveTarget(toCwd(targetPath, cwd));
  const served = options?.served ?? servedForPath(preResolvedPath);
  const { normalized: originalNormalized, bom, originalEnding, endingSeparators: originalSeparators, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath, identity } = await readNormFile(
    targetPath, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options?.noPersist, allocation: options?.noPersist ? "shadow" : "real", preloadedNorm: options?.preloadedNorm },
  );
  const displayPath = toDisplayPath(cwd, absolutePath, targetPath);
  const effectiveEdit = options?.preserveDeletionSeparators === false
    ? anchoredEdit
    : preserveDeletionSeparators(anchoredEdit, splitLines(originalNormalized), originalHashes);

  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(
      originalNormalized,
      effectiveEdit,
      options?.signal,
      originalHashes,
      displayPath,
      served,
      options?.stripWarning,
    );
  } catch (error) {
    await noteAnchorError(absolutePath, error, options?.noPersist);
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const pipeSpan = isNoop ? undefined : spanForEdit(originalHashes, effectiveEdit.hash_bounds[0].hash, effectiveEdit.hash_bounds[1].hash, result);
  if (pipeSpan && options?.anchorCarry !== undefined) pipeSpan.carry = options.anchorCarry;
  const pipeSpans = pipeSpan ? [pipeSpan] : undefined;

  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, {
        content: originalNormalized,
        hashes: originalHashes,
        ...(pipeSpans ? { spans: pipeSpans } : {}),
      }, hashStore, false, true);
  const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
  await throwIfStrictInput(warnings);
  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    effectiveEdit, originalHashes, isNoop,
  );
  return {
    path: displayPath,
    originalNormalized,
    result,
    bom,
    originalEnding,
    originalSeparators,
    hadUtf8DecodeErrors,
    warnings,
    noopEdit: anchorResult.noopEdit,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    resultHashes,
    originalHashes,
    totalAddedLines,
    totalRemovedLines,
    identity,
    ...(pipeSpans ? { spans: pipeSpans } : {}),
    ...(effectiveEdit.content_separators !== undefined ? { contentSeparators: effectiveEdit.content_separators } : {}),
  };
}

export function previewFromPipe(pipe: PipelineResult): RPreview {
  if (pipe.originalNormalized === pipe.result) {
    if (pipe.contentSeparators !== undefined) {
      return { diff: "", path: pipe.path };
    }
    return {
      error: `No changes made to ${pipe.path}. The edit produced identical content.`,
      path: pipe.path,
    };
  }
  const base = genDiff(pipe.originalNormalized, pipe.result, 4, pipe.resultHashes, pipe.originalHashes, undefined, pipe.spans);
  return { diff: base.diff, path: pipe.path };
}
export function previewError(error: unknown): RPreview {
  return { error: error instanceof Error ? error.message : String(error) };
}
export async function compPreview(
  request: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<RPreview> {
  try {
    const normalized = normReq(request, "remove");
    assertReq(normalized);
    const targetPath = await resolveEditTargetWithRequirement({
      removeFrom: (normalized as ReqParams).remove_from,
      removeTo: (normalized as ReqParams).remove_to,
      providedPath: (normalized as ReqParams).path,
      cwd,
    });
    const pipe = await execPipeline(
      targetPath,
      normalized,
      cwd,
      { accessMode: constants.R_OK, noPersist: true, signal },
    );
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

type ToolDef = ToolDefinition<
  any,
  ReplaceDetails,
  RRState
> & { renderShell?: "default" | "self" };

const prepareRemoveArguments = makePrepareArguments("remove");

function prepareReplaceArguments(args: unknown): unknown {
  const prepared = prepareRemoveArguments(args);
  if (isRec(prepared) && typeof prepared.text !== "string" && ("match" in prepared || "replacement" in prepared)) {
    throw new Error('[E_BAD_SHAPE] Replace request received "match"/"replacement" instead of "remove_from"/"remove_to"/"text". To change part of a line, call replace_match with "replace_from", "replace_to", "match", and "replacement".');
  }
  return prepared;
}

export function buildToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): ToolDef {
  const prompted = withReplacePrompts({
    description: loadP("../tool-prompts/replace.md"),
    snippet: loadP("../tool-prompts/replace-snippet.md"),
    guidelines: loadGuidelines("../tool-prompts/replace-guidelines.md"),
  }, flags);
  const parameters = buildEditToolSchema(flags.requirePath);
  return {
    name: "replace",
    label: "Replace",
    description: prompted.description,
    parameters,
    outputSchema: editResultSchema,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    prepareArguments: prepareReplaceArguments,
    renderCall: editRenderCallWrapper(compPreview),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, { diff: "" }, () => withAnchorSession(ctx, async () => {
        const canonical = normReq(params, "remove");
        assertReq(canonical);
        const normalizedParams = canonical;
        const literalEscapes = literalEscapeHints([normalizedParams.text], "text");
        const member = batchMemberFor(_toolCallId);
        const targetPath = await resolveEditTargetWithRequirement({
          removeFrom: normalizedParams.remove_from,
          removeTo: normalizedParams.remove_to,
          providedPath: normalizedParams.path,
          cwd: ctx.cwd,
          anchorTarget: member?.target,
        }).catch((error: unknown) => {
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          if (!member) {
            const pipe = await execPipeline(
              targetPath,
              normalizedParams,
              ctx.cwd,
              { accessMode: constants.R_OK | constants.W_OK, signal },
            );
            return await commitEdit(pipe, {
              path: pipe.path,
              absolutePath,
              mutationTargetPath,
              editAnchors: [normalizedParams.remove_from, normalizedParams.remove_to],
              prefixWarnings: literalEscapes,
              signal,
            });
          }
          return executeBatchMember({
            member,
            targetPath,
            mutationTargetPath,
            cwd: ctx.cwd,
            signal,
          });
        });
      }));
    },
  };
}

export function regReplace(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildToolDef(flags));
}
