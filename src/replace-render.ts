import type { Theme } from "@earendil-works/pi-coding-agent";
import { normReq } from "./replace-normalize";
import type { ReqParams, ReplaceDetails } from "./replace";
import { isRec } from "./utils";

export type FgT = Pick<Theme, "fg">;
export type CallT = Pick<Theme, "fg" | "bold">;
export type MdTheme = Pick<
	Theme,
	"fg" | "bold" | "italic" | "underline" | "strikethrough"
>;

export type RPreview =
  | { diff: string; diffLineNumbers?: (number | undefined)[] }
  | { error: string };
export type RRState = {
	argsKey?: string;
	preview?: RPreview;
	previewGeneration?: number;
	previewTimer?: ReturnType<typeof setTimeout>;
};

export function getPreviewInput(
	args: unknown,
): ReqParams | null {
	let normalized: unknown;
	try {
		normalized = normReq(args);
	} catch {
		return null;
	}
	if (!isRec(normalized) || typeof normalized.path !== "string") {
		return null;
	}

	if (Array.isArray(normalized.changes)) {
		return { path: normalized.path, hash_range_inclusive: ["", ""] as [string, string], content_lines: [] };
	}

	if (!Array.isArray(normalized.hash_range_inclusive) || !Array.isArray(normalized.content_lines)) {
		return null;
	}

	const request: ReqParams = {
		path: normalized.path,
		hash_range_inclusive: normalized.hash_range_inclusive as [string, string],
		content_lines: normalized.content_lines as string[],
	};
	return request;
}

const DIFF_MARKER_RE = /^(?:\s*\d+\s*│\s*)?([+-])/;

export function colorLines(lines: string[], theme: FgT): string[] {
	return lines.map((line) => {
		const marker = line.match(DIFF_MARKER_RE)?.[1];
		if (marker === "+" && !line.startsWith("+++")) {
			return theme.fg("success", line);
		}
		if (marker === "-" && !line.startsWith("---")) {
			return theme.fg("error", line);
		}
		return theme.fg("dim", line);
	});
}

export function numberedDiffRows(
	diff: string,
	lineNumbers: (number | undefined)[] | undefined,
): string[] {
	const rows = diff.split("\n");
	if (!lineNumbers) return rows;
	const present = lineNumbers.filter((n): n is number => n !== undefined);
	const width =
		present.length > 0
			? Math.max(...present.map((n) => String(n).length))
			: 1;
	const blankPrefix = " ".repeat(width + 3);
	return rows.map((row, index) => {
		const num = lineNumbers[index];
		if (num === undefined) return `${blankPrefix}${row}`;
		return `${String(num).padStart(width)} │ ${row}`;
	});
}

export function fmtPreview(
	diff: string,
	expanded: boolean,
	theme: FgT,
	lineNumbers?: (number | undefined)[],
): string {
	const lines = numberedDiffRows(diff, lineNumbers);
	const maxLines = expanded ? 40 : 16;
	const shown = colorLines(lines.slice(0, maxLines), theme);

	if (lines.length > maxLines) {
		shown.push(
			theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
		);
	}
	return shown.join("\n");
}

export function fmtResult(
	diff: string,
	theme: FgT,
	lineNumbers?: (number | undefined)[],
): string {
	return colorLines(numberedDiffRows(diff, lineNumbers), theme).join("\n");
}

export function fmtCall(
	args: ReqParams | undefined,
	state: RRState,
	expanded: boolean,
	theme: CallT,
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("replace"))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
		return text;
	}

	if (state.preview.diff) {
		text += `\n\n${fmtPreview(state.preview.diff, expanded, theme, state.preview.diffLineNumbers)}`;
	}
	return text;
}

export function getResultText(result: {
	content?: Array<{ type: string; text?: string }>;
}): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } =>
			entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

export function extractWarnings(
	text: string | undefined,
): string | undefined {
	return text?.match(/(?:^|\n)Warnings:\n[\s\S]*$/)?.[0]?.trimStart();
}

export function isApplied(
	details: ReplaceDetails | undefined,
): boolean {
	const metrics = details?.metrics;
	return (
		metrics?.classification === "applied" &&
		metrics.added_lines !== undefined &&
		metrics.removed_lines !== undefined
	);
}

export function buildAppliedText(
	text: string | undefined,
	details: ReplaceDetails | undefined,
	theme: FgT,
): string | undefined {
	const sections: string[] = [];

	if (details?.diff) {
		sections.push(fmtResult(details.diff, theme, details.diffLineNumbers));
	}

	const warnings = extractWarnings(text);
	if (warnings) sections.push(warnings);

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function trimEmpty(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && lines[start] === "") {
		start++;
	}
	while (end > start && lines[end - 1] === "") {
		end--;
	}

	return lines.slice(start, end);
}

function isSectionBoundary(line: string): boolean {
	return (
		line === "--- Anchors ---" ||
		line === "Warnings:" ||
		line === "Structure outline:" ||
		/^--- Range \d+ ---$/.test(line)
	);
}

export function fmtResultMd(text: string): string {
	const lines = text.split("\n");
	const sections: string[] = [];
	let plainLines: string[] = [];

	const flush = () => {
		const trimmed = trimEmpty(plainLines);
		if (trimmed.length > 0) {
			sections.push(trimmed.join("\n"));
		}
		plainLines = [];
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;

		if (line.startsWith("--- Anchors ")) {
			flush();
			const title = line.replace(/^---\s*/, "").replace(/\s*---$/, "");
			index++;
			const bodyLines: string[] = [];
			while (
				index < lines.length &&
				!isSectionBoundary(lines[index]!)
			) {
				bodyLines.push(lines[index]!);
				index++;
			}
			sections.push(
				[
					`#### ${title}`,
					"```text",
					...trimEmpty(bodyLines),
					"```",
				].join("\n"),
			);
			continue;
		}

		plainLines.push(line);
		index++;
	}

	flush();

	return sections.join("\n\n");
}

export function mkMdTheme(theme: MdTheme) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => (theme.italic ? theme.italic(text) : text),
		underline: (text: string) =>
			theme.underline ? theme.underline(text) : text,
		strikethrough: (text: string) =>
			theme.strikethrough ? theme.strikethrough(text) : text,
		highlightCode: (code: string, lang?: string) =>
			code.split("\n").map((line) => {
				if (lang === "diff") {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("-") && !line.startsWith("---")) {
						return theme.fg("toolDiffRemoved", line);
					}
					return theme.fg("toolDiffContext", line);
				}

				return theme.fg("mdCodeBlock", line);
			}),
	};
}
