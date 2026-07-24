import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regReplace, regReplaceFlat } from "./src/replace";
import { regRead, fmtReadPreview } from "./src/read";
import { visLines } from "./src/utils";
import { AUTO_READ_MAX } from "./src/constants";
import {
  readConfig,
  toggleReplaceMode,
  toggleAutoRead,
} from "./src/config";
import { loadHashStore, pruneMissing } from "./src/hash-store";
import { readNormFile } from "./src/file-reader";

export default function (pi: ExtensionAPI): void {
  regRead(pi);

  regReplace(pi);


function registerReplaceTool(pi: ExtensionAPI, mode: string, autoRead?: boolean): void {
  if (mode === "flat") {
    regReplaceFlat(pi, autoRead);
  } else {
    regReplace(pi, autoRead);
  }
}
  const debugValue = process.env.PI_HASHLINE_DEBUG;
  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  let autoRead = autoReadValue === "1" || autoReadValue === "true";

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
    const mode = config.replaceMode;
    autoRead = config.autoRead;
    registerReplaceTool(pi, mode, autoRead);


    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active (${mode} replace)`, "info");
    }
  });

  pi.registerCommand("toggle-replace-mode", {
    description: "Toggle replace tool between bulk (changes array) and flat (single edit at top level) mode",
    handler: async (_args, ctx) => {
      const mode = await toggleReplaceMode();
      registerReplaceTool(pi, mode, autoRead);
      ctx.ui.notify(`Replace mode switched to: ${mode}`, "info");
    },
  });

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write and replace operations",
    handler: async (_args, ctx) => {
      autoRead = await toggleAutoRead();
      const mode = (await readConfig()).replaceMode;
      registerReplaceTool(pi, mode, autoRead);
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write/replace: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!autoRead) return;
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "replace") return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const { normalized, fileHashes, absolutePath } = await readNormFile(filePath, ctx.cwd, undefined);

      if (visLines(normalized).length === 0) return;

      const preview = await fmtReadPreview(normalized, { limit: AUTO_READ_MAX }, fileHashes, absolutePath);

      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
        ],
      };
    } catch (error) {
      console.error("Auto-read after write/replace failed:", error);
    }
  });
}
