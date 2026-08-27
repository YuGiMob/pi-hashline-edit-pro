import { existsSync } from "fs";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode, isRec, splitLines } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_RE } from "./hashline/alphabet";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";

type SqlParams = (string | number)[];

interface RawStatement {
  get(...params: SqlParams): unknown;
  all(...params: SqlParams): unknown;
  run(...params: SqlParams): unknown;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
  readonly isOpen: boolean;
}
export type SqliteEngine = "node:sqlite" | "bun:sqlite";

interface BunDbLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: SqlParams): unknown;
    all(...params: SqlParams): unknown[];
    run(...params: SqlParams): unknown;
  };
  close(): void;
}

let openDbFn: (path: string) => RawDb;
let sqliteEngine: SqliteEngine;

if (typeof process !== "undefined" && (process.versions as Record<string, string | undefined>).bun) {
  const specifier = "bun:sqlite";
  const mod = await import(specifier) as { Database: new (path: string) => BunDbLike };
  sqliteEngine = "bun:sqlite";
  openDbFn = (path) => {
    const db = new mod.Database(path);
    db.exec(`PRAGMA busy_timeout = ${HASH_STORE_BUSY_TIMEOUT}`);
    let closed = false;
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          get: (...p) => stmt.get(...p) ?? undefined,
          all: (...p) => stmt.all(...p),
          run: (...p) => stmt.run(...p),
        };
      },
      close: () => { if (!closed) { closed = true; db.close(); } },
      get isOpen() { return !closed; },
    };
  };
} else {
  const { DatabaseSync } = await import("node:sqlite");
  sqliteEngine = "node:sqlite";
  openDbFn = (path) => new DatabaseSync(path, { timeout: HASH_STORE_BUSY_TIMEOUT }) as unknown as RawDb;
}

interface Prepared {
  get: (...params: SqlParams) => Record<string, unknown> | undefined;
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  allHashes: (...params: SqlParams) => Record<string, unknown>[];
  allServed: (...params: SqlParams) => Record<string, unknown>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
  undoUpsert: (...params: SqlParams) => void;
  undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoDelete: (...params: SqlParams) => void;
  servedGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  servedUpsert: (...params: SqlParams) => void;
  servedDelete: (...params: SqlParams) => void;
}

export interface HashStore {
  readonly stmts: Prepared;
  readonly engine: SqliteEngine;
}

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
}

interface LegacySnapshot {
  content: string;
  hashes: string[];
}

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  if (new Set(value).size !== value.length) return false;
  return true;
}

export function parseHashList(raw: string, onInvalid: () => void): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onInvalid();
    return undefined;
  }
  if (!isValidHashList(parsed)) {
    onInvalid();
    return undefined;
  }
  return parsed;
}

export function parseStoredHashes(
  row: Record<string, unknown> | undefined,
  onInvalid: () => void,
): string[] | undefined {
  if (!row) return undefined;
  return parseHashList(row.hashes as string, onInvalid);
}

function isValidSnapshot(value: unknown): value is LegacySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  return isValidHashList(v.hashes);
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

const sleepSab = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepSab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 50;

function withBusyRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
      sleepSync(BUSY_RETRY_DELAY_MS * (1 << attempt));
    }
  }
  throw lastError;
}

function openDbWithBusyRetry(storePath: string): { db: RawDb; stmts: Prepared } {
  return withBusyRetry(() => openDb(storePath));
}

function retriedWrite(
  stmt: { run(...params: SqlParams): unknown },
): (...params: SqlParams) => void {
  return (...params) => {
    withBusyRetry(() => { stmt.run(...params); });
  };
}

let cachedDb: { path: string; db: RawDb; stmts: Prepared } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;
interface SnapshotCacheEntry {
  checksum: string;
  lineCount: number;
  hashes: string[];
}
const snapshotCache = new Map<string, SnapshotCacheEntry>();
export const SNAPSHOT_CACHE_LIMIT = 256;
function openDb(storePath: string): { db: RawDb; stmts: Prepared } {
  const db = openDbFn(storePath);
  try {
    return buildStore(db);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function buildStore(
  db: RawDb,
): { db: RawDb; stmts: Prepared } {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY, " +
      "value TEXT NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS undo (" +
      "path TEXT PRIMARY KEY, " +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "path TEXT PRIMARY KEY, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
  if (versionRow && versionRow.value !== String(HASH_STORE_VERSION)) {
    db.exec("DELETE FROM snapshots");
    db.exec("DELETE FROM undo");
    db.exec("DELETE FROM served");
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(HASH_STORE_VERSION));
  const getStmt = db.prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
  const allStmt = db.prepare("SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served");
  const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots");
  const allServedStmt = db.prepare("SELECT path, hashes FROM served");
  const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at"
  );
  const undoUpsertStmt = db.prepare(
    "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at"
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?"
  );
  const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
  const servedGetStmt = db.prepare("SELECT hashes FROM served WHERE path = ?");
  const servedUpsertStmt = db.prepare(
    "INSERT INTO served (path, hashes, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at"
  );
  const servedDelStmt = db.prepare("DELETE FROM served WHERE path = ?");
  const stmts: Prepared = {
    get: (...params) => getStmt.get(...params) as Record<string, unknown> | undefined,
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    allHashes: (...params) => allHashesStmt.all(...params) as Record<string, unknown>[],
    allServed: (...params) => allServedStmt.all(...params) as Record<string, unknown>[],
    deleteOne: retriedWrite(delStmt),
    upsert: retriedWrite(upsertStmt),
    undoUpsert: retriedWrite(undoUpsertStmt),
    undoGet: (...params) => undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: retriedWrite(undoDelStmt),
    servedGet: (...params) => servedGetStmt.get(...params) as Record<string, unknown> | undefined,
    servedUpsert: retriedWrite(servedUpsertStmt),
    servedDelete: retriedWrite(servedDelStmt),
  };
  return { db, stmts };
}

function isHealthy(db: RawDb): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Failed to quarantine corrupt hash store file:", error);
      }
    }
  }
}

function shutdownDb(db: RawDb): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
  }
  db.close();
}

async function openStore(storePath: string): Promise<HashStore> {
  shutdownHashStore();

  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true });

  let existed = existsSync(storePath);
  let opened: { db: RawDb; stmts: Prepared };
  try {
    opened = openDbWithBusyRetry(storePath);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  const { db, stmts } = opened;

  if (!existed) {
    try {
      await migrateLegacy(db);
    } catch (error) {
      console.error("Hash store migration failed; continuing without legacy import:", error);
    }
  }
  cachedDb = { path: storePath, db, stmts };

  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.once("exit", () => shutdownHashStore());
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        shutdownHashStore();
        process.kill(process.pid, sig);
      });
    }
  }

  return { stmts, engine: sqliteEngine };
}

export function loadHashStore(): Promise<HashStore> {
  const storePath = hashStorePath();
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return Promise.resolve({ stmts: cachedDb.stmts, engine: sqliteEngine });
  }
  if (opening && opening.path === storePath) {
    return opening.promise;
  }
  const promise = openStore(storePath).finally(() => {
    if (opening?.path === storePath) opening = null;
  });
  opening = { path: storePath, promise };
  return promise;
}

export function shutdownHashStore(): void {
  if (cachedDb) {
    shutdownDb(cachedDb.db);
    cachedDb = null;
  }
  snapshotCache.clear();
}

function withStore(fn: () => void): void {
  if (!cachedDb) {
    throw new Error("Hash store is not open; transactional update aborted");
  }
  withBusyRetry(() => {
    cachedDb!.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      cachedDb!.db.exec("COMMIT");
    } catch (e) {
      try { cachedDb!.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  });
}

async function migrateLegacy(db: RawDb): Promise<void> {
  const legacyPath = legacyHashStorePath();
  let content: string;
  try {
    content = await readFile(legacyPath, "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return;
    console.error("Failed to read legacy hash store for migration:", error);
    return;
  }

  let parsed: { snapshots?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (error) {
    console.error("Failed to parse legacy hash store, skipping migration:", error);
    return;
  }

  const raw = parsed.snapshots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const rows: [string, string, number, string, number][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (
      isRec(value) &&
      Array.isArray(value.hashes) &&
      new Set(value.hashes).size !== value.hashes.length
    ) {
      console.warn(
        `Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
      );
      continue;
    }
    if (!isValidSnapshot(value)) continue;
    rows.push([
      key,
      contentChecksum(value.content),
      splitLines(value.content).length,
      JSON.stringify(value.hashes),
      Date.now(),
    ]);
  }
  if (rows.length > 0) {
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const stmt = db.prepare(
          "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)"
        );
        for (const row of rows) stmt.run(...row);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    });
  }

  try {
    await rename(legacyPath, `${legacyPath}.bak`);
  } catch (error) {
    console.error("Failed to rename legacy hash store after migration:", error);
  }
}

function cacheSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void {
  snapshotCache.delete(path);
  snapshotCache.set(path, { checksum, lineCount, hashes: hashes.slice() });
  if (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
}

export function getSnapshot(
  store: HashStore,
  path: string,
  content: string,
  deleteCorrupt = true,
): string[] | undefined {
  const checksum = contentChecksum(content);
  const lineCount = splitLines(content).length;
  const cached = snapshotCache.get(path);
  if (cached && cached.checksum === checksum && cached.lineCount === lineCount) {
    snapshotCache.delete(path);
    snapshotCache.set(path, cached);
    return cached.hashes.slice();
  }
  const row = store.stmts.get(path, checksum, lineCount);
  const parsed = parseStoredHashes(row, () => {
    if (deleteCorrupt) store.stmts.deleteOne(path);
    snapshotCache.delete(path);
  });
  if (!parsed) return undefined;
  cacheSnapshot(path, checksum, lineCount, parsed);
  return parsed;
}

export function upsertSnapshot(
  store: HashStore,
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
): void {
  store.stmts.upsert(path, checksum, lineCount, JSON.stringify(hashes), Date.now());
  cacheSnapshot(path, checksum, lineCount, hashes);
}

export function upsertUndo(store: HashStore, path: string, entry: UndoRecord): void {
  store.stmts.undoUpsert(
    path,
    entry.content,
    entry.bom,
    entry.ending,
    JSON.stringify(entry.hashes),
    entry.resultContent,
    Date.now(),
  );
}

export function getUndoEntry(store: HashStore, path: string): UndoRecord | undefined {
  const row = store.stmts.undoGet(path);
  if (!row) return undefined;
  const parsed = parseStoredHashes(row, () => store.stmts.undoDelete(path));
  if (!parsed) return undefined;
  return {
    content: row.content as string,
    bom: row.bom as string,
    ending: row.ending as string,
    hashes: parsed,
    resultContent: row.result_content as string,
  };
}

export function deleteUndo(store: HashStore, path: string): void {
  store.stmts.undoDelete(path);
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          await stat(row.path);
          return undefined;
        } catch (error: unknown) {
          if (errCode(error) !== "ENOENT") {
            console.error("Failed to stat hash store path:", row.path, error);
            return undefined;
          }
          return row.path;
        }
      }),
    );
    for (const path of results) {
      if (path !== undefined) missing.push(path);
    }
  }
  return missing;
}

export async function pruneMissing(store: HashStore): Promise<void> {
  const rows = store.stmts.allPaths() as { path: string }[];
  const missing = await statMissing(rows);
  if (missing.length === 0) return;
  withStore(() => {
    for (const path of missing) {
      store.stmts.deleteOne(path);
      snapshotCache.delete(path);
      store.stmts.servedDelete(path);
    }
  });
}

function matchPathsByHashes(
  rows: { path: string; hashes: string }[],
  hashes: string[],
): string[] {
  const matches: string[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.hashes) as unknown;
      if (!isValidHashList(parsed)) continue;
      if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
    } catch {
      continue;
    }
  }
  return matches;
}

export function findSnapshotPaths(store: HashStore, hashes: string[]): string[] {
  return matchPathsByHashes(store.stmts.allHashes() as { path: string; hashes: string }[], hashes);
}

export function findServedPaths(store: HashStore, hashes: string[]): string[] {
  return matchPathsByHashes(store.stmts.allServed() as { path: string; hashes: string }[], hashes);
}
