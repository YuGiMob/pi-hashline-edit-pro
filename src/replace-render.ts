import { Markdown, Text } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { normReq } from "./replace-normalize";
import type { ReqParams, ReplaceDetails } from "./replace";
import { isRec, withLineNumbers } from "./utils";

export type FgT = Pick<Theme, "fg">;
export type CallT = Pick<Theme, "fg" | "bold">;
export type MdTheme = Pick<
	Theme,
	"fg" | "bold" | "italic" | "underline" | "strikethrough"
>;

export type RPreview = { diff: string } | { error: string };

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

	if (
		typeof normalized.remove_from !== "string" ||
		typeof normalized.remove_to !== "string" ||
		!Array.isArray(normalized.replacement_lines) ||
		normalized.replacement_lines.some((line) => typeof line !== "string")
	) {
		return null;
	}

	const request: ReqParams = {
		path: normalized.path,
		remove_from: normalized.remove_from,
		remove_to: normalized.remove_to,
		replacement_lines: normalized.replacement_lines,
	};
	return request;
}

type DiffRowKind = "added" | "removed" | "context";

function diffRowKind(line: string): DiffRowKind {
	const stripped = line.replace(/^\s*\d+\s+│\s*/, "");
	if (stripped.startsWith("+") && !stripped.startsWith("+++")) return "added";
	if (stripped.startsWith("-") && !stripped.startsWith("---")) return "removed";
	return "context";
}

export function colorLines(lines: string[], theme: FgT): string[] {
	return lines.map((line) => {
		const kind = diffRowKind(line);
		if (kind === "added") return theme.fg("success", line);
		if (kind === "removed") return theme.fg("error", line);
		return theme.fg("dim", line);
	});
}
export function toNumberedDiff(diff: string, lineNumbers: (number|undefined)[]): string {
	return withLineNumbers(diff, lineNumbers);
}

export function fmtPreview(
	diff: string,
	expanded: boolean,
	theme: FgT,
): string {
	const lines = diff.split("\n");
	const maxLines = expanded ? 40 : 16;
	const shown = colorLines(lines.slice(0, maxLines), theme);

	if (lines.length > maxLines) {
		shown.push(
			theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
		);
	}
	return shown.join("\n");
}

export function fmtResult(diff: string, theme: FgT): string {
	return colorLines(diff.split("\n"), theme).join("\n");
}

export function fmtCall(
	args: { path?: string } | undefined,
	state: RRState,
	expanded: boolean,
	theme: CallT,
	toolName = "replace",
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold(toolName))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
		return text;
	}

	if (state.preview.diff) {
		text += `\n\n${fmtPreview(state.preview.diff, expanded, theme)}`;
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

const RESULT_PREVIEW_LINES = 16;

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

function extractSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	if (text.includes("│")) return undefined;
	const warningsIdx = text.indexOf("\n\nWarnings:");
	const summary = warningsIdx >= 0 ? text.slice(0, warningsIdx) : text;
	return summary.length > 0 ? summary : undefined;
}

export function buildAppliedText(
	text: string | undefined,
	details: ReplaceDetails | undefined,
	theme: FgT,
	expanded: boolean,
): string | undefined {
	const sections: string[] = [];
	const summary = extractSummary(text);
	if (summary) sections.push(summary);
	if (details?.diff) {
		const rawDiff = details.diffLineNumbers ? toNumberedDiff(details.diff, details.diffLineNumbers) : details.diff;
		const diffLines = details.diff.split("\n");
		const diffSection = expanded
			? fmtResult(rawDiff, theme)
			: fmtPreview(rawDiff, false, theme);
		const hint =
			!expanded && diffLines.length > RESULT_PREVIEW_LINES
				? ` (${expandHint()})`
				: "";
		sections.push(`${diffSection}${hint}`);
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

export function fmtResultMd(text: string): string {
	return trimEmpty(text.split("\n")).join("\n");
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
					const kind = diffRowKind(line);
					if (kind === "added") return theme.fg("toolDiffAdded", line);
					if (kind === "removed") return theme.fg("toolDiffRemoved", line);
					return theme.fg("toolDiffContext", line);
				}

				return theme.fg("mdCodeBlock", line);
			}),
	};
}

export const PREVIEW_DEBOUNCE_MS = 150;

export function reuseText(context: any, content: string): Text {
	const t = context.lastComponent instanceof Text
		? context.lastComponent
		: new Text("", 0, 0);
	t.setText(content);
	return t;
}

export function reuseMarkdown(context: any, content: string, theme: any): Markdown {
	const m = context.lastComponent instanceof Markdown
		? context.lastComponent
		: new Markdown("", 0, 0, mkMdTheme(theme));
	m.setText(content);
	return m;
}

export function makeRenderCall(
	preview: (args: unknown, cwd: string) => Promise<RPreview>,
	options: { getInput?: (args: unknown) => { path?: string } | null; toolName?: string } = {},
) {
	const getInput = options.getInput ?? getPreviewInput;
	const toolName = options.toolName ?? "replace";
	return (args: any, theme: CallT, context: any): Text => {
		const previewInput = getInput(args);
		const cancelPendingPreview = () => {
			if (context.state.previewTimer) {
				clearTimeout(context.state.previewTimer);
				context.state.previewTimer = undefined;
			}
		};
		if (context.executionStarted) {
			cancelPendingPreview();
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
		} else if (!context.argsComplete || !previewInput) {
			cancelPendingPreview();
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
		} else {
			const argsKey = JSON.stringify(previewInput);
			if (context.state.argsKey !== argsKey) {
				cancelPendingPreview();
				context.state.argsKey = argsKey;
				context.state.preview = undefined;
				const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
				context.state.previewGeneration = previewGeneration;
				context.state.previewTimer = setTimeout(() => {
					context.state.previewTimer = undefined;
					preview(args, context.cwd)
						.then((result) => {
							if (
								context.state.argsKey === argsKey &&
								context.state.previewGeneration === previewGeneration
							) {
								context.state.preview = result;
								context.invalidate();
							}
						})
						.catch((err: unknown) => {
							if (
								context.state.argsKey === argsKey &&
								context.state.previewGeneration === previewGeneration
							) {
								context.state.preview = {
									error: err instanceof Error ? err.message : String(err),
								};
								context.invalidate();
							}
						});
				}, PREVIEW_DEBOUNCE_MS);
			}
		}
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(fmtCall(getInput(args) ?? undefined, context.state as RRState, context.expanded, theme, toolName));
		return text;
	};
}

export function renderEditResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: ReplaceDetails },
	isPartial: boolean,
	theme: FgT,
	context: any,
): Text | Markdown {
	if (isPartial) return reuseText(context, theme.fg("warning", "Editing..."));
	const renderedText = getResultText(result);
	const renderState = context.state as RRState | undefined;
	if (renderState) {
		if (renderState.previewTimer) {
			clearTimeout(renderState.previewTimer);
			renderState.previewTimer = undefined;
		}
		renderState.preview = undefined;
		renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
	}
	if (context.isError) {
		return renderedText
			? reuseText(context, `\n${theme.fg("error", renderedText)}`)
			: new Text("", 0, 0);
	}
	if (isApplied(result.details)) {
		const appliedText = buildAppliedText(renderedText, result.details, theme, context.expanded === true);
		return appliedText ? reuseText(context, appliedText) : new Text("", 0, 0);
	}
	if (!renderedText) return new Text("", 0, 0);
	return reuseMarkdown(context, fmtResultMd(renderedText), theme);
}

