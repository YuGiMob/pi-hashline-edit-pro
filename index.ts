import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regInsert } from "./src/insert";
import { regGrep } from "./src/grep";
import { regUndo, clearUndo } from "./src/replace-undo";
import { regRead, fmtReadPreview } from "./src/read";
import type { RMetrics } from "./src/replace-response";
import { extractWarnings } from "./src/replace-render";
import { MAX_HASH_LINES } from "./src/hashline";
import {
  readConfig,
  toggleAutoRead,
} from "./src/config";
import { loadHashStore, pruneMissing } from "./src/hash-store";
import { recordServedSafe, clearServed } from "./src/served";
import { clearBoundaryBypass } from "./src/boundary-bypass";
import { readNormFile } from "./src/file-reader";
import { loadFileKindAndText } from "./src/file-kind";
import { resolveInCwd } from "./src/fs-write";
import { valAccess } from "./src/validation";

export default function (pi: ExtensionAPI): void {
  regRead(pi);

  regReplace(pi);
  regInsert(pi);
  regGrep(pi);
  regUndo(pi);

  let autoRead = true;

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    try {
      const store = await loadHashStore();
      await pruneMissing(store);
    } catch (err) {
      console.error("Failed to load or prune hash store:", err);
    }
    const config = await readConfig();
    autoRead = config.autoRead;
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  });

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle auto-read anchors after write and post-edit diffs after replace, insert, and undo_last_change",
    handler: async (_args, ctx) => {
      autoRead = await toggleAutoRead();
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read anchors after write and post-edit diffs after replace/undo: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      let resolvedPath: string | undefined;
      if (typeof writtenPath === "string") {
        try {
          resolvedPath = (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
          await clearUndo(resolvedPath);
          clearBoundaryBypass(resolvedPath);
          const store = await loadHashStore();
          clearServed(store, resolvedPath);
        } catch (error) {
          console.error("Failed to clear undo after write:", error);
        }
      }
      if (!autoRead) return;
      if (typeof writtenPath !== "string") return;
      try {
        resolvedPath ??= (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
        await valAccess(resolvedPath, writtenPath);
        const file = await loadFileKindAndText(resolvedPath, { maxLines: MAX_HASH_LINES, displayPath: writtenPath });
        if (file.kind !== "text") return;
        const { normalized, fileHashes, absolutePath } = await readNormFile(
          writtenPath, ctx.cwd, { maxLines: MAX_HASH_LINES, preloadedFile: file },
        );
        const preview = await fmtReadPreview(
          normalized,
          {},
          fileHashes,
          absolutePath,
          DEFAULT_MAX_BYTES,
          DEFAULT_MAX_LINES,
        );
        await recordServedSafe(absolutePath, preview.servedHashes, "auto-read", new Set(fileHashes));
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
          ],
        };
      } catch (error) {
        console.error("Auto-read after write failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
          ],
        };
      }
    }

    if (
      event.toolName !== "replace" &&
      event.toolName !== "insert" &&
      event.toolName !== "undo_last_change"
    ) return;
    if (!autoRead) return;

    const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
    if (metrics?.classification === "noop") return;

    const diff = (event.details as { diff?: string } | undefined)?.diff;
    if (!diff) return;

    const rendered = (event.content ?? [])
      .filter(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof entry.text === "string",
      )
      .map((entry) => entry.text)
      .join("\n");
    const warnings = extractWarnings(rendered);
    return {
      content: [
        {
          type: "text",
          text: warnings ? `${diff}\n\n${warnings}` : diff,
        },
      ],
    };
  });
}
