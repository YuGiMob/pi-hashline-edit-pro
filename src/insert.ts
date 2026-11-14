import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { execPipeline, type ReplaceDetails, previewFromPipe, previewError } from "./replace.ts";
import { commitEdit } from "./commit.ts";
import { batchMemberFor, executeBatchMember, noteBatchFailure, registerBatchPlanner, type BatchMemberPlan, type BatchPlannerInput } from "./batch.ts";
import { readNormFile, type NormFile } from "./file-reader.ts";
import { MAX_HASH_LINES, parseHashRef, parsePayloadText, planEdit, preserveDeletionSeparators, resEdit, resolveAnchorLine, type Anchor, type HTEdit, type StripWarningLocation } from "./hashline/index.ts";
import { TEXT_ENDING_NOTE } from "./constants.ts";
import type { LineEnding } from "./normalize.ts";
import { stripAnchorRow } from "./hashline/resolve.ts";
import { withAnchorSession } from "./anchor-registry.ts";
import { loadP, loadGuidelines } from "./prompts.ts";
import { assertInsertReq, normReq, pathRequiredSchema, type InsertReq } from "./payload-contract.ts";
import { anchorCarryIndex, isRec, literalEscapeHints, splitLines } from "./utils.ts";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper, resolveEditTargetWithRequirement, throwIfStrictInput, withInsertPrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common.ts";
import type { RPreview, RRState } from "./replace-render.ts";
import { editResultSchema, withStructuredErrors } from "./structured.ts";
export { assertInsertReq, type InsertReq };

const insertAnchorSchema = Type.String({
  description:
    "5-char anchor of the line to insert next to.",
});

const insertDirectionSchema = Type.Unsafe<"after" | "before">({
  type: "string",
  enum: ["after", "before"],
  description: '"after" or "before"',
});
const insertTextSchema = Type.String({
  description:
    `The exact text to insert; an empty string inserts one blank line. ${TEXT_ENDING_NOTE} Never include the anchor line.`,
});

const insertToolSchema = Type.Object(
  {
    anchor: insertAnchorSchema,
    direction: insertDirectionSchema,
    text: insertTextSchema,
  },
  { additionalProperties: true },
);

export function buildInsertToolSchema(requirePath: boolean): typeof insertToolSchema {
  if (!requirePath) return insertToolSchema;
  return Type.Object(
    {
      path: pathRequiredSchema,
      anchor: insertAnchorSchema,
      direction: insertDirectionSchema,
      text: insertTextSchema,
    },
    { additionalProperties: true },
  ) as typeof insertToolSchema;
}

export function parseInsertAnchor(raw: string): { ref: Anchor; warnings: string[] } {
  const trimmedAnchor = raw.trim();
  const warnings: string[] = [];
  const anchorText = stripAnchorRow(trimmedAnchor, "anchor entry", warnings);
  return { ref: parseHashRef(anchorText, warnings, "anchor"), warnings };
}

export function buildInsertEdit(
  req: InsertReq,
  preload: NormFile,
  ref: Anchor,
  path: string,
): { editParams: HTEdit; anchorLine: string | undefined; contentSeparators: (LineEnding | undefined)[] } {
  const parsed = parsePayloadText(req.text.length === 0 ? "\n" : req.text);
  const fileLines = splitLines(preload.normalized);
  const line = resolveAnchorLine(ref, fileLines, preload.fileHashes, path);
  const anchorLine = preload.normalized.length === 0 ? undefined : fileLines[line - 1];
  const editParams: HTEdit = {
    remove_from: ref.hash,
    remove_to: ref.hash,
    text:
      anchorLine === undefined
        ? [...parsed.lines]
        : req.direction === "after"
          ? [anchorLine, ...parsed.lines]
          : [...parsed.lines, anchorLine],
  };
  const contentSeparators = anchorLine === undefined
    ? parsed.separators
    : req.direction === "after"
      ? [undefined, ...parsed.separators]
      : [...parsed.separators, undefined];
  return { editParams, anchorLine, contentSeparators };
}

function insertStripWarning(anchorLine: string | undefined, direction: "before" | "after"): StripWarningLocation {
  return { label: "text", indexOffset: anchorLine !== undefined && direction === "after" ? -1 : 0 };
}

function insertAnchorCarry(direction: "before" | "after", editParams: HTEdit, anchorLine: string | undefined): number | undefined {
  if (anchorLine === undefined) return undefined;
  return anchorCarryIndex(direction, editParams.text.length - 1);
}

function planInsertBatchMember(input: BatchPlannerInput): BatchMemberPlan {
  const req = normReq(input.member.args);
  assertInsertReq(req);
  const insertWarnings = literalEscapeHints([req.text], "text");
  const { ref, warnings: anchorWarnings } = parseInsertAnchor(req.anchor);
  const basePreload = { normalized: input.base.content, fileHashes: input.base.hashes } as NormFile;
  const built = buildInsertEdit(req, basePreload, ref, input.displayPath);
  const resWarnings: string[] = [];
  const hedit = resEdit(built.editParams, resWarnings);
  const stripWarning = insertStripWarning(built.anchorLine, req.direction);
  const effectiveHedit = preserveDeletionSeparators(hedit, input.base.baseLines, input.base.hashes);
  const planned = planEdit(input.base.content, effectiveHedit, input.base.hashes, {
    filePath: input.displayPath,
    servedHashes: input.served,
    signal: input.signal,
    baseFileLines: input.base.baseLines,
    stripWarning,
  });
  return {
    hedit,
    warnings: [...anchorWarnings, ...insertWarnings, ...resWarnings],
    planned,
    foldedLines: built.anchorLine === undefined ? 0 : 1,
    direction: req.direction,
    stripWarning,
    contentSeparators: built.contentSeparators,
  };
}

registerBatchPlanner("insert", planInsertBatchMember);

export async function insertPreview(request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertInsertReq(normalized);
    const previewReq = normalized as InsertReq;
    const { ref, warnings: previewAnchorWarnings } = parseInsertAnchor(previewReq.anchor);
    await throwIfStrictInput(previewAnchorWarnings);
    const targetPath = await resolveEditTargetWithRequirement({
      anchor: previewReq.anchor,
      providedPath: previewReq.path,
      cwd,
    });
    const preload = await readNormFile(targetPath, cwd, {
      accessMode: constants.R_OK,
      maxLines: MAX_HASH_LINES,
      noPersist: true,
      allocation: "shadow",
      signal,
    });
    const { editParams, anchorLine, contentSeparators } = buildInsertEdit(normalized, preload, ref, targetPath);
    const anchorCarry = insertAnchorCarry(normalized.direction, editParams, anchorLine);
    const pipe = await execPipeline(targetPath, editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      signal,
      stripWarning: insertStripWarning(anchorLine, normalized.direction),
      endingOverrides: contentSeparators,
      ...(anchorCarry !== undefined ? { anchorCarry } : {}),
    });
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

function getInsertInput(args: unknown): { path?: string; anchor?: string; direction?: "before" | "after"; text?: string } | null {
  let normalized: unknown;
  try {
    normalized = normReq(args);
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.anchor !== "string" ||
    (normalized.direction !== "before" && normalized.direction !== "after") ||
    typeof normalized.text !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    anchor: normalized.anchor as string,
    direction: normalized.direction as "before" | "after",
    text: normalized.text,
  };
}

type InsertToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildInsertToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): InsertToolDef {
  const prompted = withInsertPrompts({
    description: loadP("../tool-prompts/insert.md"),
    snippet: loadP("../tool-prompts/insert-snippet.md"),
    guidelines: loadGuidelines("../tool-prompts/insert-guidelines.md"),
  }, flags);
  return {
    name: "insert",
    label: "Insert",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    parameters: buildInsertToolSchema(flags.requirePath),
    outputSchema: editResultSchema,
    renderCall: editRenderCallWrapper(insertPreview, getInsertInput, "insert"),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, { diff: "" }, () => withAnchorSession(ctx, async () => {
        const canonical = normReq(params);
        assertInsertReq(canonical);
        const req = canonical;
        const insertWarnings: string[] = [...literalEscapeHints([req.text], "text")];
        const member = batchMemberFor(_toolCallId);
        const targetPath = await resolveEditTargetWithRequirement({
          anchor: req.anchor,
          providedPath: req.path,
          cwd: ctx.cwd,
          anchorTarget: member?.target,
        }).catch((error: unknown) => {
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        let ref: Anchor;
        let anchorWarnings: string[];
        try {
          ({ ref, warnings: anchorWarnings } = parseInsertAnchor(req.anchor));
          if (member === undefined) await throwIfStrictInput([...anchorWarnings, ...insertWarnings]);
        } catch (error) {
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          if (member) {
            return executeBatchMember({ member, targetPath, mutationTargetPath, cwd: ctx.cwd, signal });
          }
          const preload = await readNormFile(targetPath, ctx.cwd, {
            signal,
            accessMode: constants.R_OK | constants.W_OK,
            maxLines: MAX_HASH_LINES,
          });
          const { editParams, anchorLine, contentSeparators } = buildInsertEdit(req, preload, ref, targetPath);
          const anchorCarry = insertAnchorCarry(req.direction, editParams, anchorLine);
          const pipe = await execPipeline(targetPath, editParams, ctx.cwd, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            preloadedNorm: preload,
            stripWarning: insertStripWarning(anchorLine, req.direction),
            endingOverrides: contentSeparators,
            ...(anchorCarry !== undefined ? { anchorCarry } : {}),
          });
          return commitEdit(pipe, {
            path: pipe.path,
            absolutePath,
            mutationTargetPath,
            editAnchors: [editParams.remove_from, editParams.remove_to],
            ...(anchorCarry !== undefined ? { anchorCarry } : {}),
            signal,
            verb: "inserted",
            noopNoun: "Insertion",
            foldedAnchorLines: anchorLine === undefined ? 0 : 1,
            prefixWarnings: [...anchorWarnings, ...insertWarnings],
            endingOverrides: contentSeparators,
          });
        });
      }));
    },
  };
}

export function regInsert(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildInsertToolDef(flags));
}
