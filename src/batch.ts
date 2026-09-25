import { readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { toDisplayPath } from "./paths";
import { readConfig, getDiffContextLines } from "./config";
import { throwIfStrictInput, tryResolveEditTarget } from "./edit-common";
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
import { adoptAnchors, servedForPath } from "./anchor-registry";
import { restoreEndings, stripBOM, toLF, type LineEnding } from "./normalize";
import { assertInsertReq, assertReq, normReq } from "./payload-contract";
import { saveUndo } from "./replace-undo";
import { buildChanged, buildNoop, type RMetrics, type TResult } from "./replace-response";
import { serveRows, servedHashesFromDiff } from "./served";
import { abortIf, assertByteLimit, assertLineLimit, errCode, isRec, splitLines } from "./utils";

export interface PlannedMember {
  batchKey: number;
  id: string;
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
  direction?: "before" | "after";
  start: number;
  end: number;
  fromHash: string;
  toHash: string;
  newLines: string[];
  warnings: string[];
  noop: boolean;
  foldedLines: number;
  carryIndex?: number;
}

export interface BatchMemberInput {
  kind: BatchKind;
  direction?: "before" | "after";
  member: PlannedMember;
  targetPath: string;
  mutationTargetPath: string;
  cwd: string;
  signal?: AbortSignal;
  hedit: HEdit;
  extraWarnings: string[];
  foldedLines?: number;
}

interface BatchFailure {
  kind: BatchKind;
  order: number;
  code?: string;
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
  failure?: BatchFailure;
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
const abortedMembers = new Map<string, { display: number; message: string }>();
const ABORTED_MEMBERS_LIMIT = 1024;
const placeholderResults = new Map<string, TResult>();

function markBatchMembersAborted(runtime: BatchState): void {
  const message = abortedBatchMessage(runtime);
  for (const id of runtime.memberIds) {
    abortedMembers.delete(id);
    abortedMembers.set(id, { display: runtime.display, message });
    const result = placeholderResults.get(id);
    if (result?.details.batch) {
      result.details.batch.aborted = true;
      result.details.batch.abortMessage = message;
    }
  }
  while (abortedMembers.size > ABORTED_MEMBERS_LIMIT) {
    const oldest = abortedMembers.keys().next().value;
    if (oldest === undefined) break;
    abortedMembers.delete(oldest);
  }
}

export function abortedBatchMessageFor(toolCallId: string): string | undefined {
  const marked = abortedMembers.get(toolCallId);
  if (marked !== undefined) return marked.message;
  const member = plan.get(toolCallId);
  if (!member) return undefined;
  const runtime = batches.get(member.batchKey);
  return runtime?.failed ? abortedBatchMessage(runtime) : undefined;
}

export function batchMemberFor(toolCallId: string): PlannedMember | undefined {
  return plan.get(toolCallId);
}

export function resetBatchStateForTests(): void {
  plan.clear();
  batches.clear();
  abortedMembers.clear();
  placeholderResults.clear();
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

async function verifyPaths(
  group: Array<{ id: string; target: string; kind: BatchKind; args: unknown; path?: string }>,
  cwd: string,
): Promise<Array<{ id: string; target: string; kind: BatchKind; args: unknown; path?: string }>> {
  const verified: Array<{ id: string; target: string; kind: BatchKind; args: unknown; path?: string }> = [];
  for (const item of group) {
    if (!item.path) continue;
    let resolved: string | undefined;
    try {
      resolved = (await resolveInCwd(item.path, cwd)).resolved;
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
    if (state) {
      for (const id of state.memberIds) {
        plan.delete(id);
        placeholderResults.delete(id);
      }
    }
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
  interface ResolvedCall { id: string; target: string; kind: BatchKind; args: unknown; path?: string }
  const resolved: ResolvedCall[] = [];
  for (const call of calls) {
    const normalized = normalizeEditArgs(call.args);
    if (!normalized) continue;
    let target = normalized.kind === "replace" ? tryResolveEditTarget(normalized.removeFrom, normalized.removeTo) : tryResolveEditTarget(normalized.anchor);
    if (!target) {
      if (requirePath && normalized.path) {
        try {
          target = (await resolveInCwd(normalized.path, cwd)).resolved;
        } catch {
          target = undefined;
        }
      } else if (normalized.kind === "replace") {
        target = tryResolveEditTarget(normalized.removeFrom) ?? (normalized.removeTo ? tryResolveEditTarget(normalized.removeTo) : undefined);
      }
    }
    if (target) resolved.push({ id: call.id, target, kind: call.name as BatchKind, args: call.args, ...(normalized.path ? { path: normalized.path } : {}) });
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
  let display = 0;
  for (const group of finalGroups) {
    display += 1;
    const key = nextBatchKey++;
    batches.set(key, {
      display,
      target: group[0]!.target,
      memberIds: group.map((item) => item.id),
      replaceCount: 0,
      insertCount: 0,
      pieces: [],
      applied: 0,
      noops: 0,
      failures: 0,
      failed: false,
      warnings: [],
    });
    group.forEach((item, index) => {
      plan.set(item.id, {
        batchKey: key,
        id: item.id,
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
  return `batch ${member.display}:`;
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
  const added = piece.kind === "insert" ? Math.max(0, piece.newLines.length - piece.foldedLines) : piece.newLines.length;
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
        text: `In batch ${member.display}`,
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

export function withAbortSuffix(message: string, display: number): string {
  const suffix = `Aborts batch ${display}.`;
  if (message.includes(suffix)) return message;
  return message.endsWith(".") ? `${message} ${suffix}` : `${message}. ${suffix}`;
}

const ERROR_CODE_RE = /\[(E_[A-Z0-9_]+)\]/;

function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = ERROR_CODE_RE.exec(error.message)?.[1];
  return code === "E_OP_ABORTED" ? undefined : code;
}

export function noteBatchFailure(member: PlannedMember, error: unknown): void {
  const runtime = batches.get(member.batchKey);
  if (!runtime) return;
  if (error instanceof Error && !error.message.startsWith("[E_OP_ABORTED]")) error.message = withAbortSuffix(error.message, member.display);
  runtime.failures += 1;
  if (!runtime.failed) {
    runtime.failed = true;
    runtime.firstError = error;
    const code = errorCodeOf(error);
    runtime.failure = { kind: member.kind, order: member.order, ...(code !== undefined ? { code } : {}) };
  }
  markBatchMembersAborted(runtime);
}

function firstFailureCause(runtime: BatchState): string | undefined {
  const error = runtime.firstError;
  if (!(error instanceof Error)) return undefined;
  const suffix = ` Aborts batch ${runtime.display}.`;
  const message = error.message.endsWith(suffix) ? error.message.slice(0, -suffix.length) : error.message;
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  if (!firstLine.endsWith(":")) return firstLine;
  const sentenceEnd = firstLine.lastIndexOf(". ");
  return sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine.slice(0, -1);
}

function abortedBatchMessage(runtime: BatchState): string {
  const failure = runtime.failure;
  if (failure?.code !== undefined) {
    return `[E_OP_ABORTED] Batch ${runtime.display} aborted: [${failure.kind}] Call Nr ${failure.order} errored [${failure.code}]`;
  }
  const cause = firstFailureCause(runtime);
  return cause ? `[E_OP_ABORTED] Batch ${runtime.display} aborted: ${cause}` : `[E_OP_ABORTED] Batch ${runtime.display} aborted.`;
}

function batchAbortedError(runtime: BatchState): Error {
  discardBatchState(runtime);
  return new Error(abortedBatchMessage(runtime));
}
function discardBatchState(runtime: BatchState): void {
  markBatchMembersAborted(runtime);
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
    displayPath: toDisplayPath(input.cwd, file.absolutePath, input.targetPath),
  };
  return base;
}

export async function executeBatchMember(input: BatchMemberInput): Promise<TResult> {
  const runtime = batches.get(input.member.batchKey);
  if (!runtime) throw new Error(`[E_STALE_ANCHOR] Batch ${input.member.display} is no longer tracked. Call read for fresh anchors.`);
  if (runtime.failed) throw batchAbortedError(runtime);
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
    discardBatchState(runtime);
    throw error;
  }
  if (input.mutationTargetPath !== input.member.target) {
    const error = new Error(`[E_STALE_ANCHOR] "${input.hedit.hash_bounds[0].hash}" is no longer owned by ${input.member.target}. Call read for fresh anchors.`);
    noteBatchFailure(input.member, error);
    discardBatchState(runtime);
    throw error;
  }
  const displayPath = runtime.paths?.displayPath ?? input.targetPath;
  let planned: PlannedEdit;
  try {
    planned = planEdit(base.content, input.hedit, base.hashes, {
      filePath: displayPath,
      servedHashes: runtime.served,
      signal: input.signal,
      baseFileLines: base.baseLines,
    });
  } catch (error) {
    if (error instanceof RangeStaleError) adoptAnchors(base.absolutePath, error.rangeServedMap);
    else if (error instanceof AnchorMismatchError) adoptAnchors(base.absolutePath, error.feedbackMap);
    noteBatchFailure(input.member, error);
    discardBatchState(runtime);
    throw error;
  }
  const start = planned.resolved.hash_bounds[0].line;
  const end = planned.resolved.hash_bounds[1].line;
  const newLines = planned.resolved.content_lines;
  const baseLines = base.baseLines;
  const originalSlice = baseLines.slice(start - 1, end);
  const noop = originalSlice.length === newLines.length && originalSlice.every((line, index) => line === newLines[index]);
  const foldedLines = input.foldedLines ?? 0;
  const carryIndex =
    input.kind === "insert" && foldedLines > 0
      ? input.direction === "after"
        ? 0
        : newLines.length - 1
      : undefined;
  const piece: BatchPiece = {
    order: input.member.order,
    kind: input.kind,
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(carryIndex !== undefined ? { carryIndex } : {}),
    start,
    end,
    fromHash: input.hedit.hash_bounds[0].hash,
    toHash: input.hedit.hash_bounds[1].hash,
    newLines: [...newLines],
    warnings: [...input.extraWarnings, ...planned.warnings],
    noop,
    foldedLines,
  };
  runtime.pieces.push(piece);
  if (input.kind === "replace") runtime.replaceCount += 1;
  else runtime.insertCount += 1;
  if (noop) runtime.noops += 1;
  else runtime.applied += 1;
  runtime.warnings.push(...piece.warnings);
  if (!input.member.last) {
    const placeholder = batchPlaceholder(input.member, piece, base.snapshotId);
    placeholderResults.set(input.member.id, placeholder);
    return placeholder;
  }
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

function mergeInsertPairs(pieces: BatchPiece[]): BatchPiece[] {
  const byAnchor = new Map<number, BatchPiece[]>();
  for (const piece of pieces) {
    if (piece.kind !== "insert" || piece.start !== piece.end || piece.foldedLines === 0) continue;
    const group = byAnchor.get(piece.start) ?? [];
    group.push(piece);
    byAnchor.set(piece.start, group);
  }
  const partnerOf = new Map<BatchPiece, BatchPiece>();
  for (const group of byAnchor.values()) {
    if (group.length !== 2) continue;
    const [first, second] = group;
    if (first.direction === undefined || second.direction === undefined || first.direction === second.direction) continue;
    partnerOf.set(first, second);
    partnerOf.set(second, first);
  }
  const merged: BatchPiece[] = [];
  const consumed = new Set<BatchPiece>();
  for (const piece of pieces) {
    if (consumed.has(piece)) continue;
    const partner = partnerOf.get(piece);
    if (partner === undefined) {
      merged.push(piece);
      continue;
    }
    consumed.add(piece);
    consumed.add(partner);
    const before = piece.direction === "before" ? piece : partner;
    const after = piece.direction === "before" ? partner : piece;
    merged.push({
      ...before,
      order: Math.min(before.order, after.order),
      newLines: [...before.newLines, ...after.newLines.slice(1)],
      warnings: [...before.warnings, ...after.warnings],
      foldedLines: before.foldedLines + after.foldedLines - 1,
    });
  }
  return merged;
}

function pieceMappingSpans(pieces: BatchPiece[]): { start: number; end: number; replacementCount: number; carry?: number }[] {
  return pieces.map((piece) => ({
    start: piece.start - 1,
    end: piece.end - 1,
    replacementCount: piece.newLines.length,
    ...(piece.carryIndex !== undefined ? { carry: piece.carryIndex } : {}),
  }));
}

async function finishBatch(member: PlannedMember, signal?: AbortSignal): Promise<TResult> {
  const runtime = batches.get(member.batchKey);
  if (!runtime || !runtime.base || !runtime.paths) throw new Error(`[E_STALE_ANCHOR] Batch ${member.display} is no longer tracked. Call read for fresh anchors.`);
  const base = runtime.base;
  const paths = runtime.paths;
  if (runtime.failed) throw batchAbortedError(runtime);
  const executedOrders = new Set(runtime.pieces.map((piece) => piece.order));
  for (const id of runtime.memberIds) {
    const planned = plan.get(id);
    if (!planned) continue;
    if (executedOrders.has(planned.order)) continue;
    try {
      const normalized = normReq(planned.args);
      if (planned.kind === "replace") assertReq(normalized);
      else assertInsertReq(normalized);
    } catch (error) {
      noteBatchFailure(planned, error);
      throw batchAbortedError(runtime);
    }
  }
  const appliedPieces = runtime.pieces.filter((piece) => !piece.noop);
  if (appliedPieces.length === 0) {
    const snapshotId = await safeSnapId(paths.absolutePath, "noop edit");
    return combinedNoop(paths.displayPath, member, runtime, snapshotId);
  }
  const effectivePieces = mergeInsertPairs(appliedPieces);
  const ordered = [...effectivePieces].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start <= prev.end) {
      discardBatchState(runtime);
      throw new Error(`[E_BATCH_OVERLAP] Batch ${runtime.display} has overlapping ranges: ${formatBatchPiece(prev)} overlaps ${formatBatchPiece(current)}`);
    }
  }
  const composed = composeBatchLines(base.content, effectivePieces);
  const warnings = [...runtime.warnings];
  if (base.hadUtf8DecodeErrors) warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  try {
    await throwIfStrictInput(dedupeWarnings(warnings));
    assertNotEmpty(base.content, composed);
    assertLineLimit(composed, paths.displayPath, MAX_HASH_LINES);
    const finalBytes = base.bom + restoreEndings(composed, base.ending);
    assertByteLimit(finalBytes, paths.displayPath);
  } catch (error) {
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
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
    discardBatchState(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file was deleted after the batch started.`);
  }
  if (toLF(stripBOM(currentRaw).text) !== base.content) {
    discardBatchState(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file changed after the batch started. Call read for fresh anchors and retry.`);
  }
  const preflightSpans = pieceMappingSpans(effectivePieces);
  try {
    await lineHashes(composed, runtime.target, {
      content: base.content,
      hashes: base.hashes,
      spans: preflightSpans,
    }, undefined, false, true);
  } catch (error) {
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
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
    discardBatchState(runtime);
    throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history for ${paths.displayPath}. Aborts batch ${runtime.display}.`);
  }
  try {
    abortIf(signal);
    await writeAtomic(paths.absolutePath, base.bom + restoreEndings(composed, base.ending), base.identity);
  } catch (error) {
    await undo.restore();
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
    throw error;
  }
  const updatedSnapshotId = await safeSnapId(paths.absolutePath, "post-edit");
  const spans = pieceMappingSpans(effectivePieces);
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
    added += piece.kind === "insert" ? Math.max(0, piece.newLines.length - piece.foldedLines) : piece.newLines.length;
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
      spans,
    },
    batchVerb(runtime),
    await getDiffContextLines(),
  );
  changed.details.diff = `${header}\n${changed.details.diff}`;
  changed.details.diffLineNumbers?.unshift(null);
  try {
    serveRows(runtime.target, resultHashes, splitLines(composed), servedHashesFromDiff(changed.details.diff));
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
  const warnings = [...runtime.warnings];
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
      warnings: dedupeWarnings(warnings),
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
    for (const id of runtime.memberIds) {
      plan.delete(id);
      placeholderResults.delete(id);
    }
    batches.delete(key);
  }
}
