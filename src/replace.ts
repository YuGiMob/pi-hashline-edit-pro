import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import {
  genDiff,
  type DiffSpan,
  type LineEnding,
} from "./replace-diff";
import { readNormFile, type NormFile } from "./file-reader";
import { editToolSchema, buildEditToolSchema, type ReqParams, assertReq, normReq } from "./payload-contract";
import { splitLines } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { type FileIdentity } from "./fs-write";
import { applyEdit,
  lineHashes,
  resEdit,
  MAX_HASH_LINES,
  RangeStaleError,
  AnchorMismatchError,
  type HEdit,
  type NEdit,
} from "./hashline";
import { withDedupRows, type RMetrics } from "./replace-response";
import {
  type RPreview,
  type RRState,
} from "./replace-render";
import { loadHashStore, type HashStore } from "./hash-store";
import { adoptAnchors, servedForPath, withAnchorSession } from "./anchor-registry";
import { resolveTarget } from "./fs-write";
import { toCwd, toDisplayPath } from "./paths";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper, resolveEditTargetWithRequirement, throwIfStrictInput, getBoundaryDedupMode, withReplacePrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import { commitEdit, dedupRowsFromFixes } from "./commit";
import { batchMemberFor, executeBatchMember, noteBatchFailure } from "./batch";

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
  batch?: { id: number; size: number; last: boolean; total: number; aborted?: boolean; abortMessage?: string };
};

export interface PipelineResult {
  path: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  noopEdit?: NEdit;
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
  boundaryRemovedLines: number;
  boundaryRemovedLineTexts: string[];
  boundaryDedupAbove: string[];
  boundaryDedupBelow: string[];
  identity: FileIdentity;
  spans?: DiffSpan[];
}


export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
  skipBoundaryDedup?: boolean;
  preloadedNorm?: NormFile;
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
async function noteAnchorError(absolutePath: string, error: unknown, noPersist?: boolean): Promise<void> {
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
  removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  const span = hashSpan(originalHashes, edit.hash_bounds[0].hash, edit.hash_bounds[1].hash);
  const totalRemovedLines = span ? span[1] - span[0] + 1 : 0;
  return {
    totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
    totalRemovedLines,
  };
}

export function buildReplaceHEdit(params: ReqParams): { edit: HEdit; warnings: string[] } {
  const editWarnings: string[] = [];
  const edit = resEdit(
    {
      remove_from: params.remove_from,
      remove_to: params.remove_to,
      replacement_lines: params.replacement_lines,
    },
    editWarnings,
  );
  return { edit, warnings: editWarnings };
}

export async function execPipeline(
  targetPath: string,
  params: ReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {

  const { edit, warnings: editWarnings } = buildReplaceHEdit(params);
  const hashStore = options?.store ?? await loadHashStore();
  const preResolvedPath = await resolveTarget(toCwd(targetPath, cwd));
  const served = servedForPath(preResolvedPath);
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath, identity } = await readNormFile(
    targetPath, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options?.noPersist, allocation: options?.noPersist ? "shadow" : "real", preloadedNorm: options?.preloadedNorm },
  );
  const displayPath = toDisplayPath(cwd, absolutePath, targetPath);

  const dedupMode = await getBoundaryDedupMode();
  const effectiveSkipBoundaryDedup = options?.skipBoundaryDedup === true || dedupMode === "off";
  const strictBoundaryDedup = options?.skipBoundaryDedup !== true && dedupMode === "strict";
  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(
      originalNormalized,
      edit,
      options?.signal,
      originalHashes,
      displayPath,
      served,
      effectiveSkipBoundaryDedup,
      strictBoundaryDedup,
    );
  } catch (error) {
    await noteAnchorError(absolutePath, error, options?.noPersist);
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, {
        content: originalNormalized,
        hashes: originalHashes,
      }, hashStore, false, true);
  const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
  await throwIfStrictInput(warnings);
  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    edit, originalHashes, isNoop, anchorResult.autoFixes?.length ?? 0,
  );

  const sortedFixes = dedupRowsFromFixes(anchorResult.autoFixes ?? []);
  const pipeSpan = isNoop ? undefined : spanForEdit(originalHashes, edit.hash_bounds[0].hash, edit.hash_bounds[1].hash, result);
  const pipeSpans = pipeSpan ? [pipeSpan] : undefined;
  return {
    path: displayPath,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    noopEdit: anchorResult.noopEdit,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    resultHashes,
    originalHashes,
    totalAddedLines,
    totalRemovedLines,
    boundaryRemovedLines: anchorResult.autoFixes?.length ?? 0,
    boundaryRemovedLineTexts: sortedFixes.removedTexts,
    boundaryDedupAbove: sortedFixes.above,
    boundaryDedupBelow: sortedFixes.below,
    identity,
    ...(pipeSpans ? { spans: pipeSpans } : {}),
  };
}

export function previewFromPipe(pipe: PipelineResult): RPreview {
  if (pipe.originalNormalized === pipe.result) {
    return {
      error: `No changes made to ${pipe.path}. The edit produced identical content.`,
      path: pipe.path,
    };
  }
  const base = genDiff(pipe.originalNormalized, pipe.result, 4, pipe.resultHashes, pipe.originalHashes, undefined, pipe.spans);
  return { diff: withDedupRows(base.diff, base.lineNumbers, pipe.boundaryDedupAbove, pipe.boundaryDedupBelow).diff, path: pipe.path };
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
    const normalized = normReq(request);
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

export function buildToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): ToolDef {
  const prompted = withReplacePrompts({
    description: loadP("../prompts/replace.md"),
    snippet: loadP("../prompts/replace-snippet.md"),
    guidelines: loadGuide("../prompts/replace-guidelines.md"),
  }, flags);
  const parameters = buildEditToolSchema(flags.requirePath);
  return {
    name: "replace",
    label: "Replace",
    description: prompted.description,
    parameters,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    renderCall: editRenderCallWrapper(compPreview),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withAnchorSession(ctx, async () => {
        const canonical = normReq(params);
        assertReq(canonical);
        const normalizedParams = canonical;
        const targetPath = await resolveEditTargetWithRequirement({
          removeFrom: normalizedParams.remove_from,
          removeTo: normalizedParams.remove_to,
          providedPath: normalizedParams.path,
          cwd: ctx.cwd,
        }).catch((error: unknown) => {
          const member = batchMemberFor(_toolCallId);
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          const dedupMode = await getBoundaryDedupMode();
          const strictBoundaryDedup = dedupMode === "strict";
          const member = batchMemberFor(_toolCallId);
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
              signal,
            });
          }
          let built: { edit: HEdit; warnings: string[] };
          try {
            built = buildReplaceHEdit(normalizedParams);
          } catch (error) {
            noteBatchFailure(member, error);
            throw error;
          }
          return executeBatchMember({
            kind: "replace",
            member,
            targetPath,
            mutationTargetPath,
            cwd: ctx.cwd,
            signal,
            hedit: built.edit,
            extraWarnings: built.warnings,
            skipBoundaryDedup: dedupMode === "off",
            strictBoundaryDedup,
          });
        });
      });
    },
  };
}

export function regReplace(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildToolDef(flags));
}
