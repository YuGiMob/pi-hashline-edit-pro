import { readFile } from "node:fs/promises";
import type { PipelineResult } from "./replace";
import { abortIf, assertByteLimit, errCode, splitLines } from "./utils";
import { buildChanged, buildNoop, type RMeta, type TResult } from "./replace-response";
import { saveUndo } from "./replace-undo";
import { getDiffContextLines } from "./config";
import { safeSnapId } from "./file-reader";
import { writeAtomic } from "./fs-write";
import { servedHashesFromDiff, serveRows } from "./served";
import { lineHashes } from "./hashline";
import { spanForEdit } from "./replace";
import { restoreEndings, stripBOM, toLF } from "./normalize";
export interface CommitMeta {
  editAnchors?: [string, string];
  anchorCarry?: number;
  path: string;
  absolutePath: string;
  mutationTargetPath: string;
  signal?: AbortSignal;
  verb?: string;
  noopNoun?: string;
  prefixWarnings?: string[];
  foldedAnchorLines?: number;
}

export async function commitEdit(pipe: PipelineResult, meta: CommitMeta): Promise<TResult> {
  const { path, absolutePath, mutationTargetPath, signal } = meta;
  const warnings = [...(meta.prefixWarnings ?? []), ...pipe.warnings];
  const editsAttempted = 1;

  if (pipe.result === pipe.originalNormalized) {
    const noopSnapshotId = await safeSnapId(absolutePath, "noop edit");
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
      },
      meta.noopNoun,
    );
  }

  const finalFileBytes = pipe.bom + restoreEndings(pipe.result, pipe.originalEnding);
  assertByteLimit(finalFileBytes, path);

  if (pipe.hadUtf8DecodeErrors) {
    warnings.push(
      "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
    );
  }

  abortIf(signal);
  let currentRaw: string | undefined;
  try {
    currentRaw = await readFile(mutationTargetPath, "utf-8");
  } catch (error) {
    const code = errCode(error);
    if (code === "ENOENT") currentRaw = undefined;
    else if (code === "EACCES" || code === "EPERM") throw new Error(`[E_ACCESS] File is not readable: ${path}`);
    else if (code === "ELOOP") throw new Error(`[E_ACCESS] Too many symbolic links while resolving: ${path}`);
    else throw error;
  }
  if (currentRaw === undefined) {
    throw new Error(`[E_OP_ABORTED] Edit aborted: the file was deleted after the edit started.`);
  }
  if (toLF(stripBOM(currentRaw).text) !== pipe.originalNormalized) {
    throw new Error(`[E_OP_ABORTED] Edit aborted: the file changed after the edit started. Call read for fresh anchors and retry.`);
  }
  const undo = await saveUndo(mutationTargetPath, {
    content: pipe.originalNormalized,
    bom: pipe.bom,
    originalEnding: pipe.originalEnding,
    hashes: pipe.originalHashes,
    resultContent: pipe.result,
  });
  if (!undo.persisted) {
    throw new Error(
      `[E_UNDO_UNAVAILABLE] Could not persist undo history for ${path}.`
    );
  }
  try {
    abortIf(signal);
    await writeAtomic(
      absolutePath,
      finalFileBytes,
      pipe.identity,
    );
  } catch (error) {
    await undo.restore();
    throw error;
  }
  const updatedSnapshotId = await safeSnapId(absolutePath, "post-edit");

  const editMeta: RMeta = {
    editsAttempted,
    noopEditsCount: pipe.noopEdit ? 1 : 0,
    firstChangedLine: pipe.firstChangedLine,
    lastChangedLine: pipe.lastChangedLine,
    addedLines: Math.max(0, pipe.totalAddedLines - (meta.foldedAnchorLines ?? 0)),
    removedLines: pipe.totalRemovedLines,
  };

  const span = meta.editAnchors ? spanForEdit(pipe.originalHashes, meta.editAnchors[0], meta.editAnchors[1], pipe.result) : undefined;
  if (span && meta.anchorCarry !== undefined) span.carry = meta.anchorCarry;
  let resultHashes: string[];
  try {
    resultHashes = await lineHashes(pipe.result, mutationTargetPath, {
      content: pipe.originalNormalized,
      hashes: pipe.originalHashes,
      spans: span ? [span] : undefined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail} File was written; anchor finalization failed. One undo reverts. Call read for fresh anchors.`);
  }
  const successInput = {
    path,
    originalNormalized: pipe.originalNormalized,
    originalHashes: pipe.originalHashes,
    result: pipe.result,
    resultHashes,
    warnings,
    snapshotId: updatedSnapshotId,
    editMeta,
    ...(span ? { spans: [span] } : {}),
  };
  const changed = buildChanged(successInput, meta.verb, await getDiffContextLines());
  if (changed.details.diff) {
    serveRows(mutationTargetPath, resultHashes, splitLines(pipe.result), servedHashesFromDiff(changed.details.diff));
  }
  return changed;
}
