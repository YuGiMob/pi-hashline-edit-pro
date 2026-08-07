import { readFile } from "fs/promises";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHashStore, upsertSnapshot, upsertUndo, getUndoEntry, deleteUndo, type UndoRecord } from "./hash-store";
import { contentChecksum } from "./hashline/hasher";
import { resolveTarget, writeAtomic } from "./fs-write";
import { toCwd } from "./paths";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./replace-diff";
import { cntDiff, splitLines, errCode } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { buildMetrics } from "./replace-response";
import { buildAppliedText, getResultText } from "./replace-render";
import type { ReplaceDetails } from "./replace";
import { changedRange } from "./hashline";
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

export function regReplaceUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "undo_last_replace",
    label: "Undo Last Replace",
    description: loadP("../prompts/undo-last-replace.md"),
    promptSnippet: loadP("../prompts/undo-last-replace-snippet.md"),
    promptGuidelines: loadGuide("../prompts/undo-last-replace-guidelines.md"),
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo",
      }),
    }),

    renderResult(result, _options, theme, context) {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      const typedResult = result as {
        content?: Array<{ type: string; text?: string }>;
        details?: ReplaceDetails;
      };
      const renderedText = getResultText(typedResult);
      if (context.isError) {
        text.setText(renderedText ? `\n${theme.fg("error", renderedText)}` : "");
        return text;
      }
      const appliedText = buildAppliedText(renderedText, typedResult.details, theme);
      text.setText(appliedText ?? renderedText ?? "");
      return text;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = params.path;
      const absolutePath = toCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);

      const undo = await getUndo(mutationTargetPath);
      if (!undo) {
        return {
          content: [
            {
              type: "text",
              text: `No undo history for ${path}. There is no previous replace to revert.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      return withFileMutationQueue(mutationTargetPath, async () => {
        let currentRaw: string | undefined;
        try {
          currentRaw = await readFile(mutationTargetPath, "utf-8");
        } catch (error) {
          if (errCode(error) !== "ENOENT") throw error;
        }

        if (currentRaw === undefined) {
          await clearUndo(mutationTargetPath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] Cannot undo last replace on ${path}: the file no longer exists. Call read() to inspect the current state.`
              },
            ],
            isError: true,
            details: {},
          };
        }
        if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
          await clearUndo(mutationTargetPath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] Cannot undo last replace on ${path}: the file was modified after the replace, so undoing would overwrite those changes. Call read() to inspect the current state.`
              },
            ],
            isError: true,
            details: {},
          };
        }

        const { text: currentStripped } = stripBOM(currentRaw);
        const currentNormalized = toLF(currentStripped);
        const diffResult = genDiff(undo.content, currentNormalized, 0);
        const linesAddedByReplace = cntDiff(diffResult.diff, "+");
        const linesRemovedByReplace = cntDiff(diffResult.diff, "-");
        const restoredRange = changedRange(currentNormalized, undo.content);
        const undoDiff = genDiff(currentNormalized, undo.content, 1, undo.hashes);

        await writeAtomic(
          mutationTargetPath,
          undo.bom + restoreEndings(undo.content, undo.originalEnding),
        );
        try {
          const store = await loadHashStore();
          upsertSnapshot(store, mutationTargetPath, contentChecksum(undo.content), splitLines(undo.content).length, undo.hashes);
        } catch (error) {
          console.error("Failed to restore hash store snapshot after undo:", error);
        }

        await clearUndo(mutationTargetPath);

        const parts: string[] = [
          `Undone last replace on ${path}.`,
        ];
        if (linesAddedByReplace > 0 || linesRemovedByReplace > 0) {
          parts.push(
            `Removed ${linesAddedByReplace} line(s) that were added and restored ${linesRemovedByReplace} line(s) that were removed.`,
          );
        }
        parts.push(
          "File reverted to previous state. Call `read` to get fresh anchors for follow-up edits.",
        );

        return {
          content: [
            {
              type: "text",
              text: parts.join("\n"),
            },
          ],
          details: {
            diff: undoDiff.diff,
            diffLineNumbers: undoDiff.rowLines,
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
