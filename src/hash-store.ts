import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, mkdir, stat } from "node:fs/promises";
import { hashStorePath, hashStoreDir, legacyHashStorePath } from "./paths";
import { errCode, isRec, splitLines } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";
import {
  isValidHashList,
  isValidServedMap,
  parseStoredHashes,
  parseStoredServed,
  isValidSnapshot,
  isCorruptionError,
  parseHashList,
  parseServedMap,
} from "./hash-store/validation";
import {
  withBusyRetry,
  retriedWrite,
  openDbWithBusyRetryAsync,
} from "./hash-store/retry";
import { snapshotCache, cacheSnapshot, SNAPSHOT_CACHE_LIMIT, touchSession, clearSession, forgetSession } from "./hash-store/cache";

export { isValidHashList, isValidServedMap, parseHashList, parseServedMap, parseStoredHashes, parseStoredServed, isCorruptionError };
export { SNAPSHOT_CACHE_LIMIT };
export const STORE_NOT_OPEN_MESSAGE = "Hash store is not open; transactional update aborted";

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
export type SqliteEngine = "node:sqlite";
const sqliteEngine: SqliteEngine = "node:sqlite";
const { DatabaseSync } = await import("node:sqlite");
const openDbFn = (path: string): RawDb => new DatabaseSync(path, { timeout: HASH_STORE_BUSY_TIMEOUT }) as unknown as RawDb;

interface Prepared {
  get: (...params: SqlParams) => Record<string, unknown> | undefined;
  getState: (...params: SqlParams) => Record<string, unknown> | undefined;
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  allHashes: (...params: SqlParams) => Record<string, unknown>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
  undoUpsert: (...params: SqlParams) => void;
  undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoDelete: (...params: SqlParams) => void;
  snapshotTime: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoTime: (...params: SqlParams) => Record<string, unknown> | undefined;
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

let cachedDb: { path: string; db: RawDb; stmts: Prepared } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;

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

function buildStore(db: RawDb): { db: RawDb; stmts: Prepared } {
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
  try {
    db.exec("ALTER TABLE snapshots ADD COLUMN line_checksums TEXT");
  } catch {}
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
  if (versionRow && versionRow.value !== String(HASH_STORE_VERSION)) {
    db.exec("DELETE FROM snapshots");
    db.exec("DELETE FROM undo");
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(HASH_STORE_VERSION));
  const getStmt = db.prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?");
  const getStateStmt = db.prepare("SELECT checksum, hashes, line_checksums FROM snapshots WHERE path = ?");
  const allStmt = db.prepare("SELECT path FROM snapshots UNION SELECT path FROM undo");
  const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots");
  const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO snapshots (path, checksum, line_count, hashes, line_checksums, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, line_checksums = excluded.line_checksums, updated_at = excluded.updated_at"
  );
  const undoUpsertStmt = db.prepare(
    "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at"
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?"
  );
  const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
  const snapshotTimeStmt = db.prepare("SELECT updated_at FROM snapshots WHERE path = ?");
  const undoTimeStmt = db.prepare("SELECT updated_at FROM undo WHERE path = ?");
  const stmts: Prepared = {
    get: (...params) => getStmt.get(...params) as Record<string, unknown> | undefined,
    getState: (...params) => getStateStmt.get(...params) as Record<string, unknown> | undefined,
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    allHashes: (...params) => allHashesStmt.all(...params) as Record<string, unknown>[],
    deleteOne: retriedWrite(delStmt),
    upsert: retriedWrite(upsertStmt),
    undoUpsert: retriedWrite(undoUpsertStmt),
    undoGet: (...params) => undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: retriedWrite(undoDelStmt),
    snapshotTime: (...params) => snapshotTimeStmt.get(...params) as Record<string, unknown> | undefined,
    undoTime: (...params) => undoTimeStmt.get(...params) as Record<string, unknown> | undefined,
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
  const suffix = `.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
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
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return { stmts: cachedDb.stmts, engine: sqliteEngine };
  }
  if (cachedDb) shutdownHashStore();
  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(hashStoreDir(), 0o700);
  }

  let existed = existsSync(storePath);
  let opened: { db: RawDb; stmts: Prepared };
  try {
    opened = await openDbWithBusyRetryAsync(() => openDb(storePath));
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = await openDbWithBusyRetryAsync(() => openDb(storePath));
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    existed = false;
    opened = await openDbWithBusyRetryAsync(() => openDb(storePath));
  }
  const { db, stmts } = opened;
  try {
    const autoVacuum = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
    const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const freelist = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    if (autoVacuum === 0 && !existed) {
      db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    } else if (freelist > 50 && freelist * 5 > pageCount) {
      try {
        db.exec("PRAGMA incremental_vacuum(50)");
      } catch {
        db.exec("VACUUM");
      }
    }
  } catch {}

  if (process.platform !== "win32") {
    for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
      try {
        await chmod(candidate, 0o600);
      } catch (error) {
        if (errCode(error) !== "ENOENT") throw error;
      }
    }
  }

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
  clearSession();
}

export function withStore(fn: () => void): void {
  if (!cachedDb || !cachedDb.db.isOpen) {
    throw new Error(STORE_NOT_OPEN_MESSAGE);
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

  const rows: [string, string, number, string, string, number][] = [];
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
      "",
      Date.now(),
    ]);
  }
  if (rows.length > 0) {
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const stmt = db.prepare(
          "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, line_checksums, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
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
  const row = withBusyRetry(() => store.stmts.get(path, checksum, lineCount));
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
  lineChecksums?: string[],
): void {
  store.stmts.upsert(path, checksum, lineCount, JSON.stringify(hashes), lineChecksums ? JSON.stringify(lineChecksums) : "", Date.now());
  cacheSnapshot(path, checksum, lineCount, hashes);
  touchSession(path);
}
export function persistSnapshot(
  store: HashStore,
  path: string,
  content: string,
  hashes: string[],
  lineChecksums?: string[],
): void {
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes, lineChecksums);
}

export interface AllocatedState {
  anchors: string[];
  checksums: string[] | undefined;
  contentChecksum: string;
}

export function getAllocatedState(store: HashStore, path: string, deleteCorrupt = true): AllocatedState | undefined {
  const row = withBusyRetry(() => store.stmts.getState(path)) as
    | { checksum?: unknown; hashes?: unknown; line_checksums?: unknown }
    | undefined;
  if (!row || typeof row.checksum !== "string") return undefined;
  const parsedAnchors = parseStoredHashes({ hashes: row.hashes }, () => {
    if (deleteCorrupt) store.stmts.deleteOne(path);
    snapshotCache.delete(path);
  });
  if (!parsedAnchors) return undefined;
  let checksums: string[] | undefined;
  if (typeof row.line_checksums === "string" && row.line_checksums.length > 0) {
    try {
      const parsed = JSON.parse(row.line_checksums) as unknown;
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) {
        checksums = parsed as string[];
      }
    } catch {
      checksums = undefined;
    }
  }
  return { anchors: parsedAnchors, checksums, contentChecksum: row.checksum };
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
  touchSession(path);
}

export function getUndoEntry(store: HashStore, path: string): UndoRecord | undefined {
  const row = withBusyRetry(() => store.stmts.undoGet(path));
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
          const code = errCode(error);
          if (code !== "ENOENT" && code !== "ENOTDIR") {
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

export async function pruneMissing(store: HashStore): Promise<string[]> {
  const rows = store.stmts.allPaths() as { path: string }[];
  const missing = await statMissing(rows);
  if (missing.length === 0) return [];
  withStore(() => {
    for (const path of missing) {
      store.stmts.deleteOne(path);
    }
  });
  for (const path of missing) snapshotCache.delete(path);
  for (const path of missing) forgetSession(path);
  return missing;
}



