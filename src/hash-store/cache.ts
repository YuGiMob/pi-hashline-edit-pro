export interface SnapshotCacheEntry {
  checksum: string;
  lineCount: number;
  hashes: string[];
}

export const SNAPSHOT_CACHE_LIMIT = 256;

export const snapshotCache = new Map<string, SnapshotCacheEntry>();

export function cacheSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void {
  snapshotCache.delete(path);
  snapshotCache.set(path, { checksum, lineCount, hashes: hashes.slice() });
  if (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
}

let sessionSeq = 0;
export const sessionTouched = new Map<string, number>();

export function touchSession(path: string): void {
  sessionSeq += 1;
  sessionTouched.delete(path);
  sessionTouched.set(path, sessionSeq);
}

export function sessionRank(path: string): number | undefined {
  return sessionTouched.get(path);
}

export function clearSession(): void {
  sessionTouched.clear();
  sessionSeq = 0;
}

export function forgetSession(path: string): void {
  sessionTouched.delete(path);
}
