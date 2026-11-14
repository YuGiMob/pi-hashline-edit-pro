import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveInCwd } from "./fs-write.ts";
import { abortIf, makePrepareArguments } from "./utils.ts";
import { anchorWasMinted, ownerOf } from "./anchor-registry.ts";
import { assertRangeServed, lineChecksum, parseHashRef, stripAnchorRow } from "./hashline/index.ts";
import { readConfig } from "./config.ts";
import { makeRenderCall, renderEditResult, type RPreview, type FgT } from "./replace-render.ts";
import type { ReplaceDetails } from "./replace.ts";
import type { Guideline } from "./prompts.ts";
export const editPrepare = makePrepareArguments();

export interface EditToolFlags {
  requirePath: boolean;
  strictInput: boolean;
  autoRead: boolean;
  autoReadAllActive: boolean;
  autoReadAllOutline: boolean;
  replaceMatchEnabled: boolean;
  copyMoveEnabled: boolean;
  outlineEnabled: boolean;
  codemode: boolean;
}

export const DEFAULT_EDIT_FLAGS: EditToolFlags = {
  requirePath: false,
  strictInput: false,
  autoRead: true,
  autoReadAllActive: false,
  autoReadAllOutline: false,
  replaceMatchEnabled: true,
  copyMoveEnabled: true,
  outlineEnabled: false,
  codemode: false,
};

export type EditToolGate = Pick<EditToolFlags, "replaceMatchEnabled" | "copyMoveEnabled" | "outlineEnabled">;

export function editToolEnabled(tool: string, flags: EditToolGate): boolean {
  if (tool === "outline") return flags.outlineEnabled;
  if (tool === "replace_match") return flags.replaceMatchEnabled;
  if (tool === "copy" || tool === "move") return flags.copyMoveEnabled;
  return true;
}

export async function currentEditFlags(codemode = false): Promise<EditToolFlags> {
  const config = await readConfig();
  return {
    requirePath: config.requirePath === true,
    strictInput: config.strictInput === true,
    autoRead: config.autoRead !== false,
    autoReadAllActive: (config.autoReadAll ?? "off") !== "off",
    autoReadAllOutline: (config.autoReadAll ?? "off") === "outline",
    replaceMatchEnabled: config.replaceMatchEnabled !== false,
    copyMoveEnabled: config.copyMoveEnabled !== false,
    outlineEnabled: config.outlineEnabled === true,
    codemode
  };
}

function preferenceGuideline(flags: EditToolFlags): string {
  const tools = gatedEditOps(["read", "outline", "replace", "replace_match", "insert", "copy", "move", "undo_last_change"], flags);
  return `Remember to use the hashline tools for every file read and edit: ${joinOps(tools, { backtick: true })}.`;
}

const SHARED_EDIT_OPS = ["replace", "replace_match", "insert", "copy", "move"];
const SHARED_PAYLOAD_OPS = ["replace", "replace_match", "insert"];
const SHARED_DIFF_OPS = ["replace", "replace_match", "insert", "copy", "move", "undo_last_change"];
const SHARED_SCRIPT_OPS = ["read", "outline", "replace", "replace_match", "insert", "copy", "move", "grep", "undo_last_change"];

function resultContractGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_SCRIPT_OPS, flags);
  return `${tools}: when called from a codemode script, failures resolve to \`{ ok: false, kind: "error", error: { code, message } }\`; branch on \`ok\` instead of \`try\`/\`catch\`. Arguments that fail the tool's schema still throw before the tool runs.`;
}
const READ_SCRIPT_GUIDELINE =
  '`read` in a codemode script resolves to the file\'s text, like the built-in `read`; pass `anchors: true` to receive `{ text, lines, notices }` with the raw file content and `lines[].anchor` for chained edits. An image read resolves to an image block.';
const GREP_SCRIPT_GUIDELINE =
  '`grep`: a codemode script receives `{ text, results }`; each `results[].lines[]` entry carries the matching line\'s `anchor` and `text`, so a result is editable without a fresh read.';
function editScriptGuideline(flags: EditToolFlags): string {
  return `${operationNames(SHARED_EDIT_OPS, flags)}: a codemode script receives \`{ ok, kind: "edit", classification, diff, anchors, anchorsOmitted }\`; reuse \`anchors[].anchor\` to chain the next edit, and read again when \`anchorsOmitted\` is true.`;
}
const SCRIPT_BATCH_GUIDELINE =
  "Script calls apply immediately in order, and only the most recent edit per file is undoable.";
const SCRIPT_TRANSFER_GUIDELINE =
  "`copy`/`move`: a call from a codemode script commits on its own and never joins a batch; a script cross-file `move` shows both the source and destination diffs.";
const SCRIPT_UNDO_GUIDELINE =
  "`undo_last_change`: each edit from one codemode script takes the undo slot, so only the most recent is undoable.";

const READ_REREAD_ID = "read-reread";
const READ_OUTLINE_ID = "read-outline";
const READ_MATCH_ID = "read-match-served";
const UNDO_WRITE_CLEARS_ID = "undo-write-clears";
const UNDO_CROSS_FILE_MOVE_ID = "undo-cross-file-move";
const NEUTRAL_READ_REREAD = "`read`: call again after an edit when you need anchors you lack.";
const NEUTRAL_UNDO_WRITE_CLEARS = "`undo_last_change`: only the last `replace`/`replace_match`/`insert`/`copy`/`move` per file is undoable; a `write` clears it, so undo before any other edit or write.";
const UNDO_OPS_PHRASE = "replace, replace_match, insert, copy, or move";
const UNDO_GUIDELINE_OPS_PHRASE = "`replace`/`replace_match`/`insert`/`copy`/`move`";

function operationNames(ops: string[], flags: EditToolFlags): string {
  return joinOps(gatedEditOps(ops, flags), { backtick: true, separator: "/" });
}

function batchGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  const outcome = flags.autoRead ? "diff" : "result";
  const script = flags.codemode ? ` ${SCRIPT_BATCH_GUIDELINE}` : "";
  return `${tools}: same-file calls in one message commit as one batch. If you already know all the edits and their anchors, send them together instead of one turn at a time; an edit that needs anchors from a previous result waits for the next turn. Earlier calls reply \`In batch N (queued)\`, the last shows the combined ${outcome}, and one undo reverts all. A request-invalid call (anchors, shape, or \`match\`) fails alone; a failure while the batch runs aborts it.${script}`;
}

function diffGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_DIFF_OPS, flags);
  return `${tools}: in the post-edit diff, \`-anchor│\` rows are dead anchors; \`+anchor│\` and \` anchor│\` rows carry live anchors for the next edit. Rows the diff does not show keep their anchors, so a follow-up edit on them needs no re-read.`;
}

function pathGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  return flags.requirePath
    ? `${tools}: pass \`path\` matching the file the anchors were served for; it is required and must match anchor ownership.`
    : `${tools}: anchors resolve the file; \`path\` is optional but must match anchor ownership when passed.`;
}

function payloadGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_PAYLOAD_OPS, flags);
  return `${tools}: \`text\` is written exactly as received; escapes are decoded once when the call is parsed, and the tool never decodes again — \`\\uXXXX\` is the character, \`\\\\uXXXX\` the literal text.`;
}

function strictInputGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  return `${tools}: strict-input mode is on; auto-fixable slips are rejected instead of fixed with warnings.`;
}

export function withReplacePrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  let description = base.description;
  const shared = [batchGuideline(flags), pathGuideline(flags)];
  if (flags.codemode) shared.push(editScriptGuideline(flags));
  if (flags.autoRead) shared.push(diffGuideline(flags));
  shared.push(payloadGuideline(flags));
  if (flags.strictInput) shared.push(strictInputGuideline(flags));
  if (!flags.replaceMatchEnabled) {
    description = description
      .split(/(?<=\.)\s+/)
      .filter((sentence) => !sentence.includes("`replace_match`"))
      .join(" ");
  }
  return { description, snippet: base.snippet, guidelines: [...base.guidelines.map((guideline) => guideline.text), ...shared] };
}

function readGuidelineApplies(guideline: Guideline, flags: EditToolFlags): boolean {
  if (guideline.id === READ_OUTLINE_ID) return flags.autoReadAllOutline;
  if (guideline.id === READ_MATCH_ID) return flags.replaceMatchEnabled;
  return true;
}

export function withReadPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const preference = preferenceGuideline(flags);
  const script = flags.codemode ? [READ_SCRIPT_GUIDELINE, resultContractGuideline(flags)] : [];
  const applicable = base.guidelines.filter((guideline) => readGuidelineApplies(guideline, flags));
  if (flags.autoReadAllActive) {
    const rewritten = applicable.filter((guideline) => guideline.id !== READ_REREAD_ID).map((guideline) => guideline.text);
    return { description: base.description, snippet: base.snippet, guidelines: [preference, ...rewritten, ...script] };
  }
  const guidelines = applicable.map((guideline) =>
    guideline.id === READ_REREAD_ID && !flags.autoRead ? NEUTRAL_READ_REREAD : guideline.text,
  );
  return { description: base.description, snippet: base.snippet, guidelines: [preference, ...guidelines, ...script] };
}

export function withInsertPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, _flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  return { description: base.description, snippet: base.snippet, guidelines: base.guidelines.map((guideline) => guideline.text) };
}

export function withReplaceMatchPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, _flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  return { description: base.description, snippet: base.snippet, guidelines: base.guidelines.map((guideline) => guideline.text) };
}

function gatedEditOps(ops: string[], flags: EditToolFlags): string[] {
  return ops.filter((op) => editToolEnabled(op, flags));
}

function joinOps(ops: string[], options?: { backtick?: boolean; separator?: "/" }): string {
  const formatted = ops.map((op) => (options?.backtick ? `\`${op}\`` : op));
  if (options?.separator === "/") return formatted.join("/");
  if (formatted.length <= 1) return formatted[0] ?? "";
  const last = formatted[formatted.length - 1]!;
  const head = formatted.slice(0, -1).join(", ");
  return formatted.length === 2 ? `${head} or ${last}` : `${head}, or ${last}`;
}

export function withGrepPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const guidelines = base.guidelines.map((guideline) => guideline.text);
  if (flags.codemode) guidelines.push(GREP_SCRIPT_GUIDELINE);
  return { description: base.description, snippet: base.snippet, guidelines };
}

export function withUndoPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const ops = gatedEditOps(["replace", "replace_match", "insert", "copy", "move"], flags);
  const script = flags.codemode ? [SCRIPT_UNDO_GUIDELINE] : [];
  let description = base.description;
  let guidelines = [
    ...base.guidelines
      .filter((guideline) => flags.copyMoveEnabled || guideline.id !== UNDO_CROSS_FILE_MOVE_ID)
      .map((guideline) => (guideline.id === UNDO_WRITE_CLEARS_ID && !flags.autoRead ? NEUTRAL_UNDO_WRITE_CLEARS : guideline.text)),
    ...script,
  ];
  if (ops.length !== 5) {
    description = description.replaceAll(UNDO_OPS_PHRASE, joinOps(ops));
    guidelines = guidelines.map((guideline) => guideline.replaceAll(UNDO_GUIDELINE_OPS_PHRASE, joinOps(ops, { backtick: true, separator: "/" })));
  }
  return { description, snippet: base.snippet, guidelines };
}

export function withTransferPrompts(base: { description: string; snippet: string; guidelines: Guideline[] }, flags: EditToolFlags, options?: { scriptGuidelines?: boolean }): { description: string; snippet: string; guidelines: string[] } {
  const guidelines = base.guidelines.map((guideline) => guideline.text);
  if (flags.codemode && options?.scriptGuidelines !== false) guidelines.push(SCRIPT_TRANSFER_GUIDELINE);
  return { description: base.description, snippet: base.snippet, guidelines };
}

export function staleAnchorMessage(hash: string, next = "Call read() on the target file for fresh anchors."): string {
  const state = anchorWasMinted(hash)
    ? "is stale: it was valid earlier in this session, but its line was edited or its anchors were freed since."
    : "was never served in this session, so it addresses no line here.";
  return `[E_STALE_ANCHOR] "${hash}" ${state} ${next}`;
}

export function resolveEditTarget(removeFrom: string, removeTo?: string): string {
  const refs = [removeFrom, removeTo].filter((value): value is string => typeof value === "string");
  const hashes = refs.map((ref) => parseHashRef(stripAnchorRow(ref.trim(), "anchor entry")).hash);
  const owners = hashes.map((hash) => ownerOf(hash));
  const missing = owners.findIndex((owner) => !owner);
  if (missing >= 0) {
    throw new Error(staleAnchorMessage(hashes[missing]!));
  }
  const paths = new Set(owners.map((owner) => owner!.path));
  if (paths.size > 1) {
    throw new Error(
      `[E_BAD_SHAPE] The anchors are owned by different files (${owners.map((owner) => owner!.path).join(", ")}); edit one file per call.`,
    );
  }
  return owners[0]!.path;
}

export function tryResolveEditTarget(removeFrom: string | undefined, removeTo?: string): string | undefined {
  if (typeof removeFrom !== "string") return undefined;
  try {
    return resolveEditTarget(removeFrom, removeTo);
  } catch {
    return undefined;
  }
}

export interface PathRequirementInput {
  removeFrom?: string;
  removeTo?: string;
  anchor?: string;
  providedPath?: unknown;
  cwd: string;
  anchorTarget?: string;
}

export interface PathOptionInput {
  providedPath: unknown;
  cwd: string;
  targets: readonly string[];
  expected: string;
  requestLabel: string;
}

export async function assertPathOption(input: PathOptionInput): Promise<void> {
  const { requirePath } = await readConfig();
  if (input.providedPath === undefined || (requirePath && input.providedPath === "")) {
    if (requirePath) {
      throw new Error(`[E_BAD_SHAPE] ${input.requestLabel} requires a non-empty "path" string when require-path mode is on. Provide \`path\` matching ${input.expected}.`);
    }
    return;
  }
  if (typeof input.providedPath !== "string" || input.providedPath.length === 0) {
    throw new Error(`[E_BAD_SHAPE] ${input.requestLabel} field "path" must be a non-empty string when provided.`);
  }
  const { resolved } = await resolveInCwd(input.providedPath, input.cwd);
  if (!input.targets.includes(resolved)) {
    throw new Error(`[E_BAD_SHAPE] Provided "path" "${input.providedPath}" does not match ${input.expected}.`);
  }
}

export async function resolveEditTargetWithRequirement(input: PathRequirementInput): Promise<string> {
  const anchorTarget = input.anchorTarget
    ?? (typeof input.anchor === "string"
      ? resolveEditTarget(input.anchor)
      : resolveEditTarget(input.removeFrom as string, input.removeTo));
  await assertPathOption({
    providedPath: input.providedPath,
    cwd: input.cwd,
    targets: [anchorTarget],
    expected: `anchor ownership "${anchorTarget}"`,
    requestLabel: "Edit request",
  });
  return anchorTarget;
}

const STRICT_INPUT_REJECT_CODES = ["[W_BAD_SHAPE]", "[W_BAD_REF]", "[W_INVALID_PATCH]", "[W_BARE_HASH_PREFIX]", "[W_ANCHOR_CASE]"];
export async function throwIfStrictInput(warnings: string[]): Promise<void> {
  const fixes = warnings.filter((warning) => STRICT_INPUT_REJECT_CODES.some((code) => warning.startsWith(code)));
  if (fixes.length === 0) return;
  const { strictInput } = await readConfig();
  if (strictInput === true) {
    throw new Error(`[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input and replace_match retyping warnings:\n${fixes.join("\n")}`);
  }
}

export function editRenderCallWrapper(
  preview: (args: unknown, cwd: string, signal?: AbortSignal) => Promise<RPreview>,
  getInput?: (args: unknown) => { path?: string } | null,
  toolName?: string,
) {
  return makeRenderCall(preview, {
    getInput,
    toolName,
    resolveTarget: (input) => {
      if (typeof input.remove_from === "string") return tryResolveEditTarget(input.remove_from, input.remove_to);
      if (typeof input.anchor === "string") return tryResolveEditTarget(input.anchor);
      return undefined;
    },
  });
}

export function editRenderResultWrapper(
  result: { content?: Array<{ type: string; text?: string }>; details?: ReplaceDetails },
  opts: { isPartial: boolean; expanded?: boolean } | boolean,
  theme: FgT,
  context: any,
) {
  return renderEditResult(result, opts, theme, context);
}

export const editToolBase = {
  prepareArguments: editPrepare,
  executionMode: "sequential" as const,
  renderShell: "default" as const,
};

export async function queuedEdit<T>(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  work: (absolute: string, resolved: string) => Promise<T>,
): Promise<T> {
  abortIf(signal);
  const { absolute, resolved } = await resolveInCwd(path, cwd);
  return withFileMutationQueue(resolved, async () => {
    abortIf(signal);
    return work(absolute, resolved);
  });
}

export function trustRangeServed(
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlyMap<string, string> | undefined,
  startLine: number,
  endLine: number,
): ReadonlyMap<string, string> | undefined {
  if (served === undefined) return undefined;
  const merged = new Map(served);
  for (let line = startLine; line <= endLine; line += 1) {
    merged.set(fileHashes[line - 1]!, lineChecksum(fileLines[line - 1]!));
  }
  return merged;
}

export function assertBoundaryLinesServed(
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlyMap<string, string> | undefined,
  startLine: number,
  endLine: number,
  displayPath: string,
): void {
  if (served === undefined) return;
  assertRangeServed(
    {
      content_lines: [],
      hash_bounds: [
        { line: startLine, hash: fileHashes[startLine - 1]! },
        { line: endLine, hash: fileHashes[endLine - 1]! },
      ],
    },
    fileLines,
    fileHashes,
    served,
    displayPath,
  );
}
