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
