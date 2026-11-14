import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHashStore, persistSnapshot, upsertUndo, getUndoEntry, deleteUndo, type UndoRecord } from "./hash-store.ts";
import { servedHashesFromDiff, serveRows } from "./served.ts";
import { lineChecksum } from "./hashline/index.ts";
import { freeAnchors, adoptAnchors, withAnchorSession, formatAnchorReclaimNotice, takeReclaimedPaths } from "./anchor-registry.ts";
import { resolveInCwd, writeAtomic, type FileIdentity } from "./fs-write.ts";
import { toLF, stripBOM, restoreEndings, type LineEnding } from "./normalize.ts";
import { joinSeparators } from "./line-endings.ts";
import { genDiff, genPatch, spansFromHashes } from "./replace-diff.ts";
import { getDiffContextLines } from "./config.ts";
import { cntDiff, errCode, makePrepareArguments, mapIoError, splitLines } from "./utils.ts";
import { loadP, loadGuidelines } from "./prompts.ts";
import { withUndoPrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common.ts";
import { buildMetrics } from "./replace-response.ts";
import { renderEditResult, fmtCall } from "./replace-render.ts";
import { anchoredLinesFromDiff, diffAnchorsOmitted, editResultSchema, structuredFailure, withStructuredErrors, type EditStructured } from "./structured.ts";
import { Text } from "@earendil-works/pi-tui";
import { changedRange, lineHashes } from "./hashline/index.ts";
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: LineEnding;
  separators?: LineEnding[];
  hashes: string[];
  resultContent: string;
  resultSeparators?: LineEnding[];
  mode?: number;
}

export async function saveUndo(
  path: string,
  entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: UndoRecord | undefined;
  try {
    const store = await loadHashStore();
    previous = getUndoEntry(store, path);
    let mode: number | undefined;
    try {
      mode = (await stat(path)).mode & 0o7777;
    } catch {
    }
    upsertUndo(store, path, {
      content: entry.content,
      bom: entry.bom,
      ending: entry.originalEnding,
      ...(entry.separators !== undefined ? { separators: entry.separators } : {}),
      hashes: entry.hashes,
      resultContent: entry.resultContent,
      ...(entry.resultSeparators !== undefined ? { resultSeparators: entry.resultSeparators } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
  } catch (error) {
    console.error("Failed to persist undo entry:", error);
    return { persisted: false, restore: async () => undefined };
  }
  return {
    persisted: true,
    restore: async () => {
      try {
        const store = await loadHashStore();
        if (previous) upsertUndo(store, path, previous);
        else deleteUndo(store, path);
      } catch (error) {
        console.error("Failed to restore previous undo entry:", error);
      }
    },
  };
}

export async function getUndo(path: string): Promise<UndoEntry | undefined> {
  try {
    const store = await loadHashStore();
    const record = getUndoEntry(store, path);
    if (!record) return undefined;
    const originalEnding = record.ending;
    if (originalEnding !== "\r\n" && originalEnding !== "\n" && originalEnding !== "\r") {
      await deleteUndo(store, path);
      return undefined;
    }
    return {
      content: record.content,
      bom: record.bom,
      originalEnding,
      ...(record.separators !== undefined ? { separators: record.separators as LineEnding[] } : {}),
      hashes: record.hashes,
      resultContent: record.resultContent,
      ...(record.resultSeparators !== undefined ? { resultSeparators: record.resultSeparators as LineEnding[] } : {}),
      ...(record.mode !== undefined ? { mode: record.mode } : {}),
    };
  } catch (error) {
    console.error("Failed to load undo entry:", error);
    return undefined;
  }
}

export async function clearUndo(path: string): Promise<void> {
  try {
    const store = await loadHashStore();
    deleteUndo(store, path);
  } catch (error) {
    console.error("Failed to clear undo entry:", error);
  }
}

async function targetIsGone(target: string): Promise<boolean> {
  try {
    await stat(target);
    return false;
  } catch (error) {
    const code = errCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

function fallbackFileMode(): number {
  return 0o666 & ~process.umask();
}

export function regUndo(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  const prompted = withUndoPrompts({
    description: loadP("../tool-prompts/undo-last-change.md"),
    snippet: loadP("../tool-prompts/undo-last-change-snippet.md"),
    guidelines: loadGuidelines("../tool-prompts/undo-last-change-guidelines.md"),
  }, flags);
  pi.registerTool({
    name: "undo_last_change",
    label: "Undo Last Change",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    prepareArguments: makePrepareArguments(),
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo",
      }),
    }),
    outputSchema: editResultSchema,
    executionMode: "sequential",
    renderCall(args: any, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(fmtCall(args as { path?: string } | undefined, { preview: undefined } as never, context.expanded === true, theme, "undo_last_change"));
      return text;
    },
    renderResult(result, opts, theme, context) {
      return renderEditResult(result as never, opts as { isPartial: boolean; expanded?: boolean }, theme as never, context as never);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, {}, () => withAnchorSession(ctx, async () => {
        const path = params.path;
        if (typeof path !== "string" || path.length === 0) {
          throw new Error('[E_BAD_SHAPE] Undo request requires a non-empty "path" string.');
        }
        const { resolved: mutationTargetPath } = await resolveInCwd(path, ctx.cwd);

        const undo = await getUndo(mutationTargetPath);
        if (!undo) {
          if (await targetIsGone(mutationTargetPath)) {
            return structuredFailure(new Error(`[E_NOT_FOUND] File not found: ${path}. Nothing was reverted.`), {});
          }
          return structuredFailure(new Error(`[E_UNDO_NONE] No undo history for ${path}.`), {});
        }

        return withFileMutationQueue(mutationTargetPath, async () => {
          let currentRaw: string | undefined;
          let currentIdentity: FileIdentity | undefined;
          try {
            const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
            const handle = await open(mutationTargetPath, constants.O_RDONLY | noFollow);
            try {
              const { dev, ino } = await handle.stat();
              currentIdentity = { dev, ino };
              currentRaw = await handle.readFile("utf-8");
            } finally {
              await handle.close();
            }
          } catch (error) {
            if (errCode(error) !== "ENOENT") throw mapIoError(error, "read", path);
          }

          if (
            currentRaw !== undefined &&
            currentRaw !== undo.bom + (undo.resultSeparators !== undefined ? joinSeparators(undo.resultContent, undo.resultSeparators) : restoreEndings(undo.resultContent, undo.originalEnding))
          ) {
            return structuredFailure(new Error(`[E_UNDO_STALE] Cannot undo last change on ${path}: the file was modified after the edit, so nothing was reverted and the file was left untouched. The undo record is kept. Do not edit the file to force the undo. Call read() to inspect the current state.`), {});
          }

          await writeAtomic(
            mutationTargetPath,
            undo.bom + (undo.separators !== undefined ? joinSeparators(undo.content, undo.separators) : restoreEndings(undo.content, undo.originalEnding)),
            currentIdentity,
            undo.mode ?? fallbackFileMode(),
          );

          const currentNormalized = currentRaw === undefined ? "" : toLF(stripBOM(currentRaw).text);
          const currentHashes = await lineHashes(currentNormalized, mutationTargetPath, undefined, undefined, false, true);
          const diffResult = genDiff(undo.content, undo.resultContent, 0, undefined, undo.hashes, { unlimited: true });
          const linesAddedByReplace = cntDiff(diffResult.diff, "+");
          const linesRemovedByReplace = cntDiff(diffResult.diff, "-");
          const restoredRange = changedRange(currentNormalized, undo.content);
          const undoSpans = spansFromHashes(currentHashes, undo.hashes);
          const undoDiffResult = genDiff(currentNormalized, undo.content, await getDiffContextLines(), undo.hashes, currentHashes, undefined, undoSpans);
          const undoDiff = undoDiffResult.diff;

          try {
            const store = await loadHashStore();
            const undoLines = splitLines(undo.content);
            persistSnapshot(store, mutationTargetPath, undo.content, undo.hashes, undoLines.map(lineChecksum));
            freeAnchors(mutationTargetPath);
            adoptAnchors(
              mutationTargetPath,
              new Map(undoLines.map((line, i) => [undo.hashes[i]!, lineChecksum(line)])),
            );
            serveRows(
              mutationTargetPath,
              undo.hashes,
              undoLines,
              servedHashesFromDiff(undoDiff),
            );
          } catch (error) {
            console.error("Failed to restore hash store snapshot after undo:", error);
          }

          await clearUndo(mutationTargetPath);

          const parts: string[] = [
            `Undone last change on ${path}.`,
          ];
          if (currentRaw === undefined) {
            parts.push("The file was deleted; restored it from undo history.");
          }
          if (linesAddedByReplace > 0 || linesRemovedByReplace > 0) {
            parts.push(
              `Removed ${linesAddedByReplace} line(s), restored ${linesRemovedByReplace} line(s).`,
            );
          }
          parts.push(
            "Call read for fresh anchors.",
          );
          const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
          if (reclaimNotice !== undefined) parts.push(reclaimNotice);

          const patchResult = genPatch(path, currentNormalized, undo.content);
          const structuredContent: EditStructured = {
            ok: true,
            kind: "edit",
            verb: "undone",
            classification: "applied",
            path,
            text: parts.join("\n"),
            diff: undoDiff,
            warnings: reclaimNotice !== undefined ? [reclaimNotice] : [],
            hints: [],
            firstChangedLine: restoredRange?.firstChangedLine ?? null,
            anchors: anchoredLinesFromDiff(undoDiff, undoDiffResult.lineNumbers),
            anchorsOmitted: diffAnchorsOmitted(undoDiff),
          };
          return {
            content: [
              {
                type: "text",
                text: parts.join("\n"),
              },
            ],
            details: {
              diff: undoDiff,
              diffLineNumbers: undoDiffResult.lineNumbers.map((line) => line ?? null),
              patch: patchResult.patch,
              ...(patchResult.truncated ? { patchTruncated: true as const } : {}),
              metrics: buildMetrics({
                classification: "applied",
                editsAttempted: 1,
                noopEditsCount: 0,
                warningsCount: reclaimNotice !== undefined ? 1 : 0,
                firstChangedLine: restoredRange?.firstChangedLine,
                lastChangedLine: restoredRange?.lastChangedLine,
                addedLines: linesRemovedByReplace,
                removedLines: linesAddedByReplace,
              }),
            },
            structuredContent,
          };
        });
      }));
    },
  });
}
