// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/db-base.ts.
/**
 * db-base — Reusable SQLite infrastructure for context-mode packages.
 *
 * Provides the bun:sqlite adapter, WAL pragma setup, prepared
 * statement caching interface, and DB file cleanup helpers for ContentStore.
 */

import { Database as BunDB } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
// v1.0.130 — `acquireDbLock` + `locking_mode = EXCLUSIVE` were REMOVED.
// See docs/adr/0001-sessiondb-multi-writer.md for the architectural
// rationale. The short version: SessionDB is multi-writer-safe and the
// process-identity invariants the lockfile tried to enforce belong in
// the process layer (sibling-mcp), not the DB layer. WAL + busy_timeout
// + withRetry handle the actual concurrency safely.

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic `Statement` collapses under
 * `ReturnType` to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────
// bun:sqlite adapter (#45)
// ─────────────────────────────────────────────────────────

/**
 * Wraps a bun:sqlite Database to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), multi-statement .exec(), .get() null→undefined.
 */
export class BunSQLiteAdapter {
  #raw: any;

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    // Multi-row pragmas (table_xinfo, etc.) → return array
    if (rows.length > 1) return rows;
    // Single-row: extract scalar value (e.g. journal_mode = "wal")
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // bun:sqlite .exec() is single-statement only.
    // Split multi-statement SQL respecting string literals (don't split on ; inside quotes).
    let current = "";
    let inString: string | null = null;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (inString) {
        current += ch;
        if (ch === inString) inString = null;
      } else if (ch === "'" || ch === '"') {
        current += ch;
        inString = ch;
      } else if (ch === ";") {
        const trimmed = current.trim();
        if (trimmed) this.#raw.prepare(trimmed).run();
        current = "";
      } else {
        current += ch;
      }
    }
    const trimmed = current.trim();
    if (trimmed) this.#raw.prepare(trimmed).run();
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => {
        const r = stmt.get(...args);
        return r === null ? undefined : r;
      },
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => stmt.iterate(...args),
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    return this.#raw.transaction(fn);
  }

  close(): void {
    this.#raw.close();
  }
}

export type DatabaseInstance = BunSQLiteAdapter;

/** Open a bun:sqlite database behind the better-sqlite3-shaped adapter. */
export function openDatabase(path: string, opts?: { readonly?: boolean; timeout?: number }): DatabaseInstance {
  const raw = new BunDB(path, {
    readonly: opts?.readonly,
    create: true,
  });
  const adapter = new BunSQLiteAdapter(raw);
  // bun:sqlite has no busy-timeout constructor option, so set it via pragma (#243)
  if (opts?.timeout) {
    adapter.pragma(`busy_timeout = ${opts.timeout}`);
  }
  return adapter;
}

// ─────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Should be called immediately after opening a new database connection.
 *
 * WAL mode provides:
 * - Concurrent readers while a write is in progress
 * - Dramatically faster writes (no full-page sync on each commit)
 * NORMAL synchronous is safe under WAL and avoids an extra fsync per
 * transaction.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Memory-map the DB file for read-heavy FTS5 search workloads.
  // Eliminates read() syscalls — the kernel serves pages directly from
  // the page cache. 256MB is a safe upper bound (SQLite only maps up to
  // the actual file size). Falls back gracefully on platforms where mmap
  // is unavailable or restricted.
  try { db.pragma("mmap_size = 268435456"); } catch { /* unsupported runtime */ }
  // NOTE: `locking_mode = EXCLUSIVE` is intentionally NOT applied here.
  // ALL DBs built on this helper — ContentStore (FTS5 shared knowledge
  // base) AND SessionDB (per-project events) — are multi-writer-safe by
  // contract. WAL + busy_timeout + the withRetry() wrapper below handle
  // SQLITE_BUSY natively. EXCLUSIVE locking is opt-out, never opt-in
  // from a base class shared by multi-writer consumers.
  // See docs/adr/0001-sessiondb-multi-writer.md for the v1.0.130 ADR.
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove orphaned WAL/SHM files when the main DB file doesn't exist.
 * On Windows, stale -wal/-shm files from crashed processes cause
 * "file is not a database" errors when creating a fresh DB.
 */
export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
}

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so a partial cleanup
 * does not abort the rest.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // ignore — file may not exist
    }
  }
}

/**
 * Safely close a database connection. Swallows errors so callers can
 * always call this in a finally/cleanup path without try/catch.
 */
export function closeDB(db: DatabaseInstance): void {
  try {
    // Checkpoint WAL before close to prevent contention on restart (#103)
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch { /* WAL may not be active */ }
  try {
    db.close();
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────

/**
 * Retry a DB operation with exponential backoff on SQLITE_BUSY errors.
 * Catches errors containing "SQLITE_BUSY" or "database is locked" and
 * retries up to 3 times with delays: 100ms, 500ms, 2000ms.
 * If all retries fail, throws a descriptive error.
 * Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 */
export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000]): T {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const delay = delays[attempt];
        const start = Date.now();
        while (Date.now() - start < delay) { /* busy-wait for sync retry */ }
      }
    }
  }
  throw new Error(
    `SQLITE_BUSY: database is locked after ${delays.length} retries. ` +
    `Original error: ${lastError?.message}`
  );
}

// ─────────────────────────────────────────────────────────
// Corrupt DB recovery (#244)
// ─────────────────────────────────────────────────────────

/**
 * Detect SQLite corruption errors that warrant a rename-and-recreate.
 * Matches SQLITE_CORRUPT, SQLITE_NOTADB, and their human-readable equivalents.
 */
export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  );
}
