import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HASH_CLASS } from "./hashline/alphabet";
import { HASH_SEP } from "./hashline/hash";
import { loadHashStore } from "./hash-store";
import { getServed } from "./served";
import { resolveInCwd } from "./fs-write";
import { abortIf, splitLines, isRec, normalizeFilePath } from "./utils";

const HASH_ECHO_RE = new RegExp(`^(${HASH_CLASS})${HASH_SEP}`);

function searchEcho(lines: string[], served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const match = HASH_ECHO_RE.exec(lines[i]!);
    if (match && served.has(match[1]! as never)) return { line: i + 1, hash: match[1]! };
  }
  return undefined;
}

export function findServedHashEcho(content: string, served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  return searchEcho(splitLines(content), served);
}

export function findEditHashEcho(lines: string[], served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  return searchEcho(lines, served);
}

export async function servedHashEchoDenial(rawPath: string, content: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  abortIf(signal);
  const { resolved } = await resolveInCwd(rawPath, cwd);
  abortIf(signal);
  const store = await loadHashStore();
  const served = getServed(store, resolved);
  if (!served || served.size === 0) return undefined;
  const echo = findServedHashEcho(content, served);
  if (!echo) return undefined;
  return `[E_WRITE_HASH_ECHO] Refused write to ${rawPath}: line ${echo.line} begins with the exact ${echo.hash}${HASH_SEP} anchor served for this file. Remove the copied anchors and retry. Nothing was written.`;
}

export function registerWriteHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || !isRec(input)) return;
    const normalized = { ...input };
    normalizeFilePath(normalized);
    const rawPath = normalized.path as unknown;
    const content = normalized.content as unknown;
    if (typeof rawPath !== "string" || typeof content !== "string") return;
    const signal = ctx.signal;
    try {
      const reason = await servedHashEchoDenial(rawPath, content, ctx.cwd, signal);
      if (reason !== undefined) return { block: true, reason };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error("write hook failed:", error);
    }
    return;
  });
}
