import { readFile } from "fs/promises";
import { constants } from "fs";
import { relative } from "path";
import { readConfig, getDiffContextLines } from "./config";
import { resolveEditTarget, throwIfStrictInput, tryResolveEditTarget } from "./edit-common";
import { readNormFile, safeSnapId } from "./file-reader";
import { resolveInCwd, writeAtomic, type FileIdentity } from "./fs-write";
import {
  AnchorMismatchError,
  RangeStaleError,
  assertNotEmpty,
  changedRange,
  lineHashes,
  planEdit,
  MAX_HASH_LINES,
  type HEdit,
  type PlannedEdit,
} from "./hashline";
import { clearBoundaryBypass, markBoundaryNoop } from "./boundary-bypass";
import { boundaryDedupWarning } from "./commit";
import { adoptAnchors, markServed, servedForPath } from "./anchor-registry";
import { restoreEndings, stripBOM, toLF, type LineEnding } from "./normalize";
import { assertInsertReq, assertReq, normReq } from "./payload-contract";
import { saveUndo } from "./replace-undo";
import { buildChanged, buildNoop, type RMetrics, type TResult } from "./replace-response";
import { buildServedMap, servedHashesFromDiff } from "./served";
import { abortIf, assertLineLimit, errCode, isRec, splitLines } from "./utils";
import { MAX_BYTES } from "./constants";

export interface PlannedMember {
  batchKey: number;
  display: number;
  total: number;
  target: string;
  kind: BatchKind;
  args: unknown;
  order: number;
  size: number;
  last: boolean;
}

export type BatchKind = "replace" | "insert";

interface BatchBase {
  content: string;
  hashes: string[];
  bom: string;
  ending: LineEnding;
  identity: FileIdentity;
  hadUtf8DecodeErrors: boolean;
  absolutePath: string;
  snapshotId?: string;
  baseLines: string[];
}

export interface BatchPiece {
  order: number;
  kind: BatchKind;
  start: number;
  end: number;
  fromHash: string;
  toHash: string;
  newLines: string[];
  warnings: string[];
  autoFixes: number;
  noop: boolean;
  noopPayload?: string;
  foldedLines: number;
  bypassConsumed?: boolean;
}

export interface BatchMemberInput {
  kind: BatchKind;
  member: PlannedMember;
  targetPath: string;
  mutationTargetPath: string;
  cwd: string;
  signal?: AbortSignal;
  hedit: HEdit;
  extraWarnings: string[];
  skipBoundaryDedup: boolean;
  strictBoundaryDedup: boolean;
  noopPayload?: string;
  foldedLines?: number;
  bypassConsumed?: boolean;
}

interface BatchState {
  display: number;
  target: string;
  memberIds: string[];
  replaceCount: number;
  insertCount: number;
  base?: BatchBase;
  paths?: { absolutePath: string; mutationTargetPath: string; displayPath: string };
  served?: ReadonlyMap<string, string>;
  pieces: BatchPiece[];
  applied: number;
  noops: number;
  failures: number;
  failed: boolean;
  firstError?: unknown;
  warnings: string[];
}

interface EditCall {
  id: string;
  name: string;
  args: unknown;
}

type NormalizedEditArgs =
  | { kind: "replace"; removeFrom: string; removeTo?: string; path?: string }
  | { kind: "insert"; anchor: string; path?: string };

const MAX_TRACKED_BATCHES = 256;

const plan = new Map<string, PlannedMember>();
const batches = new Map<number, BatchState>();
let nextBatchKey = 1;

export function batchMemberFor(toolCallId: string): PlannedMember | undefined {
  return plan.get(toolCallId);
}

export function resetBatchStateForTests(): void {
  plan.clear();
  batches.clear();
  nextBatchKey = 1;
}

function normalizeEditArgs(args: unknown): NormalizedEditArgs | undefined {
  if (!isRec(args)) return undefined;
  const normalized = normReq(args);
  if (!isRec(normalized)) return undefined;
  const path = typeof normalized.path === "string" ? normalized.path : undefined;
  if (typeof normalized.remove_from === "string") {
    return {
      kind: "replace",
      removeFrom: normalized.remove_from,
      ...(typeof normalized.remove_to === "string" ? { removeTo: normalized.remove_to } : {}),
      ...(path ? { path } : {}),
    };
  }
  if (typeof normalized.anchor === "string") {
    return { kind: "insert", anchor: normalized.anchor, ...(path ? { path } : {}) };
  }
  return undefined;
}
function anchorTargetFor(args: unknown): string | undefined {
  const normalized = normalizeEditArgs(args);
  if (!normalized) return undefined;
  if (normalized.kind === "replace") return tryResolveEditTarget(normalized.removeFrom, normalized.removeTo);
  return tryResolveEditTarget(normalized.anchor);
}
function unresolvedErrorFor(call: EditCall): Error {
  const normalized = normalizeEditArgs(call.args);
  if (!normalized) return new Error(`sibling invalid`);
  const refs = normalized.kind === "replace" ? [normalized.removeFrom, normalized.removeTo].filter((ref): ref is string => typeof ref === "string").join("→") : normalized.anchor;
  try {
    if (normalized.kind === "replace") resolveEditTarget(normalized.removeFrom, normalized.removeTo);
    else resolveEditTarget(normalized.anchor);
  } catch {
    return new Error(`sibling stale (${refs})`);
  }
  return new Error(`sibling stale (${refs})`);
}
async function inferredTargetFor(args: unknown, cwd: string, requirePath: boolean): Promise<string | undefined> {
  const normalized = normalizeEditArgs(args);
  if (!normalized) return undefined;
  if (requirePath && normalized.path) {
    try {
      return (await resolveInCwd(normalized.path, cwd)).resolved;
    } catch {
      return undefined;
    }
  }
  if (normalized.kind === "replace") {
    return tryResolveEditTarget(normalized.removeFrom) ?? (normalized.removeTo ? tryResolveEditTarget(normalized.removeTo) : undefined);
  }
  return undefined;
}

async function verifyPaths(
  group: Array<{ id: string; target: string; kind: BatchKind; args: unknown }>,
  cwd: string,
): Promise<Array<{ id: string; target: string; kind: BatchKind; args: unknown }>> {
  const verified: Array<{ id: string; target: string; kind: BatchKind; args: unknown }> = [];
  for (const item of group) {
    const normalized = normalizeEditArgs(item.args);
    if (!normalized || !normalized.path) continue;
    let resolved: string | undefined;
    try {
      resolved = (await resolveInCwd(normalized.path, cwd)).resolved;
    } catch {
      resolved = undefined;
    }
    if (resolved === item.target) verified.push(item);
  }
  return verified;
}

function enforceCap(): void {
  while (batches.size > MAX_TRACKED_BATCHES) {
    const oldest = batches.keys().next().value;
    if (oldest === undefined) return;
    const state = batches.get(oldest);
    batches.delete(oldest);
    if (state) for (const id of state.memberIds) plan.delete(id);
  }
}

export async function planAssistantMessage(message: unknown, cwd: string): Promise<void> {
  if (!isRec(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const calls: EditCall[] = [];
  for (const block of message.content) {
    if (!isRec(block) || block.type !== "toolCall") continue;
    if (block.name !== "replace" && block.name !== "insert") continue;
    if (typeof block.id !== "string") continue;
    calls.push({ id: block.id, name: block.name, args: block.arguments });
  }
  if (calls.length < 2) return;
  const earlyConfig = await readConfig();
  const requirePath = earlyConfig.requirePath === true;
  interface ResolvedCall { id: string; target: string; kind: BatchKind; args: unknown }
  const resolved: ResolvedCall[] = [];
  for (const call of calls) {
    const target = anchorTargetFor(call.args) ?? await inferredTargetFor(call.args, cwd, requirePath);
    if (target) resolved.push({ id: call.id, target, kind: call.name as BatchKind, args: call.args });
  }
  const groups = new Map<string, ResolvedCall[]>();
  for (const item of resolved) {
    const group = groups.get(item.target) ?? [];
    group.push(item);
    groups.set(item.target, group);
  }
  const multi = [...groups.values()].filter((group) => group.length >= 2);
  const finalGroups: ResolvedCall[][] = [];
  if (requirePath) {
    for (const group of multi) {
      const verified = await verifyPaths(group, cwd);
      if (verified.length >= 2) finalGroups.push(verified);
    }
  } else {
    finalGroups.push(...multi);
  }
  const resolvedIds = new Set(resolved.map((item) => item.id));
  const unplanned = calls.filter((call) => !resolvedIds.has(call.id));
  let poison: { target: string; error: unknown } | undefined;
  if (unplanned.length > 0 && groups.size === 1) {
    const sole = [...groups.values()][0]!;
    const poisonTarget = sole[0]!.target;
    poison = { target: poisonTarget, error: unresolvedErrorFor(unplanned[0]!) };
    if (!finalGroups.some((group) => group[0]!.target === poisonTarget)) finalGroups.push(sole);
  }
  let display = 0;
  for (const group of finalGroups) {
    display += 1;
    const key = nextBatchKey++;
    const matchingPoison = poison !== undefined && group[0]!.target === poison.target ? poison : undefined;
    const poisoned = matchingPoison !== undefined;
    batches.set(key, {
      display,
      target: group[0]!.target,
      memberIds: group.map((item) => item.id),
      replaceCount: 0,
      insertCount: 0,
      pieces: [],
      applied: 0,
      noops: 0,
      failures: poisoned ? 1 : 0,
      failed: poisoned,
      ...(matchingPoison ? { firstError: matchingPoison.error } : {}),
      warnings: [],
    });
    group.forEach((item, index) => {
      plan.set(item.id, {
        batchKey: key,
        display,
        total: finalGroups.length,
        target: item.target,
        kind: item.kind,
        args: item.args,
        order: index + 1,
        size: group.length,
        last: index === group.length - 1,
      });
    });
    enforceCap();
  }
}

function dedupeWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    out.push(warning);
  }
  return out;
}

function batchVerb(runtime: BatchState): string {
  if (runtime.replaceCount > 0 && runtime.insertCount > 0) return "edited";
  if (runtime.insertCount > 0) return "inserted";
  return "replaced";
}
function batchHeader(member: PlannedMember): string {
  return member.total > 1 ? `batch ${member.display}:` : "batch:";
}

function formatBatchLines(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function formatBatchPiece(piece: BatchPiece): string {
  const lines = formatBatchLines(piece.start, piece.end);
  if (piece.kind === "insert") return `edit #${piece.order} (insert at ${piece.fromHash}, ${lines})`;
  if (piece.fromHash === piece.toHash) return `edit #${piece.order} (replace ${piece.fromHash}, ${lines})`;
  return `edit #${piece.order} (replace ${piece.fromHash}→${piece.toHash}, ${lines})`;
}

function batchPlaceholder(member: PlannedMember, piece: BatchPiece, snapshotId: string | undefined): TResult {
  const grossAdded = Math.max(0, piece.newLines.length - piece.autoFixes);
  const added = piece.kind === "insert" ? Math.max(0, grossAdded - piece.foldedLines) : grossAdded;
  const metrics: RMetrics = {
    edits_attempted: 1,
    edits_noop: piece.noop ? 1 : 0,
    warnings: 0,
    classification: piece.noop ? "noop" : "applied",
    ...(piece.noop ? {} : { added_lines: added, removed_lines: piece.end - piece.start + 1 }),
  };
  return {
    content: [
      {
        type: "text",
        text: member.total > 1 ? `In batch ${member.display}` : "In batch",
      },
    ],
    details: {
      diff: "",
      patch: "",
      ...(piece.noop ? {} : { firstChangedLine: piece.start }),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ...(piece.noop ? { classification: "noop" as const } : {}),
      metrics,
      batch: { id: member.display, size: member.size, last: false, total: member.total },
    },
  };
}

export function noteBatchFailure(member: PlannedMember, error: unknown): void {
  const runtime = batches.get(member.batchKey);
  if (!runtime) return;
  runtime.failures += 1;
  if (!runtime.failed) {
    runtime.failed = true;
    runtime.firstError = error;
  }
}

function batchAbortedError(runtime: BatchState, input?: BatchMemberInput): Error {
  restoreBatchBypasses(runtime, input);
  return new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted.`);
}
function restoreBatchBypasses(runtime: BatchState, input?: BatchMemberInput): void {
  for (const piece of runtime.pieces) {
    if (piece.bypassConsumed && piece.noopPayload) markBoundaryNoop(runtime.target, piece.noopPayload);
  }
  if (input?.bypassConsumed && input.noopPayload) markBoundaryNoop(input.mutationTargetPath, input.noopPayload);
}

export async function ensureBatchBase(input: {
  member: PlannedMember;
  targetPath: string;
  mutationTargetPath: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<BatchBase> {
  const runtime = batches.get(input.member.batchKey);
  if (!runtime) throw new Error(`[E_STALE_ANCHOR] Batch ${input.member.display} is no longer tracked. Call read for fresh anchors.`);
  if (runtime.base) return runtime.base;
  abortIf(input.signal);
  const file = await readNormFile(input.targetPath, input.cwd, {
    signal: input.signal,
    accessMode: constants.R_OK | constants.W_OK,
    maxLines: MAX_HASH_LINES,
  });
  const snapshotId = await safeSnapId(file.absolutePath, "batch edit");
  const base: BatchBase = {
    content: file.normalized,
    hashes: file.fileHashes.slice(),
    bom: file.bom,
    ending: file.originalEnding,
    identity: file.identity,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors,
    absolutePath: file.absolutePath,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    baseLines: splitLines(file.normalized),
  };
  runtime.base = base;
  runtime.served = servedForPath(file.absolutePath);
  runtime.paths = {
    absolutePath: file.absolutePath,
    mutationTargetPath: input.mutationTargetPath,
    displayPath: relative(input.cwd, file.absolutePath).replace(/\\/g, "/") || input.targetPath,
  };
  return base;
}

export async function executeBatchMember(input: BatchMemberInput): Promise<TResult> {
  const runtime = batches.get(input.member.batchKey);
  if (!runtime) throw new Error(`[E_STALE_ANCHOR] Batch ${input.member.display} is no longer tracked. Call read for fresh anchors.`);
  if (runtime.failed) throw batchAbortedError(runtime, input);
  let base: BatchBase;
  try {
    base = await ensureBatchBase({
      member: input.member,
      targetPath: input.targetPath,
      mutationTargetPath: input.mutationTargetPath,
      cwd: input.cwd,
      signal: input.signal,
    });
  } catch (error) {
    noteBatchFailure(input.member, error);
    restoreBatchBypasses(runtime, input);
    throw error;
  }
  if (input.mutationTargetPath !== input.member.target) {
    const error = new Error(`[E_STALE_ANCHOR] "${input.hedit.hash_bounds[0].hash}" is no longer owned by ${input.member.target}. Call read for fresh anchors.`);
    noteBatchFailure(input.member, error);
    restoreBatchBypasses(runtime, input);
    throw error;
  }
  const displayPath = runtime.paths?.displayPath ?? input.targetPath;
  let planned: PlannedEdit;
  try {
    planned = planEdit(base.content, input.hedit, base.hashes, {
      filePath: displayPath,
      servedHashes: runtime.served,
      skipBoundaryDedup: input.skipBoundaryDedup,
      strictBoundaryDedup: input.strictBoundaryDedup,
      signal: input.signal,
      baseFileLines: base.baseLines,
    });
  } catch (error) {
    if (error instanceof RangeStaleError) adoptAnchors(base.absolutePath, error.rangeServedMap);
    else if (error instanceof AnchorMismatchError) adoptAnchors(base.absolutePath, error.feedbackMap);
    else if (error instanceof Error && error.message.startsWith("[E_BOUNDARY_STRICT]")) {
      const indexed = new Error(`edit #${input.member.order} strict boundary-dedup rejection: ${error.message}`);
      noteBatchFailure(input.member, indexed);
      restoreBatchBypasses(runtime, input);
      throw indexed;
    }
    noteBatchFailure(input.member, error);
    restoreBatchBypasses(runtime, input);
    throw error;
  }
  const start = planned.resolved.hash_bounds[0].line;
  const end = planned.resolved.hash_bounds[1].line;
  const newLines = planned.resolved.content_lines;
  const baseLines = base.baseLines;
  const originalSlice = baseLines.slice(start - 1, end);
  const noop = originalSlice.length === newLines.length && originalSlice.every((line, index) => line === newLines[index]);
  const autoFixes = planned.autoFixes?.length ?? 0;
  const piece: BatchPiece = {
    order: input.member.order,
    kind: input.kind,
    start,
    end,
    fromHash: input.hedit.hash_bounds[0].hash,
    toHash: input.hedit.hash_bounds[1].hash,
    newLines: [...newLines],
    warnings: [...input.extraWarnings, ...planned.warnings],
    autoFixes,
    noop,
    ...(input.noopPayload !== undefined ? { noopPayload: input.noopPayload } : {}),
    foldedLines: input.foldedLines ?? 0,
    ...(input.bypassConsumed ? { bypassConsumed: true as const } : {}),
  };
  runtime.pieces.push(piece);
  if (input.kind === "replace") runtime.replaceCount += 1;
  else runtime.insertCount += 1;
  if (noop) runtime.noops += 1;
  else runtime.applied += 1;
  runtime.warnings.push(...piece.warnings);
  if (!input.member.last) return batchPlaceholder(input.member, piece, base.snapshotId);
  return finishBatch(input.member, input.signal);
}

function composeBatchLines(baseContent: string, pieces: BatchPiece[]): string {
  const lines = splitLines(baseContent);
  const descending = [...pieces].sort((a, b) => b.start - a.start);
  for (const piece of descending) lines.splice(piece.start - 1, piece.end - piece.start + 1, ...piece.newLines);
  let composed = lines.join("\n");
  if (lines.length > 0 && (baseContent.endsWith("\n") || lines[lines.length - 1] === "")) composed += "\n";
  return composed;
}

async function finishBatch(member: PlannedMember, signal?: AbortSignal): Promise<TResult> {
  const runtime = batches.get(member.batchKey);
  if (!runtime || !runtime.base || !runtime.paths) throw new Error(`[E_STALE_ANCHOR] Batch ${member.display} is no longer tracked. Call read for fresh anchors.`);
  const base = runtime.base;
  const paths = runtime.paths;
  if (runtime.failed) throw batchAbortedError(runtime);
  for (const id of runtime.memberIds) {
    const planned = plan.get(id);
    if (!planned) continue;
    try {
      const normalized = normReq(planned.args);
      if (planned.kind === "replace") assertReq(normalized);
      else assertInsertReq(normalized);
    } catch (error) {
      noteBatchFailure(member, error);
      throw batchAbortedError(runtime);
    }
  }
  const appliedPieces = runtime.pieces.filter((piece) => !piece.noop);
  if (appliedPieces.length === 0) {
    for (const piece of runtime.pieces) {
      if (piece.autoFixes > 0 && piece.noopPayload !== undefined) markBoundaryNoop(runtime.target, piece.noopPayload);
    }
    const snapshotId = await safeSnapId(paths.absolutePath, "noop edit");
    return combinedNoop(paths.displayPath, member, runtime, snapshotId);
  }
  const ordered = [...appliedPieces].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start <= prev.end) {
      restoreBatchBypasses(runtime);
      throw new Error(`[E_BATCH_OVERLAP] Batch ${runtime.display} has overlapping ranges: ${formatBatchPiece(prev)} overlaps ${formatBatchPiece(current)}`);
    }
  }
  const composed = composeBatchLines(base.content, appliedPieces);
  const warnings = [...runtime.warnings];
  if (base.hadUtf8DecodeErrors) warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  const dedupTotal = runtime.pieces.reduce((sum, piece) => sum + piece.autoFixes, 0);
  if (dedupTotal > 0) warnings.push(boundaryDedupWarning(dedupTotal));
  try {
    await throwIfStrictInput(dedupeWarnings(warnings));
    assertNotEmpty(base.content, composed);
    assertLineLimit(composed, paths.displayPath, MAX_HASH_LINES);
    const finalBytes = base.bom + restoreEndings(composed, base.ending);
    if (Buffer.byteLength(finalBytes, "utf-8") > MAX_BYTES) {
      throw new Error(`[E_FILE_TOO_LARGE] File is too large: ${paths.displayPath} (exceeds the ${MAX_BYTES / (1024 * 1024)}MB size limit). For very large files, use write.`);
    }
  } catch (error) {
    restoreBatchBypasses(runtime);
    throw error;
  }
  if (composed === base.content) {
    const snapshotId = await safeSnapId(paths.absolutePath, "noop edit");
    return combinedNoop(paths.displayPath, member, runtime, snapshotId);
  }
  abortIf(signal);
  let currentRaw: string;
  try {
    currentRaw = await readFile(runtime.target, "utf-8");
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
    restoreBatchBypasses(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file was deleted after the batch started.`);
  }
  if (toLF(stripBOM(currentRaw).text) !== base.content) {
    restoreBatchBypasses(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file changed after the batch started. Call read for fresh anchors and retry.`);
  }
  const preflightSpans = appliedPieces.map((piece) => ({ start: piece.start - 1, end: piece.end - 1, replacementCount: piece.newLines.length }));
  try {
    await lineHashes(composed, runtime.target, {
      content: base.content,
      hashes: base.hashes,
      spans: preflightSpans,
    }, undefined, false, true);
  } catch (error) {
    restoreBatchBypasses(runtime);
    throw error;
  }
  const undo = await saveUndo(runtime.target, {
    content: base.content,
    bom: base.bom,
    originalEnding: base.ending,
    hashes: base.hashes,
    resultContent: composed,
  });
  if (!undo.persisted) {
    restoreBatchBypasses(runtime);
    throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history; the edit was not applied and ${paths.displayPath} is unchanged.`);
  }
  try {
    abortIf(signal);
    await writeAtomic(paths.absolutePath, base.bom + restoreEndings(composed, base.ending), base.identity);
  } catch (error) {
    await undo.restore();
    restoreBatchBypasses(runtime);
    throw error;
  }
  clearBoundaryBypass(runtime.target);
  const updatedSnapshotId = await safeSnapId(paths.absolutePath, "post-edit");
  const spans = appliedPieces.map((piece) => ({ start: piece.start - 1, end: piece.end - 1, replacementCount: piece.newLines.length }));
  let resultHashes: string[];
  try {
    resultHashes = await lineHashes(composed, runtime.target, {
      content: base.content,
      hashes: base.hashes,
      spans,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail} File was written; anchor finalization failed. One undo reverts. Call read for fresh anchors.`);
  }
  const range = changedRange(base.content, composed);
  let added = 0;
  let removed = 0;
  for (const piece of appliedPieces) {
    removed += piece.end - piece.start + 1;
    const gross = Math.max(0, piece.newLines.length - piece.autoFixes);
    added += piece.kind === "insert" ? Math.max(0, gross - piece.foldedLines) : gross;
  }
  const header = batchHeader(member);
  const changed = buildChanged(
    {
      path: paths.displayPath,
      originalNormalized: base.content,
      originalHashes: base.hashes,
      result: composed,
      resultHashes,
      warnings: dedupeWarnings(warnings),
      snapshotId: updatedSnapshotId,
      editMeta: {
        editsAttempted: runtime.applied + runtime.noops,
        noopEditsCount: runtime.noops,
        firstChangedLine: range?.firstChangedLine,
        lastChangedLine: range?.lastChangedLine,
        addedLines: added,
        removedLines: removed,
      },
      boundaryDedupAbove: [],
      boundaryDedupBelow: [],
    },
    batchVerb(runtime),
    await getDiffContextLines(),
  );
  changed.details.diff = `${header}\n${changed.details.diff}`;
  changed.details.diffLineNumbers?.unshift(undefined);
  try {
    markServed(runtime.target, buildServedMap(resultHashes, splitLines(composed), servedHashesFromDiff(changed.details.diff)), new Set(resultHashes));
  } catch (error) {
    console.error("Failed to mark batch diff served:", error);
  }
  const executed = runtime.applied + runtime.noops;
  changed.content[0]!.text = `${header}\n${changed.content[0]!.text}\nBatch ${member.display}: ${executed} edit${executed === 1 ? "" : "s"} applied as one commit; one undo reverts them.`;
  changed.details.batch = { id: member.display, size: member.size, last: true, total: member.total };
  return changed;
}

async function combinedNoop(path: string, member: PlannedMember, runtime: BatchState, snapshotId: string | undefined): Promise<TResult> {
  const executed = runtime.applied + runtime.noops;
  const noop = buildNoop(
    {
      path,
      noopEdit: undefined,
      snapshotId,
      editMeta: {
        editsAttempted: executed,
        noopEditsCount: runtime.noops,
        addedLines: 0,
        removedLines: 0,
      },
      warnings: dedupeWarnings(runtime.warnings),
      boundaryRemovedLines: 0,
    },
    "Batch",
  );
  noop.content[0]!.text += `\nBatch ${member.display}: ${executed} edits produced no net change; undo history preserved.`;
  noop.details.batch = { id: member.display, size: member.size, last: true, total: member.total };
  return noop;
}


export async function finalizeTurn(toolCallIds: string[]): Promise<void> {
  const keys = new Set<number>();
  for (const id of toolCallIds) {
    const member = plan.get(id);
    if (member) keys.add(member.batchKey);
  }
  for (const key of keys) {
    const runtime = batches.get(key);
    if (!runtime) continue;
    for (const id of runtime.memberIds) plan.delete(id);
    batches.delete(key);
  }
}
