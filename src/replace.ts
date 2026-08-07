import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import {
  genDiff,
  restoreEndings,
  type LineEnding,
} from "./replace-diff";
import { readNormFile } from "./file-reader";
import { normReq, normalizeFilePath, tryParseContentLines } from "./replace-normalize";
import { isRec, has, rejectUnknownFields, abortIf } from "./utils";
import { resolveTarget, writeAtomic } from "./fs-write";
import { applyEdit,
  lineHashes,
  resEdit,
  MAX_HASH_LINES,
  type HEdit,
  type NEdit,
} from "./hashline";
import { toCwd } from "./paths";
import { fileSnap } from "./file-reader";
import {
  buildChanged,
  buildNoop,
  type RMeta,
  type RMetrics,
} from "./replace-response";
import {
  buildAppliedText,
  mkMdTheme,
  fmtCall,
  fmtResultMd,
  getPreviewInput,
  getResultText,
  isApplied,
  type RPreview,
  type RRState,
} from "./replace-render";
import { loadP, loadGuide } from "./prompts";
import { saveUndo } from "./replace-undo";
import { loadHashStore, type HashStore } from "./hash-store";

const contentLinesSchema = Type.Array(Type.String(), {
  description:
    "Replacement content, one string per line; entries must not contain line breaks. Use [] to delete the range."
});

const hashRangeInclSchema = Type.Array(
  Type.String({ description: "A 3-char HASH from read output" }),
  {
    description: "Pair of 3-char hashes from read output marking the first and last line of the range to replace (inclusive).",
    minItems: 2,
    maxItems: 2,
  },
);

export const editToolSchema = Type.Object(
  {
    path: Type.String({ description: "Path to edit" }),
    hash_range_inclusive: hashRangeInclSchema,
    content_lines: contentLinesSchema,
  },
  { additionalProperties: false },
);
export type ReqParams = {
  path: string;
  hash_range_inclusive: [string, string];
  content_lines: string[];
};

export type ReplaceDetails = {
  diff: string;
  diffLineNumbers?: (number | undefined)[];
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
};

interface PipelineResult {
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
}

const PREVIEW_DEBOUNCE_MS = 150;

const ROOT_KS = new Set(["path", "content_lines", "hash_range_inclusive"]);

const LEGACY_KS = ["oldText", "newText", "old_text", "new_text", "old_range", "start", "end", "lines", "changes"];

export function assertNoLegacyKeys(request: unknown): void {
  if (!isRec(request)) return;
  for (const legacyKey of LEGACY_KS) {
    if (has(request, legacyKey)) {
      throw new Error(
        `[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {hash_range_inclusive: ["<START>", "<END>"], content_lines: [...]}.`
      );
    }
  }
}

export function assertReq(
  request: unknown,
): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }

  assertNoLegacyKeys(request);

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request.hash_range_inclusive) || !Array.isArray(request.content_lines)) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires both "hash_range_inclusive" and "content_lines" at the top level.',
    );
  }
}

export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
}

function collectRemovedHashes(
  edit: HEdit,
  originalHashes: string[],
): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_range_inclusive[0].hash;
  const endHash = edit.hash_range_inclusive[1].hash;
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
  const startLine = originalHashes.indexOf(edit.hash_range_inclusive[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_range_inclusive[1].hash);
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

  const hashStore = options?.store ?? await loadHashStore();

  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
    path, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore },
  );

  const edit = resEdit({
    hash_range_inclusive: params.hash_range_inclusive,
    content_lines: params.content_lines,
  });
  const anchorResult = applyEdit(
    originalNormalized,
    edit,
    options?.signal,
    originalHashes,
    path,
  );

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
  const warnings = [...(anchorResult.warnings ?? [])];

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
  };
}

export async function compPreview(
  request: unknown,
  cwd: string,
): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertReq(normalized);
    const { path, originalNormalized, result, resultHashes } = await execPipeline(
      normalized,
      cwd,
      { accessMode: constants.R_OK, noPersist: true },
    );

    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edit produced identical content.`,
      };
    }
    const diffResult = genDiff(originalNormalized, result, 4, resultHashes);
    return { diff: diffResult.diff, diffLineNumbers: diffResult.rowLines };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type ToolDef = ToolDefinition<
  any,
  ReplaceDetails,
  RRState
> & { renderShell?: "default" | "self" };

export function reuseText(context: any, content: string): Text {
  const t = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  t.setText(content);
  return t;
}

export function reuseMarkdown(context: any, content: string, theme: any): Markdown {
  const m = context.lastComponent instanceof Markdown
    ? context.lastComponent
    : new Markdown("", 0, 0, mkMdTheme(theme));
  m.setText(content);
  return m;
}

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
    prepareArguments: (args: unknown) => {
      assertNoLegacyKeys(args);
      if (!isRec(args)) return args as any;
      const record = { ...args };
      normalizeFilePath(record);
      if (has(record, "content_lines") && typeof record.content_lines === "string") {
        tryParseContentLines(record, "content_lines");
      }
      return record;
    },
    renderShell: "default",
    renderCall(args, theme, context) {
      const previewInput = getPreviewInput(args);
      const cancelPendingPreview = () => {
        if (context.state.previewTimer) {
          clearTimeout(context.state.previewTimer);
          context.state.previewTimer = undefined;
        }
      };
      if (context.executionStarted) {
        cancelPendingPreview();
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else if (!context.argsComplete || !previewInput) {
        cancelPendingPreview();
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else {
        const argsKey = JSON.stringify(previewInput);
        if (context.state.argsKey !== argsKey) {
          cancelPendingPreview();
          context.state.argsKey = argsKey;
          context.state.preview = undefined;
          const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
          context.state.previewGeneration = previewGeneration;
          context.state.previewTimer = setTimeout(() => {
            context.state.previewTimer = undefined;
            compPreview(args, context.cwd)
              .then((preview) => {
                if (
                  context.state.argsKey === argsKey &&
                  context.state.previewGeneration === previewGeneration
                ) {
                  context.state.preview = preview;
                  context.invalidate();
                }
              })
              .catch((err: unknown) => {
                if (
                  context.state.argsKey === argsKey &&
                  context.state.previewGeneration === previewGeneration
                ) {
                  context.state.preview = {
                    error: err instanceof Error ? err.message : String(err),
                  };
                  context.invalidate();
                }
              });
          }, PREVIEW_DEBOUNCE_MS);
        }
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        fmtCall(
          getPreviewInput(args) ?? undefined,
          context.state as RRState,
          context.expanded,
          theme,
        ),
      );
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return reuseText(context, theme.fg("warning", "Editing..."));
      }

      const typedResult = result as {
        content?: Array<{ type: string; text?: string }>;
        details?: ReplaceDetails;
      };
      const renderedText = getResultText(typedResult);

      const renderState = context.state as RRState | undefined;
      if (renderState) {
        if (renderState.previewTimer) {
          clearTimeout(renderState.previewTimer);
          renderState.previewTimer = undefined;
        }
        renderState.preview = undefined;
        renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
      }

      if (context.isError) {
        return renderedText
          ? reuseText(context, `\n${theme.fg("error", renderedText)}`)
          : new Text("", 0, 0);
      }

      if (isApplied(typedResult.details)) {
        const appliedText = buildAppliedText(renderedText, typedResult.details, theme);
        return appliedText ? reuseText(context, appliedText) : new Text("", 0, 0);
      }

      if (!renderedText) return new Text("", 0, 0);
      return reuseMarkdown(context, fmtResultMd(renderedText), theme);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      assertReq(canonical);

      const normalizedParams = canonical;
      const path = normalizedParams.path;
      const absolutePath = toCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);

        const {
          originalNormalized,
          originalHashes,
          result,
          bom,
          originalEnding,
          hadUtf8DecodeErrors,
          warnings,
          noopEdit,
          firstChangedLine,
          lastChangedLine,
          resultHashes,
          totalAddedLines,
          totalRemovedLines,
        } = await execPipeline(
          normalizedParams,
          ctx.cwd,
          { accessMode: constants.R_OK | constants.W_OK, signal },
        );

        const editsAttempted = 1;
        if (originalNormalized === result) {
          let noopSnapshotId: string | undefined;
          try {
            noopSnapshotId = (await fileSnap(absolutePath)).snapshotId;
          } catch (error) {
            console.error("Failed to compute snapshot for noop edit:", error);
          }
          return buildNoop({
            path,
            noopEdit,
            snapshotId: noopSnapshotId,
            editMeta: {
              editsAttempted,
              noopEditsCount: noopEdit ? 1 : 0,
              addedLines: 0,
              removedLines: 0,
            },
            warnings,
          });
        }

        if (hadUtf8DecodeErrors) {
          warnings.push(
            "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
          );
        }

        abortIf(signal);
        const undo = await saveUndo(mutationTargetPath, {
          content: originalNormalized,
          bom,
          originalEnding,
          hashes: originalHashes,
          resultContent: result,
        });
        if (!undo.persisted) {
          throw new Error(
            `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the replace, or use write if the store cannot be recovered.`
          );
        }
        try {
          abortIf(signal);
          await writeAtomic(
            absolutePath,
            bom + restoreEndings(result, originalEnding),
          );
        } catch (error) {
          await undo.restore();
          throw error;
        }
        let updatedSnapshotId: string | undefined;
        try {
          updatedSnapshotId = (await fileSnap(absolutePath)).snapshotId;
        } catch (error) {
          console.error("Failed to compute post-edit snapshot:", error);
        }

        const editMeta: RMeta = {
          editsAttempted,
          noopEditsCount: noopEdit ? 1 : 0,
          firstChangedLine,
          lastChangedLine,
          addedLines: totalAddedLines,
          removedLines: totalRemovedLines,
        };

        const successInput = {
          path,
          originalNormalized,
          originalHashes,
          result,
          resultHashes,
          warnings,
          snapshotId: updatedSnapshotId,
          editMeta,
        };
        return buildChanged(successInput);
      });
    },
  };
}

export function regReplace(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef());
}
