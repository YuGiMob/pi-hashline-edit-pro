import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { execPipeline, noteAnchorError, previewFromPipe, previewError, type PipelineResult, type ReplaceDetails } from "./replace.ts";
import { commitEdit, fileStateSinceRead } from "./commit.ts";
import { readNormFile, safeSnapId, type NormFile } from "./file-reader.ts";
import { preEditSnapshotFor } from "./pre-edit-snapshot.ts";
import {
  lineHashes,
  MAX_HASH_LINES,
  parseHashRef,
  planEdit,
  preserveDeletionSeparators,
  resEdit,
  resolveAnchorLine,
  stripAnchorRow,
  type Anchor,
  type HEdit,
  type HTEdit,
} from "./hashline/index.ts";
import { formatAnchorReclaimNotice, servedForPath, takeReclaimedPaths, withAnchorSession } from "./anchor-registry.ts";
import { batchMemberFor, batchServedFor, ensureBatchBase, executeBatchMember, noteBatchFailure, pendingBatchMemberFor, registerBatchPlanner, type BatchBase, type BatchMemberPlanner, type PlannedMember } from "./batch.ts";
import { loadP, loadGuidelines } from "./prompts.ts";
import { assertTransferReq, normReq, type TransferReq } from "./payload-contract.ts";
import { abortIf, anchorCarryIndex, assertByteLimit, isRec, splitLines } from "./utils.ts";
import { toDisplayPath } from "./paths.ts";
import { getDiffContextLines } from "./config.ts";
import { resolveInCwd, writeAtomic } from "./fs-write.ts";
import { restoreEndings, type LineEnding } from "./normalize.ts";
import { applyEndingOverrides, endingsForRange, joinSeparators, separatorsForSpans } from "./line-endings.ts";
import { saveUndo, type UndoEntry } from "./replace-undo.ts";
import { buildChanged, buildMetrics, type TResult } from "./replace-response.ts";
import { servedHashesFromDiff, serveRows } from "./served.ts";
import {
  assertBoundaryLinesServed,
  assertPathOption,
  DEFAULT_EDIT_FLAGS,
  editRenderResultWrapper,
  editToolBase,
  queuedEdit,
  resolveEditTarget,
  throwIfStrictInput,
  tryResolveEditTarget,
  trustRangeServed,
  withTransferPrompts,
  type EditToolFlags,
} from "./edit-common.ts";
import { makeRenderCall, type RPreview, type RRState } from "./replace-render.ts";
import { anchoredLinesFromDiff, diffAnchorsOmitted, editResultSchema, withStructuredErrors, type EditStructured } from "./structured.ts";

export type TransferKind = "copy" | "move";

interface TransferRefs {
  sourceFrom: Anchor;
  sourceTo: Anchor;
  anchor: Anchor;
  direction: "before" | "after";
}

export interface TransferPlan {
  editParams: HTEdit;
  foldedAnchorLines: number;
  anchorCarry?: number;
  servedOverride?: ReadonlyMap<string, string>;
  endingOverrides?: (LineEnding | undefined)[];
}

interface PairFileCommit {
  pipe: PipelineResult;
  displayPath: string;
  absolutePath: string;
  mutationTargetPath: string;
  foldedAnchorLines: number;
  anchorCarry?: number;
  endingOverrides?: (LineEnding | undefined)[];
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

export function parseTransferAnchors(req: TransferReq): { refs: TransferRefs; warnings: string[] } {
  const warnings: string[] = [];
  const from = stripAnchorRow(req.source_from.trim(), "source_from entry", warnings);
  const to = stripAnchorRow(req.source_to.trim(), "source_to entry", warnings);
  const destination = stripAnchorRow(req.anchor.trim(), "anchor entry", warnings);
  return {
    refs: {
      sourceFrom: parseHashRef(from, warnings, "source_from"),
      sourceTo: parseHashRef(to, warnings, "source_to"),
      anchor: parseHashRef(destination, warnings, "anchor"),
      direction: req.direction,
    },
    warnings,
  };
}

function offsetEndings(offset: number, endings: (LineEnding | undefined)[]): (LineEnding | undefined)[] {
	return [...new Array<LineEnding | undefined>(offset).fill(undefined), ...endings];
}

export function buildTransferEdit(input: {
  kind: TransferKind;
  refs: TransferRefs;
  preload: NormFile;
  displayPath: string;
  served?: ReadonlyMap<string, string>;
}): TransferPlan {
  const { kind, refs, preload, displayPath, served } = input;
  if (preload.normalized.length === 0) {
    throw new Error("[E_BAD_SHAPE] The file is empty, so there are no lines to copy or move; use insert or replace to seed content.");
  }
  const fileLines = splitLines(preload.normalized);
  const fromLine = resolveAnchorLine(refs.sourceFrom, fileLines, preload.fileHashes, displayPath);
  const toLine = resolveAnchorLine(refs.sourceTo, fileLines, preload.fileHashes, displayPath);
  const sourceStart = Math.min(fromLine, toLine);
  const sourceEnd = Math.max(fromLine, toLine);
  const anchorLine = resolveAnchorLine(refs.anchor, fileLines, preload.fileHashes, displayPath);
  const insertLine = refs.direction === "after" ? anchorLine : anchorLine - 1;
  if (insertLine >= sourceStart && insertLine < sourceEnd) {
    throw new Error(
      `[E_BAD_SHAPE] "anchor" resolves to line ${anchorLine}, which places the block inside the source range (lines ${sourceStart}-${sourceEnd}). Use a line outside the source range.`,
    );
  }
  assertBoundaryLinesServed(fileLines, preload.fileHashes, served, anchorLine, anchorLine, displayPath);
  assertBoundaryLinesServed(fileLines, preload.fileHashes, served, sourceStart, sourceStart, displayPath);
  assertBoundaryLinesServed(fileLines, preload.fileHashes, served, sourceEnd, sourceEnd, displayPath);
  const sourceLines = fileLines.slice(sourceStart - 1, sourceEnd);
  const sourceEndings = endingsForRange(preload.endingSeparators, sourceStart, sourceEnd);
  if (kind === "copy") {
    return {
      editParams: {
        remove_from: preload.fileHashes[anchorLine - 1]!,
        remove_to: preload.fileHashes[anchorLine - 1]!,
        text: refs.direction === "after"
          ? [fileLines[anchorLine - 1]!, ...sourceLines]
          : [...sourceLines, fileLines[anchorLine - 1]!],
      },
      foldedAnchorLines: 1,
      anchorCarry: anchorCarryIndex(refs.direction, sourceLines.length),
      endingOverrides: refs.direction === "after"
        ? [undefined, ...sourceEndings]
        : [...sourceEndings, undefined],
    };
  }
  if (insertLine < sourceStart) {
    const replacedStart = insertLine + 1;
    const replacedEnd = sourceEnd;
    return {
      editParams: {
        remove_from: preload.fileHashes[replacedStart - 1]!,
        remove_to: preload.fileHashes[replacedEnd - 1]!,
        text: [...sourceLines, ...fileLines.slice(insertLine, sourceStart - 1)],
      },
      foldedAnchorLines: 0,
      servedOverride: trustRangeServed(fileLines, preload.fileHashes, served, replacedStart, replacedEnd),
      endingOverrides: sourceEndings,
    };
  }
  const replacedStart = sourceStart;
  const replacedEnd = insertLine;
  return {
    editParams: {
      remove_from: preload.fileHashes[replacedStart - 1]!,
      remove_to: preload.fileHashes[replacedEnd - 1]!,
      text: [...fileLines.slice(sourceEnd, insertLine), ...sourceLines],
    },
    foldedAnchorLines: 0,
    servedOverride: trustRangeServed(fileLines, preload.fileHashes, served, replacedStart, replacedEnd),
    endingOverrides: offsetEndings(insertLine - sourceEnd, sourceEndings),
  };
}

function describeTransferTargets(sourcePath: string, destinationPath: string): string {
  return sourcePath === destinationPath
    ? `the file "${sourcePath}"`
    : `the source file "${sourcePath}" or the destination file "${destinationPath}"`;
}

async function resolveTransferTargets(req: TransferReq, cwd: string): Promise<{ sourcePath: string; destinationPath: string }> {
  const sourcePath = resolveEditTarget(req.source_from, req.source_to);
  const destinationPath = resolveEditTarget(req.anchor);
  await assertPathOption({
    providedPath: req.path,
    cwd,
    targets: [sourcePath, destinationPath],
    expected: describeTransferTargets(sourcePath, destinationPath),
    requestLabel: "Copy/move request",
  });
  return { sourcePath, destinationPath };
}

async function assertTransferPathOption(req: TransferReq, cwd: string, member: PlannedMember): Promise<void> {
  const sourceTarget = member.sourceTarget ?? member.target;
  await assertPathOption({
    providedPath: req.path,
    cwd,
    targets: [sourceTarget, member.target],
    expected: describeTransferTargets(sourceTarget, member.target),
    requestLabel: "Copy/move request",
  });
}

interface CrossTransferPreparation {
  sourcePreload: NormFile;
  destinationPreload: NormFile;
  sourceDisplay: string;
  destinationDisplay: string;
  destinationEdit: HTEdit;
  destinationFolded: number;
  anchorCarry?: number;
  endingOverrides: (LineEnding | undefined)[];
  sourceEdit?: HTEdit;
}

async function prepareCrossTransfer(input: {
  kind: TransferKind;
  refs: TransferRefs;
  sourcePath: string;
  destinationPath: string;
  cwd: string;
  signal?: AbortSignal;
  noPersist: boolean;
  sourcePreload?: NormFile;
  destinationPreload?: NormFile;
  sourceServed?: ReadonlyMap<string, string>;
  destinationServed?: ReadonlyMap<string, string>;
}): Promise<CrossTransferPreparation> {
  const { kind, refs, sourcePath, destinationPath, cwd, signal, noPersist } = input;
  const common = { signal, maxLines: MAX_HASH_LINES };
  const sourceAccessMode = kind === "move" ? constants.R_OK | constants.W_OK : constants.R_OK;
  const candidate = kind === "copy" && input.sourcePreload === undefined ? preEditSnapshotFor(sourcePath) : undefined;
  const snapshotPreload = candidate !== undefined
    && candidate.fileHashes.includes(refs.sourceFrom.hash)
    && candidate.fileHashes.includes(refs.sourceTo.hash)
    ? candidate
    : undefined;
  const sourcePreload = input.sourcePreload ?? snapshotPreload ?? (await readNormFile(sourcePath, cwd, noPersist ? { ...common, accessMode: constants.R_OK, noPersist: true, allocation: "shadow" } : { ...common, accessMode: sourceAccessMode }));
  const destinationPreload = input.destinationPreload ?? (await readNormFile(destinationPath, cwd, noPersist ? { ...common, accessMode: constants.R_OK, noPersist: true, allocation: "shadow" } : { ...common, accessMode: constants.R_OK | constants.W_OK }));
  const sourceDisplay = toDisplayPath(cwd, sourcePreload.absolutePath, sourcePath);
  const destinationDisplay = toDisplayPath(cwd, destinationPreload.absolutePath, destinationPath);
  const sourceServed = input.sourceServed ?? (snapshotPreload !== undefined ? snapshotPreload.served : servedForPath(sourcePreload.absolutePath));
  const destinationServed = input.destinationServed ?? servedForPath(destinationPreload.absolutePath);
  const sourceLines = splitLines(sourcePreload.normalized);
  const destinationLines = splitLines(destinationPreload.normalized);

  const adopt = async (path: string, error: unknown): Promise<void> => {
    if (!noPersist) await noteAnchorError(path, error);
  };

  if (sourcePreload.normalized.length === 0) {
    throw new Error("[E_BAD_SHAPE] The source file is empty, so there are no lines to copy or move; use insert or replace to seed content.");
  }

  let sourceStart = 0;
  let sourceEnd = 0;
  try {
    const fromLine = resolveAnchorLine(refs.sourceFrom, sourceLines, sourcePreload.fileHashes, sourceDisplay);
    const toLine = resolveAnchorLine(refs.sourceTo, sourceLines, sourcePreload.fileHashes, sourceDisplay);
    sourceStart = Math.min(fromLine, toLine);
    sourceEnd = Math.max(fromLine, toLine);
  } catch (error) {
    await adopt(sourcePreload.absolutePath, error);
    throw error;
  }
  try {
    assertBoundaryLinesServed(sourceLines, sourcePreload.fileHashes, sourceServed, sourceStart, sourceStart, sourceDisplay);
    assertBoundaryLinesServed(sourceLines, sourcePreload.fileHashes, sourceServed, sourceEnd, sourceEnd, sourceDisplay);
  } catch (error) {
    await adopt(sourcePreload.absolutePath, error);
    throw error;
  }

  let anchorLine = 0;
  try {
    anchorLine = resolveAnchorLine(refs.anchor, destinationLines, destinationPreload.fileHashes, destinationDisplay);
  } catch (error) {
    await adopt(destinationPreload.absolutePath, error);
    throw error;
  }
  try {
    assertBoundaryLinesServed(destinationLines, destinationPreload.fileHashes, destinationServed, anchorLine, anchorLine, destinationDisplay);
  } catch (error) {
    await adopt(destinationPreload.absolutePath, error);
    throw error;
  }

  const moved = sourceLines.slice(sourceStart - 1, sourceEnd);
  const destinationEdit: HTEdit = destinationPreload.normalized.length === 0
    ? {
        remove_from: destinationPreload.fileHashes[0]!,
        remove_to: destinationPreload.fileHashes[0]!,
        text: [...moved],
      }
    : refs.direction === "after"
      ? {
          remove_from: destinationPreload.fileHashes[anchorLine - 1]!,
          remove_to: destinationPreload.fileHashes[anchorLine - 1]!,
          text: [destinationLines[anchorLine - 1]!, ...moved],
        }
      : {
          remove_from: destinationPreload.fileHashes[anchorLine - 1]!,
          remove_to: destinationPreload.fileHashes[anchorLine - 1]!,
          text: [...moved, destinationLines[anchorLine - 1]!],
        };
  const destinationFolded = destinationPreload.normalized.length === 0 ? 0 : 1;
  const sourceEndings = endingsForRange(sourcePreload.endingSeparators, sourceStart, sourceEnd);
  const endingOverrides = destinationFolded === 0
    ? sourceEndings
    : refs.direction === "after"
      ? offsetEndings(1, sourceEndings)
      : sourceEndings;
  if (kind === "copy") {
    return { sourcePreload, destinationPreload, sourceDisplay, destinationDisplay, destinationEdit, destinationFolded, ...(destinationFolded === 1 ? { anchorCarry: anchorCarryIndex(refs.direction, moved.length) } : {}), endingOverrides };
  }
  const sourceEdit: HTEdit = {
    remove_from: sourcePreload.fileHashes[sourceStart - 1]!,
    remove_to: sourcePreload.fileHashes[sourceEnd - 1]!,
    text: [],
  };
  return { sourcePreload, destinationPreload, sourceDisplay, destinationDisplay, destinationEdit, destinationFolded, ...(destinationFolded === 1 ? { anchorCarry: anchorCarryIndex(refs.direction, moved.length) } : {}), sourceEdit, endingOverrides };
}

function pairEntry(pipe: PipelineResult, separators: LineEnding[] | undefined): UndoEntry {
  return {
    content: pipe.originalNormalized,
    bom: pipe.bom,
    originalEnding: pipe.originalEnding,
    separators: pipe.originalSeparators,
    hashes: pipe.originalHashes,
    resultContent: pipe.result,
    ...(separators !== undefined ? { resultSeparators: separators } : {}),
  };
}

async function commitMovePair(input: {
  source: PairFileCommit;
  destination: PairFileCommit;
  signal?: AbortSignal;
  warnings: string[];
}): Promise<TResult> {
  const warnings = dedupeWarnings([
    ...input.warnings,
    ...input.destination.pipe.warnings,
    ...input.source.pipe.warnings,
  ]);
  const destinationSpan = input.destination.pipe.spans?.[0];
  const sourceSpan = input.source.pipe.spans?.[0];
  if (destinationSpan && input.destination.anchorCarry !== undefined) destinationSpan.carry = input.destination.anchorCarry;
  const destinationSeparators = destinationSpan
    ? separatorsForSpans(input.destination.pipe.originalSeparators, input.destination.pipe.originalHashes.length, [destinationSpan], input.destination.pipe.result, input.destination.pipe.originalEnding, splitLines(input.destination.pipe.originalNormalized))
    : undefined;
  if (destinationSeparators !== undefined && destinationSpan !== undefined) {
    applyEndingOverrides(destinationSeparators, destinationSpan.start, input.destination.endingOverrides);
  }
  const sourceSeparators = sourceSpan
    ? separatorsForSpans(input.source.pipe.originalSeparators, input.source.pipe.originalHashes.length, [sourceSpan], input.source.pipe.result, input.source.pipe.originalEnding, splitLines(input.source.pipe.originalNormalized))
    : undefined;
  const destinationBytes = input.destination.pipe.bom + (destinationSeparators !== undefined
    ? joinSeparators(input.destination.pipe.result, destinationSeparators)
    : restoreEndings(input.destination.pipe.result, input.destination.pipe.originalEnding));
  const sourceBytes = input.source.pipe.bom + (sourceSeparators !== undefined
    ? joinSeparators(input.source.pipe.result, sourceSeparators)
    : restoreEndings(input.source.pipe.result, input.source.pipe.originalEnding));
  assertByteLimit(destinationBytes, input.destination.displayPath);
  assertByteLimit(sourceBytes, input.source.displayPath);

  if (input.destination.pipe.hadUtf8DecodeErrors || input.source.pipe.hadUtf8DecodeErrors) {
    warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  }

  const destinationState = await fileStateSinceRead(input.destination.mutationTargetPath, input.destination.displayPath, input.destination.pipe.originalNormalized, input.signal);
  if (destinationState !== "unchanged") {
    const verb = destinationState === "deleted" ? "was deleted" : "changed";
    throw new Error(`[E_OP_ABORTED] Edit aborted: ${input.destination.displayPath} ${verb} after the move started. Call read for fresh anchors and retry.`);
  }
  const sourceState = await fileStateSinceRead(input.source.mutationTargetPath, input.source.displayPath, input.source.pipe.originalNormalized, input.signal);
  if (sourceState !== "unchanged") {
    const verb = sourceState === "deleted" ? "was deleted" : "changed";
    throw new Error(`[E_OP_ABORTED] Edit aborted: ${input.source.displayPath} ${verb} after the move started. Call read for fresh anchors and retry.`);
  }

  const undoDestination = await saveUndo(input.destination.mutationTargetPath, pairEntry(input.destination.pipe, destinationSeparators));
  if (!undoDestination.persisted) {
    throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history for ${input.destination.displayPath}. Nothing was written.`);
  }
  const undoSource = await saveUndo(input.source.mutationTargetPath, pairEntry(input.source.pipe, sourceSeparators));
  if (!undoSource.persisted) {
    await undoDestination.restore();
    throw new Error(`[E_UNDO_UNAVAILABLE] Could not persist undo history for ${input.source.displayPath}. Nothing was written.`);
  }

  const restoreUndoRecords = async (): Promise<void> => {
    await undoDestination.restore();
    await undoSource.restore();
  };

  try {
    abortIf(input.signal);
    await writeAtomic(input.destination.absolutePath, destinationBytes, input.destination.pipe.identity);
  } catch (error) {
    await restoreUndoRecords();
    throw error;
  }
  try {
    abortIf(input.signal);
    await writeAtomic(input.source.absolutePath, sourceBytes, input.source.pipe.identity);
  } catch (error) {
    try {
      const destinationOriginal = input.destination.pipe.bom + joinSeparators(input.destination.pipe.originalNormalized, input.destination.pipe.originalSeparators);
      await writeAtomic(input.destination.absolutePath, destinationOriginal);
    } catch (rollbackError) {
      console.error("Failed to roll back the destination after a cross-file move failed:", rollbackError);
    }
    await restoreUndoRecords();
    throw error;
  }

  const destinationSnapshot = await safeSnapId(input.destination.absolutePath, "post-edit");
  const sourceSnapshot = await safeSnapId(input.source.absolutePath, "post-edit");
  let destinationHashes: string[];
  let sourceHashes: string[];
  try {
    destinationHashes = await lineHashes(input.destination.pipe.result, input.destination.mutationTargetPath, {
      content: input.destination.pipe.originalNormalized,
      hashes: input.destination.pipe.originalHashes,
      ...(destinationSpan !== undefined ? { spans: [destinationSpan] } : {}),
    });
    sourceHashes = await lineHashes(input.source.pipe.result, input.source.mutationTargetPath, {
      content: input.source.pipe.originalNormalized,
      hashes: input.source.pipe.originalHashes,
      ...(sourceSpan !== undefined ? { spans: [sourceSpan] } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail} Both files were written; one undo per file reverts the move. Call read for fresh anchors.`);
  }

  const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
  if (reclaimNotice !== undefined) warnings.push(reclaimNotice);

  const contextLines = await getDiffContextLines();
  const destinationChanged = buildChanged({
    path: input.destination.displayPath,
    originalNormalized: input.destination.pipe.originalNormalized,
    originalHashes: input.destination.pipe.originalHashes,
    result: input.destination.pipe.result,
    resultHashes: destinationHashes,
    warnings,
    snapshotId: destinationSnapshot,
    editMeta: {
      editsAttempted: 1,
      noopEditsCount: 0,
      firstChangedLine: input.destination.pipe.firstChangedLine,
      lastChangedLine: input.destination.pipe.lastChangedLine,
      addedLines: Math.max(0, input.destination.pipe.totalAddedLines - input.destination.foldedAnchorLines),
      removedLines: Math.max(0, input.destination.pipe.totalRemovedLines - input.destination.foldedAnchorLines),
    },
    ...(destinationSpan !== undefined ? { spans: [destinationSpan] } : {}),
  }, "moved", contextLines);
  const sourceChanged = buildChanged({
    path: input.source.displayPath,
    originalNormalized: input.source.pipe.originalNormalized,
    originalHashes: input.source.pipe.originalHashes,
    result: input.source.pipe.result,
    resultHashes: sourceHashes,
    warnings,
    snapshotId: sourceSnapshot,
    editMeta: {
      editsAttempted: 1,
      noopEditsCount: 0,
      firstChangedLine: input.source.pipe.firstChangedLine,
      lastChangedLine: input.source.pipe.lastChangedLine,
      addedLines: 0,
      removedLines: input.source.pipe.totalRemovedLines,
    },
    ...(sourceSpan !== undefined ? { spans: [sourceSpan] } : {}),
  }, "moved", contextLines);

  try {
    serveRows(input.destination.mutationTargetPath, destinationHashes, splitLines(input.destination.pipe.result), servedHashesFromDiff(destinationChanged.details.diff));
    serveRows(input.source.mutationTargetPath, sourceHashes, splitLines(input.source.pipe.result), servedHashesFromDiff(sourceChanged.details.diff));
  } catch (error) {
    console.error("Failed to mark cross-file move diff served:", error);
  }

  const movedLines = input.source.pipe.totalRemovedLines;
  const warningBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
  const rawDiff = `--- ${input.source.displayPath} ---\n${sourceChanged.details.diff}\n\n--- ${input.destination.displayPath} ---\n${destinationChanged.details.diff}`;
  const diffTruncation = truncateHead(rawDiff, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const diff = diffTruncation.truncated
    ? `${diffTruncation.content}\n[Cross-file move diff truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; use read to see each file.]`
    : diffTruncation.content;
  const rawPatch = [sourceChanged.details.patch, destinationChanged.details.patch]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const patchTruncation = truncateHead(rawPatch, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const patch = patchTruncation.truncated
    ? `${patchTruncation.content}\n... [cross-file move patch truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the patch cannot be applied as-is. Use read to see the full files.]`
    : rawPatch;
  const patchTruncated = patchTruncation.truncated || sourceChanged.details.patchTruncated === true || destinationChanged.details.patchTruncated === true;
  const structuredContent: EditStructured = {
    ok: true,
    kind: "edit",
    verb: "moved",
    classification: "applied",
    path: input.destination.displayPath,
    text: `Successfully moved ${movedLines} line(s) from ${input.source.displayPath} to ${input.destination.displayPath}.${warningBlock}`,
    diff,
    warnings: [...warnings],
    hints: [],
    firstChangedLine: input.destination.pipe.firstChangedLine ?? null,
    anchors: anchoredLinesFromDiff(destinationChanged.details.diff, destinationChanged.details.diffLineNumbers),
    anchorsOmitted: diffTruncation.truncated || patchTruncated || diffAnchorsOmitted(destinationChanged.details.diff),
  };
  return {
    content: [
      {
        type: "text",
        text: `Successfully moved ${movedLines} line(s) from ${input.source.displayPath} to ${input.destination.displayPath}.${warningBlock}`,
      },
    ],
    details: {
      diff,
      patch,
      ...(patchTruncated ? { patchTruncated: true as const } : {}),
      firstChangedLine: input.destination.pipe.firstChangedLine,
      snapshotId: destinationSnapshot,
      metrics: buildMetrics({
        classification: "applied",
        editsAttempted: 1,
        noopEditsCount: 0,
        warningsCount: warnings.length,
        addedLines: movedLines,
        removedLines: movedLines,
      }),
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    },
    structuredContent,
  };
}

async function queuedEditPair<T>(
  sourcePath: string,
  destinationPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
  work: (source: { absolute: string; resolved: string }, destination: { absolute: string; resolved: string }) => Promise<T>,
): Promise<T> {
  abortIf(signal);
  const source = await resolveInCwd(sourcePath, cwd);
  const destination = await resolveInCwd(destinationPath, cwd);
  const ordered = source.resolved <= destination.resolved ? [source, destination] : [destination, source];
  return withFileMutationQueue(ordered[0]!.resolved, async () => {
    abortIf(signal);
    return withFileMutationQueue(ordered[1]!.resolved, async () => {
      abortIf(signal);
      return work(source, destination);
    });
  });
}

async function executeCrossFile(
  kind: TransferKind,
  refs: TransferRefs,
  anchorWarnings: string[],
  sourcePath: string,
  destinationPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<TResult> {
  return queuedEditPair(sourcePath, destinationPath, cwd, signal, async (source, destination) => {
    const prepared = await prepareCrossTransfer({ kind, refs, sourcePath, destinationPath, cwd, signal, noPersist: false });
    const destinationPipe = await execPipeline(destinationPath, prepared.destinationEdit, cwd, {
      accessMode: constants.R_OK | constants.W_OK,
      signal,
      preloadedNorm: prepared.destinationPreload,
      endingOverrides: prepared.endingOverrides,
      ...(prepared.anchorCarry !== undefined ? { anchorCarry: prepared.anchorCarry } : {}),
    });
    if (kind === "copy") {
      return commitEdit(destinationPipe, {
        path: destinationPipe.path,
        absolutePath: destination.absolute,
        mutationTargetPath: destination.resolved,
        editAnchors: [prepared.destinationEdit.remove_from, prepared.destinationEdit.remove_to],
        ...(prepared.anchorCarry !== undefined ? { anchorCarry: prepared.anchorCarry } : {}),
        endingOverrides: prepared.endingOverrides,
        signal,
        verb: "copied",
        noopNoun: "Copy",
        foldedAnchorLines: prepared.destinationFolded,
        prefixWarnings: anchorWarnings,
      });
    }
    const sourcePipe = await execPipeline(sourcePath, prepared.sourceEdit!, cwd, {
      accessMode: constants.R_OK | constants.W_OK,
      signal,
      preloadedNorm: prepared.sourcePreload,
      preserveDeletionSeparators: false,
    });
    return commitMovePair({
      source: { pipe: sourcePipe, displayPath: prepared.sourceDisplay, absolutePath: source.absolute, mutationTargetPath: source.resolved, foldedAnchorLines: 0 },
      destination: {
        pipe: destinationPipe,
        displayPath: prepared.destinationDisplay,
        absolutePath: destination.absolute,
        mutationTargetPath: destination.resolved,
        foldedAnchorLines: prepared.destinationFolded,
        ...(prepared.anchorCarry !== undefined ? { anchorCarry: prepared.anchorCarry } : {}),
        endingOverrides: prepared.endingOverrides,
      },
      signal,
      warnings: anchorWarnings,
    });
  });
}

function preloadFromBase(base: BatchBase): NormFile {
  return {
    absolutePath: base.absolutePath,
    normalized: base.content,
    bom: base.bom,
    originalEnding: base.ending,
    endingSeparators: base.separators,
    fileHashes: base.hashes,
    hadUtf8DecodeErrors: base.hadUtf8DecodeErrors,
    identity: base.identity,
  };
}

function planTransferBatchMember(kind: TransferKind): BatchMemberPlanner {
  return (input) => {
    if (input.member.sourceTarget !== undefined && input.member.sourceTarget !== input.member.target) return undefined;
    const req = normReq(input.member.args);
    assertTransferReq(req);
    const { refs, warnings } = parseTransferAnchors(req);
    const preload = preloadFromBase(input.base);
    const transferPlan = buildTransferEdit({ kind, refs, preload, displayPath: input.displayPath, served: input.served });
    const resWarnings: string[] = [];
    const hedit = resEdit(transferPlan.editParams, resWarnings);
    const effectiveHedit = preserveDeletionSeparators(hedit, input.base.baseLines, input.base.hashes);
    const planned = planEdit(input.base.content, effectiveHedit, input.base.hashes, {
      filePath: input.displayPath,
      servedHashes: transferPlan.servedOverride ?? input.served,
      signal: input.signal,
      baseFileLines: input.base.baseLines,
    });
    return {
      hedit,
      warnings: [...warnings, ...resWarnings],
      planned,
      foldedLines: transferPlan.foldedAnchorLines,
      direction: refs.direction,
      ...(transferPlan.anchorCarry !== undefined ? { carryIndex: transferPlan.anchorCarry } : {}),
      ...(transferPlan.servedOverride !== undefined ? { servedOverride: transferPlan.servedOverride } : {}),
      ...(transferPlan.endingOverrides !== undefined ? { contentSeparators: transferPlan.endingOverrides } : {}),
    };
  };
}

registerBatchPlanner("copy", planTransferBatchMember("copy"));
registerBatchPlanner("move", planTransferBatchMember("move"));

async function executeBatchCrossCopy(
  member: PlannedMember,
  refs: TransferRefs,
  warnings: string[],
  sourcePath: string,
  destinationPath: string,
  mutationTargetPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<TResult> {
  const destinationBase = await ensureBatchBase({ member, targetPath: destinationPath, mutationTargetPath, cwd, signal });
  let prepared: CrossTransferPreparation;
  try {
    const sourceMember = pendingBatchMemberFor(sourcePath);
    const sourcePreload = sourceMember
      ? preloadFromBase(await ensureBatchBase({ member: sourceMember, targetPath: sourcePath, mutationTargetPath: sourceMember.target, cwd, signal }))
      : undefined;
    prepared = await prepareCrossTransfer({
      kind: "copy",
      refs,
      sourcePath,
      destinationPath,
      cwd,
      signal,
      noPersist: false,
      sourcePreload,
      sourceServed: sourceMember !== undefined ? batchServedFor(sourceMember) : undefined,
      destinationServed: batchServedFor(member),
      destinationPreload: preloadFromBase(destinationBase),
    });
  } catch (error) {
    noteBatchFailure(member, error);
    throw error;
  }
  const resWarnings: string[] = [];
  let hedit: HEdit;
  try {
    hedit = resEdit(prepared.destinationEdit, resWarnings);
  } catch (error) {
    noteBatchFailure(member, error);
    throw error;
  }
  return executeBatchMember({
    member,
    targetPath: destinationPath,
    mutationTargetPath,
    cwd,
    signal,
    plan: {
      hedit,
      warnings: [...warnings, ...resWarnings],
      foldedLines: prepared.destinationFolded,
      ...(prepared.anchorCarry !== undefined ? { carryIndex: prepared.anchorCarry } : {}),
      contentSeparators: prepared.endingOverrides,
    },
  });
}

async function executeBatchCrossMove(
  member: PlannedMember,
  refs: TransferRefs,
  warnings: string[],
  sourcePath: string,
  destinationPath: string,
  mutationTargetPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<TResult> {
  const destinationBase = await ensureBatchBase({ member, targetPath: destinationPath, mutationTargetPath, cwd, signal });
  let prepared: CrossTransferPreparation;
  let sourcePipe: PipelineResult;
  try {
    const sourcePreload = await readNormFile(sourcePath, cwd, { signal, accessMode: constants.R_OK | constants.W_OK, maxLines: MAX_HASH_LINES });
    prepared = await prepareCrossTransfer({
      kind: "move",
      refs,
      sourcePath,
      destinationPath,
      cwd,
      signal,
      noPersist: false,
      sourcePreload,
      destinationPreload: preloadFromBase(destinationBase),
      destinationServed: batchServedFor(member),
    });
    sourcePipe = await execPipeline(sourcePath, prepared.sourceEdit!, cwd, {
      accessMode: constants.R_OK | constants.W_OK,
      signal,
      preloadedNorm: prepared.sourcePreload,
      preserveDeletionSeparators: false,
    });
  } catch (error) {
    noteBatchFailure(member, error);
    throw error;
  }
  const resWarnings: string[] = [];
  let hedit: HEdit;
  try {
    hedit = resEdit(prepared.destinationEdit, resWarnings);
  } catch (error) {
    noteBatchFailure(member, error);
    throw error;
  }
  const sourceWarnings = [
    ...sourcePipe.warnings,
    ...(sourcePipe.hadUtf8DecodeErrors ? ["Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8."] : []),
  ];
  return executeBatchMember({
    member,
    targetPath: destinationPath,
    mutationTargetPath,
    cwd,
    signal,
    plan: {
      hedit,
      warnings: [...warnings, ...resWarnings, ...sourceWarnings],
      foldedLines: prepared.destinationFolded,
      ...(prepared.anchorCarry !== undefined ? { carryIndex: prepared.anchorCarry } : {}),
      contentSeparators: prepared.endingOverrides,
      sourceMove: {
        displayPath: prepared.sourceDisplay,
        mutationTargetPath: prepared.sourcePreload.absolutePath,
        pipe: sourcePipe,
      },
    },
  });
}

export async function transferPreview(kind: TransferKind, request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertTransferReq(normalized);
    const req = normalized;
    const { refs, warnings } = parseTransferAnchors(req);
    await throwIfStrictInput(warnings);
    const { sourcePath, destinationPath } = await resolveTransferTargets(req, cwd);
    if (sourcePath === destinationPath) {
      const preload = await readNormFile(sourcePath, cwd, {
        accessMode: constants.R_OK,
        maxLines: MAX_HASH_LINES,
        noPersist: true,
        allocation: "shadow",
        signal,
      });
      const plan = buildTransferEdit({
        kind,
        refs,
        preload,
        displayPath: toDisplayPath(cwd, preload.absolutePath, sourcePath),
        served: servedForPath(preload.absolutePath),
      });
      const pipe = await execPipeline(sourcePath, plan.editParams, cwd, {
        accessMode: constants.R_OK,
        noPersist: true,
        preloadedNorm: preload,
        served: plan.servedOverride,
        endingOverrides: plan.endingOverrides,
        signal,
        ...(plan.anchorCarry !== undefined ? { anchorCarry: plan.anchorCarry } : {}),
      });
      return previewFromPipe(pipe);
    }
    const prepared = await prepareCrossTransfer({ kind, refs, sourcePath, destinationPath, cwd, signal, noPersist: true });
    const destinationPipe = await execPipeline(destinationPath, prepared.destinationEdit, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: prepared.destinationPreload,
      endingOverrides: prepared.endingOverrides,
      signal,
      ...(prepared.anchorCarry !== undefined ? { anchorCarry: prepared.anchorCarry } : {}),
    });
    if (kind === "copy") return previewFromPipe(destinationPipe);
    const sourcePipe = await execPipeline(sourcePath, prepared.sourceEdit!, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: prepared.sourcePreload,
      preserveDeletionSeparators: false,
      signal,
    });
    const destinationPreview = previewFromPipe(destinationPipe);
    const sourcePreview = previewFromPipe(sourcePipe);
    if ("error" in destinationPreview) return destinationPreview;
    if ("error" in sourcePreview) return sourcePreview;
    return {
      diff: `--- ${prepared.sourceDisplay} ---\n${sourcePreview.diff}\n\n--- ${prepared.destinationDisplay} ---\n${destinationPreview.diff}`,
      path: prepared.destinationDisplay,
    };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

function getTransferInput(args: unknown): { path?: string; source_from?: string; source_to?: string; anchor?: string; direction?: string } | null {
  let normalized: unknown;
  try {
    normalized = normReq(args);
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.source_from !== "string" ||
    typeof normalized.source_to !== "string" ||
    typeof normalized.anchor !== "string" ||
    typeof normalized.direction !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    source_from: normalized.source_from,
    source_to: normalized.source_to,
    anchor: normalized.anchor,
    direction: normalized.direction,
  };
}

const transferSourceFromSchema = Type.String({
  description:
    "5-char anchor of the FIRST source line.",
});
const transferSourceToSchema = Type.String({
  description:
    "5-char anchor of the LAST source line.",
});
const transferAnchorSchema = Type.String({
  description:
    "5-char anchor of the destination line; the block lands before or after it and it may live in another file.",
});
const transferDirectionSchema = Type.Unsafe<"after" | "before">({
  type: "string",
  enum: ["after", "before"],
  description: '"after" places the block below the anchor line, "before" above it',
});
const transferPathRequiredSchema = Type.String({
  description:
    "Path to the source or destination file the anchors were served for; required and must match anchor ownership.",
});

const transferToolSchema = Type.Object(
  {
    source_from: transferSourceFromSchema,
    source_to: transferSourceToSchema,
    anchor: transferAnchorSchema,
    direction: transferDirectionSchema,
  },
  { additionalProperties: true },
);

export function buildTransferToolSchema(requirePath: boolean): typeof transferToolSchema {
  if (!requirePath) return transferToolSchema;
  return Type.Object(
    {
      path: transferPathRequiredSchema,
      source_from: transferSourceFromSchema,
      source_to: transferSourceToSchema,
      anchor: transferAnchorSchema,
      direction: transferDirectionSchema,
    },
    { additionalProperties: true },
  ) as typeof transferToolSchema;
}

type TransferToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildTransferToolDef(kind: TransferKind, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): TransferToolDef {
  const prompted = withTransferPrompts(
    {
      description: loadP(`../tool-prompts/${kind}.md`),
      snippet: loadP(`../tool-prompts/${kind}-snippet.md`),
      guidelines: [
        ...loadGuidelines(`../tool-prompts/${kind}-guidelines.md`),
        ...loadGuidelines("../tool-prompts/transfer-guidelines.md"),
      ],
    },
    flags,
    { scriptGuidelines: kind === "copy" },
  );
  return {
    name: kind,
    label: kind === "copy" ? "Copy" : "Move",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    parameters: buildTransferToolSchema(flags.requirePath),
    outputSchema: editResultSchema,
    renderCall: makeRenderCall(
      (request, cwd, signal) => transferPreview(kind, request, cwd, signal),
      {
        getInput: getTransferInput,
        toolName: kind,
        resolveTarget: (input) => (typeof input.source_from === "string" ? tryResolveEditTarget(input.source_from, input.source_to) : undefined),
      },
    ),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, { diff: "" }, () => withAnchorSession(ctx, async () => {
        const canonical = normReq(params);
        assertTransferReq(canonical);
        const req = canonical;
        const member = batchMemberFor(_toolCallId);
        let refs: TransferRefs;
        let warnings: string[];
        try {
          ({ refs, warnings } = parseTransferAnchors(req));
          const sameFileMember = member !== undefined && (member.sourceTarget === undefined || member.sourceTarget === member.target);
          if (!sameFileMember) await throwIfStrictInput(warnings);
        } catch (error) {
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        let sourcePath: string;
        let destinationPath: string;
        try {
          if (member) {
            await assertTransferPathOption(req, ctx.cwd, member);
            sourcePath = member.sourceTarget ?? member.target;
            destinationPath = member.target;
          } else {
            ({ sourcePath, destinationPath } = await resolveTransferTargets(req, ctx.cwd));
          }
        } catch (error) {
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        if (sourcePath === destinationPath) {
          return queuedEdit(sourcePath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
            if (member) {
              return executeBatchMember({ member, targetPath: sourcePath, mutationTargetPath, cwd: ctx.cwd, signal });
            }
            const preload = await readNormFile(sourcePath, ctx.cwd, {
              signal,
              accessMode: constants.R_OK | constants.W_OK,
              maxLines: MAX_HASH_LINES,
            });
            const displayPath = toDisplayPath(ctx.cwd, preload.absolutePath, sourcePath);
            let plan: TransferPlan;
            try {
              plan = buildTransferEdit({ kind, refs, preload, displayPath, served: servedForPath(preload.absolutePath) });
            } catch (error) {
              await noteAnchorError(preload.absolutePath, error);
              throw error;
            }
            const pipe = await execPipeline(sourcePath, plan.editParams, ctx.cwd, {
              accessMode: constants.R_OK | constants.W_OK,
              signal,
              preloadedNorm: preload,
              served: plan.servedOverride,
              endingOverrides: plan.endingOverrides,
              ...(plan.anchorCarry !== undefined ? { anchorCarry: plan.anchorCarry } : {}),
            });
            return commitEdit(pipe, {
              path: pipe.path,
              absolutePath,
              mutationTargetPath,
              editAnchors: [plan.editParams.remove_from, plan.editParams.remove_to],
              ...(plan.anchorCarry !== undefined ? { anchorCarry: plan.anchorCarry } : {}),
              ...(plan.endingOverrides !== undefined ? { endingOverrides: plan.endingOverrides } : {}),
              signal,
              verb: kind === "copy" ? "copied" : "moved",
              noopNoun: kind === "copy" ? "Copy" : "Move",
              foldedAnchorLines: plan.foldedAnchorLines,
              prefixWarnings: warnings,
            });
          });
        }
        if (member) {
          return queuedEdit(destinationPath, ctx.cwd, signal, async (_absolutePath, mutationTargetPath) => {
            return kind === "copy"
              ? executeBatchCrossCopy(member, refs, warnings, sourcePath, destinationPath, mutationTargetPath, ctx.cwd, signal)
              : executeBatchCrossMove(member, refs, warnings, sourcePath, destinationPath, mutationTargetPath, ctx.cwd, signal);
          });
        }
        return executeCrossFile(kind, refs, warnings, sourcePath, destinationPath, ctx.cwd, signal);
      }));
    },
  };
}

export function regCopy(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildTransferToolDef("copy", flags));
}

export function regMove(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildTransferToolDef("move", flags));
}
