import { loadHashStore, parseStoredHashes, STORE_NOT_OPEN_MESSAGE, withStore, type HashStore } from "./hash-store";
import { HASH_CLASS } from "./hashline/alphabet";

const SERVED_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│`);

export function servedHashesFromDiff(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

export function getServed(store: HashStore, path: string): Set<string> | undefined {
  const row = store.stmts.servedGet(path);
  const parsed = parseStoredHashes(row, () => store.stmts.servedDelete(path));
  if (!parsed) return undefined;
  return new Set(parsed);
}

function computeUpdate(
  store: HashStore,
  path: string,
  hashes: string[],
  scope?: ReadonlySet<string>,
): Set<string> | undefined {
  const existing = getServed(store, path);
  if (!existing && hashes.length === 0) return undefined;
  const set = existing ?? new Set<string>();
  let changed = false;
  if (scope) {
    for (const hash of set) {
      if (!scope.has(hash)) {
        set.delete(hash);
        changed = true;
      }
    }
  }
  for (const hash of hashes) {
    if (!set.has(hash)) {
      set.add(hash);
      changed = true;
    }
  }
  if (!changed) return undefined;
  return set;
}

export function recordServed(
  store: HashStore,
  path: string,
  hashes: string[],
  scope?: ReadonlySet<string>,
): void {
  try {
    withStore(() => {
      const set = computeUpdate(store, path, hashes, scope);
      if (!set) return;
      store.stmts.servedUpsert(path, JSON.stringify([...set]), Date.now());
    });
    return;
  } catch (error) {
    if (!(error instanceof Error && error.message === STORE_NOT_OPEN_MESSAGE)) throw error;
  }
  const set = computeUpdate(store, path, hashes, scope);
  if (!set) return;
  store.stmts.servedUpsert(path, JSON.stringify([...set]), Date.now());
}

export function recordServedDiff(
  store: HashStore,
  path: string,
  diff: string,
  scope?: ReadonlySet<string>,
): void {
  recordServed(store, path, servedHashesFromDiff(diff), scope);
}

export function clearServed(store: HashStore, path: string): void {
  store.stmts.servedDelete(path);
}

export async function recordServedSafe(
  path: string,
  hashes: string[],
  context: string,
  scope?: ReadonlySet<string>,
): Promise<void> {
  if (hashes.length === 0 && !scope) return;
  try {
    const store = await loadHashStore();
    recordServed(store, path, hashes, scope);
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
  await recordServedSafe(path, servedHashesFromDiff(diff), context, scope);
}
