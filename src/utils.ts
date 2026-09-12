export function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFilePath(record: Record<string, unknown>): void {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

export function normalizeAnchors(record: Record<string, unknown>): void {
  if (typeof record.remove_from !== "string" && typeof record.replace_from === "string") {
    record.remove_from = record.replace_from;
    delete record.replace_from;
  }
  if (typeof record.remove_to !== "string" && typeof record.replace_to === "string") {
    record.remove_to = record.replace_to;
    delete record.replace_to;
  }
}

export function makePrepareArguments(): (args: unknown) => any {
  return (args) => {
    if (!isRec(args)) return args;
    const record = { ...args };
    normalizeFilePath(record);
    normalizeAnchors(record);
    return record;
  };
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function visLines(text: string): string[] {
  return text.length === 0 ? [] : splitLines(text);
}


export function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  hint?: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const suffix = hint ? ` ${hint}` : "";
    throw new Error(
      `[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`,
    );
  }
}

export function cntDiff(diff: string, marker: "+" | "-"): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      line.startsWith(marker) &&
      !line.startsWith(`${marker}${marker}${marker}`)
    ) {
      count += 1;
    }
  }
  return count;
}

export function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export function errCode(error: unknown): string | undefined {
	if (error instanceof Error) {
		return (error as NodeJS.ErrnoException).code;
	}
	return undefined;
}

export function lastNonEmptyIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]!.length > 0) return i;
	}
	return -1;
}

export function firstNonEmptyIndex(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.length > 0) return i;
	}
	return -1;
}

export function lastNonEmpty(lines: string[]): string | undefined {
	const idx = lastNonEmptyIndex(lines);
	return idx >= 0 ? lines[idx] : undefined;
}

export function firstNonEmpty(lines: string[]): string | undefined {
	const idx = firstNonEmptyIndex(lines);
	return idx >= 0 ? lines[idx] : undefined;
}

export function truncateToBytes(s: string, maxBytes: number): string {
	if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
	let out = "";
	let bytes = 0;
	for (const ch of s) {
		const chBytes = Buffer.byteLength(ch, "utf-8");
		if (bytes + chBytes > maxBytes) break;
		out += ch;
		bytes += chBytes;
	}
	return out;
}

export function getCached<K, V>(map: Map<K, V>, key: K, compute: (key: K) => V): V {
	if (map.has(key)) return map.get(key)!;
	const v = compute(key);
	map.set(key, v);
	return v;
}

export function isHashRow(line: string): boolean {
	return /^[A-Za-z0-9]{4}│/.test(line);
}

function gutterWidth(max: number, fallback: number): number {
	return String(max || fallback).length;
}

function formatGutter(n: number, width: number): string {
	return String(n).padStart(width) + " │ ";
}

function blankGutter(width: number): string {
	return " ".repeat(width) + " │ ";
}

export function numberedRead(text: string, offset: number): string {
	const lines = text.split("\n");
	const hashLines = lines.filter(isHashRow).length;
	const max = hashLines > 0 ? offset + hashLines - 1 : offset;
	const width = gutterWidth(max, offset);
	let n = offset;
	return lines.map((line) => {
		if (!isHashRow(line)) return line;
		const prefix = formatGutter(n++, width);
		return prefix + line;
	}).join("\n");
}

export function withLineNumbers(text: string, numbers: (number|undefined)[]): string {
	const lines = text.split("\n");
	const nums = numbers ?? [];
	const max = nums.reduce<number>((m, n) => n !== undefined && n > m ? n : m, 0);
	const width = gutterWidth(max, lines.length);
	return lines.map((line, i) => {
		const n = nums[i];
		const prefix = n !== undefined ? formatGutter(n, width) : blankGutter(width);
		return prefix + line;
	}).join("\n");
}
export function clipLine(line: string, maxLen = 200): string {
	const flat = line.replace(/\n/g, "\\n");
	return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;
}
export function assertLineLimit(content: string, displayPath: string, limit: number): void {
	const count = splitLines(content).length;
	if (count > limit) throw new Error(formatLineLimit(displayPath, limit, count));
}
export function lineLimitMoreThanMessage(displayPath: string, limit: number): string {
	return formatLineLimit(displayPath, limit, undefined);
}
function formatLineLimit(displayPath: string, limit: number, count: number | undefined): string {
	const detail = count === undefined ? `has more than ${limit}` : `has ${count}`;
	return `[E_FILE_TOO_LARGE] ${displayPath} ${detail} lines, exceeding the ${limit}-line hashline limit. For very large files, use write.`;
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return fenced ? fenced[1]!.trim() : trimmed;
}

function jsonStringArray(text: string): string[] | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
			return parsed as string[];
		}
	} catch {
	}
	return undefined;
}

function decodeEscape(char: string): string | undefined {
	switch (char) {
		case "\"": return "\"";
		case "'": return "'";
		case "\\": return "\\";
		case "/": return "/";
		case "b": return "\b";
		case "f": return "\f";
		case "n": return "\n";
		case "r": return "\r";
		case "t": return "\t";
		default: return undefined;
	}
}

function scanQuotedSegment(inner: string, start: number): { value: string; next: number } | undefined {
	const quote = inner[start]!;
	let out = "";
	let index = start + 1;
	while (index < inner.length) {
		const char = inner[index]!;
		if (char === "\\") {
			const escaped = inner[index + 1];
			if (escaped === undefined) return undefined;
			if (escaped === "u") {
				const hex = inner.slice(index + 2, index + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
				out += String.fromCharCode(Number.parseInt(hex, 16));
				index += 6;
				continue;
			}
			const decoded = decodeEscape(escaped);
			if (decoded === undefined) return undefined;
			out += decoded;
			index += 2;
			continue;
		}
		if (char === quote) return { value: out, next: index + 1 };
		out += char;
		index += 1;
	}
	return undefined;
}

function scanArrayText(inner: string): string[] | undefined {
	const values: string[] = [];
	let index = 0;
	while (index < inner.length && /\s/.test(inner[index]!)) index += 1;
	if (index >= inner.length) return [];
	for (;;) {
		if (inner[index] !== "\"" && inner[index] !== "'") return undefined;
		const segment = scanQuotedSegment(inner, index);
		if (!segment) return undefined;
		values.push(segment.value);
		index = segment.next;
		while (index < inner.length && /\s/.test(inner[index]!)) index += 1;
		if (index >= inner.length) return values;
		if (inner[index] !== ",") return undefined;
		index += 1;
		while (index < inner.length && /\s/.test(inner[index]!)) index += 1;
		if (index >= inner.length) return values;
	}
}

function decodeArrayText(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = stripCodeFence(value);
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const decoded = jsonStringArray(trimmed);
	if (decoded !== undefined && decoded.length > 0) return decoded;
	const scanned = scanArrayText(trimmed.slice(1, -1));
	return scanned !== undefined && scanned.length > 0 ? scanned : undefined;
}

function looksLikeStringArray(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = stripCodeFence(value);
	return trimmed.endsWith("]") && /^\[\s*['"]/.test(trimmed);
}

export function decodeStringArray(value: unknown, warnings?: string[], label = "replacement_lines"): string[] | undefined {
	const candidate = typeof value === "string"
		? value
		: Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
			? value[0]
			: undefined;
	if (candidate === undefined) return undefined;
	const decoded = decodeArrayText(candidate);
	if (decoded !== undefined) {
		warnings?.push(`[W_BAD_SHAPE] Unwrapped JSON array syntax from a ${label} element.`);
		return decoded;
	}
	if (looksLikeStringArray(candidate)) {
		warnings?.push(`[W_BAD_SHAPE] ${label} looked like a JSON array but could not be parsed; kept as one literal line: ${clipLine(candidate, 60)}`);
	}
	return undefined;
}
