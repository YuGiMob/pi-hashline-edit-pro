import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import {
  genDiff,
  type LineEnding,
} from "./replace-diff";
import { readNormFile, type NormFile } from "./file-reader";
import { normReq } from "./replace-normalize";
import { isRec, rejectUnknownFields, abortIf, makePrepareArguments } from "./utils";
import { resolveInCwd } from "./fs-write";
import { applyEdit,
  lineHashes,
  resEdit,
  parseHashRef,
  MAX_HASH_LINES,
  RangeStaleError,
  AnchorMismatchError,
  type HEdit,
  type NEdit,
} from "./hashline";
import { commitEdit } from "./commit";
import type { RMetrics } from "./replace-response";
import {
  makeRenderCall,
  renderEditResult,
  type RPreview,
  type RRState,
} from "./replace-render";
import { loadP, loadGuide } from "./prompts";
import { loadHashStore, findSnapshotPaths, findServedPaths, type HashStore } from "./hash-store";
import { getServed, recordServedSafe } from "./served";
import { noopPayloadKey, markBoundaryNoop, consumeBoundaryBypass, clearBoundaryBypass } from "./boundary-bypass";

const replacementLinesSchema = Type.Array(
  Type.String({
    description:
      "One replacement line. Each element is exactly one line; do not embed \\n inside an element: use separate elements.",
  }),
  {
    description:
      "Replacement lines as an array of strings, one element per line. Use [] to delete the range."
  }
);

const removeFromSchema = Type.String({
  description: "Bare 3-char anchor only (e.g. \"aB3\"): copy just the anchor from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)",
});

const removeToSchema = Type.String({
  description: "Bare 3-char anchor only (e.g. \"aB3\"): copy just the anchor from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)",
});

export const editToolSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Path to edit. Required: always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake." })),
    remove_from: removeFromSchema,
    remove_to: removeToSchema,
    replacement_lines: replacementLinesSchema,
  },
  { additionalProperties: false },
);
export type ReqParams = {
  path: string;
  remove_from: string;
  remove_to: string;
  replacement_lines: string[];
};

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
}

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_lines"]);

export function assertReq(
  request: unknown,
): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (
    typeof request.remove_from !== "string" ||
    typeof request.remove_to !== "string" ||
    !Array.isArray(request.replacement_lines) ||
    request.replacement_lines.some((line) => typeof line !== "string")
  ) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_lines" (array of strings, one per line; use [] to delete).',
    );
  }
}

async function resolveMissingPath(
  request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
  if (typeof request.path === "string") return undefined;
  const from = request.remove_from;
  const to = request.remove_to;
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const hashes: string[] = [];
  for (const ref of [from, to]) {
    try {
      hashes.push(parseHashRef(ref).hash);
    } catch {
      return undefined;
    }
  }
  let store: HashStore;
  try {
    store = await loadHashStore();
  } catch {
    return undefined;
  }
  const matches = [...new Set([...findSnapshotPaths(store, hashes), ...findServedPaths(store, hashes)])];
  if (matches.length === 1) {
    return {
      path: matches[0]!,
      warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]}.`,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}.`,
    );
  }
  return undefined;
}

export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
  skipBoundaryDedup?: boolean;
  preloadedNorm?: NormFile;
}

function collectRemovedHashes(
  edit: HEdit,
  originalHashes: string[],
): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const startLine = originalHashes.indexOf(startHash);
  const endLine = originalHashes.indexOf(endHash);
  if (startLine >= 0 && endLine >= 0) {
    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    for (let i = firstLine; i <= lastLine; i++) {
      removedHashes.add(originalHashes[i]!);
    }
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
  let totalRemovedLines = 0;
  const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
  if (startLine >= 0 && endLine >= 0) {
    totalRemovedLines = Math.abs(endLine - startLine) + 1;
  }
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
  const edit = resEdit(
    {
      remove_from: params.remove_from,
      remove_to: params.remove_to,
      replacement_lines: params.replacement_lines,
    },
    editWarnings,
  );

  const hashStore = options?.store ?? await loadHashStore();
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
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
    if (options?.noPersist !== true) {
      if (error instanceof RangeStaleError) {
        await recordServedSafe(absolutePath, error.rangeHashes, "range-stale feedback", new Set(originalHashes));
      } else if (error instanceof AnchorMismatchError) {
        await recordServedSafe(absolutePath, error.feedbackHashes, "anchor-mismatch feedback", new Set(originalHashes));
      }
    }
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
  };
}

export async function compPreview(
  request: unknown,
  cwd: string,
): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertReq(normalized);
    const { path, originalNormalized, result, resultHashes, originalHashes } = await execPipeline(
      normalized,
      cwd,
      { accessMode: constants.R_OK, noPersist: true },
    );
    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edit produced identical content.`,
      };
    }

    return { diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
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
    prepareArguments: makePrepareArguments(),
    executionMode: "sequential",
    renderShell: "default",
    renderCall: makeRenderCall(compPreview),
    renderResult(result, { isPartial }, theme, context) {
      return renderEditResult(
        result as {
          content?: Array<{ type: string; text?: string }>;
          details?: ReplaceDetails;
        },
        isPartial,
        theme,
        context,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      const resolution = isRec(canonical) ? await resolveMissingPath(canonical) : undefined;
      if (resolution && isRec(canonical)) {
        canonical.path = resolution.path;
      }
      assertReq(canonical);

      const normalizedParams = canonical;
      const path = normalizedParams.path;
      const { absolute: absolutePath, resolved: mutationTargetPath } = await resolveInCwd(path, ctx.cwd);
      const noopPayload = noopPayloadKey(mutationTargetPath, normalizedParams.remove_from, normalizedParams.remove_to, normalizedParams.replacement_lines);
      const boundaryBypass = consumeBoundaryBypass(mutationTargetPath, noopPayload);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
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
