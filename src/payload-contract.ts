import { Type } from "typebox";
import { isRec, normalizeRequest, rejectUnknownFields, assertNoNul } from "./utils.ts";
import { TEXT_ENDING_NOTE, TEXT_NOT_STRING_MSG, NEW_CONTENT_NOT_STRING_MSG } from "./constants.ts";
import { toLF } from "./normalize.ts";

const textSchema = Type.String({
  description:
    `The exact text to write in place of the removed range. "" deletes the range. ${TEXT_ENDING_NOTE}`,
});

const removeFromSchema = Type.String({
  description:
    "5-char anchor of the FIRST line to remove.",
});

const removeToSchema = Type.String({
  description:
    "5-char anchor of the LAST line to remove.",
});
export const pathRequiredSchema = Type.String({
  description:
    "Path to the file the anchors were served for; required and must match anchor ownership.",
});

export const editToolSchema = Type.Object(
  {
    remove_from: removeFromSchema,
    remove_to: removeToSchema,
    text: textSchema,
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
      text: textSchema,
    },
    { additionalProperties: true },
  ) as typeof editToolSchema;
}

export type ReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  text: string;
};

export type RawReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  text: string | string[];
};

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "text"]);

const REPLACE_MATCH_SHAPE_KEYS = ["match", "replacement", "old_string", "new_string"];

function replaceMatchFieldHint(request: Record<string, unknown>): string | undefined {
  if (!REPLACE_MATCH_SHAPE_KEYS.some((key) => key in request)) return undefined;
  return 'This looks like a replace_match request: to change part of a line, call replace_match with "replace_from", "replace_to", "match", and "replacement"; replace takes "remove_from", "remove_to", and "text".';
}

export function assertReq(request: unknown): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }
  rejectUnknownFields(request, ROOT_KS, "Edit request", replaceMatchFieldHint(request));
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Edit request field "path" must be a string when provided.');
  }
  if (
    typeof request.remove_from !== "string" ||
    typeof request.remove_to !== "string"
  ) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires "remove_from" and "remove_to" anchor strings and a "text" string with the exact text to write.',
    );
  }
  if (typeof request.text !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  assertNoNul([request.text]);
}

export { normalizeRequest as normReq } from "./utils.ts";

export function getPreviewInput(args: unknown): { path?: string; remove_from: string; remove_to: string; text: string } | null {
  let normalized: unknown;
  try {
    normalized = normalizeRequest(args, "remove");
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.remove_from !== "string" ||
    typeof normalized.remove_to !== "string" ||
    typeof normalized.text !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    remove_from: normalized.remove_from as string,
    remove_to: normalized.remove_to as string,
    text: normalized.text,
  };
}

const INSERT_KS = new Set(["path", "anchor", "direction", "text"]);

export interface InsertReq {
  path?: string;
  anchor: string;
  direction: "before" | "after";
  text: string;
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
    throw new Error('[E_BAD_SHAPE] Insert request requires an "anchor" string (5-char anchor from read output).');
  }
  if (request.direction !== "before" && request.direction !== "after") {
    throw new Error('[E_BAD_SHAPE] Insert request "direction" must be "before" or "after".');
  }
  if (typeof request.text !== "string") {
    throw new Error(TEXT_NOT_STRING_MSG);
  }
  assertNoNul([request.text]);
}

const TRANSFER_KEYS = new Set(["path", "source_from", "source_to", "anchor", "direction"]);

export interface TransferReq {
  path?: string;
  source_from: string;
  source_to: string;
  anchor: string;
  direction: "before" | "after";
}

export function assertTransferReq(request: unknown): asserts request is TransferReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Copy/move request must be an object.");
  }
  rejectUnknownFields(request, TRANSFER_KEYS, "Copy/move request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Copy/move request field "path" must be a string when provided.');
  }
  if (typeof request.source_from !== "string" || request.source_from.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires a "source_from" string (5-char anchor from read output).');
  }
  if (typeof request.source_to !== "string" || request.source_to.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires a "source_to" string (5-char anchor from read output).');
  }
  if (typeof request.anchor !== "string" || request.anchor.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires an "anchor" string (5-char anchor from read output).');
  }
  if (request.direction !== "before" && request.direction !== "after") {
    throw new Error('[E_BAD_SHAPE] Copy/move request "direction" must be "before" or "after" (the anchor is the destination line).');
  }
}

const MATCH_KS = new Set(["path", "replace_from", "replace_to", "match", "replacement", "allowEmbeddedMatch"]);

export interface ReplaceMatchReq {
  path?: string;
  replace_from: string;
  replace_to: string;
  match: string;
  replacement: string;
  allowEmbeddedMatch?: boolean;
}

export function singleLineMatch(raw: string): string {
  const text = toLF(raw);
  const fragment = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lineBreak = fragment.indexOf("\n");
  if (lineBreak >= 0) {
    const column = [...fragment.slice(0, lineBreak)].length + 1;
    throw new Error(
      `[E_BAD_SHAPE] match must stay within one line, but the value contains a line break at column ${column}. A trailing line break is accepted as the line's own terminator; a match that spans lines belongs to replace.`,
    );
  }
  if (fragment.length === 0) {
    throw new Error('[E_BAD_SHAPE] Replace-match request field "match" must be a non-empty string holding the exact text to find.');
  }
  return fragment;
}

export function replacementFragment(raw: string): string {
  const text = toLF(raw);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function assertReplaceMatchReq(request: unknown): asserts request is ReplaceMatchReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Replace-match request must be an object.");
  }
  if ("old_string" in request || "new_string" in request) {
    throw new Error('[E_BAD_SHAPE] Replace-match request no longer accepts "old_string"/"new_string"; use "match" for the text to find and "replacement" for the new text.');
  }
  rejectUnknownFields(request, MATCH_KS, "Replace-match request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Replace-match request field "path" must be a string when provided.');
  }
  for (const key of ["replace_from", "replace_to", "match", "replacement"] as const) {
    if (typeof (request as Record<string, unknown>)[key] !== "string") {
      throw new Error(`[E_BAD_SHAPE] Replace-match request requires a "${key}" string.`);
    }
  }
  const within = request as unknown as ReplaceMatchReq;
  if (within.replace_from.length === 0 || within.replace_to.length === 0) {
    throw new Error('[E_BAD_SHAPE] Replace-match request requires non-empty "replace_from" and "replace_to" anchors.');
  }
  if (within.allowEmbeddedMatch !== undefined && typeof within.allowEmbeddedMatch !== "boolean") {
    throw new Error('[E_BAD_SHAPE] Replace-match request field "allowEmbeddedMatch" must be a boolean when provided.');
  }
  singleLineMatch(within.match);
  assertNoNul([within.replacement]);
}

export function getReplaceMatchInput(args: unknown): { path?: string; replace_from: string; replace_to: string; match: string; replacement: string; allowEmbeddedMatch?: boolean } | null {
  let normalized: unknown;
  try {
    normalized = normalizeRequest(args, "replace");
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.replace_from !== "string" ||
    typeof normalized.replace_to !== "string" ||
    typeof normalized.match !== "string" ||
    typeof normalized.replacement !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    replace_from: normalized.replace_from,
    replace_to: normalized.replace_to,
    match: normalized.match,
    replacement: normalized.replacement,
    ...(normalized.allowEmbeddedMatch === true ? { allowEmbeddedMatch: true } : {}),
  };
}

const replaceMatchFromSchema = Type.String({
  description:
    "5-char anchor of the FIRST line of the range searched.",
});
const replaceMatchToSchema = Type.String({
  description:
    "5-char anchor of the LAST line of the range searched; same as `replace_from` for a single line.",
});
const replaceMatchMatchSchema = Type.String({
  description:
    "The exact text to find inside the selected lines, copied from the served row: only the fragment that changes, never text that `replacement` leaves unchanged. It must stay within one line and hold text: a single trailing line break is accepted as the line's own terminator, a line break anywhere else is refused, and a value that is only a line break leaves nothing to find and is refused. Every occurrence inside the range is replaced; the text around each match is left untouched. An occurrence whose edge touches an identifier character (letters, digits, \"$\", \"_\", and Unicode identifier characters) is refused with [E_MATCH_NOT_ISOLATED] unless `allowEmbeddedMatch` is true.",
});
const replaceMatchAllowEmbeddedSchema = Type.Optional(
  Type.Boolean({
    description:
      "Replace inside a larger identifier too. By default an occurrence glued to an identifier character is refused with [E_MATCH_NOT_ISOLATED] before anything is written; set this to true when replacing a fragment inside an identifier is intended.",
  }),
);
const replaceMatchReplacementSchema = Type.String({
  description:
    `The exact replacement for every matched occurrence within the range. "" deletes the matches. A single trailing line break is accepted and dropped (a value that is only a line break counts as ""); an interior or leading line break splits the replacement into lines, and new lines inherit the file's line endings. The text around each match is kept byte-for-byte.`,
});

export const replaceMatchToolSchema = Type.Object(
  {
    replace_from: replaceMatchFromSchema,
    replace_to: replaceMatchToSchema,
    match: replaceMatchMatchSchema,
    replacement: replaceMatchReplacementSchema,
    allowEmbeddedMatch: replaceMatchAllowEmbeddedSchema,
  },
  { additionalProperties: true },
);

export function buildReplaceMatchToolSchema(requirePath: boolean): typeof replaceMatchToolSchema {
  if (!requirePath) return replaceMatchToolSchema;
  return Type.Object(
    {
      path: pathRequiredSchema,
      replace_from: replaceMatchFromSchema,
      replace_to: replaceMatchToSchema,
      match: replaceMatchMatchSchema,
      replacement: replaceMatchReplacementSchema,
      allowEmbeddedMatch: replaceMatchAllowEmbeddedSchema,
    },
    { additionalProperties: true },
  ) as typeof replaceMatchToolSchema;
}
