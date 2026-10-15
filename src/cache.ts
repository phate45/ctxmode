/**
 * Baseline + session DB lifecycle.
 *
 * `<repo>/.ctxmode/<config id>.db` holds the last prewarmed index plus a
 * manifest of the files it was built from. Startup copies it to a per-process session
 * DB, re-indexes only the files whose content changed, and writes the result
 * back with one atomic rename, so concurrent sessions need no lock.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { ContentStore, STORE_VERSION, deleteDBFiles } from "./store.ts";
import {
  PREPROCESS_VERSION,
  preprocessText,
  resolveSourcePaths,
  type Config,
  type FoundConfig,
  type PrewarmSourceSummary,
  type SourceConfig,
} from "./prewarm.ts";

const MANIFEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cache_meta (key TEXT NOT NULL, scanned_ns TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cache_files (
    label TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime_ns TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL
  );
`;

interface ManifestRow {
  label: string;
  source: string;
  path: string;
  /** Decimal string: nanosecond mtimes overflow a double. */
  mtime_ns: string;
  size: number;
  sha256: string;
}

export interface PrewarmReport {
  warm: boolean;
  clean: number;
  changed: number;
  added: number;
  removed: number;
  /** Stat changed but content did not: only the manifest row is updated. */
  refreshed: number;
  files: number;
  chunks: number;
  sources: PrewarmSourceSummary[];
  /** Write-back error message, if the baseline could not be replaced. */
  writeBackError?: string;
  timings: Record<string, number>;
}

// ── Locations ───────────────────────────────────────────────────────

/** Create the sessions dir, sweep DBs of dead processes, return this process's (empty) DB path. */
export function startSession(): string {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ctxmode", "sessions");
  mkdirSync(dir, { recursive: true });
  sweepDead(dir, /^(\d+)\.db(-wal|-shm)?$/);
  const path = join(dir, `${process.pid}.db`);
  // A crashed process that had this PID may have left its DB behind.
  deleteDBFiles(path);
  return path;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Unlink files in `dir` whose name matches `re` with a PID (group 1) that is not running. */
export function sweepDead(dir: string, re: RegExp): number {
  let swept = 0;
  for (const name of readdirSync(dir)) {
    const pid = Number(name.match(re)?.[1]);
    if (!pid || pid === process.pid || pidAlive(pid)) continue;
    try {
      unlinkSync(join(dir, name));
      swept++;
    } catch { /* raced with another sweeper */ }
  }
  return swept;
}

/**
 * `<repo>/.ctxmode/<id>.db`, one baseline per config. `<repo>` is the main
 * checkout, else `sourceBase`; `<id>` hashes the config's path within its
 * checkout, so worktrees share a baseline, or its absolute path when outside.
 */
export function baselinePath({ configPath, sourceBase }: FoundConfig): string {
  let root = sourceBase;
  let checkout = sourceBase;
  try {
    const [top, common] = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd: sourceBase,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n");
    checkout = top;
    // A submodule's common dir lives inside the superproject's .git/modules.
    if (basename(common) === ".git") root = dirname(common);
  } catch { /* not a git checkout */ }
  const rel = relative(checkout, configPath);
  const id = rel.startsWith("..") || isAbsolute(rel) ? configPath : rel;
  return join(root, ".ctxmode", `${createHash("sha256").update(id).digest("hex").slice(0, 12)}.db`);
}

/** Descriptions are left out: they only reach the search manifest, which reads the live config. */
export function cacheKey(config: Config): string {
  const sources = config.sources.map(({ description, ...rest }) => rest);
  return `${STORE_VERSION}.${PREPROCESS_VERSION}.${createHash("sha256").update(JSON.stringify(sources)).digest("hex")}`;
}

// ── Prewarm ─────────────────────────────────────────────────────────

/**
 * Bring the session DB at `sessionPath` up to date with the configured
 * sources, starting from the baseline when its key matches, and write the
 * result back to the baseline when anything changed.
 */
export function prewarmSession(found: FoundConfig, sessionPath: string): PrewarmReport {
  const { config, sourceBase } = found;
  const scannedNs = BigInt(Date.now()) * 1_000_000n;
  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (phase: string) => {
    const now = performance.now();
    timings[phase] = now - mark;
    mark = now;
  };

  // Later entries win a label clash, matching the store's per-label dedupe.
  const current = new Map<string, { source: SourceConfig; name: string; path: string; mtimeNs: string; size: number }>();
  const unresolved = new Set<string>();
  for (const source of config.sources) {
    const paths = resolveSourcePaths(source, sourceBase);
    if (!paths) unresolved.add(source.label);
    for (const { name, path } of paths ?? []) {
      try {
        const st = statSync(path, { bigint: true });
        if (!st.isFile()) continue;
        current.set(`${source.label}: ${name}`, { source, name, path, mtimeNs: String(st.mtimeNs), size: Number(st.size) });
      } catch { /* vanished or unreadable */ }
    }
  }
  lap("resolve");

  const baseline = baselinePath(found);
  const key = cacheKey(config);
  const restored = restoreBaseline(baseline, key, sessionPath);
  const manifest = restored?.rows;
  const warm = restored !== null;
  // A file written within a timestamp tick of the last scan can change without changing its stat.
  const racyFrom = (restored?.scannedNs ?? 0n) - 1_000_000_000n;
  lap("restore");

  const upserts: ManifestRow[] = [];
  const work: Array<{ label: string; text: string }> = [];
  let clean = 0, changed = 0, added = 0, refreshed = 0;
  for (const [label, f] of current) {
    const old = manifest?.get(label);
    const sameStat = old && old.path === f.path && old.mtime_ns === f.mtimeNs && old.size === f.size;
    if (sameStat && BigInt(f.mtimeNs) < racyFrom) {
      clean++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(f.path);
    } catch {
      current.delete(label);
      continue;
    }
    const row = { label, source: f.source.label, path: f.path, mtime_ns: f.mtimeNs, size: f.size, sha256: createHash("sha256").update(buf).digest("hex") };
    if (old?.sha256 === row.sha256) {
      if (sameStat) clean++;
      else {
        refreshed++;
        upserts.push(row);
      }
      continue;
    }
    upserts.push(row);
    if (old) changed++;
    else added++;
    work.push({ label, text: preprocessText(buf.toString("utf-8"), f.name, f.source) });
  }
  const removed = [...(manifest?.values() ?? [])]
    .filter((row) => !current.has(row.label) && !unresolved.has(row.source))
    .map((row) => row.label);
  lap("diff");

  if (!warm || work.length > 0 || removed.length > 0) {
    const store = new ContentStore(sessionPath);
    try {
      store.transaction(() => {
        for (const label of removed) store.deleteByLabel(label);
        for (const { label, text } of work) {
          if (text.trim().length > 0) store.index({ content: text, source: label });
          else store.deleteByLabel(label);
        }
      });
      // Incremental diffs stay within FTS5 automerge; a full merge only pays off after a cold build.
      if (!warm) store.optimize();
    } finally {
      store.close();
    }
  }
  lap("index");

  const db = new Database(sessionPath);
  let writeBackError: string | undefined;
  let summary: { sources: PrewarmSourceSummary[]; files: number; chunks: number };
  try {
    db.run(MANIFEST_SCHEMA);
    const dirty = !warm || upserts.length > 0 || removed.length > 0;
    if (dirty) {
      db.transaction(() => {
        db.run("DELETE FROM cache_meta");
        db.run("INSERT INTO cache_meta (key, scanned_ns) VALUES (?, ?)", [key, String(scannedNs)]);
        const del = db.prepare("DELETE FROM cache_files WHERE label = ?");
        for (const label of removed) del.run(label);
        const put = db.prepare("INSERT OR REPLACE INTO cache_files (label, source, path, mtime_ns, size, sha256) VALUES (?, ?, ?, ?, ?, ?)");
        for (const r of upserts) put.run(r.label, r.source, r.path, r.mtime_ns, r.size, r.sha256);
      })();
    }
    summary = summarize(db, config);
    lap("manifest");
    if (dirty) {
      writeBackError = writeBack(db, baseline);
      lap("write-back");
    }
  } finally {
    db.close();
  }

  return {
    warm,
    clean,
    changed,
    added,
    removed: removed.length,
    refreshed,
    ...summary,
    writeBackError,
    timings,
  };
}

/** Copy the baseline to `sessionPath` and return its manifest, or null (and an empty session DB) on any miss. */
function restoreBaseline(baseline: string, key: string, sessionPath: string): { rows: Map<string, ManifestRow>; scannedNs: bigint } | null {
  deleteDBFiles(sessionPath);
  try {
    copyFileSync(baseline, sessionPath);
    const db = new Database(sessionPath);
    try {
      const meta = db.query("SELECT key, scanned_ns FROM cache_meta").get() as { key: string; scanned_ns: string } | null;
      if (meta?.key === key) {
        const rows = db.query("SELECT label, source, path, mtime_ns, size, sha256 FROM cache_files").all() as ManifestRow[];
        return { rows: new Map(rows.map((r) => [r.label, r])), scannedNs: BigInt(meta.scanned_ns) };
      }
    } finally {
      db.close();
    }
  } catch { /* missing, unreadable or corrupt baseline */ }
  deleteDBFiles(sessionPath);
  return null;
}

/** Per-source rollup from the manifest, in config order, so cold and warm starts agree. */
function summarize(db: Database, config: Config): { sources: PrewarmSourceSummary[]; files: number; chunks: number } {
  const rows = db.query(`
    SELECT f.source AS label, COUNT(*) AS files, SUM(s.chunk_count) AS chunks
    FROM cache_files f JOIN sources s ON s.label = f.label
    GROUP BY f.source
  `).all() as Array<{ label: string; files: number; chunks: number }>;
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const sources: PrewarmSourceSummary[] = [];
  for (const source of config.sources) {
    const row = byLabel.get(source.label);
    if (!row) continue;
    byLabel.delete(source.label);
    sources.push({ label: row.label, description: source.description, files: row.files, chunks: row.chunks });
  }
  return {
    sources,
    files: sources.reduce((n, s) => n + s.files, 0),
    chunks: sources.reduce((n, s) => n + s.chunks, 0),
  };
}

/** VACUUM INTO a staging file beside the baseline, then rename it over. Returns an error message on failure. */
function writeBack(db: Database, baseline: string): string | undefined {
  const dir = dirname(baseline);
  const staging = `${baseline}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
    sweepDead(dir, /^\w+\.db\.(\d+)\.tmp$/);
    try { unlinkSync(staging); } catch { /* absent */ }
    db.run("VACUUM INTO ?", [staging]);
    renameSync(staging, baseline);
    return undefined;
  } catch (err) {
    try { unlinkSync(staging); } catch { /* absent */ }
    return (err as Error).message;
  }
}

export function formatReport(r: PrewarmReport, ms: number): string {
  const t = Object.entries(r.timings).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(", ");
  return (
    `Pre-warmed ${r.chunks} chunks from ${r.files} files in ${ms.toFixed(0)}ms ` +
    `(${r.warm ? "warm" : "cold"}: ${r.clean} clean, ${r.changed} changed, ${r.added} added, ` +
    `${r.removed} removed, ${r.refreshed} refreshed; ${t})`
  );
}
