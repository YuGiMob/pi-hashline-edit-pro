import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import { execPipeline, type ReqParams, type ReplaceDetails, previewFromPipe, previewError } from "./replace";
import { commitEdit } from "./commit";
import { readNormFile, type NormFile } from "./file-reader";
import { MAX_HASH_LINES, parseHashRef, resolveAnchorLine, type Anchor } from "./hashline";
import { stripAnchorRow } from "./hashline/resolve";
import { loadP, loadGuide } from "./prompts";
import { normReq } from "./payload-contract";
import { isRec, rejectUnknownFields, splitLines } from "./utils";
import { clearBoundaryBypass } from "./boundary-bypass";
import type { RPreview, RRState } from "./replace-render";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper } from "./edit-common";

const INSERT_KS = new Set(["path", "anchor", "direction", "lines"]);

export interface InsertReq {
  path: string;
  anchor: string;
  direction: "before" | "after";
  lines: string[];
}

export function assertInsertReq(request: unknown): asserts request is InsertReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Insert request must be an object.");
  }
  rejectUnknownFields(request, INSERT_KS, "Insert request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Insert request requires a non-empty "path" string.');
  }
  if (typeof request.anchor !== "string" || request.anchor.length === 0) {
    throw new Error('[E_BAD_SHAPE] Insert request requires an "anchor" string (4-char anchor from read output).');
  }
  if (request.direction !== "before" && request.direction !== "after") {
    throw new Error('[E_BAD_SHAPE] Insert request "direction" must be "before" or "after".');
  }
  if (!Array.isArray(request.lines) || request.lines.some((line) => typeof line !== "string")) {
    throw new Error('[E_BAD_SHAPE] Insert request requires "lines" as an array of strings, one element per line.');
  }
}

const insertToolSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file to edit",
    }),
    anchor: Type.String({
      description:
        'Bare 4-char anchor from a read row like `Hasu│content`, never the content. A pasted `+Hasu│x` diff row or `anchor│` prefix is stripped with a warning. The anchor line is preserved; lines go after or before it.',
    }),
    direction: Type.Union(
      [
        Type.Literal("after"),
        Type.Literal("before"),
      ],
      { description: '"after" or "before"' },
    ),
    lines: Type.Array(
      Type.String({
        description:
          "One line to insert; never embed \\n inside an element.",
      }),
      {
        description:
          'One string per line; [""] is a blank line; never include the anchor line.',
      }
    ),
  },
  { additionalProperties: false },
);

function parseInsertAnchor(raw: string): { ref: Anchor; warnings: string[] } {
  const trimmedAnchor = raw.trim();
  const warnings: string[] = [];
  const anchorText = stripAnchorRow(trimmedAnchor, "anchor entry", warnings);
  return { ref: parseHashRef(anchorText), warnings };
}

function buildInsertEdit(
  req: InsertReq,
  preload: NormFile,
  ref: Anchor,
): { editParams: ReqParams; anchorLine: string | undefined } {
  const fileLines = splitLines(preload.normalized);
  const line = resolveAnchorLine(ref, fileLines, preload.fileHashes, req.path);
  const anchorLine = preload.normalized.length === 0 ? undefined : fileLines[line - 1];
  const editParams: ReqParams = {
    path: req.path,
    remove_from: ref.hash,
    remove_to: ref.hash,
    replacement_lines:
      anchorLine === undefined
        ? [...req.lines]
        : req.direction === "after"
          ? [anchorLine, ...req.lines]
          : [...req.lines, anchorLine],
  };
  return { editParams, anchorLine };
}

export async function insertPreview(request: unknown, cwd: string): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertInsertReq(normalized);
    const { ref } = parseInsertAnchor(normalized.anchor);
    const preload = await readNormFile(normalized.path, cwd, {
      accessMode: constants.R_OK,
      maxLines: MAX_HASH_LINES,
      noPersist: true,
    });
    const { editParams } = buildInsertEdit(normalized, preload, ref);
    const pipe = await execPipeline(editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      skipBoundaryDedup: true,
    });
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    return previewError(error);
  }
}

function getInsertInput(args: unknown): { path?: string; anchor?: string; direction?: "before" | "after"; lines?: string[] } | null {
  let normalized: unknown;
  try {
    normalized = normReq(args);
  } catch {
    return null;
  }
  if (!isRec(normalized) || typeof normalized.path !== "string") return null;
  if (
    typeof normalized.anchor !== "string" ||
    (normalized.direction !== "before" && normalized.direction !== "after") ||
    !Array.isArray(normalized.lines) ||
    normalized.lines.some((line) => typeof line !== "string")
  ) {
    return null;
  }
  return {
    path: normalized.path,
    anchor: normalized.anchor,
    direction: normalized.direction,
    lines: normalized.lines,
  };
}

type InsertToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildInsertToolDef(): InsertToolDef {
  return {
    name: "insert",
    label: "Insert",
    description: loadP("../prompts/insert.md"),
    promptSnippet: loadP("../prompts/insert-snippet.md"),
    promptGuidelines: loadGuide("../prompts/insert-guidelines.md"),
    ...editToolBase,
    parameters: insertToolSchema,
    renderCall: editRenderCallWrapper(insertPreview, getInsertInput, "insert"),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      assertInsertReq(canonical);
      const req = canonical;
      const path = req.path;
      const { ref, warnings: anchorWarnings } = parseInsertAnchor(req.anchor);
      return queuedEdit(path, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
        const preload = await readNormFile(path, ctx.cwd, {
          signal,
          accessMode: constants.R_OK | constants.W_OK,
          maxLines: MAX_HASH_LINES,
        });
        const { editParams, anchorLine } = buildInsertEdit(req, preload, ref);
        const pipe = await execPipeline(editParams, ctx.cwd, {
          accessMode: constants.R_OK | constants.W_OK,
          signal,
          preloadedNorm: preload,
          skipBoundaryDedup: true,
        });
        return commitEdit(pipe, {
          path,
          absolutePath,
          mutationTargetPath,
          signal,
          verb: "inserted",
          noopNoun: "Insertion",
          foldedAnchorLines: anchorLine === undefined ? 0 : 1,
          prefixWarnings: anchorWarnings,
          onApplied: () => clearBoundaryBypass(mutationTargetPath),
        });
      });
    },
  };
}

export function regInsert(pi: ExtensionAPI): void {
  pi.registerTool(buildInsertToolDef());
}
