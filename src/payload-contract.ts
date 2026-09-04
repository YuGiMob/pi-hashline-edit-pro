import { Type } from "typebox";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils";

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
    "Bare 4-char anchor from a read row like `Hasu│content` (the leftmost column), never the row content. Marks the FIRST line to remove (inclusive)",
});

const removeToSchema = Type.String({
  description:
    "Bare 4-char anchor from a read row like `Hasu│content` (the leftmost column), never the row content. Marks the LAST line to remove (inclusive)",
});

export const editToolSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Path to edit; always provide it explicitly — it is only auto-resolved from the anchors as a fallback.",
      }),
    ),
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

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_lines"]);

export function assertReq(request: unknown): asserts request is ReqParams {
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

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }
  const record: Record<string, unknown> = { ...input };
  normalizeFilePath(record);
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
