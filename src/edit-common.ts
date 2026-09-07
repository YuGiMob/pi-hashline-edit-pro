import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveInCwd } from "./fs-write";
import { abortIf, makePrepareArguments } from "./utils";
import { ownerOf } from "./anchor-registry";
import { parseHashRef, stripAnchorRow } from "./hashline";
import { readConfig } from "./config";
import { makeRenderCall, renderEditResult, type RPreview, type FgT } from "./replace-render";
import type { ReplaceDetails } from "./replace";
export const editPrepare = makePrepareArguments();

export function resolveEditTarget(removeFrom: string, removeTo?: string): string {
  const refs = [removeFrom, removeTo].filter((value): value is string => typeof value === "string");
  const owners = refs.map((ref) => ownerOf(parseHashRef(stripAnchorRow(ref.trim(), "anchor entry")).hash));
  const missing = owners.findIndex((owner) => !owner);
  if (missing >= 0) {
    throw new Error(
      `[E_STALE_ANCHOR] "${refs[missing]!}" is not owned in this session. Call read() on the target file first.`,
    );
  }
  const paths = new Set(owners.map((owner) => owner!.path));
  if (paths.size > 1) {
    throw new Error(
      `[E_BAD_SHAPE] The anchors are owned by different files (${owners.map((owner) => owner!.path).join(", ")}); edit one file per call.`,
    );
  }
  return owners[0]!.path;
}

export function tryResolveEditTarget(removeFrom: string | undefined, removeTo?: string): string | undefined {
  if (typeof removeFrom !== "string") return undefined;
  try {
    return resolveEditTarget(removeFrom, removeTo);
  } catch {
    return undefined;
  }
}

export interface PathRequirementInput {
  removeFrom?: string;
  removeTo?: string;
  anchor?: string;
  providedPath?: unknown;
  cwd: string;
}

export async function resolveEditTargetWithRequirement(input: PathRequirementInput): Promise<string> {
  const { requirePath } = await readConfig();
  if (!requirePath && input.providedPath !== undefined) {
    throw new Error("[E_BAD_SHAPE] Edit request contains unknown or unsupported fields: path. Path resolution is anchor-only; run /toggle-require-path to require it.");
  }
  if (requirePath && (typeof input.providedPath !== "string" || input.providedPath.length === 0)) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string when require-path mode is on (run /toggle-require-path to disable).');
  }
  const anchorTarget = typeof input.anchor === "string"
    ? resolveEditTarget(input.anchor)
    : resolveEditTarget(input.removeFrom as string, input.removeTo);
  if (requirePath) {
    const { resolved } = await resolveInCwd(input.providedPath as string, input.cwd);
    if (resolved !== anchorTarget) {
      throw new Error(`[E_BAD_SHAPE] Provided "path" "${input.providedPath}" does not match anchor ownership "${anchorTarget}".`);
    }
  }
  return anchorTarget;
}

export function editRenderCallWrapper(
  preview: (args: unknown, cwd: string, signal?: AbortSignal) => Promise<RPreview>,
  getInput?: (args: unknown) => { path?: string } | null,
  toolName?: string,
) {
  return makeRenderCall(preview, {
    getInput,
    toolName,
    resolveTarget: (input) => {
      if (typeof input.remove_from === "string") return tryResolveEditTarget(input.remove_from, input.remove_to);
      if (typeof input.anchor === "string") return tryResolveEditTarget(input.anchor);
      return undefined;
    },
  });
}

export function editRenderResultWrapper(
  result: { content?: Array<{ type: string; text?: string }>; details?: ReplaceDetails },
  opts: { isPartial: boolean; expanded?: boolean } | boolean,
  theme: FgT,
  context: any,
) {
  return renderEditResult(result, opts, theme, context);
}

export const editToolBase = {
  prepareArguments: editPrepare,
  executionMode: "sequential" as const,
  renderShell: "default" as const,
};

export async function queuedEdit<T>(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  work: (absolute: string, resolved: string) => Promise<T>,
): Promise<T> {
  abortIf(signal);
  const { absolute, resolved } = await resolveInCwd(path, cwd);
  return withFileMutationQueue(resolved, async () => {
    abortIf(signal);
    return work(absolute, resolved);
  });
}

