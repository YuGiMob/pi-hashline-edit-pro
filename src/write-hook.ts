import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HASH_RUN } from "./hashline/alphabet.ts";
import { HASH_SEP } from "./hashline/hash.ts";
import { sessionContextReadable, servedForPath, withAnchorSession, type AnchorSessionContext } from "./anchor-registry.ts";
import { resolveInCwd } from "./fs-write.ts";
import { abortIf, splitLines, isRec } from "./utils.ts";
import type { ModelLike } from "./model-gate.ts";

const HASH_ECHO_RE = new RegExp(`^(?: *[0-9]+(?: │ |[:-]│ ))?[+ -]?(${HASH_RUN})${HASH_SEP}`);

function searchEcho(lines: string[], served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const match = HASH_ECHO_RE.exec(lines[i]!);
    const hash = match?.[1]?.toLowerCase();
    if (hash !== undefined && served.has(hash)) return { line: i + 1, hash };
  }
  return undefined;
}

export function findServedHashEcho(content: string, served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  return searchEcho(splitLines(content), served);
}

export async function servedHashEchoDenial(rawPath: string, content: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  abortIf(signal);
  const { resolved } = await resolveInCwd(rawPath, cwd);
  abortIf(signal);
  const served = servedForPath(resolved);
  if (!served || served.size === 0) return undefined;
  const echo = findServedHashEcho(content, served);
  if (!echo) return undefined;
  return `[E_WRITE_HASH_ECHO] Refused write to ${rawPath}: line ${echo.line} contains the copied ${echo.hash}${HASH_SEP} anchor served for this file. Remove the copied anchors and retry.`;
}

function withReadableSession<T>(ctx: AnchorSessionContext | undefined, fn: () => Promise<T> | T): Promise<T | undefined> {
  return sessionContextReadable(ctx) ? withAnchorSession(ctx, fn) : Promise.resolve(undefined);
}

export function registerWriteHook(pi: ExtensionAPI, isModelDisabled?: (model: ModelLike | undefined) => boolean): void {
  pi.on("tool_call", async (event, ctx) => withReadableSession(ctx, async () => {
    if (event.toolName !== "write") return;
    if (isModelDisabled?.(ctx.model)) return;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || !isRec(input)) return;
    const rawPath = input.path as unknown;
    const content = input.content as unknown;
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
  }));
}
