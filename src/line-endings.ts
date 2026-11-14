import type { LineEnding } from "./normalize.ts";

export interface EndingSpan {
	start: number;
	end: number;
	replacementCount: number;
}

export function countNewlines(content: string): number {
	let count = 0;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

export function splitSeparators(raw: string): LineEnding[] {
	const separators: LineEnding[] = [];
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (char === "\r") {
			if (raw[index + 1] === "\n") {
				separators.push("\r\n");
				index += 1;
			} else {
				separators.push("\r");
			}
		} else if (char === "\n") {
			separators.push("\n");
		}
	}
	return separators;
}

export function joinSeparators(content: string, separators: readonly LineEnding[]): string {
	let out = "";
	let separatorIndex = 0;
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index]!;
		if (char === "\n") {
			const separator = separators[separatorIndex] ?? "\n";
			const emptyLineBefore = content[index - 1] === "\n";
			const followsLoneCr = separator === "\n" && separators[separatorIndex - 1] === "\r" && emptyLineBefore;
			out += followsLoneCr ? "\r\n" : separator;
			separatorIndex += 1;
		} else {
			out += char;
		}
	}
	return out;
}

function sourceLineMap(baseLineCount: number, spans: readonly EndingSpan[]): number[] {
	const sorted = [...spans].sort((left, right) => left.start - right.start);
	const map: number[] = [];
	let baseLine = 0;
	for (const span of sorted) {
		while (baseLine < span.start && baseLine < baseLineCount) {
			map.push(baseLine);
			baseLine += 1;
		}
		const spanLength = span.end >= span.start ? span.end - span.start + 1 : 0;
		for (let offset = 0; offset < span.replacementCount; offset++) {
			if (offset < spanLength) map.push(span.start + offset);
			else map.push(spanLength > 0 ? span.end : span.start - 1);
		}
		baseLine = span.end >= span.start ? span.end + 1 : span.start;
	}
	while (baseLine < baseLineCount) {
		map.push(baseLine);
		baseLine += 1;
	}
	return map;
}

export function separatorsForSpans(
	baseSeparators: readonly LineEnding[],
	baseLineCount: number,
	spans: readonly EndingSpan[],
	resultContent: string,
	fallback: LineEnding,
	baseLines?: readonly string[],
): LineEnding[] {
	const consumed = new Set<number>();
	if (baseLines !== undefined && baseSeparators.length < baseLineCount) {
		for (const span of spans) {
			if (span.replacementCount !== 0 || span.end !== baseLineCount - 1) continue;
			const previous = baseLines[span.start - 1];
			if (previous !== undefined && previous.trim().length > 0) consumed.add(span.start - 1);
		}
	}
	const mapped = sourceLineMap(baseLineCount, spans).map((source) =>
		source >= 0 && source < baseSeparators.length && !consumed.has(source) ? baseSeparators[source]! : "",
	);
	const needed = countNewlines(resultContent);
	const result: LineEnding[] = [];
	for (let index = 0; index < needed; index++) {
		const candidate = mapped[index];
		if (candidate !== undefined && candidate !== "") result.push(candidate);
		else result.push(result[index - 1] ?? fallback);
	}
	return result;
}

export function endingsForRange(separators: readonly LineEnding[], startLine: number, endLine: number): (LineEnding | undefined)[] {
	const endings: (LineEnding | undefined)[] = [];
	for (let line = startLine; line <= endLine; line += 1) {
		endings.push(separators[line - 1]);
	}
	return endings;
}

export function splitWithEndings(text: string): { lines: string[]; endings: (LineEnding | undefined)[] } {
	const lines: string[] = [];
	const endings: (LineEnding | undefined)[] = [];
	let current = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (char === "\r") {
			const crlf = text[index + 1] === "\n";
			endings.push(crlf ? "\r\n" : "\r");
			lines.push(current);
			current = "";
			if (crlf) index += 1;
			continue;
		}
		if (char === "\n") {
			endings.push("\n");
			lines.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	lines.push(current);
	endings.push(undefined);
	return { lines, endings };
}

export function applyEndingOverrides(separators: LineEnding[], spanStart: number, endings: readonly (LineEnding | undefined)[] | undefined): void {
	if (endings === undefined) return;
	for (let index = 0; index < endings.length; index += 1) {
		const ending = endings[index];
		if (ending === undefined) continue;
		const target = spanStart + index;
		if (target >= 0 && target < separators.length) separators[target] = ending;
	}
}

export function applySpanEndings(separators: LineEnding[], spans: readonly { start: number; end: number; replacementCount: number; endings?: (LineEnding | undefined)[] }[]): void {
	const sorted = [...spans].sort((left, right) => left.start - right.start);
	let offset = 0;
	for (const span of sorted) {
		if (span.endings !== undefined) {
			for (let index = 0; index < span.endings.length; index += 1) {
				const ending = span.endings[index];
				if (ending === undefined) continue;
				const target = span.start + offset + index;
				if (target >= 0 && target < separators.length) separators[target] = ending;
			}
		}
		offset += span.replacementCount - (span.end - span.start + 1);
	}
}
