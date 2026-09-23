import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { initHasher, lineChecksum } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regInsert } from "./src/insert";
import { regGrep } from "./src/grep";
import { regUndo, clearUndo } from "./src/replace-undo";
import { regRead, fmtReadPreview } from "./src/read";
import { buildAutoReadAllInjection, autoReadAllBudget } from "./src/auto-read-all";
import { clearAutoReadAllComplete } from "./src/auto-read-all-state";
import type { RMetrics } from "./src/replace-response";
import type { ReplaceDetails } from "./src/replace";
import { extractWarnings } from "./src/replace-render";
import { MAX_HASH_LINES } from "./src/hashline";
import type { AutoReadAllMode } from "./src/config";
import {
  readConfigWithStatus,
  toggleAutoRead,
  cycleAutoReadAllMode,
  toggleAnchorGrep,
  toggleRequirePath,
  toggleStrictInput,
  adjustDiffContextLines,
  setAutoReadAllIgnoreFromText,
} from "./src/config";
import { loadHashStore, persistSnapshot, pruneMissing } from "./src/hash-store";
import { initRegistry, gcRegistrySidecars, clearRegistry, freeAnchors, sessionKeyFor, withAnchorSession, releaseRegistrySession } from "./src/anchor-registry";
import { serveRows } from "./src/served";
import { finalizeTurn, planAssistantMessage } from "./src/batch";
import { currentEditFlags } from "./src/edit-common";
import { HashlineConfigOverlay } from "./src/config-ui";
import { registerWriteHook } from "./src/write-hook";
import { readNormFile } from "./src/file-reader";
import { loadFileKindAndText } from "./src/file-kind";
import { resolveInCwd } from "./src/fs-write";
import { valAccess } from "./src/validation";
import { splitLines } from "./src/utils";
import { AUTO_READ_ALL_CUSTOM_TYPE } from "./src/constants";

export default function (pi: ExtensionAPI): void {
  regRead(pi);

  regReplace(pi);
  regInsert(pi);
  regGrep(pi);
  regUndo(pi);
  registerWriteHook(pi);

  let autoRead = true;
  let autoReadAll: AutoReadAllMode = "off";
  let autoReadAllIgnore: string[] = [];
  let autoReadAllInjected = false;
  let grepWasActive = false;

  async function refreshEditTools(): Promise<void> {
    try {
      const flags = await currentEditFlags();
      regRead(pi, flags);
      regReplace(pi, flags);
      regInsert(pi, flags);
      regUndo(pi, flags);
    } catch (error) {
      console.error("Failed to refresh edit tools:", error);
    }
  }

  pi.on("session_start", async (_event, ctx) => withAnchorSession(ctx, async () => {
    const active = pi.getActiveTools();
    grepWasActive = active.includes("grep");
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    loadHashStore()
      .then(async store => {
        const missing = await pruneMissing(store);
        for (const path of missing) freeAnchors(path);
      })
      .catch(err => {
        console.error("Failed to load hash store:", err);
      });
    const sessionManager = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionKeyFor(ctx) === undefined) await initRegistry(sessionFile);
    await gcRegistrySidecars();
    const { config, corrupted } = await readConfigWithStatus();
    if (corrupted && (ctx as { hasUI?: boolean }).hasUI) ctx.ui.notify("Hashline config was corrupt and was reset to defaults", "warning");
    autoRead = config.autoRead;
    autoReadAll = config.autoReadAll ?? "off";
    autoReadAllIgnore = config.autoReadAllIgnore ?? [];
    const sessionBranch = (ctx as { sessionManager?: { getBranch?: () => Array<{ type?: string; customType?: string }> } }).sessionManager?.getBranch?.() ?? [];
    autoReadAllInjected = sessionBranch.some((entry) => entry.type === "custom_message" && entry.customType === AUTO_READ_ALL_CUSTOM_TYPE);
    await refreshEditTools();
    pi.setActiveTools(
      pi.getActiveTools().filter((t) =>
        config.anchorGrepEnabled ? t !== "grep" : t !== "anchor_grep",
      ),
    );
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  }));

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const key = sessionKeyFor(ctx);
      clearAutoReadAllComplete(key);
      if (key !== undefined) releaseRegistrySession(key);
    } catch (error) {
      console.error("Failed to release anchor registry session:", error);
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => withAnchorSession(ctx, async () => {
    if (autoReadAll === "off" || autoReadAllInjected) return;
    autoReadAllInjected = true;
    try {
      const injection = await buildAutoReadAllInjection(ctx.cwd, autoReadAllBudget(ctx.model), autoReadAll, autoReadAllIgnore, sessionKeyFor(ctx));
      if (!injection) return;
      if (ctx.hasUI) ctx.ui.notify(`Auto-read all: attached ${injection.files} file(s) with anchors`, "info");
      return { message: { customType: AUTO_READ_ALL_CUSTOM_TYPE, content: injection.text, display: false } };
    } catch (error) {
      console.error("Auto-read all failed:", error);
      return;
    }
  }));

  pi.registerCommand("hashline-config", {
    description: "Open the hashline settings window (auto-read, auto-read all, ignore folders/files, diff context, grep, path, strict input)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hashline-config requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
        const overlay = new HashlineConfigOverlay({
          tui,
          theme,
          done,
          onToggle: async (key, delta, value) => {
            if (key === "autoRead") autoRead = await toggleAutoRead();
            else if (key === "autoReadAll") { autoReadAll = await cycleAutoReadAllMode(); autoReadAllInjected = false; }
            else if (key === "autoReadAllIgnore") autoReadAllIgnore = await setAutoReadAllIgnoreFromText(value ?? "");
            else if (key === "diffContextLines") await adjustDiffContextLines(delta ?? 1);
            else if (key === "anchorGrepEnabled") {
              const enabled = await toggleAnchorGrep();
              const active = pi.getActiveTools();
              pi.setActiveTools(enabled ? [...new Set([...active.filter((t) => t !== "grep"), "anchor_grep"])] : [...new Set([...active.filter((t) => t !== "anchor_grep"), ...(grepWasActive ? ["grep"] : [])])]);
            }
            else if (key === "requirePath") await toggleRequirePath();
            else if (key === "strictInput") await toggleStrictInput();
            await refreshEditTools();
          },
        });
        await overlay.load();
        return overlay;
      }, {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "90%" },
      });
    },
  });

  pi.registerCommand("clear-anchors", {
    description: "Clear the session's anchor claims (path-free resolution state); anchors are re-claimed on the next read",
    handler: async (_args, ctx) => withAnchorSession(ctx, async () => {
      clearRegistry();
      ctx.ui.notify(`Anchor claims cleared for this session`, "info");
    }),
  });
  pi.on("message_end", async (event, ctx) => withAnchorSession(ctx, async () => {
    try {
      await planAssistantMessage(event.message, ctx.cwd);
    } catch (error) {
      console.error("Failed to plan edit batch:", error);
    }
  }));
  pi.on("turn_end", async (event) => {
    try {
      const ids = (event.toolResults ?? []).map((result) => (result as { toolCallId?: unknown }).toolCallId).filter((id): id is string => typeof id === "string");
      await finalizeTurn(ids);
    } catch (error) {
      console.error("Failed to finalize edit batch:", error);
    }
  });
  pi.on("tool_result", async (event, ctx) => withAnchorSession(ctx, async () => {
    if (event.isError) return;

    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      let resolvedPath: string | undefined;
      if (typeof writtenPath === "string") {
        try {
          resolvedPath = (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
          freeAnchors(resolvedPath);
          await clearUndo(resolvedPath);
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
        const fileLines = splitLines(normalized);
        persistSnapshot(await loadHashStore(), absolutePath, normalized, fileHashes, fileLines.map(lineChecksum));
        serveRows(absolutePath, fileHashes, fileLines, preview.servedHashes);
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

    const batched = (event.details as { batch?: { last?: boolean } } | undefined)?.batch;
    if (batched?.last === false) return;
    const toolDetails = event.details as ReplaceDetails | undefined;
    const diff = toolDetails?.diff;
    const detailWarnings = Array.isArray(toolDetails?.warnings) ? toolDetails.warnings.filter((w): w is string => typeof w === "string") : [];
    if (typeof diff !== "string") return;
    const hasDiff = diff.length > 0;

    const rendered = (event.content ?? [])
      .filter(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof entry.text === "string",
      )
      .map((entry) => entry.text)
      .join("\n");
    const warnings = detailWarnings.length ? `Warnings:\n${detailWarnings.join("\n")}` : extractWarnings(rendered);
    const hint = hasDiff ? (warnings ? `${diff}\n\n${warnings}` : diff) : warnings ? `[post-edit] applied successfully; the diff is empty (whitespace-only change).\n\n${warnings}` : "[post-edit] applied successfully; the diff is empty (whitespace-only change).";
    return {
      content: [
        {
          type: "text",
          text: hint,
        },
      ],
    };
  }));
}
