import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createGrepToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline/index.ts";
import { regReplaceMatch } from "./src/replace-match.ts";
import { regReplace } from "./src/replace.ts";
import { regInsert } from "./src/insert.ts";
import { regCopy, regMove } from "./src/copy-move.ts";
import { regGrep, regVanillaGrep } from "./src/grep.ts";
import { regUndo, clearUndo } from "./src/replace-undo.ts";
import { regRead, fmtReadPreview } from "./src/read.ts";
import { regOutline } from "./src/outline-tool.ts";
import { ANCHOR_TOOL_NAMES, modelDisabled, type ModelLike } from "./src/model-gate.ts";
import { buildAutoReadAllInjection, autoReadAllBudget, isOutlineAutoReadAll } from "./src/auto-read-all.ts";
import type { RMetrics } from "./src/replace-response.ts";
import type { ReplaceDetails } from "./src/replace.ts";
import { extractHints, extractWarnings } from "./src/replace-render.ts";
import { MAX_HASH_LINES } from "./src/hashline/index.ts";
import { withStructuredText } from "./src/structured.ts";
import type { AutoReadAllMode, AutoReadWriteMode, Config, ReadOnDisabledModels } from "./src/config.ts";
import {
  readConfig,
  readConfigWithStatus,
  toggleAutoRead,
  cycleAutoReadWriteMode,
  cycleAutoReadAllMode,
  toggleAutoReadAllRequireGit,
  toggleAnchorGrep,
  toggleCopyMove,
  toggleReplaceMatch,
  toggleOutline,
  cycleReadOnDisabledModels,
  toggleRequirePath,
  toggleStrictInput,
  adjustDiffContextLines,
  adjustUndoRetentionDays,
  getUndoRetentionDays,
  setAutoReadAllIgnoreFromText,
  setDisableOnModelsFromText,
} from "./src/config.ts";
import { loadHashStore, pruneExpiredUndo, pruneMissing } from "./src/hash-store.ts";
import { type AnchorSessionContext, initRegistry, gcRegistrySidecars, clearRegistry, freeAnchors, freeAnchorsForPaths, sessionKeyFor, sessionContextReadable, withAnchorSession, releaseRegistrySession, formatAnchorReclaimNotice, takeReclaimedPaths } from "./src/anchor-registry.ts";
import { serveRows } from "./src/served.ts";
import { finalizeTurn, planAssistantMessage } from "./src/batch.ts";
import { currentEditFlags, editToolEnabled } from "./src/edit-common.ts";
import type { HashlineConfigOverlay } from "./src/config-ui.ts";
import { registerWriteHook } from "./src/write-hook.ts";
import { readNormFile } from "./src/file-reader.ts";
import { stripBOM, toLF } from "./src/normalize.ts";
import { loadFileKindAndText } from "./src/file-kind.ts";
import { resolveInCwd } from "./src/fs-write.ts";
import { valAccess } from "./src/validation.ts";
import { splitLines, visLines } from "./src/utils.ts";
import { AUTO_READ_ALL_CUSTOM_TYPE } from "./src/constants.ts";

interface PendingRegistrySession {
  key: string | undefined;
  alive: () => boolean;
}

function configEnablesTool(tool: string, config: Config): boolean {
  if (tool === "grep") return config.anchorGrepEnabled === true;
  return editToolEnabled(tool, {
    replaceMatchEnabled: config.replaceMatchEnabled !== false,
    copyMoveEnabled: config.copyMoveEnabled !== false,
    outlineEnabled: config.outlineEnabled === true,
  });
}

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regOutline(pi);

  regReplace(pi);
  regReplaceMatch(pi);
  regInsert(pi);
  regCopy(pi);
  regMove(pi);
  regGrep(pi);
  regUndo(pi);
  registerWriteHook(pi, (model) => modelDisabled(model, disableOnModels));

  let autoRead = true;
  let autoReadWrite: AutoReadWriteMode = "full";
  let autoReadAll: AutoReadAllMode = "off";
  let autoReadAllIgnore: string[] = [];
  let autoReadAllRequireGit = true;
  let disableOnModels: string[] = [];
  let readOnDisabledModels: ReadOnDisabledModels = "vanilla";
  let codemodeActive = false;
  let readFlavor: "anchored" | "vanilla" = "anchored";
  let readFlavorCwd: string | undefined;
  let autoReadAllInjected = false;
  let grepEnabled = true;
  let grepFlavor: "anchored" | "vanilla" = "anchored";
  let grepFlavorCwd: string | undefined;
  const baseAnchorTools = new Set<string>();
  let gateApplied = false;
  const pendingRegistrySessions: PendingRegistrySession[] = [];

  function setAnchorToolEnabled(tools: readonly string[], enabled: boolean): void {
    const active = pi.getActiveTools();
    pi.setActiveTools(enabled ? [...new Set([...active, ...tools])] : active.filter((tool) => !tools.includes(tool)));
    for (const tool of tools) {
      if (enabled) baseAnchorTools.add(tool);
      else baseAnchorTools.delete(tool);
    }
  }

  async function refreshEditTools(): Promise<void> {
    try {
      codemodeActive = pi.getActiveTools().includes("codemode");
      const flags = await currentEditFlags(codemodeActive);
      if (readFlavor !== "vanilla") regRead(pi, flags);
      regOutline(pi, flags);
      regReplace(pi, flags);
      regReplaceMatch(pi, flags);
      regInsert(pi, flags);
      regCopy(pi, flags);
      regMove(pi, flags);
      if (grepFlavor === "vanilla" && grepFlavorCwd !== undefined) regVanillaGrep(pi, grepFlavorCwd);
      else regGrep(pi, flags);
      regUndo(pi, flags);
    } catch (error) {
      console.error("Failed to refresh edit tools:", error);
    }
  }

  async function syncModelGate(model: ModelLike | undefined, cwd: string): Promise<void> {
    const gated = disableOnModels.length > 0 && modelDisabled(model, disableOnModels);
    if (gated && readOnDisabledModels === "vanilla") {
      if (readFlavor !== "vanilla" || readFlavorCwd !== cwd) {
        pi.registerTool(createReadToolDefinition(cwd));
        readFlavor = "vanilla";
        readFlavorCwd = cwd;
      }
    } else if (readFlavor === "vanilla") {
      readFlavor = "anchored";
      readFlavorCwd = undefined;
      await refreshEditTools();
    }
    const grepFlavorWanted = grepEnabled && !gated ? "anchored" : "vanilla";
    if (grepFlavorWanted === "vanilla") {
      if (grepFlavor !== "vanilla" || grepFlavorCwd !== cwd) {
        pi.registerTool(createGrepToolDefinition(cwd));
        grepFlavor = "vanilla";
        grepFlavorCwd = cwd;
      }
    } else if (grepFlavor === "vanilla") {
      grepFlavor = "anchored";
      grepFlavorCwd = undefined;
      await refreshEditTools();
    }
    if (gated) {
      const active = pi.getActiveTools().filter((tool) => tool !== "edit");
      const gatedTools = ANCHOR_TOOL_NAMES.filter((tool) => tool !== "grep" && (readOnDisabledModels !== "vanilla" || tool !== "read"));
      const next = active.filter((tool) => !gatedTools.includes(tool));
      pi.setActiveTools(next);
      gateApplied = true;
      return;
    }
    if (!gateApplied) {
      const current = pi.getActiveTools();
      const withoutEdit = current.filter((tool) => tool !== "edit");
      if (withoutEdit.length !== current.length) pi.setActiveTools(withoutEdit);
      return;
    }
    gateApplied = false;
    const config = await readConfig();
    const enabled = ANCHOR_TOOL_NAMES.filter((tool) => {
      if (tool === "read") return true;
      if (!baseAnchorTools.has(tool)) return false;
      return configEnablesTool(tool, config);
    });
    const active = pi.getActiveTools().filter((tool) => tool !== "edit");
    const base = enabled.includes("grep") ? active.filter((tool) => tool !== "grep") : active;
    pi.setActiveTools([...new Set([...base, ...enabled])]);
  }

  function captureRegistrySession(ctx: AnchorSessionContext | undefined): void {
    const key = sessionKeyFor(ctx);
    const entry: PendingRegistrySession = {
      key,
      alive: () => sessionContextReadable(ctx),
    };
    const index = key === undefined ? -1 : pendingRegistrySessions.findIndex((candidate) => candidate.key === key);
    if (index >= 0) pendingRegistrySessions[index] = entry;
    else pendingRegistrySessions.push(entry);
  }

  function releaseCapturedRegistrySession(key: string): void {
    const index = pendingRegistrySessions.findIndex((entry) => entry.key === key);
    if (index >= 0) pendingRegistrySessions.splice(index, 1);
    releaseRegistrySession(key);
  }

  async function withRegistrySession<T>(ctx: AnchorSessionContext | undefined, fn: () => Promise<T> | T): Promise<T | undefined> {
    if (!sessionContextReadable(ctx)) return undefined;
    captureRegistrySession(ctx);
    return withAnchorSession(ctx, fn);
  }

  pi.on("session_start", async (_event, ctx) => withRegistrySession(ctx, async () => {
    const active = pi.getActiveTools();
    baseAnchorTools.clear();
    for (const tool of ANCHOR_TOOL_NAMES) {
      if (active.includes(tool)) baseAnchorTools.add(tool);
    }
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    loadHashStore()
      .then(async store => {
        freeAnchorsForPaths(await pruneMissing(store));
        try {
          pruneExpiredUndo(store, await getUndoRetentionDays());
        } catch (error) {
          console.error("Failed to prune expired undo records:", error);
        }
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
    autoReadWrite = config.autoReadWrite ?? "full";
    autoReadAll = config.autoReadAll ?? "off";
    autoReadAllRequireGit = config.autoReadAllRequireGit ?? true;
    autoReadAllIgnore = config.autoReadAllIgnore ?? [];
    disableOnModels = config.disableOnModels ?? [];
    readOnDisabledModels = config.readOnDisabledModels ?? "vanilla";
    grepEnabled = config.anchorGrepEnabled === true;
    grepFlavor = grepEnabled ? "anchored" : "vanilla";
    grepFlavorCwd = grepEnabled ? undefined : ctx.cwd;
    const sessionBranch = (ctx as { sessionManager?: { getBranch?: () => Array<{ type?: string; customType?: string }> } }).sessionManager?.getBranch?.() ?? [];
    autoReadAllInjected = sessionBranch.some((entry) => entry.type === "custom_message" && entry.customType === AUTO_READ_ALL_CUSTOM_TYPE);
    await refreshEditTools();
    pi.setActiveTools(
      pi.getActiveTools().filter((tool) => tool === "grep" || configEnablesTool(tool, config)),
    );
    setAnchorToolEnabled(["outline"], config.outlineEnabled === true);
    await syncModelGate(ctx.model, ctx.cwd);
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  }));

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      let key: string | undefined;
      let readable = true;
      try {
        key = sessionKeyFor(ctx);
      } catch {
        readable = false;
      }
      if (readable && key !== undefined) {
        releaseCapturedRegistrySession(key);
        return;
      }
      if (readable) {
        const dead = pendingRegistrySessions.findIndex((entry) => entry.key === undefined && !entry.alive());
        const fallback = pendingRegistrySessions.findIndex((entry) => entry.key === undefined);
        const index = dead >= 0 ? dead : fallback;
        if (index >= 0) pendingRegistrySessions.splice(index, 1);
        return;
      }
      const dead = pendingRegistrySessions.findIndex((entry) => !entry.alive());
      const entry = dead >= 0 ? pendingRegistrySessions.splice(dead, 1)[0] : pendingRegistrySessions.shift();
      if (entry?.key !== undefined) releaseRegistrySession(entry.key);
    } catch (error) {
      console.error("Failed to release anchor registry session:", error);
    }
  });
  pi.on("model_select", async (event, ctx) => withRegistrySession(ctx, async () => {
    await syncModelGate(event.model, ctx.cwd);
  }));

  pi.on("before_agent_start", async (_event, ctx) => withRegistrySession(ctx, async () => {
    if (pi.getActiveTools().includes("codemode") !== codemodeActive) await refreshEditTools();
    await syncModelGate(ctx.model, ctx.cwd);
    if (autoReadAll === "off" || autoReadAllInjected) return;
    if (modelDisabled(ctx.model, disableOnModels)) return;
    autoReadAllInjected = true;
    try {
      const injection = await buildAutoReadAllInjection(ctx.cwd, autoReadAllBudget(ctx.model, autoReadAll), autoReadAll, autoReadAllIgnore, autoReadAllRequireGit);
      if (!injection) return;
      if (ctx.hasUI) ctx.ui.notify(`Auto-read all: ${isOutlineAutoReadAll(autoReadAll) ? "outlined" : "attached"} ${injection.files} file(s)`, "info");
      return { message: { customType: AUTO_READ_ALL_CUSTOM_TYPE, content: injection.text, display: false } };
    } catch (error) {
      console.error("Auto-read all failed:", error);
      return;
    }
  }));

  pi.registerCommand("hashline-config", {
    description: "Open the hashline settings window (auto-read, diff context, auto-read all, git repos only, ignore folders/files, grep, copy/move, replace_match, outline, path, strict input, disable on models, read on disabled models)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hashline-config requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
        const { HashlineConfigOverlay } = await import("./src/config-ui.ts");
        const overlay = new HashlineConfigOverlay({
          tui,
          maxHeight: () => tui.terminal ? Math.max(6, Math.floor(tui.terminal.rows * 0.9)) : undefined,
          theme,
          done,
          onToggle: async (key, delta, value) => {
            if (key === "autoRead") autoRead = await toggleAutoRead();
            else if (key === "autoReadWrite") autoReadWrite = await cycleAutoReadWriteMode(delta);
            else if (key === "autoReadAll") { autoReadAll = await cycleAutoReadAllMode(delta); autoReadAllInjected = false; }
            else if (key === "autoReadAllRequireGit") autoReadAllRequireGit = await toggleAutoReadAllRequireGit();
            else if (key === "autoReadAllIgnore") autoReadAllIgnore = await setAutoReadAllIgnoreFromText(value ?? "");
            else if (key === "disableOnModels") disableOnModels = await setDisableOnModelsFromText(value ?? "");
            else if (key === "readOnDisabledModels") readOnDisabledModels = await cycleReadOnDisabledModels(delta);
            else if (key === "diffContextLines") await adjustDiffContextLines(delta ?? 1);
            else if (key === "undoRetentionDays") await adjustUndoRetentionDays((delta ?? 1) * 5);
            else if (key === "anchorGrepEnabled") {
              const enabled = await toggleAnchorGrep();
              grepEnabled = enabled;
              grepFlavor = enabled ? "anchored" : "vanilla";
              grepFlavorCwd = enabled ? undefined : ctx.cwd;
              if (enabled) baseAnchorTools.add("grep");
              else baseAnchorTools.delete("grep");
            }
            else if (key === "copyMoveEnabled") setAnchorToolEnabled(["copy", "move"], await toggleCopyMove());
            else if (key === "replaceMatchEnabled") setAnchorToolEnabled(["replace_match"], await toggleReplaceMatch());
            else if (key === "outlineEnabled") setAnchorToolEnabled(["outline"], await toggleOutline());
            else if (key === "requirePath") await toggleRequirePath();
            else if (key === "strictInput") await toggleStrictInput();
            await refreshEditTools();
            await syncModelGate(ctx.model, ctx.cwd);
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
    handler: async (_args, ctx) => withRegistrySession(ctx, async () => {
      clearRegistry();
      ctx.ui.notify(`Anchor claims cleared for this session`, "info");
    }),
  });
  pi.on("message_end", async (event, ctx) => withRegistrySession(ctx, async () => {
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
  pi.on("tool_result", async (event, ctx) => withRegistrySession(ctx, async () => {
    if (event.isError) return;
    const gated = modelDisabled(ctx.model, disableOnModels);

    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      let resolvedPath: string | undefined;
      const writtenContent = (event.input as Record<string, unknown>)?.content;
      if (typeof writtenPath === "string") {
        try {
          resolvedPath = (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
          freeAnchors(resolvedPath);
          await clearUndo(resolvedPath);
        } catch (error) {
          console.error("Failed to clear undo after write:", error);
        }
      }
      if (autoReadWrite === "off" || gated) return;
      if (typeof writtenPath !== "string") return;
      try {
        resolvedPath ??= (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
        if (autoReadWrite === "summary") {
          let lineCount: number;
          if (typeof writtenContent === "string") {
            lineCount = visLines(toLF(stripBOM(writtenContent).text)).length;
          } else {
            const source = await loadFileKindAndText(resolvedPath, { maxLines: MAX_HASH_LINES, displayPath: writtenPath });
            if (source.kind !== "text") return;
            lineCount = visLines(toLF(stripBOM(source.text).text)).length;
          }
          return {
            content: [
              ...(event.content ?? []),
              { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${lineCount} ${lineCount === 1 ? "line" : "lines"} written. No anchors are served after a write: read the range you want to edit.` },
            ],
          };
        }
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
        serveRows(absolutePath, fileHashes, fileLines, preview.servedHashes);
        const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}${reclaimNotice !== undefined ? `\n\n${reclaimNotice}` : ""}` },
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
      event.toolName !== "replace_match" &&
      event.toolName !== "insert" &&
      event.toolName !== "copy" &&
      event.toolName !== "move" &&
      event.toolName !== "undo_last_change"
    ) return;
    if (!autoRead || gated) return;

    const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
    if (metrics?.classification === "noop") return;

    const batched = (event.details as { batch?: { last?: boolean } } | undefined)?.batch;
    if (batched?.last === false) return;
    const toolDetails = event.details as ReplaceDetails | undefined;
    const diff = toolDetails?.diff;
    const detailWarnings = Array.isArray(toolDetails?.warnings) ? toolDetails.warnings.filter((w): w is string => typeof w === "string") : [];
    const detailHints = Array.isArray(toolDetails?.hints) ? toolDetails.hints.filter((h): h is string => typeof h === "string") : [];
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
    const hints = detailHints.length ? `Hints:\n${detailHints.join("\n")}` : extractHints(rendered);
    const notices = [warnings, hints].filter((part): part is string => part !== undefined).join("\n\n");
    const emptyDiffNotice = "[post-edit] applied successfully; the diff is empty (no content change: whitespace or line endings only).";
    const noticeText = hasDiff ? (notices ? `${diff}\n\n${notices}` : diff) : notices ? `${emptyDiffNotice}\n\n${notices}` : emptyDiffNotice;
    const structured = (event as { structuredContent?: unknown }).structuredContent;
    return {
      content: [
        {
          type: "text",
          text: noticeText,
        },
      ],
      ...(structured !== undefined ? { structuredContent: withStructuredText(structured, noticeText) } : {}),
    };
  }));
}
