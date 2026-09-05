import {
	ANCHOR_LEN,
	HASH_CLASS,
} from "./hash";
import { ALPH_RE } from "./alphabet";
import { NEW_CONTENT_NOT_ARRAY_MSG } from "../constants";

const HASH_EXTRACT_RE = new RegExp(HASH_CLASS);

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 4-char alphanumeric anchor (e.g. "Hasu").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the anchor alone (e.g. "Hasu"): no line numbers or trailing content.`;
	}
	if (trimmed.includes("│") && trimmed.includes("\n")) {
		const lines = trimmed.split(/\r?\n/);
		const first = lines[0] ?? "";
		const last = lines[lines.length - 1] ?? "";
		const hashRe = HASH_EXTRACT_RE;
		const firstMatch = first.match(hashRe);
		const lastMatch = last.match(hashRe);
		const firstHash = firstMatch?.[0] ?? "Hasu";
		const lastHash = lastMatch?.[0] ?? "Hasu";
		const preview = first.slice(0, 60);
		return `[E_BAD_REF] Invalid anchor — remove_from and remove_to must each be a single bare 4-char hash (e.g. "Hasu"), not a block with HASH│content. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as remove_from and "${lastHash}" as remove_to, and put the new content (without HASH│) in replacement_lines.`;
	}
	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}": use only the 4-char anchor, drop everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 4-char alphanumeric anchor (e.g. "Hasu").`;
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

const JSON_ENVELOPE_RE = /^\s*\["(.*)"\]\.\s*$/;

function unwrapJsonEnvelope(line: string, warnings?: string[]): string {
  const match = line.match(JSON_ENVELOPE_RE);
  if (!match) return line;
  const withoutDot = line.trim().slice(0, -1);
  try {
    const parsed: unknown = JSON.parse(withoutDot);
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") {
      warnings?.push(
        '[W_BAD_SHAPE] Unwrapped JSON array syntax from a replacement_lines element.',
      );
      return parsed[0];
    }
    return line;
  } catch {
    warnings?.push(
      '[W_BAD_SHAPE] Unwrapped JSON array syntax from a replacement_lines element.',
    );
    return match[1]!;
  }
}

export function parseText(edit: string[], warnings?: string[]): string[] {
  if (!Array.isArray(edit) || edit.some((line) => typeof line !== "string")) {
    throw new Error(NEW_CONTENT_NOT_ARRAY_MSG);
  }
  const out: string[] = [];
  let split = false;
  for (const line of edit) {
    const unwrapped = unwrapJsonEnvelope(line, warnings);
    const normalized = unwrapped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (normalized !== unwrapped) split = true;
    out.push(...normalized.split("\n"));
  }
  if (split) {
    warnings?.push(
      "[W_BAD_SHAPE] replacement_lines contained embedded newlines; split into one line each.",
    );
  }
  return out;
}
