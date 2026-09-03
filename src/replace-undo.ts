import { constants } from "fs";
import { open } from "fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHashStore, persistSnapshot, upsertUndo, getUndoEntry, deleteUndo, type UndoRecord } from "./hash-store";
import { recordServed, buildServedMap, servedHashesFromDiff } from "./served";
import { resolveInCwd, writeAtomic, type FileIdentity } from "./fs-write";
import { toLF, stripBOM, restoreEndings, type LineEnding } from "./normalize";
import { genDiff, genPatch } from "./replace-diff";
import { cntDiff, errCode, makePrepareArguments, splitLines } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { buildMetrics } from "./replace-response";
import { renderEditResult } from "./replace-render";
import { changedRange, lineHashes } from "./hashline";
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: LineEnding;
  hashes: string[];
  resultContent: string;
}

export async function saveUndo(
  path: string,
  entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: UndoRecord | undefined;
  try {
    const store = await loadHashStore();
    previous = getUndoEntry(store, path);
    upsertUndo(store, path, {
      content: entry.content,
      bom: entry.bom,
      ending: entry.originalEnding,
      hashes: entry.hashes,
      resultContent: entry.resultContent,
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
      hashes: record.hashes,
      resultContent: record.resultContent,
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

export function regUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "undo_last_change",
    label: "Undo Last Change",
    description: loadP("../prompts/undo-last-change.md"),
    promptSnippet: loadP("../prompts/undo-last-change-snippet.md"),
    promptGuidelines: loadGuide("../prompts/undo-last-change-guidelines.md"),
    prepareArguments: makePrepareArguments(),
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo",
      }),
    }),
    executionMode: "sequential",
    renderResult(result, opts, theme, context) {
      return renderEditResult(result as never, opts as { isPartial: boolean; expanded?: boolean }, theme as never, context as never);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = params.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error('[E_BAD_SHAPE] Undo request requires a non-empty "path" string.');
      }
      const { resolved: mutationTargetPath } = await resolveInCwd(path, ctx.cwd);

      const undo = await getUndo(mutationTargetPath);
      if (!undo) {
        return {
          content: [
            {
              type: "text",
              text: `No undo history for ${path}.`,
            },
          ],
          isError: true,
          details: {},
        };
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
          if (errCode(error) !== "ENOENT") throw error;
        }

        if (
          currentRaw !== undefined &&
          currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)
        ) {
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] Cannot undo last change on ${path}: the file was modified after the edit, so nothing was reverted. The current content already contains your applied edit plus that external change and is most likely the correct state. Do not modify the file to make an undo possible and do not revert your own edit. The undo record is kept. Call read() to verify the current state, then stop.`
              },
            ],
            isError: true,
            details: {},
          };
        }

        await writeAtomic(
          mutationTargetPath,
          undo.bom + restoreEndings(undo.content, undo.originalEnding),
          currentIdentity,
        );

        const currentNormalized = currentRaw === undefined ? "" : toLF(stripBOM(currentRaw).text);
        const currentHashes = await lineHashes(currentNormalized, mutationTargetPath);
        const diffResult = genDiff(undo.content, undo.resultContent, 0, undefined, undo.hashes, { unlimited: true });
        const linesAddedByReplace = cntDiff(diffResult.diff, "+");
        const linesRemovedByReplace = cntDiff(diffResult.diff, "-");
        const restoredRange = changedRange(currentNormalized, undo.content);
        const undoDiffResult = genDiff(currentNormalized, undo.content, 1, undo.hashes, currentHashes);
        const undoDiff = undoDiffResult.diff;

        try {
          const store = await loadHashStore();
          persistSnapshot(store, mutationTargetPath, undo.content, undo.hashes);
          const diffHashes = servedHashesFromDiff(undoDiff);
          const undoLines = splitLines(undo.content);
          const servedMap = buildServedMap(undo.hashes, undoLines, diffHashes);
          recordServed(store, mutationTargetPath, servedMap, new Set(undo.hashes));
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

        const patchResult = genPatch(path, currentNormalized, undo.content);
        return {
          content: [
            {
              type: "text",
              text: parts.join("\n"),
            },
          ],
          details: {
            diff: undoDiff,
            diffLineNumbers: undoDiffResult.lineNumbers,
            patch: patchResult.patch,
            ...(patchResult.truncated ? { patchTruncated: true as const } : {}),
            metrics: buildMetrics({
              classification: "applied",
              editsAttempted: 1,
              noopEditsCount: 0,
              warningsCount: 0,
              firstChangedLine: restoredRange?.firstChangedLine,
              lastChangedLine: restoredRange?.lastChangedLine,
              addedLines: linesRemovedByReplace,
              removedLines: linesAddedByReplace,
            }),
          },
        };
      });
    },
  });
}
