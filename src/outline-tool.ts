import { DEFAULT_MAX_BYTES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstat, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { buildFileOutline, loadOutlineParser } from "./outline/index.ts";
import { AUTO_READ_ALL_EXCLUDED_NAMES, globRegexFor, isExcludedByCustomIgnore, isExcludedByPattern, isExcludedBySegment, listFromGit, normalizeAutoReadAllIgnoreList, walkDir } from "./auto-read-all.ts";
import { readConfig } from "./config.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { ANCHOR_POOL_EXHAUSTED_PREFIX, AUTO_READ_ALL_MAX_FILE_BYTES } from "./constants.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { serveRows } from "./served.ts";
import { toCwd, toDisplayPath } from "./paths.ts";
import { formatAnchorReclaimNotice, takeReclaimedPaths, withAnchorSession } from "./anchor-registry.ts";
import { valAccess, valKind } from "./validation.ts";
import { abortIf, errCode, isRec, makePrepareArguments, rejectUnknownFields, splitLines } from "./utils.ts";
import { loadP, loadGuidelines } from "./prompts.ts";
import { DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common.ts";
import { anchoredLine, anchoredLineSchema, outlineResultSchema, withStructuredErrors, type OutlineStructured } from "./structured.ts";

const OUTLINE_DEFAULT_DEPTH = 2;
const OUTLINE_MAX_ROWS = 400;
const OUTLINE_MIN_FILE_ROWS = 20;
const OUTLINE_BATCH_RESERVE_BYTES = 160;
const OUTLINE_MAX_SOURCE_LINES = 400_000;
export const OUTLINE_MAX_DEPTH = 10;

export interface OutlineDetails {
	truncated?: boolean;
	complete?: boolean;
	snapshotId?: string;
	metrics?: { rows: number; truncated: boolean };
}

function buildOutlineToolSchema(codemode: boolean) {
	return Type.Object({
		path: Type.String({
			description: "File, directory, or glob (e.g. src/**/*.ts) to outline, relative to the working directory; files may also use absolute paths.",
		}),
		depth: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: OUTLINE_MAX_DEPTH,
				description: `Nesting depth to show: 0 lists top-level symbols only, 1 adds their members (default 2, maximum ${OUTLINE_MAX_DEPTH}).`,
			}),
		),
		...(codemode
			? {
				anchors: Type.Optional(
					Type.Boolean({
						description: "Return { text, lines, notices } with editable anchors instead of the plain outline text to a codemode script.",
					}),
				),
			}
			: {}),
	}, { additionalProperties: true });
}

export function outlineDepth(value: unknown): number {
	if (value === undefined) return OUTLINE_DEFAULT_DEPTH;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > OUTLINE_MAX_DEPTH) {
		throw new Error(`[E_BAD_SHAPE] Outline request field "depth" must be an integer from 0 to ${OUTLINE_MAX_DEPTH}.`);
	}
	return value;
}

export interface OutlineReq {
	path: string;
	depth: number;
	anchors: boolean;
}

const OUTLINE_KEYS = new Set(["path", "depth", "anchors"]);

export function normOutlineReq(request: unknown, allowAnchors = false): OutlineReq {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Outline request must be an object.");
	}
	rejectUnknownFields(request, OUTLINE_KEYS, "Outline request");
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Outline request requires a non-empty "path" string.');
	}
	if (request.anchors !== undefined) {
		if (typeof request.anchors !== "boolean") {
			throw new Error('[E_BAD_SHAPE] Outline request field "anchors" must be a boolean when provided.');
		}
		if (!allowAnchors) {
			throw new Error('[E_BAD_SHAPE] Outline request field "anchors" is only valid in a codemode session.');
		}
	}
	return { path: request.path, depth: outlineDepth(request.depth), anchors: request.anchors === true };
}

const batchOutlineResultSchema = Type.Union([
	outlineResultSchema,
	Type.Object({
		ok: Type.Literal(true), kind: Type.Literal("outline"), path: Type.String(), text: Type.String(),
		totalLines: Type.Integer(), depth: Type.Integer(), truncated: Type.Boolean(), complete: Type.Boolean(),
		notices: Type.Array(Type.String()),
		files: Type.Array(Type.Object({
			path: Type.String(), lines: Type.Array(anchoredLineSchema),
			totalLines: Type.Integer(), truncated: Type.Boolean(), complete: Type.Boolean(),
		})),
	}),
]);

interface OutlineCandidate {
	path: string;
	size: number;
}

async function hasGitMarker(start: string): Promise<boolean> {
	let current = resolve(start);
	for (;;) {
		try {
			await lstat(join(current, ".git"));
			return true;
		} catch (error) {
			if (errCode(error) !== "ENOENT") return true;
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

async function outlineCandidates(pattern: string, cwd: string, directory: boolean, signal: AbortSignal | undefined): Promise<OutlineCandidate[]> {
	const ignore = normalizeAutoReadAllIgnoreList((await readConfig()).autoReadAllIgnore);
	const parser = await loadOutlineParser();
	if (parser === undefined) return [];
	const segments = pattern.split("/");
	const literal = directory ? segments : segments.slice(0, segments.findIndex((segment) => /[*?[{]/.test(segment)));
	const base = resolve(cwd, literal.join("/"));
	const glob = directory ? null : globRegexFor(pattern);
	if (!directory && glob === null) throw new Error(`[E_BAD_SHAPE] Invalid glob: ${pattern}`);
	const prefix = relative(cwd, base).split(sep).join("/");
	const baseIsDirectory = await stat(base).then((stats) => stats.isDirectory(), (error) => {
		const code = errCode(error);
		return code !== "ENOENT" && code !== "ENOTDIR";
	});
	let listed = (await listFromGit(base))?.map((file) => (prefix === "" ? file : `${prefix}/${file}`));
	if (listed === undefined) {
		if (baseIsDirectory && await hasGitMarker(base)) {
			throw new Error(`[E_ACCESS] Git could not list files under ${base}; refusing a filesystem walk inside a Git work tree because it could bypass .gitignore.`);
		}
		listed = [];
		await walkDir(base, cwd, listed, ignore);
	}
	abortIf(signal);
	const matched = [...new Set(listed.map((file) => file.split(sep).join("/")))].filter((file) => {
		const name = basename(file).toLowerCase();
		return !AUTO_READ_ALL_EXCLUDED_NAMES.includes(name) && !isExcludedBySegment(file) && !isExcludedByPattern(name)
			&& !isExcludedByCustomIgnore(file, ignore) && parser.languageFor(file) !== null && (glob === null || glob.test(file));
	});
	const regular = await Promise.all(matched.map((file) => lstat(resolve(cwd, file)).then((stats) => stats.isFile() ? stats.size : undefined, () => undefined)));
	const candidates: OutlineCandidate[] = [];
	for (let index = 0; index < matched.length; index++) {
		const size = regular[index];
		if (size !== undefined) candidates.push({ path: matched[index]!, size });
	}
	return candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function outlineNotices(section: { preview?: "unsupported" | "no-symbols"; hasSyntaxErrors?: boolean }, path?: string): string[] {
	const where = path === undefined ? "" : `${path}: `;
	const notices: string[] = [];
	if (section.preview !== undefined) {
		const reason = section.preview === "unsupported" ? "No outline parser for this file type" : "No symbols found";
		notices.push(`[${where}${reason}; showing the first and last lines instead of an outline.]`);
	}
	if (section.hasSyntaxErrors === true) notices.push(`[${where}The parser could not read part of this file; symbols in that part may be missing.]`);
	return notices;
}

const FILE_LEVEL_OUTLINE_READ_ERRORS = ["[E_NOT_TEXT]", "[E_FILE_TOO_LARGE]", "[E_NOT_FOUND]", "[E_ACCESS]"];

export function isSkippableOutlineReadError(error: unknown): boolean {
	const code = errCode(error);
	if (code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ELOOP") return true;
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith(ANCHOR_POOL_EXHAUSTED_PREFIX)) return false;
	return FILE_LEVEL_OUTLINE_READ_ERRORS.some((prefix) => message.startsWith(prefix));
}

export function regOutline(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
	const prompted = {
		description: loadP("../tool-prompts/outline.md"),
		snippet: loadP("../tool-prompts/outline-snippet.md"),
		guidelines: loadGuidelines("../tool-prompts/outline-guidelines.md").map((guideline) => guideline.text),
	};
	if (flags.codemode) prompted.guidelines.push("`outline`: a codemode script receives the served outline text; pass `anchors: true` to receive `{ text, lines, notices }` with editable anchors; a directory or glob returns `files: [{ path, lines, totalLines, truncated, complete }]` in place of `lines`.");
	pi.registerTool({
		name: "outline",
		defaultActive: false,
		label: "Outline",
		description: prompted.description,
		promptSnippet: prompted.snippet,
		promptGuidelines: prompted.guidelines,
		prepareArguments: makePrepareArguments(),
		parameters: buildOutlineToolSchema(flags.codemode),
		outputSchema: batchOutlineResultSchema,
		executionMode: "sequential",
		renderCall(args: any, theme: any, context: any) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const path = typeof args?.path === "string" && args.path.length > 0 ? args.path : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("outline"))} ${theme.fg("accent", path)}`);
			return text;
		},
		renderResult(result, { isPartial, expanded }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Outlining..."), 0, 0);
			const raw = (result.content?.[0] as { text?: string } | undefined)?.text;
			if (typeof raw !== "string") return new Text("", 0, 0);
			if (context.isError) return new Text(theme.fg("error", raw), 0, 0);
			if (expanded !== true && context.expanded !== true) return new Text("", 0, 0);
			return new Text(raw, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return withStructuredErrors(signal, {}, () => withAnchorSession(ctx, async () => {
				const request = normOutlineReq(params, flags.codemode);
				const rawPath = request.path;
				const depth = request.depth;
				const absolutePath = toCwd(rawPath, ctx.cwd);

				abortIf(signal);
				const pathStat = await stat(absolutePath).catch(() => undefined);
				const isGlob = pathStat === undefined && /[*?[{]/.test(rawPath);
				if (isGlob || pathStat?.isDirectory()) {
					const pattern = relative(ctx.cwd, absolutePath).split(sep).join("/");
					const candidates = await outlineCandidates(pattern, ctx.cwd, !isGlob, signal);
					if (candidates.length === 0) throw new Error(`[E_NOT_FOUND] No supported source files match: ${rawPath}`);
					const files: Array<{ path: string; lines: ReturnType<typeof anchoredLine>[]; totalLines: number; truncated: boolean; complete: boolean }> = [];
					const toServe: Array<Parameters<typeof serveRows>> = [];
					const sections: string[] = [];
					const notices: string[] = [];
					let rows = 0;
					let bytes = 0;
					let totalLines = 0;
					let sourceLines = 0;
					let stopped = false;
					let anyTruncated = false;
					let skipped = 0;
					let unlistedSkips = 0;
					const footer = (remaining: number) => `... (${remaining} more files not outlined; narrow path, lower depth, or outline one file.)`;
					const reserve = Buffer.byteLength(footer(candidates.length), "utf-8") + OUTLINE_BATCH_RESERVE_BYTES;
					const addNotice = (notice: string): boolean => {
						const size = Buffer.byteLength(notice, "utf-8") + 2;
						if (bytes + size + reserve > DEFAULT_MAX_BYTES) return false;
						notices.push(notice);
						bytes += size;
						return true;
					};
					for (const [index, candidate] of candidates.entries()) {
						const filePath = candidate.path;
						abortIf(signal);
						if (rows >= OUTLINE_MAX_ROWS || bytes + reserve >= DEFAULT_MAX_BYTES || sourceLines >= OUTLINE_MAX_SOURCE_LINES) { stopped = true; break; }
						if (candidate.size > AUTO_READ_ALL_MAX_FILE_BYTES) {
							skipped += 1;
							if (!addNotice(`[Skipped ${filePath}: ${formatSize(candidate.size)} exceeds the directory-outline file limit.]`)) unlistedSkips += 1;
							continue;
						}
						let loaded: Awaited<ReturnType<typeof readNormFile>>;
						try {
							loaded = await readNormFile(filePath, ctx.cwd, { signal, maxLines: MAX_HASH_LINES });
						} catch (error) {
							if (signal?.aborted) throw error;
							if (!isSkippableOutlineReadError(error)) throw error;
							skipped += 1;
							if (!addNotice(`[Skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}]`)) unlistedSkips += 1;
							continue;
						}
						const { normalized, fileHashes, absolutePath: resolvedPath, hadUtf8DecodeErrors } = loaded;
						sourceLines += fileHashes.length;
						const fileLines = splitLines(normalized);
						const remainingRows = OUTLINE_MAX_ROWS - rows;
						const fileRows = Math.min(remainingRows, Math.max(OUTLINE_MIN_FILE_ROWS, Math.ceil(remainingRows / (candidates.length - index))));
						const separator = sections.length > 0 ? 2 : 0;
						const utf8Notice = hadUtf8DecodeErrors ? `[${filePath}: Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]` : undefined;
						const worstNotices = [...outlineNotices({ preview: "unsupported", hasSyntaxErrors: true }, filePath), ...(utf8Notice === undefined ? [] : [utf8Notice])];
						const noticeBytes = worstNotices.reduce((sum, notice) => sum + Buffer.byteLength(notice, "utf-8") + 2, 0);
						const section = await buildFileOutline({
							displayPath: filePath, content: normalized, hashes: fileHashes, maxDepth: depth,
							maxRows: fileRows, maxBytes: DEFAULT_MAX_BYTES - bytes - reserve - separator - noticeBytes,
							previewHeadLines: Math.min(20, fileRows), previewTailLines: Math.min(10, Math.max(0, fileRows - 20)),
						});
						if (section.rows.length === 0 && section.truncated) { stopped = true; break; }
						toServe.push([resolvedPath, fileHashes, fileLines, section.servedHashes]);
						const served = new Set(section.servedHashes);
						files.push({ path: filePath, lines: section.rows.filter((row) => served.has(row.anchor)).map((row) => anchoredLine(row.line, row.text, row.anchor)),
							totalLines: normalized.length === 0 ? 0 : fileLines.length, truncated: section.truncated, complete: section.complete });
						sections.push(section.text);
						bytes += Buffer.byteLength(section.text, "utf-8") + separator;
						rows += section.rows.length;
						totalLines += normalized.length === 0 ? 0 : fileLines.length;
						if (section.truncated) anyTruncated = true;
						for (const notice of [...outlineNotices(section, filePath), ...(utf8Notice === undefined ? [] : [utf8Notice])]) {
							notices.push(notice);
							bytes += Buffer.byteLength(notice, "utf-8") + 2;
						}
					}
					for (const args of toServe) serveRows(...args);
					if (unlistedSkips > 0) notices.push(`[Skipped ${unlistedSkips} more unreadable files.]`);
					const remaining = candidates.length - files.length - skipped;
					const outlineText = [...sections, ...(stopped ? [footer(remaining)] : [])].join("\n\n");
					const reclaimedPaths = takeReclaimedPaths();
					const reclaimNotice = formatAnchorReclaimNotice(reclaimedPaths);
					if (reclaimNotice !== undefined) notices.push(reclaimNotice);
					const text = [outlineText, ...notices].filter((part) => part.length > 0).join("\n\n");
					const truncated = stopped || anyTruncated || remaining > 0;
					for (const path of reclaimedPaths) {
						const index = toServe.findIndex(([servedPath]) => servedPath === path);
						if (index >= 0) files[index]!.complete = false;
					}
					const complete = !truncated && skipped === 0 && files.every((file) => file.complete);
					return {
						content: [{ type: "text", text }],
						details: { truncated, complete, metrics: { rows, truncated } },
						structuredContent: flags.codemode && !request.anchors ? text : {
							ok: true, kind: "outline", path: rawPath, text: outlineText, totalLines, depth, files, truncated, complete, notices,
						},
					};
				}
				await valAccess(absolutePath, rawPath);

				abortIf(signal);
				const file = await loadFileKindAndText(absolutePath, { maxLines: MAX_HASH_LINES, displayPath: rawPath });
				valKind(file, rawPath);
				const { normalized, fileHashes, absolutePath: resolvedPath, hadUtf8DecodeErrors } = await readNormFile(
					rawPath,
					ctx.cwd,
					{ signal, preloadedFile: file, maxLines: MAX_HASH_LINES },
				);

				abortIf(signal);
				const displayPath = toDisplayPath(ctx.cwd, resolvedPath, rawPath);
				const fileLines = splitLines(normalized);
				const section = await buildFileOutline({
					displayPath,
					content: normalized,
					hashes: fileHashes,
					maxDepth: depth,
				});
				serveRows(resolvedPath, fileHashes, fileLines, section.servedHashes);

				const snapshotId = await safeSnapId(absolutePath, "outline");
				const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
				const notices = [
					...outlineNotices(section),
					hadUtf8DecodeErrors ? "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]" : undefined,
					reclaimNotice,
				].filter((part): part is string => part !== undefined);
				const text = [section.text, ...notices].join("\n\n");
				const served = new Set(section.servedHashes);
				const structuredContent: OutlineStructured = {
					ok: true,
					kind: "outline",
					path: rawPath,
					text: section.text,
					totalLines: normalized.length === 0 ? 0 : fileLines.length,
					depth,
					lines: section.rows.filter((row) => served.has(row.anchor)).map((row) => anchoredLine(row.line, row.text, row.anchor)),
					truncated: section.truncated,
					complete: section.complete,
					notices,
				};
				const anchorsRequested = request.anchors;
				const details: OutlineDetails = {
					truncated: section.truncated,
					complete: section.complete,
					snapshotId,
					metrics: { rows: section.rows.length, truncated: section.truncated },
				};
				return {
					content: [{ type: "text", text }],
					details,
					structuredContent: flags.codemode && !anchorsRequested ? text : structuredContent,
				};
			}));
		},
	});
}
