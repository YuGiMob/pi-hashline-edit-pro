import { splitLines, truncateToBytes, getCached } from "../utils";
import { MAX_HASH_SOURCE_BYTES } from "../constants";
import { loadHashStore, type HashStore } from "../hash-store";
import { allocateFileAnchors } from "../anchor-registry";
import { xxh32, initHasher } from "./hasher";
import { HASH_LEN, ANCHOR_COUNT, anchorAt, HASH_CLASS, HASH_RUN } from "./alphabet";
export { initHasher, HASH_LEN, HASH_CLASS, HASH_RUN };

export const ANCHOR_LEN = HASH_LEN;

export const HASH_SEP = "│";

export const HASH_SPACE = ANCHOR_COUNT;
export const MAX_HASH_LINES = HASH_SPACE;

export const HASH_PROBE_STRIDE = 836286;


function hashAt(idx: number): string {
  return anchorAt(idx);
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
  const hashSourceCache = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const c = getCached(hashSourceCache, lines[i]!, hashSource);
    const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
    hashes[i] = assignHash(used, baseIdx, hint);
  }
  return hashes;
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; spans?: { start: number; end: number; replacementCount: number }[] },
  store?: HashStore,
  persist?: boolean,
  shadow?: boolean,
): Promise<string[]> {
  await initHasher();
  if (!path) {
    return _lineHashesPure(content);
  }
  return allocateFileAnchors(store ?? (await loadHashStore()), path, content, {
    persist,
    shadow,
    previous,
  });
}

