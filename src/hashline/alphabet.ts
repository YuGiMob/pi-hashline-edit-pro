import anchorData from "./anchor-table.json";
const rawAnchors: unknown = (anchorData as { anchors?: unknown }).anchors;
const rawVersion: unknown = (anchorData as { version?: unknown }).version;
if (typeof rawAnchors !== "string" || rawAnchors.length === 0 || rawAnchors.length % 4 !== 0) {
  throw new Error("[E_REGISTRY] Anchor table is missing or corrupt; reinstall pi-hashline-edit-pro.");
}
const TABLE: string = rawAnchors;
export const ANCHOR_TABLE_VERSION: number = typeof rawVersion === "number" && Number.isInteger(rawVersion) ? rawVersion : 0;
export function isCompatibleTableVersion(stored: unknown, current: number = ANCHOR_TABLE_VERSION): boolean {
  if (stored === undefined) stored = 0;
  if (current === 1 && (stored === 0 || stored === 1)) return true;
  return stored === current;
}
export const HASH_LEN = 4;
export const ANCHOR_COUNT = TABLE.length / HASH_LEN;
const ALNUM = "A-Za-z0-9";

export const ALPH_RE = new RegExp(`^[${ALNUM}]+$`);

export const HASH_CLASS = `[${ALNUM}]{${HASH_LEN}}`;

export const HASH_RUN = `[${ALNUM}]{${HASH_LEN},${HASH_LEN + 1}}`;

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
