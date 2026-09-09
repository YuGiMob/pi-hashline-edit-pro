import { Type } from "typebox";
import { isRec, normalizeAnchors, normalizeFilePath, rejectUnknownFields } from "./utils";

const replacementLinesSchema = Type.Array(
  Type.String({
    description:
      "One replacement line; never embed \\n inside an element.",
  }),
  {
    description:
      "One string per line. Use [] to delete the range.",
  },
);

const removeFromSchema = Type.String({
  description:
    "Bare 4-char anchor from a read row (the text before the `│` separator), never the row content. Marks the FIRST line to remove (inclusive)",
});

const removeToSchema = Type.String({
  description:
    "Bare 4-char anchor from a read row (the text before the `│` separator), never the row content. Marks the LAST line to remove (inclusive)",
});
const pathRequiredSchema = Type.String({
  description:
    "Path to the file the anchors were served for; required and must match anchor ownership. Anchors still resolve the target.",
});

export const editToolSchema = Type.Object(
  {
    remove_from: removeFromSchema,
    remove_to: removeToSchema,
    replacement_lines: replacementLinesSchema,
  },
  { additionalProperties: true },
);

export function buildEditToolSchema(requirePath: boolean): typeof editToolSchema {
  if (!requirePath) return editToolSchema;
  return Type.Object(
    {
      path: pathRequiredSchema,
      remove_from: removeFromSchema,
      remove_to: removeToSchema,
      replacement_lines: replacementLinesSchema,
    },
    { additionalProperties: true },
  ) as typeof editToolSchema;
}

export type ReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  replacement_lines: string[];
};

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_lines"]);
export function assertReq(request: unknown): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }
  rejectUnknownFields(request, ROOT_KS, "Edit request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Edit request field "path" must be a string when provided.');
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

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }
  const record: Record<string, unknown> = { ...input };
  normalizeFilePath(record);
  normalizeAnchors(record);
  return record;
}

export function getPreviewInput(args: unknown): { path?: string; remove_from: string; remove_to: string; replacement_lines: string[] } | null {
  let normalized: unknown;
  try {
    normalized = normReq(args);
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.remove_from !== "string" ||
    typeof normalized.remove_to !== "string" ||
    !Array.isArray(normalized.replacement_lines) ||
    normalized.replacement_lines.some((line) => typeof line !== "string")
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    remove_from: normalized.remove_from as string,
    remove_to: normalized.remove_to as string,
    replacement_lines: normalized.replacement_lines as string[],
  };
}

const INSERT_KS = new Set(["path", "anchor", "direction", "lines"]);

export interface InsertReq {
  path?: string;
  anchor: string;
  direction: "before" | "after";
  lines: string[];
}

export function assertInsertReq(request: unknown): asserts request is InsertReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Insert request must be an object.");
  }
  rejectUnknownFields(request, INSERT_KS, "Insert request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Insert request field "path" must be a string when provided.');
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
