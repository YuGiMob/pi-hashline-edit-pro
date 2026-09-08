import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveInCwd } from "./fs-write";
import { abortIf, makePrepareArguments } from "./utils";
import { ownerOf } from "./anchor-registry";
import { parseHashRef, stripAnchorRow } from "./hashline";
import { readConfig } from "./config";
import { makeRenderCall, renderEditResult, type RPreview, type FgT } from "./replace-render";
import type { ReplaceDetails } from "./replace";
export const editPrepare = makePrepareArguments();

export interface EditToolFlags {
  requirePath: boolean;
  strictInput: boolean;
  boundaryDedupEnabled: boolean;
}

export const DEFAULT_EDIT_FLAGS: EditToolFlags = {
  requirePath: false,
  strictInput: false,
  boundaryDedupEnabled: true
};

export async function currentEditFlags(): Promise<EditToolFlags> {
  const config = await readConfig();
  return {
    requirePath: config.requirePath === true,
    strictInput: config.strictInput === true,
    boundaryDedupEnabled: config.boundaryDedupEnabled !== false
  };
}

export function withReplacePrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const descriptionParts = [base.description];
  const snippetParts = [base.snippet];
  const guidelines = [...base.guidelines];
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the file the anchors were served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
    guidelines.push("`replace`: include `path` matching the file the anchors were served for; it is required.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
    guidelines.push("`replace`: strict-input is on: auto-fixable slips are rejected instead of fixed.");
  }
  if (!flags.boundaryDedupEnabled) {
    descriptionParts.push("Boundary dedup is off: edits apply literally.");
    guidelines.push("`replace`: boundary dedup is off: edits apply literally.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}

export function withInsertPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const descriptionParts = [base.description];
  const snippetParts = [base.snippet];
  const guidelines = [...base.guidelines];
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the file the anchor was served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
    guidelines.push("`insert`: include `path` matching the file the anchor was served for; it is required.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
    guidelines.push("`insert`: strict-input is on: auto-fixable slips are rejected instead of fixed.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}
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

export async function throwIfStrictInput(warnings: string[]): Promise<void> {
  const fixes = warnings.filter((warning) => warning.startsWith("[W_"));
  if (fixes.length === 0) return;
  const { strictInput } = await readConfig();
  if (strictInput === true) {
    throw new Error(`[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input (run /toggle-strict-input to disable):\n${fixes.join("\n")}`);
  }
}

export async function isBoundaryDedupEnabled(): Promise<boolean> {
  const { boundaryDedupEnabled } = await readConfig();
  return boundaryDedupEnabled !== false;
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

