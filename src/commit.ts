import type { PipelineResult } from "./replace";
import { abortIf } from "./utils";
import { buildChanged, buildNoop, type RMeta, type TResult } from "./replace-response";
import { saveUndo } from "./replace-undo";
import { safeSnapId } from "./file-reader";
import { writeAtomic } from "./fs-write";
import { recordServedDiffSafe } from "./served";
import { restoreEndings } from "./replace-diff";

export interface CommitMeta {
  path: string;
  absolutePath: string;
  mutationTargetPath: string;
  signal?: AbortSignal;
  verb?: string;
  noopNoun?: string;
  prefixWarnings?: string[];
  appliedWarnings?: string[];
  foldedAnchorLines?: number;
  onApplied?: () => void;
  onNoopDedup?: () => void;
}

export async function commitEdit(pipe: PipelineResult, meta: CommitMeta): Promise<TResult> {
  const { path, absolutePath, mutationTargetPath, signal } = meta;
  const warnings = [...(meta.prefixWarnings ?? []), ...pipe.warnings];
  const editsAttempted = 1;

  if (pipe.result === pipe.originalNormalized) {
    const noopSnapshotId = await safeSnapId(absolutePath, "noop edit");
    if (pipe.hadBoundaryDedup) meta.onNoopDedup?.();
    return buildNoop(
      {
        path,
        noopEdit: pipe.noopEdit,
        snapshotId: noopSnapshotId,
        editMeta: {
          editsAttempted,
          noopEditsCount: pipe.noopEdit ? 1 : 0,
          addedLines: 0,
          removedLines: 0,
        },
        warnings,
        boundaryRemovedLines: pipe.boundaryRemovedLines,
      },
      meta.noopNoun,
    );
  }

  warnings.push(...(meta.appliedWarnings ?? []));
  if (pipe.hadUtf8DecodeErrors) {
    warnings.push(
      "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
    );
  }

  abortIf(signal);
  const undo = await saveUndo(mutationTargetPath, {
    content: pipe.originalNormalized,
    bom: pipe.bom,
    originalEnding: pipe.originalEnding,
    hashes: pipe.originalHashes,
    resultContent: pipe.result,
  });
  if (!undo.persisted) {
    throw new Error(
      `[E_UNDO_UNAVAILABLE] Could not persist undo history; the edit was not applied and ${path} is unchanged.`
    );
  }
  try {
    abortIf(signal);
    await writeAtomic(
      absolutePath,
      pipe.bom + restoreEndings(pipe.result, pipe.originalEnding),
      pipe.identity,
    );
  } catch (error) {
    await undo.restore();
    throw error;
  }
  meta.onApplied?.();
  const updatedSnapshotId = await safeSnapId(absolutePath, "post-edit");

  const editMeta: RMeta = {
    editsAttempted,
    noopEditsCount: pipe.noopEdit ? 1 : 0,
    firstChangedLine: pipe.firstChangedLine,
    lastChangedLine: pipe.lastChangedLine,
    addedLines: Math.max(0, pipe.totalAddedLines - (meta.foldedAnchorLines ?? 0)),
    removedLines: pipe.totalRemovedLines,
  };

  const successInput = {
    path,
    originalNormalized: pipe.originalNormalized,
    originalHashes: pipe.originalHashes,
    result: pipe.result,
    resultHashes: pipe.resultHashes,
    warnings,
    snapshotId: updatedSnapshotId,
    editMeta,
  };
  const changed = buildChanged(successInput, meta.verb);
  if (changed.details.diff) {
    await recordServedDiffSafe(mutationTargetPath, changed.details.diff, "post-edit diff", new Set(pipe.resultHashes));
  }
  return changed;
}
