export function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFilePath(record: Record<string, unknown>): void {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

export function makePrepareArguments(): (args: unknown) => any {
  return (args) => {
    if (!isRec(args)) return args;
    const record = { ...args };
    normalizeFilePath(record);
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

export function isHashRow(line: string): boolean {
	return /^[A-Za-z0-9]{3}│/.test(line);
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
