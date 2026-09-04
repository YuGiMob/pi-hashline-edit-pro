import { loadHashStore, parseStoredServed, STORE_NOT_OPEN_MESSAGE, withStore, type HashStore } from "./hash-store";
import { touchSession } from "./hash-store/cache";
import { withBusyRetry } from "./hash-store/retry";
import { HASH_CLASS } from "./hashline/alphabet";
import { contentChecksum } from "./hashline/hasher";

const SERVED_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│`);

export function servedHashesFromDiff(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

export function servedMapFromDiff(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (!match) continue;
    const hash = match[1]!;
    const content = line.slice(match[0].length);
    map.set(hash, contentChecksum(content));
  }
  return map;
}

export function buildServedMap(fileHashes: string[], fileLines: string[], wantedHashes: string[]): Map<string, string> {
  const index = new Map<string, number>();
  for (let i = 0; i < fileHashes.length; i++) index.set(fileHashes[i]!, i);
  const map = new Map<string, string>();
  for (const h of wantedHashes) {
    const idx = index.get(h);
    if (idx !== undefined) map.set(h, contentChecksum(fileLines[idx]!));
  }
  return map;
}

export function getServed(store: HashStore, path: string): Map<string, string> | undefined {
  const row = withBusyRetry(() => store.stmts.servedGet(path));
  const parsed = parseStoredServed(row, () => store.stmts.servedDelete(path));
  if (!parsed) return undefined;
  return parsed;
}

function computeUpdate(
  store: HashStore,
  path: string,
  entries: Map<string, string>,
  scope?: ReadonlySet<string>,
): Map<string, string> | undefined {
  const existing = getServed(store, path);
  if (!existing && entries.size === 0 && !scope) return undefined;
  const map = existing ? new Map(existing) : new Map<string, string>();
  let changed = false;
  if (scope) {
    for (const hash of [...map.keys()]) {
      if (!scope.has(hash)) {
        map.delete(hash);
        changed = true;
      }
    }
  }
  for (const [hash, content] of entries) {
    const prev = map.get(hash);
    if (prev !== content) {
      map.set(hash, content);
      changed = true;
    }
  }
  if (!changed && existing) return undefined;
  if (map.size === 0 && (!existing || existing.size === 0)) return undefined;
  if (!changed) return existing;
  return map;
}

export function recordServed(
  store: HashStore,
  path: string,
  entries: Map<string, string>,
  scope?: ReadonlySet<string>,
): void {
  touchSession(path);
  try {
    withStore(() => {
      const map = computeUpdate(store, path, entries, scope);
      if (!map) return;
      const obj = Object.fromEntries(map);
      store.stmts.servedUpsert(path, JSON.stringify(obj), Date.now());
    });
    return;
  } catch (error) {
    if (!(error instanceof Error && error.message === STORE_NOT_OPEN_MESSAGE)) throw error;
  }
  const map = computeUpdate(store, path, entries, scope);
  if (!map) return;
  const obj = Object.fromEntries(map);
  store.stmts.servedUpsert(path, JSON.stringify(obj), Date.now());
}

export function recordServedDiff(
  store: HashStore,
  path: string,
  diff: string,
  scope?: ReadonlySet<string>,
): void {
  recordServed(store, path, servedMapFromDiff(diff), scope);
}

export function clearServed(store: HashStore, path: string): void {
  store.stmts.servedDelete(path);
}

export async function recordServedSafe(
  path: string,
  entries: Map<string, string>,
  context: string,
  scope?: ReadonlySet<string>,
): Promise<void> {
  if (entries.size === 0 && !scope) return;
  try {
    const store = await loadHashStore();
    recordServed(store, path, entries, scope);
  } catch (error) {
    console.error(`Failed to record served state (${context}):`, error);
  }
}

export async function recordServedDiffSafe(
  path: string,
  diff: string,
  context: string,
  scope?: ReadonlySet<string>,
): Promise<void> {
  if (!diff) return;
  await recordServedSafe(path, servedMapFromDiff(diff), context, scope);
}
