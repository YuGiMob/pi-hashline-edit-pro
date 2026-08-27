import { splitLines, truncateToBytes } from "../utils";
import { MAX_HASH_SOURCE_BYTES } from "../constants";
import {
  loadHashStore,
  type HashStore,
  getSnapshot,
  upsertSnapshot,
} from "../hash-store";
import { xxh32, contentChecksum, initHasher } from "./hasher";
import { HASH_LEN, ALPH, ALPH_RE, HASH_CLASS, HASH_RUN } from "./alphabet";
export { initHasher, HASH_LEN, ALPH_RE, HASH_CLASS, HASH_RUN };

export const ANCHOR_LEN = HASH_LEN;

export const HASH_SEP = "│";

export const HASH_SPACE = ALPH.length ** HASH_LEN;
export const MAX_HASH_LINES = HASH_SPACE;

export const HASH_PROBE_STRIDE = ALPH.length ** 2 + ALPH.length + 1;

function idxToHash(idx: number): string {
  let out = "";
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPH[idx % ALPH.length]! + out;
    idx = Math.floor(idx / ALPH.length);
  }
  return out;
}

const hashCache = new Map<number, string>();

function hashAt(idx: number): string {
  let hash = hashCache.get(idx);
  if (hash === undefined) {
    hash = idxToHash(idx);
    hashCache.set(idx, hash);
  }
  return hash;
}

export const HL_PREFIX_PLUS_RE = new RegExp(
	`^\\+${HASH_RUN}│`,
);
export const HL_PREFIX_MINUS_RE = new RegExp(
	`^-(?:${HASH_RUN}│| {${ANCHOR_LEN}}│)`,
);

export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_RUN})│`);

export type RowPrefixKind = "bare" | "plus" | "minus";

export type StrippedRow = {
	text: string;
	kind: RowPrefixKind | null;
	hash: string | undefined;
};

export function stripRowPrefix(line: string): StrippedRow {
	const bare = line.match(HL_BARE_PREFIX_RE);
	if (bare) {
		return { text: line.slice(bare[0].length), kind: "bare", hash: bare[1] };
	}
	const plus = line.match(HL_PREFIX_PLUS_RE);
	if (plus) {
		return { text: line.slice(plus[0].length), kind: "plus", hash: plus[1] };
	}
	const minus = line.match(HL_PREFIX_MINUS_RE);
	if (minus) {
		return { text: line.slice(minus[0].length), kind: "minus", hash: minus[1] };
	}
	return { text: line, kind: null, hash: undefined };
}

export function canon(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

export function hashSource(line: string): string {
	return truncateToBytes(canon(line), MAX_HASH_SOURCE_BYTES);
}

const BITSET_WORDS = Math.ceil(HASH_SPACE / 32);

function getBit(bits: Uint32Array, idx: number): boolean {
  return (bits[idx >>> 5] >>> (idx & 31) & 1) !== 0;
}

function setBit(bits: Uint32Array, idx: number): void {
  bits[idx >>> 5] |= 1 << (idx & 31);
}

function nextZeroBit(bits: Uint32Array, start: number): number {
  const totalBits = HASH_SPACE;
  let idx = start % totalBits;
  for (let i = 0; i < totalBits; i++) {
    if (!getBit(bits, idx)) return idx;
    idx += HASH_PROBE_STRIDE;
    if (idx >= totalBits) idx -= totalBits;
  }
  throw new Error(
    `[E_FILE_TOO_LARGE] File exceeds the ${HASH_SPACE}-line hashline limit; use write for very large files.`,
  );
}

function assignHash(used: Uint32Array, baseIdx: number, hint: { value: number }): string {
  if (!getBit(used, baseIdx)) {
    setBit(used, baseIdx);
    hint.value = baseIdx + HASH_PROBE_STRIDE;
    return hashAt(baseIdx);
  }
  const nextIdx = nextZeroBit(used, hint.value);
  setBit(used, nextIdx);
  hint.value = nextIdx + HASH_PROBE_STRIDE;
  return hashAt(nextIdx);
}

export function _lineHashesPure(content: string): string[] {
  const lines = splitLines(content);
  const hashes = new Array<string>(lines.length);
  const used = new Uint32Array(BITSET_WORDS);
  const hint = { value: 0 };

  for (let i = 0; i < lines.length; i++) {
    const c = hashSource(lines[i]!);
    const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
    hashes[i] = assignHash(used, baseIdx, hint);
  }
  return hashes;
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  store?: HashStore,
  persist?: boolean,
): Promise<string[]> {
  await initHasher();
  if (!path) {
    return _lineHashesPure(content);
  }

  const hashStore = store ?? await loadHashStore();

  if (previous) {
    const newHashes = mapStableHashes(
      previous.content, previous.hashes,
      content,
      previous.removedHashes,
    );
    if (persist !== false) {
      try {
        upsertSnapshot(hashStore, path, contentChecksum(content), splitLines(content).length, newHashes);
      } catch (error) {
        console.error("Failed to persist hash snapshot:", error);
      }
    }
    return newHashes;
  }

  let cached: string[] | undefined;
  try {
    cached = getSnapshot(hashStore, path, content, persist !== false);
  } catch (error) {
    console.error("Failed to read hash store snapshot:", error);
  }
  if (cached) {
    return cached;
  }

  const newHashes = _lineHashesPure(content);
  if (persist !== false) {
    try {
      upsertSnapshot(hashStore, path, contentChecksum(content), splitLines(content).length, newHashes);
    } catch (error) {
      console.error("Failed to persist hash snapshot:", error);
    }
  }
  return newHashes;
}

function hashToIndex(hash: string): number {
  let idx = 0;
  for (let j = 0; j < HASH_LEN; j++) {
    const charIdx = ALPH.indexOf(hash[j]!);
    if (charIdx < 0) return -1;
    idx = idx * ALPH.length + charIdx;
  }
  return idx;
}

function nearestNew(
  candidates: number[],
  target: number,
): number {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const left = lo - 1;
  const right = lo;
  if (
    left >= 0 &&
    (right >= candidates.length ||
      target - candidates[left]! <= candidates[right]! - target)
  ) {
    return left;
  }
  return right < candidates.length ? right : -1;
}

function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
): string[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const newHashes = new Array<string>(newLines.length);
  const used = new Uint32Array(BITSET_WORDS);
  const hint = { value: 0 };
  const removed = removedHashes ?? new Set<string>();

  const oldHashIndex = new Map<string, number>();
  for (let i = 0; i < oldHashes.length; i++) {
    const hash = oldHashes[i]!;
    oldHashIndex.set(hash, i);
    const idx = hashToIndex(hash);
    if (idx >= 0) setBit(used, idx);
  }

  const removedIndexes = new Set<number>();
  for (const hash of removed) {
    const idx = oldHashIndex.get(hash);
    if (idx !== undefined) removedIndexes.add(idx);
  }

  let spanStart = oldLines.length;
  let spanEnd = -1;
  for (const idx of removedIndexes) {
    if (idx < spanStart) spanStart = idx;
    if (idx > spanEnd) spanEnd = idx;
  }
  const spanLen = spanEnd >= spanStart ? spanEnd - spanStart + 1 : 0;
  const replacementLen = newLines.length - oldLines.length + spanLen;
  const shiftAfterSpan = spanEnd >= spanStart ? replacementLen - spanLen : 0;

  const survivors: { index: number; hash: string }[] = [];
  const removedEntries: { index: number; hash: string }[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    const entry = { index: i, hash: oldHashes[i]! };
    if (removedIndexes.has(i)) removedEntries.push(entry);
    else survivors.push(entry);
  }

  const newByContent = new Map<string, number[]>();
  for (let i = 0; i < newLines.length; i++) {
    const key = hashSource(newLines[i]!);
    const list = newByContent.get(key);
    if (list) list.push(i);
    else newByContent.set(key, [i]);
  }

  const markUsed = (hash: string): void => {
    const idx = hashToIndex(hash);
    if (idx >= 0) {
      setBit(used, idx);
      if (idx + HASH_PROBE_STRIDE > hint.value) hint.value = idx + HASH_PROBE_STRIDE;
    }
  };

  for (const entry of survivors) {
    const candidates = newByContent.get(hashSource(oldLines[entry.index]!));
    if (!candidates || candidates.length === 0) continue;
    const target = entry.index > spanEnd ? entry.index + shiftAfterSpan : entry.index;
    const pos = nearestNew(candidates, target);
    if (pos < 0) continue;
    const newIdx = candidates.splice(pos, 1)[0]!;
    newHashes[newIdx] = entry.hash;
    markUsed(entry.hash);
  }

  const removedByContent = new Map<string, { hashes: string[]; pos: number }>();
  for (const entry of removedEntries) {
    const key = oldLines[entry.index]!;
    let queue = removedByContent.get(key);
    if (!queue) {
      queue = { hashes: [], pos: 0 };
      removedByContent.set(key, queue);
    }
    queue.hashes.push(entry.hash);
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue;
    const queue = removedByContent.get(newLines[i]!);
    if (!queue || queue.pos >= queue.hashes.length) continue;
    newHashes[i] = queue.hashes[queue.pos]!;
    queue.pos += 1;
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue;
    const c = hashSource(newLines[i]!);
    const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
    newHashes[i] = assignHash(used, baseIdx, hint);
  }

  return newHashes;
}
