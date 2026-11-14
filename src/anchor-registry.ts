import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { sessionClaimsDir } from "./paths.ts";
import { contentChecksum } from "./hashline/hasher.ts";
import { ANCHOR_COUNT, HASH_RE, anchorAt } from "./hashline/alphabet.ts";
import { HASH_PROBE_STRIDE, MAX_HASH_LINES } from "./hashline/hash.ts";
import { assertLineCount, errCode, isRec, splitLines, spliceAll } from "./utils.ts";
import * as Diff from "diff";
import { lineChecksum } from "./hashline/index.ts";
import { getAllocatedState, persistSnapshot, type HashStore } from "./hash-store.ts";
import { ANCHOR_POOL_EXHAUSTED_PREFIX, ANCHOR_RECLAIM_WARNING_CODE, MAX_RECLAIMED_PATHS_REPORTED } from "./constants.ts";

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

export interface AnchorSessionContext {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
}

interface OwnedAnchorMap {
  readonly size: number;
  has(anchor: string): boolean;
  get(anchor: string): OwnedAnchor | undefined;
  set(anchor: string, entry: OwnedAnchor): unknown;
  delete(anchor: string): boolean;
  clear(): void;
  keys(): Iterable<string>;
  values(): Iterable<OwnedAnchor>;
  entries(): Iterable<[string, OwnedAnchor]>;
  [Symbol.iterator](): IterableIterator<[string, OwnedAnchor]>;
}

interface AnchorMintedSet {
  readonly size: number;
  has(anchor: string): boolean;
  add(anchor: string): unknown;
  [Symbol.iterator](): IterableIterator<string>;
}

class ShadowOwnedMap implements OwnedAnchorMap {
  private readonly parent: OwnedAnchorMap;
  private readonly overrides = new Map<string, OwnedAnchor | undefined>();

  constructor(parent: OwnedAnchorMap) {
    this.parent = parent;
  }

  has(anchor: string): boolean {
    return this.overrides.has(anchor) ? this.overrides.get(anchor) !== undefined : this.parent.has(anchor);
  }

  get(anchor: string): OwnedAnchor | undefined {
    return this.overrides.has(anchor) ? this.overrides.get(anchor) : this.parent.get(anchor);
  }

  set(anchor: string, entry: OwnedAnchor): this {
    this.overrides.set(anchor, entry);
    return this;
  }

  delete(anchor: string): boolean {
    const owned = this.has(anchor);
    this.overrides.set(anchor, undefined);
    return owned;
  }

  clear(): void {
    for (const anchor of this.parent.keys()) this.overrides.set(anchor, undefined);
    for (const [anchor, entry] of this.overrides) {
      if (entry !== undefined && !this.parent.has(anchor)) this.overrides.delete(anchor);
    }
  }

  get size(): number {
    let count = 0;
    for (const _entry of this) count += 1;
    return count;
  }

  *keys(): IterableIterator<string> {
    for (const [anchor] of this.merged()) yield anchor;
  }

  *values(): IterableIterator<OwnedAnchor> {
    for (const [, entry] of this.merged()) yield entry;
  }

  *entries(): IterableIterator<[string, OwnedAnchor]> {
    yield* this.merged();
  }

  *[Symbol.iterator](): IterableIterator<[string, OwnedAnchor]> {
    yield* this.merged();
  }

  private *merged(): IterableIterator<[string, OwnedAnchor]> {
    for (const [anchor, entry] of this.parent) {
      if (this.overrides.has(anchor)) {
        const override = this.overrides.get(anchor);
        if (override !== undefined) yield [anchor, override];
      } else {
        yield [anchor, entry];
      }
    }
    for (const [anchor, entry] of this.overrides) {
      if (entry !== undefined && !this.parent.has(anchor)) yield [anchor, entry];
    }
  }
}

class ShadowMintedSet implements AnchorMintedSet {
  private readonly parent: AnchorMintedSet;
  private readonly added = new Set<string>();
  private extra = 0;
  private parentSize: number;

  constructor(parent: AnchorMintedSet) {
    this.parent = parent;
    this.parentSize = parent.size;
  }

  has(anchor: string): boolean {
    return this.added.has(anchor) || this.parent.has(anchor);
  }

  add(anchor: string): this {
    if (!this.added.has(anchor) && !this.parent.has(anchor)) this.extra += 1;
    this.added.add(anchor);
    return this;
  }

  get size(): number {
    if (this.parent.size !== this.parentSize) {
      this.parentSize = this.parent.size;
      this.extra = 0;
      for (const anchor of this.added) {
        if (!this.parent.has(anchor)) this.extra += 1;
      }
    }
    return this.parentSize + this.extra;
  }

  *[Symbol.iterator](): IterableIterator<string> {
    yield* this.parent;
    for (const anchor of this.added) {
      if (!this.parent.has(anchor)) yield anchor;
    }
  }
}

interface SessionState {
	owned: OwnedAnchorMap;
	served: Map<string, Map<string, string>>;
	everMinted: AnchorMintedSet;
	probe: number;
	allocatedChecksum: Map<string, string>;
	lastUsedAt: Map<string, number>;
	usageClock: number;
	reclaimed: string[];
	shadow?: boolean;
}

const SIDECAR_SUFFIX = ".registry.jsonl";
const SIDECAR_COMPACT_LINES = 5000;
const SIDECAR_COMPACT_BYTES = 1024 * 1024;
export const SIDECAR_COMPACT_LINE_BYTES = 48 * 1024;
export const SIDECAR_HEADER_BYTES = 64 * 1024;
const SIDECAR_HEADER_CHUNK = 4096;
let currentKey: string | undefined;
const sidecarByKey = new Map<string, string>();
const sessionFileByKey = new Map<string, string>();
const pendingInits = new Map<string, Promise<void>>();
const loadTokens = new Map<string, object>();
const registries = new Map<string, SessionState>();
const sessionScope = new AsyncLocalStorage<string>();

function newSessionState(seed?: string): SessionState {
	let probe = 0;
	if (seed) {
		for (const byte of createHash("sha256").update(seed).digest()) {
			probe = (probe * 256 + byte) % ANCHOR_COUNT;
		}
	}
	return { owned: new Map(), served: new Map(), everMinted: new Set(), probe, allocatedChecksum: new Map(), lastUsedAt: new Map(), usageClock: 0, reclaimed: [] };
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

export function foldRegistryEvents(events: RegistryEvent[], seed?: string): SessionState {
  const state = newSessionState(seed);
  for (const event of events) {
    if (!isRegistryEvent(event)) continue;
    if (event.kind === "clear") {
      state.owned.clear();
      state.lastUsedAt.clear();
    } else if (event.kind === "minted") {
      for (const anchor of event.anchors) state.everMinted.add(anchor);
    } else if (event.kind === "allocate") {
      state.usageClock += 1;
      state.lastUsedAt.set(event.path, state.usageClock);
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
        state.lastUsedAt.delete(event.path);
      }
    }
  }
  const ownedPaths = new Set<string>();
  for (const entry of state.owned.values()) ownedPaths.add(entry.path);
  for (const path of [...state.lastUsedAt.keys()]) {
    if (!ownedPaths.has(path)) state.lastUsedAt.delete(path);
  }
  return state;
}

function isAnchor(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function isAnchorList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isAnchor);
}

function isRegistryEvent(value: unknown): value is RegistryEvent {
  if (!isRec(value) || typeof value.kind !== "string") return false;
  if (value.kind === "session") return typeof value.sessionFile === "string";
  if (value.kind === "clear") return true;
  if (value.kind === "allocate") {
    return typeof value.path === "string"
      && Array.isArray(value.rows)
      && value.rows.every((row) => Array.isArray(row) && row.length === 2 && isAnchor(row[0]) && typeof row[1] === "string");
  }
  if (value.kind === "free") return typeof value.path === "string" && (value.anchors === undefined || isAnchorList(value.anchors));
  if (value.kind === "minted") return isAnchorList(value.anchors);
  return false;
}

export function parseRegistryLog(raw: string): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRegistryEvent(parsed)) events.push(parsed);
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

function parseSessionFileLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const event = JSON.parse(trimmed) as { kind?: unknown; sessionFile?: unknown };
    if (event.kind === "session" && typeof event.sessionFile === "string" && event.sessionFile.length > 0) return event.sessionFile;
  } catch {
  }
  return undefined;
}

function firstLineSessionFile(raw: string): string | undefined {
  const newline = raw.indexOf("\n");
  return parseSessionFileLine(newline >= 0 ? raw.slice(0, newline) : raw);
}

function chunkBySerializedBytes<T>(items: T[], wrap: (chunk: T[]) => unknown, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  if (items.length === 0) return chunks;
  const overhead = Buffer.byteLength(JSON.stringify(wrap([])), "utf-8");
  let chunk: T[] = [];
  let bytes = overhead;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf-8");
    const nextBytes = bytes + itemBytes + (chunk.length > 0 ? 1 : 0);
    if (chunk.length > 0 && nextBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [item];
      bytes = overhead + itemBytes;
    } else {
      chunk.push(item);
      bytes = nextBytes;
    }
  }
  chunks.push(chunk);
  return chunks;
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
    for (const chunk of chunkBySerializedBytes(rows, (part) => ({ kind: "allocate", path, rows: part }), SIDECAR_COMPACT_LINE_BYTES)) {
      out.push(JSON.stringify({ kind: "allocate", path, rows: chunk }));
    }
  }
  const freedHistory = [...state.everMinted].filter((anchor) => !state.owned.has(anchor));
  for (const chunk of chunkBySerializedBytes(freedHistory, (part) => ({ kind: "minted", anchors: part }), SIDECAR_COMPACT_LINE_BYTES)) {
    out.push(JSON.stringify({ kind: "minted", anchors: chunk }));
  }
  return out.join("\n") + "\n";
}
async function compactSidecarIfNeeded(sidecar: string, raw: string, sessionFile: string, state: SessionState, force = false): Promise<void> {
  if (!force && !shouldCompactSidecar(raw)) return;
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

async function loadRegistryState(key: string, sessionFile: string, token: object): Promise<void> {
  const sidecar = sidecarPath(key);
  let events: RegistryEvent[] = [];
  let rawLog = "";
  try {
    rawLog = await readFile(sidecar, "utf-8");
    events = parseRegistryLog(rawLog);
  } catch (error) {
    if (errCode(error) !== "ENOENT") {
      console.error("Failed to read anchor registry sidecar:", error);
    }
  }
  const folded = foldRegistryEvents(events, `${key}:${process.pid}`);
  if (loadTokens.get(key) !== token) return;
  seedServedFromOwned(folded);
  registries.set(key, folded);
  sidecarByKey.set(key, sidecar);
  if (rawLog.length > 0) {
    const loggedEvents = rawLog.split("\n").filter((line) => line.trim().length > 0).length;
    await compactSidecarIfNeeded(sidecar, rawLog, sessionFile, folded, loggedEvents > events.length || firstLineSessionFile(rawLog) !== sessionFile);
  }
  try {
    await mkdir(sessionClaimsDir(), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { await chmod(sessionClaimsDir(), 0o700); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry directory:", error); }
      try { await chmod(sidecar, 0o600); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry sidecar:", error); }
    }
    appendEvent({ kind: "session", sessionFile } satisfies RegistryEvent);
  } catch (error) {
    console.error("Failed to initialize anchor registry sidecar:", error);
  }
}

async function ensureRegistryForKey(key: string, sessionFile: string | undefined): Promise<void> {
  currentKey = key;
  if (registries.has(key)) return;
  const pending = pendingInits.get(key);
  if (pending) {
    await pending;
    return;
  }
  const token: object = {};
  loadTokens.set(key, token);
  const promise = (async () => {
    if (sessionFile === undefined) {
      registries.set(key, newSessionState(key));
      return;
    }
    sessionFileByKey.set(key, sessionFile);
    await loadRegistryState(key, sessionFile, token);
  })();
  pendingInits.set(key, promise);
  try {
    await promise;
  } finally {
    if (pendingInits.get(key) === promise) pendingInits.delete(key);
  }
}

export async function initRegistry(sessionFile: string | undefined): Promise<string> {
  if (sessionFile === undefined) {
    const key = `__ephemeral__-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentKey = key;
    registries.set(key, newSessionState(key));
    return key;
  }
  const key = sidecarKeyFor(sessionFile);
  await ensureRegistryForKey(key, sessionFile);
  return key;
}

export function sessionKeyFor(ctx: AnchorSessionContext | undefined): string | undefined {
  const sessionFile = sessionFileFor(ctx);
  if (sessionFile !== undefined) return sidecarKeyFor(sessionFile);
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId === "string" && sessionId.length > 0) return `ephemeral:${sessionId}`;
  return undefined;
}

function sessionFileFor(ctx: AnchorSessionContext | undefined): string | undefined {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : undefined;
}

export function sessionContextReadable(ctx: AnchorSessionContext | undefined): boolean {
  try {
    void ctx?.sessionManager;
    return true;
  } catch {
    return false;
  }
}

export async function withAnchorSession<T>(ctx: AnchorSessionContext | undefined, fn: () => Promise<T> | T): Promise<T> {
  const key = sessionKeyFor(ctx);
  if (key === undefined) return fn();
  const sessionFile = sessionFileFor(ctx);
  return sessionScope.run(key, async () => {
    await ensureRegistryForKey(key, sessionFile);
    return fn();
  });
}

function activeKey(): string | undefined {
  return sessionScope.getStore() ?? currentKey;
}

function current(): SessionState | undefined {
  const key = activeKey();
  if (!key) return undefined;
  return registries.get(key);
}

function sidecarNeedsSessionRecord(sidecar: string): boolean {
  try {
    return statSync(sidecar).size === 0;
  } catch {
    return true;
  }
}

function ensureSidecarSessionRecord(key: string, sidecar: string): void {
  const sessionFile = sessionFileByKey.get(key);
  if (sessionFile === undefined || !sidecarNeedsSessionRecord(sidecar)) return;
  appendEvent({ kind: "session", sessionFile } satisfies RegistryEvent);
}

function appendEvent(event: RegistryEvent): void {
  const key = activeKey();
  if (!key) return;
  const sidecar = sidecarByKey.get(key);
  if (!sidecar) return;
  try {
    if (event.kind !== "session") ensureSidecarSessionRecord(key, sidecar);
    appendFileSync(sidecar, JSON.stringify(event) + "\n", "utf-8");
    if (process.platform !== "win32") {
      try { chmodSync(sidecar, 0o600); } catch (error) { if (errCode(error) !== "ENOENT") console.error("Failed to secure anchor registry sidecar:", error); }
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
const FRESH_PROBE_CUTOFF = Math.floor(ANCHOR_COUNT / 64);

function touchPath(state: SessionState, path: string): void {
	state.usageClock += 1;
	state.lastUsedAt.set(path, state.usageClock);
}

function hasOwnedPath(state: SessionState, path: string): boolean {
	for (const entry of state.owned.values()) {
		if (entry.path === path) return true;
	}
	return false;
}

function evictPath(state: SessionState, path: string): string[] {
	const anchors: string[] = [];
	for (const [anchor, entry] of state.owned) {
		if (entry.path === path) {
			anchors.push(anchor);
			state.owned.delete(anchor);
		}
	}
	state.served.delete(path);
	state.lastUsedAt.delete(path);
	if (anchors.length > 0 && state === current()) {
		appendEvent({ kind: "free", path, anchors });
	}
	return anchors;
}

export function reclaimAnchorSpace(state: SessionState, protectPath?: string): string | undefined {
	if (state.shadow) return undefined;
	let victim: string | undefined;
	let victimTime = Number.POSITIVE_INFINITY;
	for (const [, entry] of state.owned) {
		if (entry.path === protectPath) continue;
		const time = state.lastUsedAt.get(entry.path) ?? -1;
		if (time < victimTime) {
			victimTime = time;
			victim = entry.path;
		}
	}
	if (victim === undefined) return undefined;
	evictPath(state, victim);
	state.reclaimed.push(victim);
	return victim;
}

export function mintAnchor(state: SessionState, protectPath?: string): string {
  for (;;) {
    if (ANCHOR_COUNT - state.everMinted.size > FRESH_PROBE_CUTOFF) {
      for (let probe = 0; probe < MINT_PROBE_LIMIT; probe++) {
        state.probe = (state.probe + HASH_PROBE_STRIDE) % ANCHOR_COUNT;
        const candidate = anchorAt(state.probe);
        if (!state.owned.has(candidate) && !state.everMinted.has(candidate)) {
          return candidate;
        }
      }
    }
    for (let step = 1; step <= ANCHOR_COUNT; step++) {
      const candidate = anchorAt((state.probe + step) % ANCHOR_COUNT);
      if (!state.owned.has(candidate)) {
        state.probe = (state.probe + step) % ANCHOR_COUNT;
        for (const served of state.served.values()) served.delete(candidate);
        return candidate;
      }
    }
    if (reclaimAnchorSpace(state, protectPath) === undefined) break;
  }
  throw new Error(
    `${ANCHOR_POOL_EXHAUSTED_PREFIX}; use write for very large files.`,
  );
}

export function takeReclaimedPaths(): string[] {
	const state = current();
	if (!state || state.reclaimed.length === 0) return [];
	return state.reclaimed.splice(0, state.reclaimed.length);
}

export function formatAnchorReclaimNotice(paths: string[]): string | undefined {
	const unique = [...new Set(paths)];
	if (unique.length === 0) return undefined;
	const shown = unique.slice(0, MAX_RECLAIMED_PATHS_REPORTED);
	const more = unique.length - shown.length;
	const list = more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ");
	return `${ANCHOR_RECLAIM_WARNING_CODE} The session's anchor quota is nearly exhausted; freed all anchors of ${list}, the files least recently read or edited. Read each freed file again before editing it; for read-heavy work, ask the user to run /clear-anchors or start a new session.`;
}

export function allocateAnchor(path: string, checksum: string): string {
  const state = current();
  if (!state) {
    throw new Error("[E_REGISTRY] The anchor registry is not initialized; call initRegistry on session_start first.");
  }
  const anchor = mintAnchor(state, path);
  state.everMinted.add(anchor);
  state.owned.set(anchor, { path, checksum });
  appendEvent({ kind: "allocate", path, rows: [[anchor, checksum]] });
  return anchor;
}



export function freeAnchors(path: string, anchors?: string[]): void {
	const state = current();
	if (!state) return;
	if (!anchors) {
		evictPath(state, path);
		return;
	}
	const freed: string[] = [];
	for (const anchor of anchors) {
		if (state.owned.has(anchor)) {
			freed.push(anchor);
			state.owned.delete(anchor);
			state.served.get(path)?.delete(anchor);
		}
	}
	if (freed.length > 0) {
		if (!hasOwnedPath(state, path)) state.lastUsedAt.delete(path);
		appendEvent({ kind: "free", path, anchors });
	}
}

export function freeAnchorsForPaths(paths: Iterable<string>): void {
	const state = current();
	if (!state) return;
	const targets = new Set(paths);
	if (targets.size === 0) return;
	const freedByPath = new Map<string, string[]>();
	for (const [anchor, entry] of state.owned) {
		if (!targets.has(entry.path)) continue;
		state.owned.delete(anchor);
		const freed = freedByPath.get(entry.path);
		if (freed === undefined) freedByPath.set(entry.path, [anchor]);
		else freed.push(anchor);
	}
	for (const path of targets) {
		state.served.delete(path);
		state.lastUsedAt.delete(path);
	}
	for (const [path, anchors] of freedByPath) {
		appendEvent({ kind: "free", path, anchors });
	}
}

export function clearRegistry(): void {
	const state = current();
	if (!state) return;
	state.owned.clear();
	state.served.clear();
	state.allocatedChecksum.clear();
	state.lastUsedAt.clear();
	state.reclaimed.length = 0;
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

export function anchorWasMinted(anchor: string): boolean {
  const state = current();
  return state !== undefined && state.everMinted.has(anchor);
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
  const key = activeKey();
  if (key && registries.has(key)) return;
  if (sessionScope.getStore() !== undefined) {
    throw new Error("[E_REGISTRY] The anchor registry for this session is no longer available; the session was replaced or reloaded. Retry the operation in the new session.");
  }
  initRegistry(undefined).catch(() => undefined);
}

export function shadowStateFrom(state: SessionState): SessionState {
	return {
		owned: new ShadowOwnedMap(state.owned),
		served: new Map(),
		everMinted: new ShadowMintedSet(state.everMinted),
		probe: state.probe,
		allocatedChecksum: state.allocatedChecksum,
		lastUsedAt: new Map(state.lastUsedAt),
		usageClock: state.usageClock,
		reclaimed: [],
		shadow: true,
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

type ArrayPart = { count: number; added?: boolean; removed?: boolean };

function computeParts(
  prevChecksums: string[] | undefined,
  newChecksums: string[],
): ArrayPart[] {
  if (!prevChecksums) {
    return [{ count: newChecksums.length, added: true }];
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
    return [{ count: newChecksums.length }];
  }
  const prevMid = prevChecksums.slice(prefix, prevChecksums.length - suffix);
  const newMid = newChecksums.slice(prefix, newChecksums.length - suffix);
  if (prevMid.length === 0) {
    return [{ count: prefix }, { count: newMid.length, added: true }, { count: suffix }];
  }
  if (newMid.length === 0) {
    return [{ count: prefix }, { count: prevMid.length, removed: true }, { count: suffix }];
  }
  if (prevMid.length * newMid.length > 4_000_000) {
    return [{ count: prefix }, { count: prevMid.length, removed: true }, { count: newMid.length, added: true }, { count: suffix }];
  }
  const parts: ArrayPart[] = [];
  if (prefix > 0) parts.push({ count: prefix });
  for (const part of Diff.diffArrays(prevMid, newMid) as unknown as Array<{ count?: number; added?: boolean; removed?: boolean }>) {
    parts.push({ count: part.count ?? 0, added: part.added, removed: part.removed });
  }
  if (suffix > 0) parts.push({ count: suffix });
  return parts;
}

export function alignOwnershipWithSpans(
  path: string,
  prevAnchors: string[],
  prevChecksums: string[],
  newChecksums: string[],
  spans: { start: number; end: number; replacementCount: number; carry?: number }[],
  options?: { shadow?: boolean },
): Aligned {
  const state = options?.shadow ? shadowStateFrom(current()!) : current()!;
  const freed: { anchor: string; checksum: string }[] = [];
  const minted: MintedAt[] = [];
  const reused = new Set<string>();
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
    for (let i = start; i <= end; i++) {
      const anchor = anchors[i]!;
      if (state.owned.has(anchor)) {
        state.owned.delete(anchor);
        const checksum = prevChecksums[i - offset] ?? "";
        freed.push({ anchor, checksum });
      }
    }
    const replacement: (string | undefined)[] = new Array(span.replacementCount);
    const carryIndex =
      span.carry !== undefined && span.carry >= 0 && span.carry < span.replacementCount ? span.carry : undefined;
    const carried = carryIndex === undefined ? undefined : prevAnchors[prevStart];
    if (carryIndex !== undefined && carried !== undefined && prevChecksums[prevStart] === newChecksums[start + carryIndex]) {
      replacement[carryIndex] = carried;
      reused.add(carried);
    } else {
      for (let k = 0; k < span.replacementCount; k++) {
        if (k === carryIndex) continue;
        const positional = k < spanLength ? prevAnchors[prevStart + k] : undefined;
        if (
          positional !== undefined &&
          prevChecksums[prevStart + k] === newChecksums[start + k] &&
          (!state.owned.has(positional) || state.owned.get(positional)!.path === path)
        ) {
          replacement[k] = positional;
          reused.add(positional);
        }
      }
    }
    for (let k = 0; k < span.replacementCount; k++) {
      const anchor = replacement[k];
      if (anchor === undefined) continue;
      state.everMinted.add(anchor);
      state.owned.set(anchor, { path, checksum: newChecksums[start + k]! });
    }
    for (let k = 0; k < span.replacementCount; k++) {
      if (replacement[k] !== undefined) continue;
      const anchor = mintAnchor(state, path);
      const checksum = newChecksums[start + k]!;
      minted.push({ index: start + k, anchor, checksum });
      state.everMinted.add(anchor);
      state.owned.set(anchor, { path, checksum });
      replacement[k] = anchor;
    }
    const settled = replacement as string[];
    spliceAll(anchors, start, spanLength, settled);
    offset += span.replacementCount - spanLength;
  }
  const rows: [string, string][] = minted.map((m) => [m.anchor, m.checksum]);
  const retained = freed.filter((candidate) => !reused.has(candidate.anchor));
  if (retained.length > 0) log({ kind: "free", path, anchors: retained.map((f) => f.anchor) });
  if (rows.length > 0) log({ kind: "allocate", path, rows });
  return { anchors, freed: retained.map((f) => f.anchor), minted: minted.map((m) => m.anchor) };
}

export function alignOwnership(
  path: string,
  prevAnchors: string[] | undefined,
  prevChecksums: string[] | undefined,
  newChecksums: string[],
  options?: { shadow?: boolean },
): Aligned {
  const state = options?.shadow ? shadowStateFrom(current()!) : current()!;
  const anchors: string[] = new Array(newChecksums.length);
  const freed: { anchor: string; checksum: string }[] = [];
  const minted: MintedAt[] = [];
  const adopted: string[] = [];
  const log = (event: RegistryEvent): void => {
    if (!options?.shadow) appendEvent(event);
  };
  if (prevAnchors) {
    for (const anchor of prevAnchors) state.everMinted.add(anchor);
  }

  const parts: ArrayPart[] = computeParts(prevChecksums, newChecksums);
  let prevIdx = 0;
  let newIdx = 0;
  for (const part of parts) {
    const count = part.count;
    if (part.added) {
      for (let k = 0; k < count; k++) {
        const checksum = newChecksums[newIdx + k]!;
        const anchor = mintAnchor(state, path);
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
          const fresh = mintAnchor(state, path);
          state.everMinted.add(fresh);
          minted.push({ index: newIdx + k, anchor: fresh, checksum });
          state.owned.set(fresh, { path, checksum });
          anchors[newIdx + k] = fresh;
        } else {
          if (!entry) adopted.push(anchor);
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
  const logged = new Set<string>([...minted.map((m) => m.anchor), ...adopted]);
  if (freed.length > 0) log({ kind: "free", path, anchors: freed.map((f) => f.anchor) });
  if (logged.size > 0) log({ kind: "allocate", path, rows: rows.filter(([anchor]) => logged.has(anchor)) });
  return { anchors, freed: freed.map((f) => f.anchor), minted: minted.map((m) => m.anchor) };
}

function snapshotMatchesAllocation(state: SessionState | undefined, path: string, checksum: string): boolean {
  const allocated = state?.allocatedChecksum.get(path);
  return allocated === undefined || allocated === checksum;
}

export async function allocateFileAnchors(
  store: HashStore,
  path: string,
  content: string,
  options?: {
    persist?: boolean;
    shadow?: boolean;
    previous?: { content: string; hashes: string[]; spans?: { start: number; end: number; replacementCount: number; carry?: number }[] };
  },
): Promise<string[]> {
  ensureRegistry();
  const registry = current();
  const shadow = options?.shadow === true;
  const lines = splitLines(content);
  assertLineCount(lines.length, path, MAX_HASH_LINES);
  if (!shadow && registry) touchPath(registry, path);
  const checksums = lines.map(lineChecksum);
  if (options?.previous?.spans) {
    const prevChecksums = splitLines(options.previous.content).map(lineChecksum);
    const aligned = alignOwnershipWithSpans(path, options.previous.hashes, prevChecksums, checksums, options.previous.spans, { shadow });
    if (!shadow && registry) registry.allocatedChecksum.set(path, contentChecksum(content));
    if (!shadow && options.persist !== false) {
      persistSnapshot(store, path, content, aligned.anchors, checksums);
    }
    return aligned.anchors;
  }
  let prevAnchors: string[] | undefined;
  let prevChecksums: string[] | undefined;
  if (options?.previous) {
    prevAnchors = options.previous.hashes;
    prevChecksums = splitLines(options.previous.content).map(lineChecksum);
  } else {
    const previousState = getAllocatedState(store, path, !shadow);
    if (previousState && snapshotMatchesAllocation(registry, path, previousState.contentChecksum)) {
      prevAnchors = previousState.anchors;
      prevChecksums = previousState.checksums;
      if (!prevChecksums) {
        if (previousState.contentChecksum === contentChecksum(content)) {
          prevChecksums = checksums;
        } else if (!shadow) {
          const state = current();
          const stale = state && prevAnchors ? prevAnchors.filter((anchor) => state.owned.get(anchor)?.path === path) : [];
          if (state && stale.length > 0) {
            const usedAt = state.lastUsedAt.get(path);
            freeAnchors(path, stale);
            if (usedAt !== undefined) state.lastUsedAt.set(path, usedAt);
          }
        }
      }
    }
  }
  const aligned: Aligned = prevAnchors
    ? alignOwnership(path, prevAnchors, prevChecksums, checksums, { shadow })
    : (() => {
        const state = shadow ? shadowStateFrom(current()!) : current()!;
        const reuseIndex = fingerprintIndex(state, path);
        const reuseTaken = new Map<string, number>();
        const anchors: string[] = checksums.map((checksum) => {
          const candidates = reuseIndex.get(checksum) ?? [];
          const taken = reuseTaken.get(checksum) ?? 0;
          reuseTaken.set(checksum, taken + 1);
          const anchor = taken < candidates.length ? candidates[taken]! : mintAnchor(state, path);
          state.everMinted.add(anchor);
          state.owned.set(anchor, { path, checksum });
          return anchor;
        });
        if (!shadow) {
          appendEvent({ kind: "allocate", path, rows: anchors.map((a, i) => [a, checksums[i]!]) });
        }
        return { anchors, freed: [], minted: anchors };
      })();
  if (!shadow && registry) registry.allocatedChecksum.set(path, contentChecksum(content));
  if (!shadow && options?.persist !== false) {
    persistSnapshot(store, path, content, aligned.anchors, checksums);
  }
  return aligned.anchors;
}

export function adoptAnchors(path: string, entries: Map<string, string>): void {
	ensureRegistry();
	const state = current()!;
	touchPath(state, path);
	let served = state.served.get(path);
	if (!served) {
		served = new Map();
		state.served.set(path, served);
	}
	const adopted: Array<[string, string]> = [];
	for (const [anchor, checksum] of entries) {
		if (!HASH_RE.test(anchor)) continue;
		const existing = state.owned.get(anchor);
		if (existing && existing.path !== path) continue;
		state.owned.set(anchor, { path, checksum });
		served.set(anchor, checksum);
		adopted.push([anchor, checksum]);
	}
	if (adopted.length > 0) {
		appendEvent({ kind: "allocate", path, rows: adopted });
	}
}

export function resetRegistryForTests(): void {
  currentKey = undefined;
  sidecarByKey.clear();
  sessionFileByKey.clear();
  pendingInits.clear();
  loadTokens.clear();
  registries.clear();
}

export function lastUsedAtForTests(path: string): number | undefined {
  return current()?.lastUsedAt.get(path);
}

async function readSidecarWindow(sidecar: string): Promise<{ text: string; filled: boolean }> {
  const handle = await open(sidecar, "r");
  const buffer = Buffer.alloc(SIDECAR_HEADER_BYTES);
  try {
    let readBytes = 0;
    while (readBytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, readBytes, Math.min(SIDECAR_HEADER_CHUNK, buffer.length - readBytes), readBytes);
      if (bytesRead === 0) break;
      readBytes += bytesRead;
    }
    return { text: buffer.subarray(0, readBytes).toString("utf-8"), filled: readBytes === buffer.length };
  } finally {
    await handle.close();
  }
}

export async function readSidecarHeader(sidecar: string): Promise<string> {
  const { text, filled } = await readSidecarWindow(sidecar);
  const newline = text.indexOf("\n");
  if (newline >= 0) return text.slice(0, newline);
  return filled ? "" : text;
}

export async function readSidecarSessionFile(sidecar: string): Promise<string | undefined> {
  const { text } = await readSidecarWindow(sidecar);
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline).split("\n") : [];
  for (const line of complete) {
    const sessionFile = parseSessionFileLine(line);
    if (sessionFile !== undefined) return sessionFile;
  }
  return parseSessionFileLine(lastNewline >= 0 ? text.slice(lastNewline + 1) : text);
}

export function releaseRegistrySession(key: string): void {
  loadTokens.delete(key);
  if (currentKey === key) currentKey = undefined;
  pendingInits.delete(key);
  sidecarByKey.delete(key);
  sessionFileByKey.delete(key);
  registries.delete(key);
}

function isClaimedSidecar(sidecar: string): boolean {
  for (const claimed of sidecarByKey.values()) {
    if (claimed === sidecar) return true;
  }
  return false;
}

function isExpectedAccessError(error: unknown): boolean {
  const code = errCode(error);
  return code === "EPERM" || code === "EACCES";
}

export async function gcRegistrySidecars(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(sessionClaimsDir());
  } catch (error) {
    if (errCode(error) !== "ENOENT" && !isExpectedAccessError(error)) console.error("Failed to list registry sidecars:", error);
    return;
  }
  for (const name of names) {
    if (name.includes(`${SIDECAR_SUFFIX}.compact-`)) {
      const tmpPath = join(sessionClaimsDir(), name);
      try {
        const tmpStat = await stat(tmpPath);
        if (Date.now() - tmpStat.mtimeMs > 60 * 60 * 1000) await rm(tmpPath, { force: true });
      } catch (error) {
        if (errCode(error) !== "ENOENT" && !isExpectedAccessError(error)) console.error("Failed to inspect registry sidecar:", error);
      }
      continue;
    }
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const sidecar = join(sessionClaimsDir(), name);
    if (isClaimedSidecar(sidecar)) continue;
    try {
      const sessionFile = await readSidecarSessionFile(sidecar);
      if (sessionFile === undefined) continue;
      await stat(sessionFile);
    } catch (error) {
      if (errCode(error) === "ENOENT") {
        try {
          await rm(sidecar, { force: true });
        } catch (removeError) {
          if (!isExpectedAccessError(removeError)) throw removeError;
        }
      } else if (!isExpectedAccessError(error)) {
        console.error("Failed to inspect registry sidecar:", error);
      }
    }
  }
}