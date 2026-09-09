import { readFile } from "fs/promises";
import { commitEdit, type CommitMeta } from "./commit";
import { readConfig } from "./config";
import { tryResolveEditTarget } from "./edit-common";
import { resolveInCwd } from "./fs-write";
import { changedRange, lineHashes } from "./hashline";
import { deleteUndo, getUndoEntry, loadHashStore, upsertUndo, type UndoRecord } from "./hash-store";
import { markServed } from "./anchor-registry";
import { stripBOM, toLF, type LineEnding } from "./normalize";
import { normReq } from "./payload-contract";
import { buildChanged, buildNoop, type TResult } from "./replace-response";
import { buildServedMap, servedHashesFromDiff } from "./served";
import { errCode, isRec, splitLines } from "./utils";
import type { PipelineResult } from "./replace";

export interface PlannedMember {
  batchKey: number;
  display: number;
  total: number;
  target: string;
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
}

interface PriorUndo {
  present: boolean;
  record?: UndoRecord;
}

interface BatchState {
  display: number;
  target: string;
  memberIds: string[];
  replaceCount: number;
  insertCount: number;
  base?: BatchBase;
  priorUndo?: PriorUndo;
  applied: number;
  noops: number;
  failures: number;
  added: number;
  removed: number;
  warnings: string[];
  final?: string;
  coalesced: boolean;
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

function argsFor(calls: EditCall[], id: string): unknown {
  return calls.find((call) => call.id === id)?.args;
}

async function verifyPaths(
  group: Array<{ id: string; target: string }>,
  calls: EditCall[],
  cwd: string,
): Promise<Array<{ id: string; target: string }>> {
  const verified: Array<{ id: string; target: string }> = [];
  for (const item of group) {
    const normalized = normalizeEditArgs(argsFor(calls, item.id));
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
  const resolved: Array<{ id: string; target: string }> = [];
  for (const call of calls) {
    const target = anchorTargetFor(call.args);
    if (target) resolved.push({ id: call.id, target });
  }
  const groups = new Map<string, Array<{ id: string; target: string }>>();
  for (const item of resolved) {
    const group = groups.get(item.target) ?? [];
    group.push(item);
    groups.set(item.target, group);
  }
  const multi = [...groups.values()].filter((group) => group.length >= 2);
  if (multi.length === 0) return;
  const config = await readConfig();
  const finalGroups: Array<Array<{ id: string; target: string }>> = [];
  if (config.requirePath === true) {
    for (const group of multi) {
      const verified = await verifyPaths(group, calls, cwd);
      if (verified.length >= 2) finalGroups.push(verified);
    }
  } else {
    finalGroups.push(...multi);
  }
  if (finalGroups.length === 0) return;
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
      applied: 0,
      noops: 0,
      failures: 0,
      added: 0,
      removed: 0,
      warnings: [],
      coalesced: false,
    });
    group.forEach((item, index) => {
      plan.set(item.id, {
        batchKey: key,
        display,
        total: finalGroups.length,
        target: item.target,
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

function batchPlaceholder(member: PlannedMember, result: TResult): TResult {
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
      firstChangedLine: result.details.firstChangedLine,
      snapshotId: result.details.snapshotId,
      classification: result.details.classification,
      metrics: result.details.metrics ? { ...result.details.metrics, warnings: 0 } : undefined,
      batch: { id: member.display, size: member.size, last: false },
    },
  };
}

async function restorePriorUndo(runtime: BatchState): Promise<void> {
  if (runtime.applied === 0 || !runtime.priorUndo) return;
  try {
    const store = await loadHashStore();
    if (runtime.priorUndo.present && runtime.priorUndo.record) upsertUndo(store, runtime.target, runtime.priorUndo.record);
    else deleteUndo(store, runtime.target);
  } catch (error) {
    console.error("Failed to restore pre-batch undo entry:", error);
  }
}

async function combinedApplied(
  pipe: PipelineResult,
  meta: CommitMeta,
  member: PlannedMember,
  runtime: BatchState,
  lastResult: TResult,
): Promise<TResult> {
  const base = runtime.base!;
  const store = await loadHashStore();
  const finalHashes = await lineHashes(pipe.result, meta.mutationTargetPath);
  const warnings = dedupeWarnings(runtime.warnings);
  const range = changedRange(base.content, pipe.result);
  const changed = buildChanged(
    {
      path: pipe.path,
      originalNormalized: base.content,
      originalHashes: base.hashes,
      result: pipe.result,
      resultHashes: finalHashes,
      warnings,
      snapshotId: lastResult.details.snapshotId,
      editMeta: {
        editsAttempted: runtime.applied + runtime.noops,
        noopEditsCount: runtime.noops,
        firstChangedLine: range?.firstChangedLine,
        lastChangedLine: range?.lastChangedLine,
        addedLines: runtime.added,
        removedLines: runtime.removed,
      },
      boundaryDedupAbove: [],
      boundaryDedupBelow: [],
    },
    batchVerb(runtime),
  );
  const header = batchHeader(member);
  changed.details.diff = `${header}
${changed.details.diff}`;
  changed.details.diffLineNumbers?.unshift(undefined);
  try {
    upsertUndo(store, meta.mutationTargetPath, {
      content: base.content,
      bom: base.bom,
      ending: base.ending,
      hashes: base.hashes,
      resultContent: pipe.result,
    });
    runtime.coalesced = true;
  } catch (error) {
    console.error("Failed to persist batch undo entry:", error);
  }
  try {
    markServed(
      meta.mutationTargetPath,
      buildServedMap(finalHashes, splitLines(pipe.result), servedHashesFromDiff(changed.details.diff)),
    );
  } catch (error) {
    console.error("Failed to mark batch diff served:", error);
  }
  const executed = runtime.applied + runtime.noops;
  changed.content[0]!.text = `${header}
${changed.content[0]!.text}
Batch ${member.display}: ${executed} edit${executed === 1 ? "" : "s"} applied as one commit; one undo reverts them.`;
  changed.details.batch = { id: member.display, size: member.size, last: true };
  return changed;
}

async function combinedNoop(path: string, member: PlannedMember, runtime: BatchState, lastResult: TResult): Promise<TResult> {
  await restorePriorUndo(runtime);
  const executed = runtime.applied + runtime.noops;
  const noop = buildNoop(
    {
      path,
      noopEdit: undefined,
      snapshotId: lastResult.details.snapshotId,
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
  noop.details.batch = { id: member.display, size: member.size, last: true };
  return noop;
}

export async function commitBatched(
  pipe: PipelineResult,
  meta: CommitMeta,
  toolCallId: string,
  kind: BatchKind,
): Promise<TResult> {
  const member = plan.get(toolCallId);
  const runtime = member ? batches.get(member.batchKey) : undefined;
  if (!member || !runtime || runtime.target !== meta.mutationTargetPath) return commitEdit(pipe, meta);
  if (!runtime.base) {
    runtime.base = {
      content: pipe.originalNormalized,
      hashes: pipe.originalHashes.slice(),
      bom: pipe.bom,
      ending: pipe.originalEnding,
    };
    try {
      const store = await loadHashStore();
      const prior = getUndoEntry(store, meta.mutationTargetPath);
      runtime.priorUndo = { present: prior !== undefined, record: prior };
    } catch {
      runtime.priorUndo = undefined;
    }
  }
  let result: TResult;
  try {
    result = await commitEdit(pipe, meta);
  } catch (error) {
    runtime.failures += 1;
    throw error;
  }
  const metrics = result.details.metrics;
  const applied = metrics?.classification === "applied";
  if (kind === "replace") runtime.replaceCount += 1;
  else runtime.insertCount += 1;
  if (applied) {
    runtime.applied += 1;
    runtime.added += metrics?.added_lines ?? 0;
    runtime.removed += metrics?.removed_lines ?? 0;
  } else {
    runtime.noops += 1;
  }
  runtime.warnings.push(...(result.details.warnings ?? []));
  runtime.final = pipe.result;
  if (!member.last) return batchPlaceholder(member, result);
  if (runtime.final === runtime.base.content) return combinedNoop(pipe.path, member, runtime, result);
  return combinedApplied(pipe, meta, member, runtime, result);
}

async function coalesceIfNeeded(runtime: BatchState): Promise<void> {
  if (runtime.coalesced || !runtime.base || runtime.final === undefined) return;
  if (runtime.final === runtime.base.content || runtime.applied === 0) return;
  let current: string | undefined;
  try {
    current = toLF(stripBOM(await readFile(runtime.target, "utf-8")).text);
  } catch (error) {
    if (errCode(error) !== "ENOENT") {
      console.error("Failed to verify batch file for undo coalescing:", error);
      return;
    }
    current = undefined;
  }
  if (current !== undefined && current !== runtime.final) return;
  try {
    const store = await loadHashStore();
    upsertUndo(store, runtime.target, {
      content: runtime.base.content,
      bom: runtime.base.bom,
      ending: runtime.base.ending,
      hashes: runtime.base.hashes,
      resultContent: runtime.final,
    });
    runtime.coalesced = true;
  } catch (error) {
    console.error("Failed to persist batch undo entry:", error);
  }
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
    await coalesceIfNeeded(runtime);
    for (const id of runtime.memberIds) plan.delete(id);
    batches.delete(key);
  }
}
