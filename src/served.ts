import { HASH_CLASS } from "./hashline/alphabet";
import { hashSource } from "./hashline";
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

export function buildServedMap(
  fileHashes: string[],
  fileLines: string[],
  wantedHashes: string[],
): Array<[string, string]> {
  const index = new Map<string, number>();
  for (let i = 0; i < fileHashes.length; i++) {
    const existing = index.get(fileHashes[i]!);
    if (existing === undefined) index.set(fileHashes[i]!, i);
  }
  const entries: Array<[string, string]> = [];
  for (const hash of wantedHashes) {
    const idx = index.get(hash);
    if (idx !== undefined) entries.push([hash, contentChecksum(hashSource(fileLines[idx]!))]);
  }
  return entries;
}
