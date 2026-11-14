import type { NormFile } from "./file-reader.ts";

export interface PreEditSnapshot extends NormFile {
  served?: ReadonlyMap<string, string>;
}

const snapshots = new Map<string, PreEditSnapshot>();

export function recordPreEditSnapshot(snapshot: PreEditSnapshot): void {
  snapshots.set(snapshot.absolutePath, snapshot);
}

export function preEditSnapshotFor(path: string): PreEditSnapshot | undefined {
  return snapshots.get(path);
}

export function clearPreEditSnapshots(): void {
  snapshots.clear();
}
