import {
	ANCHOR_LEN,
	ALPH_RE,
} from "./hash";
import { NEW_CONTENT_NOT_ARRAY_MSG } from "../constants";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the anchor alone (e.g. "aB3"): no line numbers or trailing content.`;
	}

	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}": use only the 3-char anchor, drop everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (
		trimmed.length === ANCHOR_LEN &&
		ALPH_RE.test(trimmed)
	) {
		return { hash: trimmed };
	}

	throw new Error(diagRef(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string[], warnings?: string[]): string[] {
  if (!Array.isArray(edit) || edit.some((line) => typeof line !== "string")) {
    throw new Error(NEW_CONTENT_NOT_ARRAY_MSG);
  }
  const out: string[] = [];
  let split = false;
  for (const line of edit) {
    const normalized = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (normalized !== line) split = true;
    out.push(...normalized.split("\n"));
  }
  if (split) {
    warnings?.push(
      "[E_BAD_SHAPE] Autocorrected: split embedded newlines in replacement_lines into separate lines.",
    );
  }
  return out;
}
