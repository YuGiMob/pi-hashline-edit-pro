import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { constants } from "fs";
import { relative } from "path";
import {
  genDiff,
  type LineEnding,
} from "./replace-diff";
import { readNormFile, type NormFile } from "./file-reader";
import { editToolSchema, buildEditToolSchema, type ReqParams, assertReq, normReq } from "./payload-contract";
import { decodeStringArray } from "./utils";
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
import { adoptAnchors, servedForPath } from "./anchor-registry";
import { resolveTarget } from "./fs-write";
import { toCwd } from "./paths";
import { noopPayloadKey, markBoundaryNoop, consumeBoundaryBypass, clearBoundaryBypass } from "./boundary-bypass";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper, resolveEditTargetWithRequirement, throwIfStrictInput, isBoundaryDedupEnabled, withReplacePrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import { commitBatched } from "./batch";

export { editToolSchema, type ReqParams, assertReq };

export type ReplaceDetails = {
  diff: string;
  patch?: string;
  patchTruncated?: boolean;
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
  diffLineNumbers?: (number|undefined)[];
  warnings?: string[];
  batch?: { id: number; size: number; last: boolean };
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
  hadBoundaryDedup: boolean;
  boundaryRemovedLines: number;
  boundaryRemovedLineTexts: string[];
  boundaryDedupAbove: string[];
  boundaryDedupBelow: string[];
  identity: FileIdentity;
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
async function noteAnchorError(absolutePath: string, error: unknown, scopeHashes: string[], noPersist?: boolean): Promise<void> {
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

export async function execPipeline(
  targetPath: string,
  params: ReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {

  const editWarnings: string[] = [];
  let replacementLines = params.replacement_lines;
  const expandedReplacement = decodeStringArray(replacementLines);
  if (expandedReplacement) {
    editWarnings.push('[W_BAD_SHAPE] Unwrapped JSON array syntax from a replacement_lines element.');
    replacementLines = expandedReplacement;
  }
  const edit = resEdit(
    {
      remove_from: params.remove_from,
      remove_to: params.remove_to,
      replacement_lines: replacementLines,
    },
    editWarnings,
  );

  const hashStore = options?.store ?? await loadHashStore();
  const preResolvedPath = await resolveTarget(toCwd(targetPath, cwd));
  const served = servedForPath(preResolvedPath);
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath, identity } = await readNormFile(
    targetPath, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options?.noPersist, allocation: options?.noPersist ? "shadow" : "real", preloadedNorm: options?.preloadedNorm },
  );
  const displayPath = relative(cwd, absolutePath).replace(/\\/g, "/") || targetPath;

  const dedupEnabled = await isBoundaryDedupEnabled();
  const effectiveSkipBoundaryDedup = options?.skipBoundaryDedup === true || !dedupEnabled;
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
    );
  } catch (error) {
    await noteAnchorError(absolutePath, error, originalHashes, options?.noPersist);
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

  const sortedFixes = [...(anchorResult.autoFixes ?? [])].sort((a, b) => a.removedLineIndex - b.removedLineIndex);
  const aboveFixes = sortedFixes.filter((fix) => fix.kind === "leading" || fix.kind === "last-new-before");
  const belowFixes = sortedFixes.filter((fix) => fix.kind === "trailing" || fix.kind === "first-new-after");
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
    hadBoundaryDedup: (anchorResult.autoFixes?.length ?? 0) > 0,
    boundaryRemovedLines: anchorResult.autoFixes?.length ?? 0,
    boundaryRemovedLineTexts: sortedFixes.map((fix) => fix.removedLine),
    boundaryDedupAbove: aboveFixes.map((fix) => fix.removedLine),
    boundaryDedupBelow: belowFixes.map((fix) => fix.removedLine),
    identity,
  };
}

export function previewFromPipe(pipe: PipelineResult): RPreview {
  if (pipe.originalNormalized === pipe.result) {
    return {
      error: `No changes made to ${pipe.path}. The edit produced identical content.`,
      path: pipe.path,
    };
  }
  const base = genDiff(pipe.originalNormalized, pipe.result, 4, pipe.resultHashes, pipe.originalHashes);
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
      const canonical = normReq(params);
      assertReq(canonical);
      const normalizedParams = canonical;
      const targetPath = await resolveEditTargetWithRequirement({
        removeFrom: normalizedParams.remove_from,
        removeTo: normalizedParams.remove_to,
        providedPath: normalizedParams.path,
        cwd: ctx.cwd,
      });
      return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
        const dedupOn = await isBoundaryDedupEnabled();
        const noopPayload = noopPayloadKey(mutationTargetPath, normalizedParams.remove_from, normalizedParams.remove_to, normalizedParams.replacement_lines);
        const boundaryBypass = dedupOn ? consumeBoundaryBypass(mutationTargetPath, noopPayload) : false;
        const pipe = await execPipeline(
          targetPath,
          normalizedParams,
          ctx.cwd,
          { accessMode: constants.R_OK | constants.W_OK, signal, skipBoundaryDedup: boundaryBypass },
        );
        const appliedWarnings = boundaryBypass
          ? ["[W_BOUNDARY_BYPASS] Boundary dedup was off for this call and is back on."]
          : [];
        return commitBatched(pipe, {
          path: pipe.path,
          absolutePath,
          mutationTargetPath,
          editAnchors: [normalizedParams.remove_from, normalizedParams.remove_to],
          signal,
          appliedWarnings,
          onApplied: () => { if (dedupOn) clearBoundaryBypass(mutationTargetPath); },
          onNoopDedup: dedupOn ? () => markBoundaryNoop(mutationTargetPath, noopPayload) : undefined,
        }, _toolCallId, "replace");
      });
    },
  };
}

export function regReplace(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildToolDef(flags));
}
