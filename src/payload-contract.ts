import { Type } from "typebox";
import { isRec, normalizeAnchors, normalizeFilePath, rejectUnknownFields, splitLines } from "./utils";

const replacementLinesArraySchema = Type.Array(
  Type.String({
    description:
      "One replacement line; never embed \\n inside an element.",
  }),
  {
    description:
      "One string per line. Use [] to delete the range.",
  },
);

const replacementLinesSchema = Type.Union(
  [
    replacementLinesArraySchema,
    Type.String({
      description:
        "Same lines as a single newline-separated string; it is split on newlines. Prefer the array form.",
    }),
  ],
  {
    description:
      'Replacement lines as an array (preferred) or a single newline-separated string. Example: {"remove_from":"Ab12","remove_to":"Cd34","replacement_lines":["first line","second line"]}. Use [] to delete the range.',
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
  { additionalProperties: false },
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
    { additionalProperties: false },
  ) as typeof editToolSchema;
}

export type ReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  replacement_lines: string[];
};

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_lines"]);

export function coerceLineFields(record: Record<string, unknown>): void {
  for (const key of ["replacement_lines", "lines"] as const) {
    if (typeof record[key] === "string") {
      record[key] = splitLines(record[key]);
    }
  }
}

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
      '[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_lines" (array of strings, one per line, or a single newline-separated string; use [] to delete).',
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
  coerceLineFields(record);
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
