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

function escapeRawControl(value: string): string {
	if (value === "\b") return "\\b";
	if (value === "\t") return "\\t";
	if (value === "\n") return "\\n";
	if (value === "\f") return "\\f";
	if (value === "\r") return "\\r";
	const hex = value.charCodeAt(0).toString(16).padStart(4, "0");
	return `\\u${hex}`;
}

function escapeControls(value: string): string {
	let out = "";
	for (const char of value) {
		out += char.charCodeAt(0) < 32 ? escapeRawControl(char) : char;
	}
	return out;
}

function decodeArraySegment(segment: string): string | undefined {
	const trimmed = segment.trim();
	if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
	try {
		const cleaned = escapeControls(trimmed);
		const parsed: unknown = JSON.parse(cleaned);
		return typeof parsed === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function splitArraySegments(inner: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let inQuotes = false;
	let escaped = false;
	for (const char of inner) {
		if (inQuotes) {
			current += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inQuotes = false;
			continue;
		}
		if (char === '"') {
			inQuotes = true;
			current += char;
			continue;
		}
		if (char === ",") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (inQuotes || escaped) return undefined;
	segments.push(current);
	return segments;
}

function decodeArrayText(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const segments = splitArraySegments(trimmed.slice(1, -1));
	if (!segments) return undefined;
	const decoded: string[] = [];
	for (const segment of segments) {
		const part = decodeArraySegment(segment);
		if (part === undefined) return undefined;
		decoded.push(part);
	}
	return decoded.length > 0 ? decoded : undefined;
}

export function decodeStringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") return decodeArrayText(value);
	if (Array.isArray(value) && value.length === 1) return decodeArrayText(value[0]);
	return undefined;
}
