import { loadHashStore, findSnapshotPaths, findServedPaths, rankRecentPaths } from "./hash-store";
import { parseHashRef } from "./hashline/parse";
import { stripAnchorRow } from "./hashline/resolve";

export async function resolvePathFromHashes(hashes: string[]): Promise<{ path: string; warning: string } | undefined> {
  let store;
  try {
    store = await loadHashStore();
  } catch {
    return undefined;
  }
  const matches = [...new Set([...findSnapshotPaths(store, hashes), ...findServedPaths(store, hashes)])];
  if (matches.length === 0) return undefined;
  if (matches.length === 1) {
    const single = matches[0]!;
    return { path: single, warning: `[W_BAD_SHAPE] Missing "path" resolved to ${single}.` };
  }
  const ranked = rankRecentPaths(store, [...matches]);
  const picked = ranked[0]!;
  const shown = ranked.slice(0, 3);
  const hidden = ranked.length - shown.length;
  const listed = hidden > 0 ? `${shown.join(", ")}, ... (+${hidden} more)` : shown.join(", ");
  return { path: picked, warning: `[W_BAD_SHAPE] Missing "path" resolved to ${picked} (picked most recent of ${ranked.length}: ${listed}).` };
}

export async function resolveReplacePath(request: Record<string, unknown>): Promise<{ path: string; warning: string } | undefined> {
  if (typeof request.path === "string") return undefined;
  const from = request.remove_from;
  const to = request.remove_to;
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const hashes: string[] = [];
  for (const ref of [from, to]) {
    try {
      hashes.push(parseHashRef(ref).hash);
    } catch {
      return undefined;
    }
  }
  return resolvePathFromHashes(hashes);
}

export async function resolveInsertPath(request: Record<string, unknown>): Promise<{ path: string; warning: string } | undefined> {
  if (typeof request.path === "string") return undefined;
  const anchor = request.anchor;
  if (typeof anchor !== "string") return undefined;
  let hash: string;
  try {
    const stripped = stripAnchorRow(anchor.trim(), "anchor entry");
    hash = parseHashRef(stripped).hash;
  } catch {
    return undefined;
  }
  return resolvePathFromHashes([hash]);
}
