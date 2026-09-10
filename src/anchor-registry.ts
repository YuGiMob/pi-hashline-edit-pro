import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sessionClaimsDir } from "./paths";
import { contentChecksum } from "./hashline/hasher";
import { ANCHOR_COUNT, anchorAt } from "./hashline/alphabet";
import { HASH_PROBE_STRIDE } from "./hashline/hash";
import { errCode, splitLines } from "./utils";
import { hashSource } from "./hashline";
import * as Diff from "diff";
import { getAllocatedState, persistSnapshot, type HashStore } from "./hash-store";
import { ANCHOR_POOL_EXHAUSTED_PREFIX } from "./constants";

export type RegistryEvent =
  | { kind: "session"; sessionFile: string }
  | { kind: "allocate"; path: string; rows: [string, string][] }
  | { kind: "free"; path: string; anchors?: string[] }
  | { kind: "minted"; anchors: string[] }
  | { kind: "clear" };

export interface OwnedAnchor {
  path: string;
  checksum: string;
}

interface SessionState {
	owned: Map<string, OwnedAnchor>;
	served: Map<string, Map<string, string>>;
	everMinted: Set<string>;
	probe: number;
}

const SIDECAR_SUFFIX = ".registry.jsonl";
const SIDECAR_COMPACT_LINES = 5000;
const SIDECAR_COMPACT_BYTES = 1024 * 1024;
const SIDECAR_COMPACT_CHUNK = 5000;
let currentKey: string | undefined;
let currentSidecar: string | undefined;
const registries = new Map<string, SessionState>();

function newSessionState(seed?: string): SessionState {
	let probe = 0;
	if (seed) {
		for (const byte of createHash("sha256").update(seed).digest()) {
			probe = (probe * 256 + byte) % ANCHOR_COUNT;
		}
	}
	return { owned: new Map(), served: new Map(), everMinted: new Set(), probe };
}

function seedServedFromOwned(state: SessionState): void {
	for (const [anchor, entry] of state.owned) {
		let served = state.served.get(entry.path);
		if (!served) {
			served = new Map();
			state.served.set(entry.path, served);
		}
		served.set(anchor, entry.checksum);
	}
}

export function foldRegistryEvents(events: RegistryEvent[]): SessionState {
  const state = newSessionState();
  for (const event of events) {
    if (event.kind === "clear") {
      state.owned.clear();
    } else if (event.kind === "minted") {
      for (const anchor of event.anchors) state.everMinted.add(anchor);
    } else if (event.kind === "allocate") {
      for (const [anchor, checksum] of event.rows) {
        state.owned.set(anchor, { path: event.path, checksum });
        state.everMinted.add(anchor);
      }
    } else if (event.kind === "free") {
      if (event.anchors) {
        for (const anchor of event.anchors) {
          state.owned.delete(anchor);
        }
      } else {
        for (const [anchor, entry] of [...state.owned]) {
          if (entry.path === event.path) {
            state.owned.delete(anchor);
          }
        }
      }
    }
  }
  return state;
}

export function parseRegistryLog(raw: string): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RegistryEvent;
      if (parsed && (parsed.kind === "allocate" || parsed.kind === "free" || parsed.kind === "clear" || parsed.kind === "session" || parsed.kind === "minted")) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}

function sidecarPath(key: string): string {
  return join(sessionClaimsDir(), `${key}${SIDECAR_SUFFIX}`);
}

function sidecarKeyFor(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}
export function shouldCompactSidecar(raw: string): boolean {
  if (raw.length >= SIDECAR_COMPACT_BYTES) return true;
  let lines = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines += 1;
  return lines >= SIDECAR_COMPACT_LINES;
}
export function buildCompactedLog(sessionFile: string, state: SessionState): string {
  const byPath = new Map<string, Array<[string, string]>>();
  for (const [anchor, entry] of state.owned) {
    const rows = byPath.get(entry.path) ?? [];
    rows.push([anchor, entry.checksum]);
    byPath.set(entry.path, rows);
  }
  const out: string[] = [JSON.stringify({ kind: "session", sessionFile })];
  for (const [path, rows] of byPath) {
    for (let i = 0; i < rows.length; i += SIDECAR_COMPACT_CHUNK) {
      out.push(JSON.stringify({ kind: "allocate", path, rows: rows.slice(i, i + SIDECAR_COMPACT_CHUNK) }));
    }
  }
  const freedHistory = [...state.everMinted].filter((anchor) => !state.owned.has(anchor));
  for (let i = 0; i < freedHistory.length; i += SIDECAR_COMPACT_CHUNK) {
    out.push(JSON.stringify({ kind: "minted", anchors: freedHistory.slice(i, i + SIDECAR_COMPACT_CHUNK) }));
  }
  return out.join("\n") + "\n";
}
async function compactSidecarIfNeeded(sidecar: string, raw: string, sessionFile: string, state: SessionState): Promise<void> {
  if (!shouldCompactSidecar(raw)) return;
  const tmp = `${sidecar}.compact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const compacted = buildCompactedLog(sessionFile, state);
    await writeFile(tmp, compacted, { mode: 0o600 });
    if (process.platform !== "win32") {
      try { await chmod(tmp, 0o600); } catch { }
    }
    await rename(tmp, sidecar);
  } catch (error) {
    console.error("Failed to compact anchor registry sidecar:", error);
    try { await rm(tmp, { force: true }); } catch { }
  }
}

export async function initRegistry(sessionFile: string | undefined): Promise<void> {
  if (!sessionFile) {
    currentKey = `__ephemeral__-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentSidecar = undefined;
    registries.set(currentKey, newSessionState());
    return;
  }
  const key = sidecarKeyFor(sessionFile);
  currentKey = key;
  currentSidecar = sidecarPath(key);
  let events: RegistryEvent[] = [];
  let rawLog = "";
  try {
    rawLog = await readFile(currentSidecar, "utf-8");
    events = parseRegistryLog(rawLog);
  } catch (error) {
    if (errCode(error) !== "ENOENT") {
      console.error("Failed to read anchor registry sidecar:", error);
    }
  }
  const folded = foldRegistryEvents(events);
  seedServedFromOwned(folded);
  registries.set(key, folded);
  if (rawLog.length > 0) {
    await compactSidecarIfNeeded(currentSidecar, rawLog, sessionFile, folded);
  }
  try {
    await mkdir(sessionClaimsDir(), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { await chmod(sessionClaimsDir(), 0o700); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry directory:", error); }
      try { await chmod(currentSidecar, 0o600); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry sidecar:", error); }
    }
    appendEvent({ kind: "session", sessionFile } satisfies RegistryEvent);
  } catch (error) {
    console.error("Failed to initialize anchor registry sidecar:", error);
  }
}

function current(): SessionState | undefined {
  if (!currentKey) return undefined;
  return registries.get(currentKey);
}

function appendEvent(event: RegistryEvent): void {
  if (!currentSidecar) return;
  try {
    appendFileSync(currentSidecar, JSON.stringify(event) + "\n", "utf-8");
    if (process.platform !== "win32") {
      try { chmodSync(currentSidecar, 0o600); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry sidecar:", error); }
    }
  } catch (error) {
    console.error("Failed to append registry event:", error);
  }
}

function fingerprintIndex(state: SessionState, path: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [anchor, entry] of state.owned) {
    if (entry.path !== path) continue;
    const list = index.get(entry.checksum) ?? [];
    list.push(anchor);
    index.set(entry.checksum, list);
  }
  return index;
}

export const MINT_PROBE_LIMIT = 8192;

export function mintAnchor(state: SessionState): string {
  for (let probe = 0; probe < MINT_PROBE_LIMIT; probe++) {
    state.probe = (state.probe + HASH_PROBE_STRIDE) % ANCHOR_COUNT;
    const candidate = anchorAt(state.probe);
    if (!state.owned.has(candidate) && !state.everMinted.has(candidate)) {
      return candidate;
    }
  }
  for (let step = 1; step <= ANCHOR_COUNT; step++) {
    const candidate = anchorAt((state.probe + step) % ANCHOR_COUNT);
    if (!state.owned.has(candidate)) {
      for (const served of state.served.values()) served.delete(candidate);
      return candidate;
    }
  }
  throw new Error(
    `${ANCHOR_POOL_EXHAUSTED_PREFIX}; use write for very large files.`,
  );
}

export function allocateAnchor(path: string, checksum: string): string {
  const state = current();
  if (!state) {
    throw new Error("[E_REGISTRY] The anchor registry is not initialized; call initRegistry on session_start first.");
  }
  const anchor = mintAnchor(state);
  state.everMinted.add(anchor);
  state.owned.set(anchor, { path, checksum });
  appendEvent({ kind: "allocate", path, rows: [[anchor, checksum]] });
  return anchor;
}



export function freeAnchors(path: string, anchors?: string[]): void {
	const state = current();
	if (!state) return;
	const freed: string[] = [];
	if (anchors) {
		for (const anchor of anchors) {
			if (state.owned.has(anchor)) {
				freed.push(anchor);
				state.owned.delete(anchor);
				state.served.get(path)?.delete(anchor);
			}
		}
	} else {
		for (const [anchor, entry] of [...state.owned]) {
			if (entry.path === path) {
				freed.push(anchor);
				state.owned.delete(anchor);
			}
		}
		state.served.delete(path);
	}
	if (freed.length > 0) {
		appendEvent({ kind: "free", path, anchors: anchors ?? undefined });
	}
}

export function clearRegistry(): void {
	const state = current();
	if (!state) return;
	state.owned.clear();
	state.served.clear();
	appendEvent({ kind: "clear" });
}

export function servedForPath(path: string): Map<string, string> | undefined {
	return current()?.served.get(path);
}

export function markServed(
	path: string,
	entries: Array<[string, string]>,
	scope?: ReadonlySet<string>,
): void {
	const state = current();
	if (!state) return;
	if (!state.served.has(path) && entries.length === 0 && !scope) return;
	let served = state.served.get(path);
	if (!served) {
		served = new Map();
		state.served.set(path, served);
	}
	if (scope) {
		for (const anchor of [...served.keys()]) {
			if (!scope.has(anchor)) served.delete(anchor);
		}
	}
	for (const [anchor, checksum] of entries) {
		served.set(anchor, checksum);
	}
}

export function ownerOf(anchor: string): OwnedAnchor | undefined {
  return current()?.owned.get(anchor);
}

export function ownersForPath(path: string): Map<string, string> {
  const claims = new Map<string, string>();
  const state = current();
  if (!state) return claims;
  for (const [anchor, entry] of state.owned) {
    if (entry.path === path) claims.set(anchor, entry.checksum);
  }
  return claims;
}

export function ensureRegistry(): void {
  if (currentKey && registries.has(currentKey)) return;
  initRegistry(undefined).catch(() => undefined);
}

function cloneState(state: SessionState): SessionState {
	return {
		owned: new Map(state.owned),
		served: new Map([...state.served].map(([path, served]) => [path, new Map(served)])),
		everMinted: new Set(state.everMinted),
		probe: state.probe,
	};
}

export interface Aligned {
  anchors: string[];
  freed: string[];
  minted: string[];
}

interface MintedAt {
  index: number;
  anchor: string;
  checksum: string;
}

function computeParts(
  prevChecksums: string[] | undefined,
  newChecksums: string[],
): Diff.ArrayChange<string>[] {
  if (!prevChecksums) {
    return [{ count: newChecksums.length, added: true, removed: false, value: [] } as unknown as Diff.ArrayChange<string>];
  }
  const min = Math.min(prevChecksums.length, newChecksums.length);
  let prefix = 0;
  while (prefix < min && prevChecksums[prefix] === newChecksums[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < min - prefix &&
    prevChecksums[prevChecksums.length - 1 - suffix] === newChecksums[newChecksums.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix + suffix >= min && prevChecksums.length === newChecksums.length) {
    return [{ count: newChecksums.length, value: [], added: false, removed: false } as unknown as unknown as Diff.ArrayChange<string>];
  }
  const prevMid = prevChecksums.slice(prefix, prevChecksums.length - suffix);
  const newMid = newChecksums.slice(prefix, newChecksums.length - suffix);
  if (prevMid.length === 0) {
    return [
      { count: prefix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
      { count: newMid.length, added: true, removed: false, value: [] } as unknown as Diff.ArrayChange<string>,
      { count: suffix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
    ];
  }
  if (newMid.length === 0) {
    return [
      { count: prefix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
      { count: prevMid.length, removed: true, added: false, value: [] } as unknown as Diff.ArrayChange<string>,
      { count: suffix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
    ];
  }
  if (prevMid.length * newMid.length > 4_000_000) {
    return [
      { count: prefix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
      { count: prevMid.length, removed: true, added: false, value: [] } as unknown as Diff.ArrayChange<string>,
      { count: newMid.length, added: true, removed: false, value: [] } as unknown as Diff.ArrayChange<string>,
      { count: suffix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>,
    ];
  }
  const midParts = Diff.diffArrays(prevMid, newMid) as unknown as Diff.ArrayChange<string>[];
  const parts: Diff.ArrayChange<string>[] = [];
  if (prefix > 0) parts.push({ count: prefix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>);
  parts.push(...midParts);
  if (suffix > 0) parts.push({ count: suffix, value: [], added: false, removed: false } as unknown as Diff.ArrayChange<string>);
  return parts;
}

export function alignOwnershipWithSpans(
  path: string,
  prevAnchors: string[],
  prevChecksums: string[],
  newChecksums: string[],
  spans: { start: number; end: number; replacementCount: number }[],
  options?: { shadow?: boolean },
): Aligned {
  const state = options?.shadow ? cloneState(current()!) : current()!;
  const freed: { anchor: string; checksum: string }[] = [];
  const minted: MintedAt[] = [];
  const log = (event: RegistryEvent): void => {
    if (!options?.shadow) appendEvent(event);
  };

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const anchors = [...prevAnchors];
  let offset = 0;
  for (const span of sorted) {
    const prevStart = span.start;
    const start = span.start + offset;
    const end = span.end + offset;
    const spanLength = end - start + 1;
    const spanFreed: { anchor: string; checksum: string }[] = [];
    for (let i = start; i <= end; i++) {
      const anchor = anchors[i]!;
      if (state.owned.has(anchor)) {
        state.owned.delete(anchor);
        const checksum = prevChecksums[i - offset] ?? "";
        spanFreed.push({ anchor, checksum });
        freed.push(spanFreed[spanFreed.length - 1]!);
      }
    }
    const replacement: (string | undefined)[] = new Array(span.replacementCount);
    for (let k = 0; k < span.replacementCount; k++) {
      const positional = k < spanLength ? prevAnchors[prevStart + k] : undefined;
      if (
        positional !== undefined &&
        prevChecksums[prevStart + k] === newChecksums[start + k] &&
        (!state.owned.has(positional) || state.owned.get(positional)!.path === path)
      ) {
        replacement[k] = positional;
        const freedAt = freed.findIndex((candidate) => candidate.anchor === positional);
        if (freedAt >= 0) freed.splice(freedAt, 1);
        const pooledAt = spanFreed.findIndex((candidate) => candidate.anchor === positional);
        if (pooledAt >= 0) spanFreed.splice(pooledAt, 1);
      }
    }
    for (let k = 0; k < span.replacementCount; k++) {
      if (replacement[k] !== undefined) continue;
      const anchor = mintAnchor(state);
      const checksum = newChecksums[start + k]!;
      minted.push({ index: start + k, anchor, checksum });
      state.owned.set(anchor, { path, checksum });
      replacement[k] = anchor;
    }
    const settled = replacement as string[];
    for (let k = 0; k < span.replacementCount; k++) {
      state.everMinted.add(settled[k]!);
      state.owned.set(settled[k]!, { path, checksum: newChecksums[start + k]! });
    }
    anchors.splice(start, spanLength, ...settled);
    offset += span.replacementCount - spanLength;
  }
  const rows: [string, string][] = minted.map((m) => [m.anchor, m.checksum]);
  if (rows.length > 0) log({ kind: "allocate", path, rows });
  if (freed.length > 0) log({ kind: "free", path, anchors: freed.map((f) => f.anchor) });
  return { anchors, freed: freed.map((f) => f.anchor), minted: minted.map((m) => m.anchor) };
}

export function alignOwnership(
  path: string,
  prevAnchors: string[] | undefined,
  prevChecksums: string[] | undefined,
  newChecksums: string[],
  options?: { shadow?: boolean },
): Aligned {
  const state = options?.shadow ? cloneState(current()!) : current()!;
  const anchors: string[] = new Array(newChecksums.length);
  const freed: { anchor: string; checksum: string }[] = [];
  const minted: MintedAt[] = [];
  const log = (event: RegistryEvent): void => {
    if (!options?.shadow) appendEvent(event);
  };
  if (prevAnchors) {
    for (const anchor of prevAnchors) state.everMinted.add(anchor);
  }

  const parts: Diff.ArrayChange<string>[] = computeParts(prevChecksums, newChecksums);
  let prevIdx = 0;
  let newIdx = 0;
  for (const part of parts) {
    const count = part.count ?? 0;
    if (part.added) {
      for (let k = 0; k < count; k++) {
        const checksum = newChecksums[newIdx + k]!;
        const anchor = mintAnchor(state);
        state.everMinted.add(anchor);
        state.owned.set(anchor, { path, checksum });
        minted.push({ index: newIdx + k, anchor, checksum });
        anchors[newIdx + k] = anchor;
      }
      newIdx += count;
    } else if (part.removed) {
      for (let k = 0; k < count; k++) {
        const anchor = prevAnchors![prevIdx + k]!;
        const entry = state.owned.get(anchor);
        if (entry && entry.path === path) {
          state.owned.delete(anchor);
          freed.push({ anchor, checksum: prevChecksums![prevIdx + k]! });
        }
      }
      prevIdx += count;
    } else {
      for (let k = 0; k < count; k++) {
        const anchor = prevAnchors![prevIdx + k]!;
        const entry = state.owned.get(anchor);
        const checksum = newChecksums[newIdx + k]!;
        if (entry && entry.path !== path) {
          const fresh = mintAnchor(state);
          state.owned.set(fresh, { path, checksum });
          anchors[newIdx + k] = fresh;
        } else {
          state.owned.set(anchor, { path, checksum });
          anchors[newIdx + k] = anchor;
        }
      }
      newIdx += count;
      prevIdx += count;
    }
  }

  const rows: [string, string][] = [];
  for (let i = 0; i < anchors.length; i++) {
    rows.push([anchors[i]!, newChecksums[i]!]);
  }
  if (minted.length > 0) log({ kind: "allocate", path, rows: rows.filter(([anchor]) => minted.some((m) => m.anchor === anchor)) });
  if (freed.length > 0) log({ kind: "free", path, anchors: freed.map((f) => f.anchor) });
  return { anchors, freed: freed.map((f) => f.anchor), minted: minted.map((m) => m.anchor) };
}

export async function allocateFileAnchors(
  store: HashStore,
  path: string,
  content: string,
  options?: {
    persist?: boolean;
    shadow?: boolean;
    previous?: { content: string; hashes: string[]; spans?: { start: number; end: number; replacementCount: number }[] };
  },
): Promise<string[]> {
  ensureRegistry();
  const shadow = options?.shadow === true;
  const lines = splitLines(content);
  const checksums = lines.map((line) => contentChecksum(hashSource(line)));
  if (options?.previous?.spans) {
    const prevChecksums = splitLines(options.previous.content).map((line) => contentChecksum(hashSource(line)));
    const aligned = alignOwnershipWithSpans(path, options.previous.hashes, prevChecksums, checksums, options.previous.spans, { shadow });
    if (!shadow && options.persist !== false) {
      persistSnapshot(store, path, content, aligned.anchors, checksums);
    }
    return aligned.anchors;
  }
  let prevAnchors: string[] | undefined;
  let prevChecksums: string[] | undefined;
  if (options?.previous) {
    prevAnchors = options.previous.hashes;
    prevChecksums = splitLines(options.previous.content).map((line) => contentChecksum(hashSource(line)));
  } else {
    const previousState = getAllocatedState(store, path, !shadow);
    if (previousState) {
      prevAnchors = previousState.anchors;
      prevChecksums = previousState.checksums;
      if (!prevChecksums && previousState.contentChecksum === contentChecksum(content)) {
        prevChecksums = checksums;
      }
    }
  }
  const aligned: Aligned = prevAnchors
    ? alignOwnership(path, prevAnchors, prevChecksums, checksums, { shadow })
    : (() => {
        const state = shadow ? cloneState(current()!) : current()!;
        const reuseIndex = fingerprintIndex(state, path);
        const reuseTaken = new Map<string, number>();
        const anchors: string[] = checksums.map((checksum) => {
          const candidates = reuseIndex.get(checksum) ?? [];
          const taken = reuseTaken.get(checksum) ?? 0;
          reuseTaken.set(checksum, taken + 1);
          const anchor = taken < candidates.length ? candidates[taken]! : mintAnchor(state);
          state.everMinted.add(anchor);
          state.owned.set(anchor, { path, checksum });
          return anchor;
        });
        if (!shadow) {
          appendEvent({ kind: "allocate", path, rows: anchors.map((a, i) => [a, checksums[i]!]) });
        }
        return { anchors, freed: [], minted: anchors };
      })();
  if (!shadow && options?.persist !== false) {
    persistSnapshot(store, path, content, aligned.anchors, checksums);
  }
  return aligned.anchors;
}

export function adoptAnchors(path: string, entries: Map<string, string>): void {
	ensureRegistry();
	const state = current()!;
	let served = state.served.get(path);
	if (!served) {
		served = new Map();
		state.served.set(path, served);
	}
	for (const [anchor, checksum] of entries) {
		state.owned.set(anchor, { path, checksum });
		served.set(anchor, checksum);
	}
	if (entries.size > 0) {
		appendEvent({ kind: "allocate", path, rows: [...entries] });
	}
}

export function resetRegistryForTests(): void {
  currentKey = undefined;
  currentSidecar = undefined;
  registries.clear();
}

export async function gcRegistrySidecars(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(sessionClaimsDir());
  } catch (error) {
    if (errCode(error) !== "ENOENT") console.error("Failed to list registry sidecars:", error);
    return;
  }
  for (const name of names) {
    if (name.includes(`${SIDECAR_SUFFIX}.compact-`)) {
      const tmpPath = join(sessionClaimsDir(), name);
      try {
        const tmpStat = await stat(tmpPath);
        if (Date.now() - tmpStat.mtimeMs > 60 * 60 * 1000) await rm(tmpPath, { force: true });
      } catch (error) {
        if (errCode(error) !== "ENOENT") console.error("Failed to inspect registry sidecar:", error);
      }
      continue;
    }
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const sidecar = join(sessionClaimsDir(), name);
    try {
      const raw = await readFile(sidecar, "utf-8");
      const header = JSON.parse(raw.split("\n")[0] ?? "{}") as { kind?: string; sessionFile?: string };
      if (header.kind !== "session" || !header.sessionFile) continue;
      await stat(header.sessionFile);
    } catch (error) {
      if (errCode(error) === "ENOENT") {
        await rm(sidecar, { force: true });
      } else {
        console.error("Failed to inspect registry sidecar:", error);
      }
    }
  }
}