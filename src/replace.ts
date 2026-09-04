import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { constants } from "fs";
import {
  genDiff,
  type LineEnding,
} from "./replace-diff";
import { readNormFile, type NormFile } from "./file-reader";
import { editToolSchema, type ReqParams, assertReq, normReq } from "./payload-contract";
import { decodeStringArray, isRec } from "./utils";
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
import { commitEdit } from "./commit";
import { withDedupRows, type RMetrics } from "./replace-response";
import {
  type RPreview,
  type RRState,
} from "./replace-render";
import { loadHashStore, type HashStore } from "./hash-store";
import { resolveReplacePath } from "./missing-path";
import { getServed, recordServedSafe } from "./served";
import { noopPayloadKey, markBoundaryNoop, consumeBoundaryBypass, clearBoundaryBypass } from "./boundary-bypass";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper } from "./edit-common";

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

function hashSpan(hashes: string[], from: string, to: string): [number, number] | undefined {
  const a = hashes.indexOf(from);
  const b = hashes.indexOf(to);
  if (a < 0 || b < 0) return undefined;
  return [Math.min(a, b), Math.max(a, b)];
}
async function noteAnchorError(absolutePath: string, error: unknown, scopeHashes: string[], noPersist?: boolean): Promise<void> {
  if (noPersist === true) return;
  if (error instanceof RangeStaleError) await recordServedSafe(absolutePath, error.rangeServedMap, "range-stale feedback", new Set(scopeHashes));
  else if (error instanceof AnchorMismatchError) await recordServedSafe(absolutePath, error.feedbackMap, "anchor-mismatch feedback", new Set(scopeHashes));
}

function collectRemovedHashes(
  edit: HEdit,
  originalHashes: string[],
): Set<string> {
  const span = hashSpan(originalHashes, edit.hash_bounds[0].hash, edit.hash_bounds[1].hash);
  const removedHashes = new Set<string>();
  if (span) {
    for (let i = span[0]; i <= span[1]; i++) removedHashes.add(originalHashes[i]!);
  }
  return removedHashes;
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
  params: ReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {

  const path = params.path;

  const editWarnings: string[] = [];
  let replacementLines = params.replacement_lines;
  const expandedReplacement = decodeStringArray(replacementLines);
  if (expandedReplacement) {
    editWarnings.push('[E_BAD_SHAPE] Unwrapped JSON array syntax from a replacement_lines element.');
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
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath, identity } = await readNormFile(
    path, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options?.noPersist, preloadedNorm: options?.preloadedNorm },
  );

  const served = await getServed(hashStore, absolutePath);
  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(
      originalNormalized,
      edit,
      options?.signal,
      originalHashes,
      path,
      served,
      options?.skipBoundaryDedup,
    );
  } catch (error) {
    await noteAnchorError(absolutePath, error, originalHashes, options?.noPersist);
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const noPersist = options?.noPersist;
  const removedHashes = isNoop
    ? undefined
    : collectRemovedHashes(edit, originalHashes);
  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, {
        content: originalNormalized,
        hashes: originalHashes,
        removedHashes,
      }, hashStore, noPersist !== true);
  const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    edit, originalHashes, isNoop, anchorResult.autoFixes?.length ?? 0,
  );

  const sortedFixes = [...(anchorResult.autoFixes ?? [])].sort((a, b) => a.removedLineIndex - b.removedLineIndex);
  const aboveFixes = sortedFixes.filter((fix) => fix.kind === "leading" || fix.kind === "last-new-before");
  const belowFixes = sortedFixes.filter((fix) => fix.kind === "trailing" || fix.kind === "first-new-after");
  return {
    path,
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
    };
  }
  const base = genDiff(pipe.originalNormalized, pipe.result, 4, pipe.resultHashes, pipe.originalHashes);
  return { diff: withDedupRows(base.diff, base.lineNumbers, pipe.boundaryDedupAbove, pipe.boundaryDedupBelow).diff };
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
    const pipe = await execPipeline(
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

export function buildToolDef(): ToolDef {
  const E_DESC = loadP("../prompts/replace.md");
  const E_SNIPPET = loadP("../prompts/replace-snippet.md");
  const E_GUIDE = loadGuide("../prompts/replace-guidelines.md");
  const parameters = editToolSchema;
  return {
    name: "replace",
    label: "Replace",
    description: E_DESC,
    parameters,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    ...editToolBase,
    renderCall: editRenderCallWrapper(compPreview),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      const resolution = isRec(canonical) ? await resolveReplacePath(canonical) : undefined;
      if (resolution && isRec(canonical)) {
        canonical.path = resolution.path;
      }
      assertReq(canonical);
      const normalizedParams = canonical;
      const path = normalizedParams.path;
      return queuedEdit(path, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
        const noopPayload = noopPayloadKey(mutationTargetPath, normalizedParams.remove_from, normalizedParams.remove_to, normalizedParams.replacement_lines);
        const boundaryBypass = consumeBoundaryBypass(mutationTargetPath, noopPayload);
        const pipe = await execPipeline(
          normalizedParams,
          ctx.cwd,
          { accessMode: constants.R_OK | constants.W_OK, signal, skipBoundaryDedup: boundaryBypass },
        );
        const appliedWarnings = boundaryBypass
          ? ["[E_BOUNDARY_BYPASS] Boundary dedup was off for this call and is back on."]
          : [];
        return commitEdit(pipe, {
          path,
          absolutePath,
          mutationTargetPath,
          signal,
          prefixWarnings: resolution ? [resolution.warning] : [],
          appliedWarnings,
          onApplied: () => clearBoundaryBypass(mutationTargetPath),
          onNoopDedup: () => markBoundaryNoop(mutationTargetPath, noopPayload),
        });
      });
    },
  };
}

export function regReplace(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef());
}
