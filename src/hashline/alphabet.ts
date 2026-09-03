import anchorData from "./anchor-table.json";

const TABLE: string = anchorData.anchors;

export const HASH_LEN = 4;

export const ANCHOR_COUNT = TABLE.length / HASH_LEN;

const ALNUM = "A-Za-z0-9";

export const ALPH_RE = new RegExp(`^[${ALNUM}]+$`);

export const HASH_CLASS = `[${ALNUM}]{${HASH_LEN}}`;

export const HASH_RUN = `[${ALNUM}]{1,${HASH_LEN * 2}}`;

export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);

let indexByAnchor: Map<string, number> | undefined;

function reverseIndex(): Map<string, number> {
  if (!indexByAnchor) {
    indexByAnchor = new Map();
    for (let i = 0; i < ANCHOR_COUNT; i++) {
      indexByAnchor.set(TABLE.slice(i * HASH_LEN, i * HASH_LEN + HASH_LEN), i);
    }
  }
  return indexByAnchor;
}

export function anchorAt(idx: number): string {
  return TABLE.slice(idx * HASH_LEN, idx * HASH_LEN + HASH_LEN);
}

export function anchorIndex(hash: string): number {
  return reverseIndex().get(hash) ?? -1;
}
