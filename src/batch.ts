import { readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { toDisplayPath } from "./paths";
import { readConfig, getDiffContextLines } from "./config";
import { throwIfStrictInput, tryResolveEditTarget } from "./edit-common";
import { readNormFile, safeSnapId } from "./file-reader";
import { clearPreEditSnapshots, recordPreEditSnapshot } from "./pre-edit-snapshot";
import { resolveInCwd, writeAtomic, type FileIdentity } from "./fs-write";
import {
  AnchorMismatchError,
  RangeStaleError,
  changedRange,
  lineHashes,
  planEdit,
  preserveDeletionSeparators,
  MAX_HASH_LINES,
  type HEdit,
  type PlannedEdit,
  type StripWarningLocation,
} from "./hashline";
import { adoptAnchors, servedForPath, formatAnchorReclaimNotice, takeReclaimedPaths } from "./anchor-registry";
import { restoreEndings, stripBOM, toLF, type LineEnding } from "./normalize";
import { applySpanEndings, joinSeparators, separatorsForSpans } from "./line-endings";
import { assertInsertReq, assertReplaceMatchReq, assertReq, assertTransferReq, normReq } from "./payload-contract";
import type { PipelineResult } from "./replace";
import { genPatch } from "./replace-diff";
import { saveUndo } from "./replace-undo";
import { buildChanged, buildNoop, type RMetrics, type TResult } from "./replace-response";
import { toEditVerb, withStructuredText, type EditStructured } from "./structured";
import { serveRows, servedHashesFromDiff } from "./served";
import { abortIf, assertByteLimit, assertLineLimit, errCode, isRec, mapIoError, splitLines, spliceAll } from "./utils";

export interface PlannedMember {
  batchKey: number;
  id: string;
  display: number;
  total: number;
  target: string;
  sourceTarget?: string;
  kind: BatchKind;
  args: unknown;
  order: number;
  size: number;
  last: boolean;
  plan?: BatchMemberPlan;
  demoted?: Error;
}

export type BatchKind = "replace" | "insert" | "replace_match" | "copy" | "move";

export interface BatchBase {
  content: string;
  hashes: string[];
  bom: string;
  ending: LineEnding;
  separators: LineEnding[];
  identity: FileIdentity;
  hadUtf8DecodeErrors: boolean;
  absolutePath: string;
  snapshotId?: string;
  baseLines: string[];
}

export interface BatchSourceMove {
  displayPath: string;
  mutationTargetPath: string;
  pipe: PipelineResult;
}

export interface BatchMemberPlan {
  hedit: HEdit;
  warnings: string[];
  planned?: PlannedEdit;
  foldedLines: number;
  direction?: "before" | "after";
  stripWarning?: StripWarningLocation;
  contentSeparators?: (LineEnding | undefined)[];
  carryIndex?: number;
  servedOverride?: ReadonlyMap<string, string>;
  sourceMove?: BatchSourceMove;
}

export interface BatchPlannerInput {
  member: PlannedMember;
  base: BatchBase;
  displayPath: string;
  served?: ReadonlyMap<string, string>;
  cwd: string;
  signal?: AbortSignal;
}

export type BatchMemberPlanner = (input: BatchPlannerInput) => BatchMemberPlan | undefined | Promise<BatchMemberPlan | undefined>;

const batchPlanners = new Map<BatchKind, BatchMemberPlanner>();

export function registerBatchPlanner(kind: BatchKind, planner: BatchMemberPlanner): void {
  batchPlanners.set(kind, planner);
}

interface SourcePreparation {
  move: BatchSourceMove;
  separators?: LineEnding[];
  bytes: string;
  originalBytes: string;
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
  separators?: (LineEnding | undefined)[];
}

export interface BatchMemberInput {
  member: PlannedMember;
  targetPath: string;
  mutationTargetPath: string;
  cwd: string;
  signal?: AbortSignal;
  plan?: BatchMemberPlan;
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
  allMemberIds: string[];
  stale: boolean;
  preflighted?: boolean;
  base?: BatchBase;
  paths?: { absolutePath: string; mutationTargetPath: string; displayPath: string };
  served?: ReadonlyMap<string, string>;
  pieces: BatchPiece[];
  sources: BatchSourceMove[];
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

interface ResolvedCall {
  id: string;
  target: string;
  altTarget?: string;
  sourceTarget?: string;
  kind: BatchKind;
  args: unknown;
  path?: string;
}

function demoteBlockedMoveCalls(resolved: ResolvedCall[]): ResolvedCall[] {
  const targets = new Set(resolved.map((item) => item.target));
  const sourceCounts = new Map<string, number>();
  for (const item of resolved) {
    if (item.kind !== "move" || item.sourceTarget === undefined || item.sourceTarget === item.target) continue;
    sourceCounts.set(item.sourceTarget, (sourceCounts.get(item.sourceTarget) ?? 0) + 1);
  }
  return resolved.filter((item) => {
    if (item.kind !== "move" || item.sourceTarget === undefined || item.sourceTarget === item.target) return true;
    if (targets.has(item.sourceTarget)) return false;
    return (sourceCounts.get(item.sourceTarget) ?? 0) === 1;
  });
}

type NormalizedEditArgs =
  | { kind: "replace"; removeFrom: string; removeTo?: string; path?: string }
  | { kind: "insert"; anchor: string; path?: string }
  | { kind: "replace_match"; replaceFrom: string; replaceTo?: string; path?: string }
  | { kind: "copy" | "move"; sourceFrom: string; sourceTo?: string; anchor?: string; direction?: string; path?: string };

const MAX_TRACKED_BATCHES = 256;
const BATCH_DISCARDED_NOTE = "Nothing was written; the whole batch was discarded.";
const BATCHABLE_CALLS = new Set(["replace", "insert", "replace_match", "copy", "move"]);
const MERGEABLE_PIECE_KINDS = new Set<BatchKind>(["insert", "copy", "move"]);

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
  const member = plan.get(toolCallId);
  if (!member || !batches.has(member.batchKey)) return undefined;
  return member;
}

export function pendingBatchMemberFor(path: string): PlannedMember | undefined {
  for (const runtime of batches.values()) {
    if (runtime.target !== path || runtime.stale || runtime.failed) continue;
    for (const id of runtime.memberIds) {
      const member = plan.get(id);
      if (member) return member;
    }
  }
  return undefined;
}

export function batchServedFor(member: PlannedMember): ReadonlyMap<string, string> | undefined {
  return batches.get(member.batchKey)?.served;
}

export function resetBatchStateForTests(): void {
  plan.clear();
  batches.clear();
  abortedMembers.clear();
  placeholderResults.clear();
  nextBatchKey = 1;
  clearPreEditSnapshots();
}

function normalizeEditArgs(name: string, args: unknown): NormalizedEditArgs | undefined {
  if (!isRec(args)) return undefined;
  const normalized = normReq(args, name === "replace_match" ? "replace" : name === "replace" ? "remove" : undefined);
  if (!isRec(normalized)) return undefined;
  const path = typeof normalized.path === "string" ? normalized.path : undefined;
  if (name === "copy" || name === "move") {
    if (typeof normalized.source_from !== "string") return undefined;
    return {
      kind: name,
      sourceFrom: normalized.source_from,
      ...(typeof normalized.source_to === "string" ? { sourceTo: normalized.source_to } : {}),
      ...(typeof normalized.anchor === "string" ? { anchor: normalized.anchor } : {}),
      ...(typeof normalized.direction === "string" ? { direction: normalized.direction } : {}),
      ...(path ? { path } : {}),
    };
  }
  if (name === "replace_match") {
    if (typeof normalized.replace_from !== "string") return undefined;
    return {
      kind: "replace_match",
      replaceFrom: normalized.replace_from,
      ...(typeof normalized.replace_to === "string" ? { replaceTo: normalized.replace_to } : {}),
      ...(path ? { path } : {}),
    };
  }
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
  group: Array<{ id: string; target: string; altTarget?: string; kind: BatchKind; args: unknown; path?: string }>,
  cwd: string,
): Promise<Array<{ id: string; target: string; altTarget?: string; kind: BatchKind; args: unknown; path?: string }>> {
  const verified: Array<{ id: string; target: string; altTarget?: string; kind: BatchKind; args: unknown; path?: string }> = [];
  for (const item of group) {
    if (!item.path) continue;
    let resolved: string | undefined;
    try {
      resolved = (await resolveInCwd(item.path, cwd)).resolved;
    } catch {
      resolved = undefined;
    }
    if (resolved === item.target || (item.altTarget !== undefined && resolved === item.altTarget)) verified.push(item);
  }
  return verified;
}

async function resolveBatchCallTarget(
  normalized: NormalizedEditArgs,
  requirePath: boolean,
  cwd: string,
): Promise<{ target: string; altTarget?: string; sourceTarget?: string } | undefined> {
  const transfer = normalized.kind === "copy" || normalized.kind === "move";
  if (normalized.kind === "replace" || normalized.kind === "replace_match") {
    const from = normalized.kind === "replace" ? normalized.removeFrom : normalized.replaceFrom;
    const to = normalized.kind === "replace" ? normalized.removeTo : normalized.replaceTo;
    const target = tryResolveEditTarget(from, to)
      ?? tryResolveEditTarget(from)
      ?? (to !== undefined ? tryResolveEditTarget(to) : undefined);
    if (target !== undefined) return { target };
  } else if (normalized.kind === "insert") {
    const target = tryResolveEditTarget(normalized.anchor);
    if (target !== undefined) return { target };
  } else {
    const sourceTarget = normalized.sourceTo !== undefined
      ? tryResolveEditTarget(normalized.sourceFrom, normalized.sourceTo)
      : tryResolveEditTarget(normalized.sourceFrom);
    const destinationTarget = normalized.anchor !== undefined ? tryResolveEditTarget(normalized.anchor) : undefined;
    if (sourceTarget === undefined) return undefined;
    if (normalized.kind === "move") {
      if (sourceTarget === destinationTarget) return { target: sourceTarget, sourceTarget };
      if (destinationTarget !== undefined) return { target: destinationTarget, altTarget: sourceTarget, sourceTarget };
    }
    if (sourceTarget === destinationTarget) return { target: sourceTarget, sourceTarget };
    if (destinationTarget !== undefined) {
      return { target: destinationTarget, altTarget: sourceTarget, sourceTarget };
    }
  }
  if (requirePath && normalized.path !== undefined && !transfer) {
    try {
      return { target: (await resolveInCwd(normalized.path, cwd)).resolved };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function enforceCap(): void {
  while (batches.size > MAX_TRACKED_BATCHES) {
    const oldest = batches.keys().next().value;
    if (oldest === undefined) return;
    const state = batches.get(oldest);
    batches.delete(oldest);
    if (state) {
      for (const id of state.allMemberIds) {
        plan.delete(id);
        placeholderResults.delete(id);
      }
    }
  }
}

export async function planAssistantMessage(message: unknown, cwd: string): Promise<void> {
  if (!isRec(message) || message.role !== "assistant") return;
  clearPreEditSnapshots();
  if (!Array.isArray(message.content)) return;
  const calls: EditCall[] = [];
  for (const block of message.content) {
    if (!isRec(block) || block.type !== "toolCall") continue;
    if (typeof block.name !== "string" || !BATCHABLE_CALLS.has(block.name)) continue;
    if (typeof block.id !== "string") continue;
    calls.push({ id: block.id, name: block.name, args: block.arguments });
  }
  if (calls.length < 2) return;
  const earlyConfig = await readConfig();
  const requirePath = earlyConfig.requirePath === true;
  const resolved: ResolvedCall[] = [];
  for (const call of calls) {
    const normalized = normalizeEditArgs(call.name, call.args);
    if (!normalized) continue;
    const resolvedTarget = await resolveBatchCallTarget(normalized, requirePath, cwd);
    if (!resolvedTarget) continue;
    resolved.push({
      id: call.id,
      target: resolvedTarget.target,
      kind: normalized.kind,
      args: call.args,
      ...(resolvedTarget.altTarget !== undefined ? { altTarget: resolvedTarget.altTarget } : {}),
      ...(resolvedTarget.sourceTarget !== undefined ? { sourceTarget: resolvedTarget.sourceTarget } : {}),
      ...(normalized.path ? { path: normalized.path } : {}),
    });
  }
  const allowed = demoteBlockedMoveCalls(resolved);
  const groups = new Map<string, ResolvedCall[]>();
  for (const item of allowed) {
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
  for (const runtime of batches.values()) runtime.stale = true;
  let display = 0;
  for (const group of finalGroups) {
    display += 1;
    const key = nextBatchKey++;
    batches.set(key, {
      display,
      target: group[0]!.target,
      memberIds: group.map((item) => item.id),
      allMemberIds: group.map((item) => item.id),
      stale: false,
      pieces: [],
      sources: [],
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
        ...(item.sourceTarget !== undefined ? { sourceTarget: item.sourceTarget } : {}),
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
  const kinds = new Set(runtime.pieces.map((piece) => piece.kind));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "insert") return "inserted";
    if (only === "copy") return "copied";
    if (only === "move") return "moved";
    return "replaced";
  }
  return "edited";
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
  if (piece.kind === "copy") return `edit #${piece.order} (copy at ${piece.fromHash}, ${lines})`;
  if (piece.kind === "move") return `edit #${piece.order} (move ${piece.fromHash}→${piece.toHash}, ${lines})`;
  if (piece.fromHash === piece.toHash) return `edit #${piece.order} (replace ${piece.fromHash}, ${lines})`;
  return `edit #${piece.order} (replace ${piece.fromHash}→${piece.toHash}, ${lines})`;
}

function batchPlaceholder(member: PlannedMember, piece: BatchPiece, snapshotId: string | undefined): TResult {
  const added = Math.max(0, piece.newLines.length - piece.foldedLines);
  const metrics: RMetrics = {
    edits_attempted: 1,
    edits_noop: piece.noop ? 1 : 0,
    warnings: 0,
    classification: piece.noop ? "noop" : "applied",
    ...(piece.noop ? {} : { added_lines: added, removed_lines: Math.max(0, piece.end - piece.start + 1 - piece.foldedLines) }),
  };
  const structuredContent: EditStructured = {
    ok: true,
    kind: "edit",
    verb: toEditVerb(piece.kind),
    classification: piece.noop ? "noop" : "applied",
    path: member.target,
    text: `In batch ${member.display} (queued)`,
    diff: "",
    warnings: [],
    hints: [],
    firstChangedLine: piece.noop ? null : piece.start,
    anchors: [],
    anchorsOmitted: false,
  };
  return {
    content: [
      {
        type: "text",
        text: `In batch ${member.display} (queued)`,
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
    structuredContent,
  };
}

export function withAbortSuffix(message: string, display: number): string {
  const suffix = `Aborts batch ${display}.`;
  if (message.includes(suffix)) return message;
  const ended = message.endsWith(".") ? `${message} ${suffix}` : `${message}. ${suffix}`;
  return `${ended} ${BATCH_DISCARDED_NOTE}`;
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
  const discarded = ` ${BATCH_DISCARDED_NOTE}`;
  const withoutDiscarded = error.message.endsWith(discarded) ? error.message.slice(0, -discarded.length) : error.message;
  const message = withoutDiscarded.endsWith(suffix) ? withoutDiscarded.slice(0, -suffix.length) : withoutDiscarded;
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  if (!firstLine.endsWith(":")) return firstLine;
  const sentenceEnd = firstLine.lastIndexOf(". ");
  return sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine.slice(0, -1);
}

function abortedBatchMessage(runtime: BatchState): string {
  const failure = runtime.failure;
  if (failure?.code !== undefined) {
    return `[E_OP_ABORTED] Batch ${runtime.display} aborted: [${failure.kind}] Call Nr ${failure.order} errored [${failure.code}]. ${BATCH_DISCARDED_NOTE}`;
  }
  const cause = firstFailureCause(runtime);
  if (cause === undefined) return `[E_OP_ABORTED] Batch ${runtime.display} aborted. ${BATCH_DISCARDED_NOTE}`;
  const ended = cause.endsWith(".") || cause.endsWith("!") || cause.endsWith("?") ? cause : `${cause}.`;
  return `[E_OP_ABORTED] Batch ${runtime.display} aborted: ${ended} ${BATCH_DISCARDED_NOTE}`;
}

function batchAbortedError(runtime: BatchState): Error {
  discardBatchState(runtime);
  return new Error(abortedBatchMessage(runtime));
}

const ATTRIBUTABLE_BATCH_CODES = new Set(["E_BAD_SHAPE", "E_BAD_REF", "E_STALE_ANCHOR", "E_RANGE_STALE", "E_SUBSTRING_NOT_FOUND", "E_MATCH_NOT_ISOLATED"]);

function isAttributableBatchError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== undefined && ATTRIBUTABLE_BATCH_CODES.has(code);
}

async function preflightBatch(runtime: BatchState, base: BatchBase, cwd: string, signal?: AbortSignal): Promise<void> {
  if (runtime.preflighted) return;
  runtime.preflighted = true;
  if (runtime.failed) return;
  const displayPath = runtime.paths?.displayPath ?? runtime.target;
  for (const id of [...runtime.memberIds]) {
    const member = plan.get(id);
    if (!member || member.demoted) continue;
    const planner = batchPlanners.get(member.kind);
    if (!planner) continue;
    try {
      const memberPlan = await planner({ member, base, displayPath, served: runtime.served, cwd, signal });
      if (memberPlan === undefined) continue;
      await throwIfStrictInput([...memberPlan.warnings, ...(memberPlan.planned?.warnings ?? [])]);
      member.plan = memberPlan;
    } catch (error) {
      if (!isAttributableBatchError(error)) {
        noteBatchFailure(member, error);
        throw error;
      }
      if (error instanceof RangeStaleError) adoptAnchors(base.absolutePath, error.rangeServedMap);
      else if (error instanceof AnchorMismatchError) adoptAnchors(base.absolutePath, error.feedbackMap);
      member.demoted = error instanceof Error ? error : new Error(String(error));
      runtime.memberIds = runtime.memberIds.filter((candidate) => candidate !== id);
    }
  }
  const survivors = runtime.memberIds
    .map((id) => plan.get(id))
    .filter((member): member is PlannedMember => member !== undefined);
  survivors.forEach((member, index) => {
    member.size = survivors.length;
    member.last = index === survivors.length - 1;
  });
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
  if (runtime.base) {
    await preflightBatch(runtime, runtime.base, input.cwd, input.signal);
    return runtime.base;
  }
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
    separators: file.endingSeparators,
    identity: file.identity,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors,
    absolutePath: file.absolutePath,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    baseLines: splitLines(file.normalized),
  };
  runtime.base = base;
  const served = servedForPath(file.absolutePath);
  runtime.served = served ? new Map(served) : undefined;
  runtime.paths = {
    absolutePath: file.absolutePath,
    mutationTargetPath: input.mutationTargetPath,
    displayPath: toDisplayPath(input.cwd, file.absolutePath, input.targetPath),
  };
  await preflightBatch(runtime, base, input.cwd, input.signal);
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
  if (runtime.failed) throw batchAbortedError(runtime);
  if (input.member.demoted) throw input.member.demoted;
  const memberPlan = input.plan ?? input.member.plan;
  if (memberPlan === undefined) {
    const error = new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: no plan for [${input.member.kind}] Call Nr ${input.member.order}. ${BATCH_DISCARDED_NOTE}`);
    noteBatchFailure(input.member, error);
    throw batchAbortedError(runtime);
  }
  if (input.mutationTargetPath !== input.member.target) {
    const error = new Error(`[E_STALE_ANCHOR] "${memberPlan.hedit.hash_bounds[0].hash}" is no longer owned by ${input.member.target}. Call read for fresh anchors.`);
    noteBatchFailure(input.member, error);
    discardBatchState(runtime);
    throw error;
  }
  const kind = input.member.kind;
  const displayPath = runtime.paths?.displayPath ?? input.targetPath;
  const effectiveHedit = preserveDeletionSeparators(memberPlan.hedit, base.baseLines, base.hashes);
  let planned: PlannedEdit;
  if (memberPlan.planned !== undefined) {
    planned = memberPlan.planned;
  } else {
    try {
      planned = planEdit(base.content, effectiveHedit, base.hashes, {
        filePath: displayPath,
        servedHashes: memberPlan.servedOverride ?? runtime.served,
        signal: input.signal,
        baseFileLines: base.baseLines,
        stripWarning: memberPlan.stripWarning,
      });
    } catch (error) {
      if (error instanceof RangeStaleError) adoptAnchors(base.absolutePath, error.rangeServedMap);
      else if (error instanceof AnchorMismatchError) adoptAnchors(base.absolutePath, error.feedbackMap);
      noteBatchFailure(input.member, error);
      discardBatchState(runtime);
      throw error;
    }
  }
  const start = planned.resolved.hash_bounds[0].line;
  const end = planned.resolved.hash_bounds[1].line;
  const newLines = planned.resolved.content_lines;
  const baseLines = base.baseLines;
  const originalSlice = baseLines.slice(start - 1, end);
  const noop = originalSlice.length === newLines.length && originalSlice.every((line, index) => line === newLines[index]);
  const foldedLines = memberPlan.foldedLines;
  const separators = memberPlan.contentSeparators ?? memberPlan.hedit.content_separators;
  const carryIndex =
    memberPlan.carryIndex !== undefined
      ? memberPlan.carryIndex
      : kind === "insert" && foldedLines > 0
        ? memberPlan.direction === "after"
          ? 0
          : newLines.length - 1
        : undefined;
  const piece: BatchPiece = {
    order: input.member.order,
    kind,
    ...(memberPlan.direction !== undefined ? { direction: memberPlan.direction } : {}),
    ...(carryIndex !== undefined ? { carryIndex } : {}),
    start,
    end,
    fromHash: planned.resolved.hash_bounds[0].hash,
    toHash: planned.resolved.hash_bounds[1].hash,
    newLines: [...newLines],
    ...(separators !== undefined ? { separators } : {}),
    warnings: [...memberPlan.warnings, ...planned.warnings],
    noop,
    foldedLines,
  };
  runtime.pieces.push(piece);
  if (noop) runtime.noops += 1;
  else runtime.applied += 1;
  runtime.warnings.push(...piece.warnings);
  if (memberPlan.sourceMove !== undefined) runtime.sources.push(memberPlan.sourceMove);
  if (!input.member.last) {
    const placeholder = batchPlaceholder(input.member, piece, base.snapshotId);
    placeholderResults.set(input.member.id, placeholder);
    return placeholder;
  }
  return finishBatch(input.member, input.signal);
}

function composeBatchLines(baseContent: string, pieces: BatchPiece[]): string {
  const lines = splitLines(baseContent);
  const baseLineCount = lines.length;
  const descending = [...pieces].sort((a, b) => b.start - a.start);
  for (const piece of descending) spliceAll(lines, piece.start - 1, piece.end - piece.start + 1, piece.newLines);
  let composed = lines.join("\n");
  if (lines.length > 0 && (baseContent.endsWith("\n") || lines[lines.length - 1] === "")) {
    composed += "\n";
  } else if (lines.length > 0) {
    const trailing = pieces.reduce<BatchPiece | undefined>((best, piece) => (best === undefined || piece.end > best.end ? piece : best), undefined);
    const lastEnding = trailing?.separators?.[trailing.newLines.length - 1];
    if (trailing !== undefined && trailing.end === baseLineCount && lastEnding !== undefined) composed += "\n";
  }
  return composed;
}

function changesEnding(piece: BatchPiece, baseSeparators: LineEnding[]): boolean {
  if (piece.separators === undefined) return false;
  for (let index = 0; index < piece.separators.length; index++) {
    const ending = piece.separators[index];
    if (ending === undefined) continue;
    const baseIndex = piece.start - 1 + index;
    if (baseIndex >= baseSeparators.length || baseSeparators[baseIndex] !== ending) return true;
  }
  return false;
}

function mergeInsertPairs(pieces: BatchPiece[]): BatchPiece[] {
  const byAnchor = new Map<number, BatchPiece[]>();
  for (const piece of pieces) {
    if (!MERGEABLE_PIECE_KINDS.has(piece.kind) || piece.start !== piece.end || piece.foldedLines === 0) continue;
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
    const beforeSeparators = before.separators ?? before.newLines.map(() => undefined);
    const afterSeparators = after.separators ?? after.newLines.map(() => undefined);
    const mergedSeparators = [...beforeSeparators.slice(0, before.newLines.length), ...afterSeparators.slice(1)];
    merged.push({
      ...before,
      order: Math.min(before.order, after.order),
      newLines: [...before.newLines, ...after.newLines.slice(1)],
      warnings: [...before.warnings, ...after.warnings],
      foldedLines: before.foldedLines + after.foldedLines - 1,
      ...(before.separators !== undefined || after.separators !== undefined ? { separators: mergedSeparators } : {}),
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
      const normalized = normReq(planned.args, planned.kind === "replace_match" ? "replace" : planned.kind === "replace" ? "remove" : undefined);
      if (planned.kind === "insert") assertInsertReq(normalized);
      else if (planned.kind === "replace") assertReq(normalized);
      else if (planned.kind === "replace_match") assertReplaceMatchReq(normalized);
      else assertTransferReq(normalized);
    } catch (error) {
      noteBatchFailure(planned, error);
      throw batchAbortedError(runtime);
    }
  }
  const appliedPieces = runtime.pieces.filter((piece) => !piece.noop);
  const candidatePieces = runtime.pieces.filter((piece) => !piece.noop || changesEnding(piece, base.separators));
  if (candidatePieces.length === 0 && runtime.sources.length === 0) {
    const snapshotId = await safeSnapId(paths.absolutePath, "noop edit");
    return combinedNoop(paths.displayPath, member, runtime, snapshotId);
  }
  const effectivePieces = mergeInsertPairs(candidatePieces);
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
  const spans = composed.length === 0
    ? [{ start: 0, end: base.hashes.length - 1, replacementCount: 1 }]
    : pieceMappingSpans(effectivePieces);
  const resultSeparators = separatorsForSpans(base.separators, base.hashes.length, spans, composed, base.ending, base.baseLines);
  applySpanEndings(resultSeparators, effectivePieces.map((piece) => ({
    start: piece.start - 1,
    end: piece.end - 1,
    replacementCount: piece.newLines.length,
    ...(piece.separators !== undefined ? { endings: piece.separators } : {}),
  })));
  const warnings = [...runtime.warnings];
  if (base.hadUtf8DecodeErrors) warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  const finalBytes = base.bom + joinSeparators(composed, resultSeparators);
  const originalBytes = base.bom + joinSeparators(base.content, base.separators);
  try {
    await throwIfStrictInput(dedupeWarnings(warnings));
    assertLineLimit(composed, paths.displayPath, MAX_HASH_LINES);
    assertByteLimit(finalBytes, paths.displayPath);
  } catch (error) {
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
    throw error;
  }
  const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
  if (reclaimNotice !== undefined) warnings.push(reclaimNotice);
  if (finalBytes === originalBytes && runtime.sources.length === 0) {
    const snapshotId = await safeSnapId(paths.absolutePath, "noop edit");
    return combinedNoop(paths.displayPath, member, runtime, snapshotId);
  }

  recordPreEditSnapshot({
    absolutePath: runtime.target,
    normalized: base.content,
    bom: base.bom,
    originalEnding: base.ending,
    endingSeparators: base.separators,
    fileHashes: base.hashes,
    hadUtf8DecodeErrors: base.hadUtf8DecodeErrors,
    identity: base.identity,
    served: runtime.served ? new Map(runtime.served) : undefined,
  });
  abortIf(signal);
  let currentRaw: string;
  try {
    currentRaw = await readFile(runtime.target, "utf-8");
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw mapIoError(error, "read", runtime.target);
    discardBatchState(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file was deleted after the batch started.`);
  }
  if (toLF(stripBOM(currentRaw).text) !== base.content) {
    discardBatchState(runtime);
    throw new Error(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the file changed after the batch started. Call read for fresh anchors and retry.`);
  }
  try {
    await lineHashes(composed, runtime.target, {
      content: base.content,
      hashes: base.hashes,
      spans,
    }, undefined, false, true);
  } catch (error) {
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
    throw error;
  }

  const sourcePreparations: SourcePreparation[] = [];
  for (const source of runtime.sources) {
    let sourceRaw: string | undefined;
    try {
      sourceRaw = await readFile(source.mutationTargetPath, "utf-8");
    } catch (error) {
      if (errCode(error) !== "ENOENT") throw mapIoError(error, "read", source.displayPath);
      sourceRaw = undefined;
    }
    if (sourceRaw === undefined || toLF(stripBOM(sourceRaw).text) !== source.pipe.originalNormalized) {
      discardBatchState(runtime);
      throw new Error(withAbortSuffix(`[E_OP_ABORTED] Batch ${runtime.display} aborted: the move source ${source.displayPath} changed after the move started. Call read for fresh anchors and retry.`, runtime.display));
    }
    const sourceSpan = source.pipe.spans?.[0];
    const sourceSeparators = sourceSpan
      ? separatorsForSpans(source.pipe.originalSeparators, source.pipe.originalHashes.length, [sourceSpan], source.pipe.result, source.pipe.originalEnding, splitLines(source.pipe.originalNormalized))
      : undefined;
    const sourceBytes = source.pipe.bom + (sourceSeparators !== undefined
      ? joinSeparators(source.pipe.result, sourceSeparators)
      : restoreEndings(source.pipe.result, source.pipe.originalEnding));
    const sourceOriginalBytes = source.pipe.bom + joinSeparators(source.pipe.originalNormalized, source.pipe.originalSeparators);
    try {
      assertByteLimit(sourceBytes, source.displayPath);
      await lineHashes(source.pipe.result, source.mutationTargetPath, {
        content: source.pipe.originalNormalized,
        hashes: source.pipe.originalHashes,
        ...(source.pipe.spans !== undefined ? { spans: source.pipe.spans } : {}),
      }, undefined, false, true);
    } catch (error) {
      discardBatchState(runtime);
      if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
      throw error;
    }
    sourcePreparations.push({
      move: source,
      ...(sourceSeparators !== undefined ? { separators: sourceSeparators } : {}),
      bytes: sourceBytes,
      originalBytes: sourceOriginalBytes,
    });
  }
  const undo = await saveUndo(runtime.target, {
    content: base.content,
    bom: base.bom,
    originalEnding: base.ending,
    separators: base.separators,
    hashes: base.hashes,
    resultContent: composed,
    resultSeparators,
  });
  if (!undo.persisted) {
    discardBatchState(runtime);
    throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history for ${paths.displayPath}. Aborts batch ${runtime.display}.`);
  }
  const undoRestores: Array<() => Promise<void>> = [undo.restore];
  for (const preparation of sourcePreparations) {
    const sourceUndo = await saveUndo(preparation.move.mutationTargetPath, {
      content: preparation.move.pipe.originalNormalized,
      bom: preparation.move.pipe.bom,
      originalEnding: preparation.move.pipe.originalEnding,
      separators: preparation.move.pipe.originalSeparators,
      hashes: preparation.move.pipe.originalHashes,
      resultContent: preparation.move.pipe.result,
      ...(preparation.separators !== undefined ? { resultSeparators: preparation.separators } : {}),
    });
    if (!sourceUndo.persisted) {
      for (const restore of [...undoRestores].reverse()) await restore();
      discardBatchState(runtime);
      throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history for ${preparation.move.displayPath}. Nothing was written. Aborts batch ${runtime.display}.`);
    }
    undoRestores.push(sourceUndo.restore);
  }
  const writtenFiles: Array<{ path: string; bytes: string }> = [];
  try {
    abortIf(signal);
    await writeAtomic(paths.absolutePath, finalBytes, base.identity);
    writtenFiles.push({ path: paths.absolutePath, bytes: originalBytes });
    for (const preparation of sourcePreparations) {
      abortIf(signal);
      await writeAtomic(preparation.move.mutationTargetPath, preparation.bytes, preparation.move.pipe.identity);
      writtenFiles.push({ path: preparation.move.mutationTargetPath, bytes: preparation.originalBytes });
    }
  } catch (error) {
    for (const written of [...writtenFiles].reverse()) {
      try {
        await writeAtomic(written.path, written.bytes);
      } catch (rollbackError) {
        console.error("Failed to roll back a file after a batched cross-file move failed:", rollbackError);
      }
    }
    for (const restore of [...undoRestores].reverse()) await restore();
    discardBatchState(runtime);
    if (error instanceof Error) error.message = withAbortSuffix(error.message, runtime.display);
    throw error;
  }
  const updatedSnapshotId = await safeSnapId(paths.absolutePath, "post-edit");
  let resultHashes: string[];
  try {
    resultHashes = await lineHashes(composed, runtime.target, {
      content: base.content,
      hashes: base.hashes,
      spans,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const written = sourcePreparations.length > 0
      ? "Files were written; anchor finalization failed. One undo per file reverts."
      : "File was written; anchor finalization failed. One undo reverts.";
    throw new Error(`${detail} ${written} Call read for fresh anchors.`);
  }

  for (const preparation of sourcePreparations) {
    try {
      await lineHashes(preparation.move.pipe.result, preparation.move.mutationTargetPath, {
        content: preparation.move.pipe.originalNormalized,
        hashes: preparation.move.pipe.originalHashes,
        ...(preparation.move.pipe.spans !== undefined ? { spans: preparation.move.pipe.spans } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail} Files were written; anchor finalization failed. One undo per file reverts. Call read for fresh anchors.`);
    }
  }
  const writeReclaim = formatAnchorReclaimNotice(takeReclaimedPaths());
  if (writeReclaim !== undefined) warnings.push(writeReclaim);
  const range = changedRange(base.content, composed);
  let added = 0;
  let removed = 0;
  for (const piece of appliedPieces) {
    removed += Math.max(0, piece.end - piece.start + 1 - piece.foldedLines);
    added += Math.max(0, piece.newLines.length - piece.foldedLines);
  }
  const verb = batchVerb(runtime);
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
    verb,
    await getDiffContextLines(),
    {
      separatorMoved:
        runtime.pieces.some((piece) => piece.kind === "insert") &&
        !runtime.pieces.some((piece) => piece.kind === "copy" || piece.kind === "move"),
      indentHints: !runtime.pieces.some((piece) => piece.kind === "copy" || piece.kind === "move"),
    },
  );

  if (sourcePreparations.length > 0) {
    const patches = [changed.details.patch ?? ""];
    let patchTruncated = changed.details.patchTruncated === true;
    for (const preparation of sourcePreparations) {
      const sourcePatch = genPatch(preparation.move.displayPath, preparation.move.pipe.originalNormalized, preparation.move.pipe.result);
      if (sourcePatch.patch.length > 0) patches.push(sourcePatch.patch);
      if (sourcePatch.truncated) patchTruncated = true;
    }
    changed.details.patch = patches.filter((patch) => patch.length > 0).join("\n");
    if (patchTruncated) changed.details.patchTruncated = true;
  }
  if (changed.details.diff.length > 0) {
    changed.details.diff = `${header}\n${changed.details.diff}`;
    changed.details.diffLineNumbers?.unshift(null);
  }
  try {
    const wanted = servedHashesFromDiff(changed.details.diff);
    if (composed.length === 0) wanted.push(...resultHashes);
    serveRows(runtime.target, resultHashes, splitLines(composed), wanted);
  } catch (error) {
    console.error("Failed to mark batch diff served:", error);
  }
  const executed = runtime.applied + runtime.noops;
  const movedLines = sourcePreparations.reduce((total, preparation) => total + preparation.move.pipe.totalRemovedLines, 0);
  const sourceFiles = sourcePreparations.map((preparation) => preparation.move.displayPath);
  const sourceNote = sourceFiles.length > 0
    ? `\nMoved ${movedLines} line(s) out of ${sourceFiles.join(", ")}; each source file keeps its own undo. Read ${sourceFiles.join(", ")} for fresh anchors.`
    : "";
  const undoNote = sourceFiles.length > 0 ? "one undo reverts the destination edits" : "one undo reverts them";
  changed.content[0]!.text = `${header}\n${changed.content[0]!.text}\nBatch ${member.display}: ${executed} edit${executed === 1 ? "" : "s"} applied as one commit; ${undoNote}.${sourceNote}`;
  changed.structuredContent = withStructuredText(changed.structuredContent, changed.content[0]!.text);
  changed.details.batch = { id: member.display, size: member.size, last: true, total: member.total };
  return changed;
}

async function combinedNoop(path: string, member: PlannedMember, runtime: BatchState, snapshotId: string | undefined): Promise<TResult> {
  const executed = runtime.applied + runtime.noops;
  const warnings = [...runtime.warnings];
  const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
  if (reclaimNotice !== undefined) warnings.push(reclaimNotice);
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
      verb: "edited",
    },
    "Batch",
  );
  noop.content[0]!.text += `\nBatch ${member.display}: ${executed} edits produced no net change; undo history preserved.`;
  noop.structuredContent = withStructuredText(noop.structuredContent, noop.content[0]!.text);
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
    for (const id of runtime.allMemberIds) {
      plan.delete(id);
      placeholderResults.delete(id);
    }
    batches.delete(key);
  }
  clearPreEditSnapshots();
}
