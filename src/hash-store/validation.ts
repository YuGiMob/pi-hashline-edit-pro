import { HASH_RE } from "../hashline/alphabet.ts";

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  if (new Set(value).size !== value.length) return false;
  return true;
}

export function parseHashList(raw: string, onInvalid: () => void, context?: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[parseHashList]${context ? ` ${context}:` : ""} failed to parse stored hashes JSON:`, error);
    onInvalid();
    return undefined;
  }
  if (!isValidHashList(parsed)) {
    console.error(`[parseHashList]${context ? ` ${context}:` : ""} stored hashes did not pass validation:`, Array.isArray(parsed) ? `length=${parsed.length} sample=${JSON.stringify(parsed.slice(0, 3))}` : (() => { try { return JSON.stringify(parsed)?.slice(0, 500) ?? String(parsed).slice(0, 500); } catch { return String(parsed).slice(0, 500); } })());
    onInvalid();
    return undefined;
  }
  return parsed;
}

export function parseStoredHashes(row: Record<string, unknown> | undefined, onInvalid: () => void): string[] | undefined {
  if (!row) return undefined;
  return parseHashList(row.hashes as string, onInvalid);
}

export function isValidSnapshot(value: unknown): value is { content: string; hashes: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  return isValidHashList(v.hashes);
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

export function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

export interface SeparatorParse {
	ok: boolean;
	value?: string[];
}

export function parseSeparators(raw: unknown): SeparatorParse {
	if (raw === null || raw === undefined || raw === "") return { ok: true };
	if (typeof raw !== "string") return { ok: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.error("[parseSeparators] failed to parse stored separators JSON:", error);
		return { ok: false };
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => entry === "\n" || entry === "\r" || entry === "\r\n")) {
		console.error("[parseSeparators] stored separators did not pass validation:", JSON.stringify(parsed).slice(0, 200));
		return { ok: false };
	}
	return { ok: true, value: parsed as string[] };
}
