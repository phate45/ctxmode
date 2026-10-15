// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/store.ts.
/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import { openDatabase, applyWALPragmas, closeDB, cleanOrphanedWALFiles, withRetry, deleteDBFiles, isSQLiteCorruptionError } from "./db-base.js";
import type { DatabaseInstance, PreparedStatement } from "./db-base.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

type SourceMatchMode = "like" | "exact";

type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  timestamp: string | null;
  label: string;
  rank: number;
  highlighted: string;
};

import type { IndexResult, SearchResult, StoreStats } from "./types.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Schema and chunking version; a change invalidates every persisted DB. */
export const STORE_VERSION = 1;

// Chunk rowids are `sourceId * ROWID_SPAN + n`, so one source's chunks are a
// rowid range that FTS5 deletes and reads without scanning its UNINDEXED columns.
const ROWID_SPAN = 2 ** 20;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove case-insensitive duplicate tokens while preserving the first
 * occurrence's original casing. FTS5's unicode61 tokenizer lowercases on
 * both sides, so `"Error" OR "error"` produces no extra recall — just
 * redundant index lookups. Dedup keeps the compiled query minimal.
 */
function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );

  if (words.length === 0) return '""';

  // Filter stopwords to improve BM25 ranking — common terms like "update",
  // "test", "fix" appear everywhere and dilute relevance scoring.
  // Fall back to unfiltered words if ALL terms are stopwords.
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  if (words.length === 0) return "";

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// Oversized chunks (e.g., a 50KB section between two headings) hurt BM25
// length normalization and produce unwieldy search results. Split at paragraph
// boundaries when a chunk exceeds this cap.
const MAX_CHUNK_BYTES = 4096;

// Blank-line sectioning is used only for output that is *naturally* sectioned:
// at least a few sections, not an unbounded explosion, and no single section so
// large that the split is clearly not the real structure (those fall back to
// line-grouping). Sections that pass the heuristic but still exceed
// MAX_CHUNK_BYTES are sub-split so no persisted chunk breaks the cap.
const MIN_BLANK_LINE_SECTIONS = 3;
const MAX_BLANK_LINE_SECTIONS = 200;
const BLANK_SECTION_STRATEGY_MAX_BYTES = 5000;

// Number of leading characters of a chunk's first line used as its title.
const CHUNK_TITLE_MAX_CHARS = 80;

// When byte-splitting an oversized single line, prefer to break at a whitespace
// boundary for readability — but only if that boundary is past this fraction of
// the slice, otherwise we'd waste too much of the byte budget.
const WHITESPACE_BREAK_RATIO = 0.5;

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

// ── Proximity helpers (pure functions) ──

/** Find all positions of a term in text. */
function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 * For each pair (term[i], term[i+1]), pairs each left position with at most one
 * right position whose offset falls within `gap` chars of `p + len(term[i])`.
 * `positionLists` must be sorted ascending (output of `findAllPositions` is).
 * Each right position is consumed by at most one left, so `"foo foo bar"`
 * counts 1 pair, not 2 — matches IR phrase-occurrence intent and avoids
 * inflating boosts for repeated-token queries.
 * Used by reranker to layer a frequency signal on top of minSpan proximity:
 * 30-char gap covers natural prose without rewarding distant matches.
 */
function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists;
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;

  // ── Cached Prepared Statements ──
  // Prepared once at construction, reused on every call to avoid
  // re-compiling SQL on each invocation.

  // Write path
  #stmtInsertSourceEmpty!: PreparedStatement;
  #stmtInsertSource!: PreparedStatement;
  #stmtInsertChunk!: PreparedStatement;
  #stmtInsertChunkTrigram!: PreparedStatement;
  #stmtInsertVocab!: PreparedStatement;

  // Dedup path (delete previous source with same label before re-indexing)
  #stmtSourceIdsByLabel!: PreparedStatement;
  #stmtDeleteChunksByRowid!: PreparedStatement;
  #stmtDeleteChunksTrigramByRowid!: PreparedStatement;
  #stmtDeleteSource!: PreparedStatement;

  // Search path (hot)
  #stmtSearchPorter!: PreparedStatement;
  #stmtSearchPorterFiltered!: PreparedStatement;
  #stmtSearchPorterExact!: PreparedStatement;
  #stmtSearchTrigram!: PreparedStatement;
  #stmtSearchTrigramFiltered!: PreparedStatement;
  #stmtSearchTrigramExact!: PreparedStatement;
  #stmtFuzzyVocab!: PreparedStatement;
  #stmtSearchPorterContentType!: PreparedStatement;
  #stmtSearchPorterFilteredContentType!: PreparedStatement;
  #stmtSearchPorterExactContentType!: PreparedStatement;
  #stmtSearchTrigramContentType!: PreparedStatement;
  #stmtSearchTrigramFilteredContentType!: PreparedStatement;
  #stmtSearchTrigramExactContentType!: PreparedStatement;

  // Read path
  #stmtListSources!: PreparedStatement;
  #stmtChunksBySource!: PreparedStatement;
  #stmtSourceChunkCount!: PreparedStatement;
  #stmtChunkContent!: PreparedStatement;
  #stmtStats!: PreparedStatement;
  #stmtSourceMeta!: PreparedStatement;

  // Fuzzy correction cache (process-local LRU). fuzzyCorrect() hits the vocab
  // DB and runs levenshtein against every candidate within length tolerance,
  // which is CPU-linear in |candidates|. Repeated queries ("erro", "erro" …)
  // recompute the same answer. The vocabulary table is insert-only, so cache
  // entries only become stale when new words enter — we clear on actual insert.
  #fuzzyCache = new Map<string, string | null>();
  static readonly FUZZY_CACHE_SIZE = 256;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
    cleanOrphanedWALFiles(this.#dbPath);
    let db: DatabaseInstance;
    try {
      db = openDatabase(this.#dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        deleteDBFiles(this.#dbPath);
        cleanOrphanedWALFiles(this.#dbPath);
        try {
          db = openDatabase(this.#dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after deleting corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    this.#initSchema();
    this.#prepareStatements();
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);
  }

  #prepareStatements(): void {
    // Write path
    this.#stmtInsertSourceEmpty = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, 0, 0)",
    );
    this.#stmtInsertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)",
    );
    this.#stmtInsertChunk = this.#db.prepare(
      "INSERT INTO chunks (rowid, title, content, source_id, content_type) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stmtInsertChunkTrigram = this.#db.prepare(
      "INSERT INTO chunks_trigram (rowid, title, content, source_id, content_type) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stmtInsertVocab = this.#db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    );

    // Dedup path: delete previous source with same label before re-indexing
    // Prevents stale outputs from accumulating in iterative workflows (build-fix-build)
    this.#stmtSourceIdsByLabel = this.#db.prepare(
      "SELECT id FROM sources WHERE label = ?",
    );
    this.#stmtDeleteChunksByRowid = this.#db.prepare(
      "DELETE FROM chunks WHERE rowid BETWEEN ? AND ?",
    );
    this.#stmtDeleteChunksTrigramByRowid = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE rowid BETWEEN ? AND ?",
    );
    this.#stmtDeleteSource = this.#db.prepare(
      "DELETE FROM sources WHERE id = ?",
    );

    // Search path (hot)
    this.#stmtSearchPorter = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFiltered = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExact = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigram = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFiltered = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExact = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Content-type filtered variants
    this.#stmtSearchPorterContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFilteredContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExactContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFilteredContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExactContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.indexed_at AS timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Fuzzy path
    this.#stmtFuzzyVocab = this.#db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );

    // Read path
    this.#stmtListSources = this.#db.prepare(
      "SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC",
    );
    this.#stmtChunksBySource = this.#db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.rowid BETWEEN ? AND ?
       ORDER BY c.rowid`,
    );
    this.#stmtSourceChunkCount = this.#db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    );
    this.#stmtChunkContent = this.#db.prepare(
      "SELECT content FROM chunks WHERE rowid BETWEEN ? AND ?",
    );
    this.#stmtSourceMeta = this.#db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at FROM sources WHERE label = ?",
    );
    // Counts come from sources: COUNT(*) on an FTS5 table scans every row.
    this.#stmtStats = this.#db.prepare(`
      SELECT
        COUNT(*) AS sources,
        COALESCE(SUM(chunk_count), 0) AS chunks,
        COALESCE(SUM(code_chunk_count), 0) AS codeChunks
      FROM sources
    `);
  }

  // ── Index ──

  index(options: { content: string; source?: string }): IndexResult {
    const { content, source } = options;
    const label = source ?? "untitled";
    const chunks = this.#chunkMarkdown(content);
    return withRetry(() => this.#insertChunks(chunks, label, content));
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.#insertChunks([], source, "");
    }

    const chunks = this.#chunkPlainText(content, linesPerChunk, maxChunkBytes);

    return withRetry(() => this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
    ));
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source, undefined, maxChunkBytes);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source, undefined, maxChunkBytes);
    }

    const chunks: Chunk[] = [];
    this.#walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source, undefined, maxChunkBytes);
    }

    return withRetry(() => this.#insertChunks(chunks, source, content));
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(
    chunks: Chunk[],
    label: string,
    text: string,
  ): IndexResult {
    const codeChunks = chunks.filter((c) => c.hasCode).length;
    if (chunks.length >= ROWID_SPAN) {
      throw new Error(`refusing to index ${label}: ${chunks.length} chunks exceeds ${ROWID_SPAN - 1}`);
    }

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#deleteByLabel(label);

      if (chunks.length === 0) {
        const info = this.#stmtInsertSourceEmpty.run(label);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmtInsertSource.run(label, chunks.length, codeChunks);
      const sourceId = Number(info.lastInsertRowid);

      let rowid = sourceId * ROWID_SPAN;
      for (const chunk of chunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmtInsertChunk.run(rowid, chunk.title, chunk.content, sourceId, ct);
        this.#stmtInsertChunkTrigram.run(rowid, chunk.title, chunk.content, sourceId, ct);
        rowid++;
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) this.#extractAndStoreVocabulary(text);

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  /** Delete every source carrying `label`, with its chunks. Returns the count removed. */
  deleteByLabel(label: string): number {
    return this.#db.transaction(() => this.#deleteByLabel(label))();
  }

  #deleteByLabel(label: string): number {
    const rows = this.#stmtSourceIdsByLabel.all(label) as Array<{ id: number }>;
    for (const { id } of rows) {
      const [first, last] = ContentStore.#rowidRange(id);
      this.#stmtDeleteChunksByRowid.run(first, last);
      this.#stmtDeleteChunksTrigramByRowid.run(first, last);
      this.#stmtDeleteSource.run(id);
    }
    return rows.length;
  }

  static #rowidRange(sourceId: number): [number, number] {
    return [sourceId * ROWID_SPAN, sourceId * ROWID_SPAN + ROWID_SPAN - 1];
  }

  /** Run `fn` in one transaction; index calls inside it nest as savepoints. */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  // ── Search ──

  #mapSearchRows(rows: SearchRow[]): SearchResult[] {
    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
      highlighted: r.highlighted,
      timestamp: r.timestamp ?? undefined,
    }));
  }

  #sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
    if (sourceMatchMode === "exact") return source;
    // Escape SQLite LIKE metacharacters so user-supplied source labels
    // containing `_`, `%`, or `\` are matched literally rather than as
    // wildcards. Backslash must be replaced first (otherwise subsequent
    // escapes would themselves be re-escaped). Paired with `ESCAPE '\'`
    // in the four prepared LIKE statements (#stmtSearchPorter*,
    // #stmtSearchTrigram*). Regression: #646.
    const escaped = source
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    return `%${escaped}%`;
  }

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeQuery(query, mode);

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExactContentType
        : this.#stmtSearchPorterFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExact
        : this.#stmtSearchPorterFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchPorterContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchPorter;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExactContentType
        : this.#stmtSearchTrigramFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExact
        : this.#stmtSearchTrigramFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchTrigramContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchTrigram;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    // Cache hit: promote to tail (Map preserves insertion order → LRU).
    if (this.#fuzzyCache.has(word)) {
      const cached = this.#fuzzyCache.get(word) ?? null;
      this.#fuzzyCache.delete(word);
      this.#fuzzyCache.set(word, cached);
      return cached;
    }

    const maxDist = maxEditDistance(word.length);

    const candidates = this.#stmtFuzzyVocab.all(
      word.length - maxDist,
      word.length + maxDist,
    ) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;
    let exactMatch = false;

    for (const { word: candidate } of candidates) {
      if (candidate === word) {
        exactMatch = true;
        break;
      }
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    const result = exactMatch ? null : bestDist <= maxDist ? bestWord : null;

    // Evict the oldest entry before insert if we hit the size cap.
    if (this.#fuzzyCache.size >= ContentStore.FUZZY_CACHE_SIZE) {
      const oldestKey = this.#fuzzyCache.keys().next().value;
      if (oldestKey !== undefined) this.#fuzzyCache.delete(oldestKey);
    }
    this.#fuzzyCache.set(word, result);

    return result;
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  #rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const K = 60; // Standard RRF constant
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, "OR", contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, "OR", contentType, sourceMatchMode);

    const scoreMap = new Map<string, { result: SearchResult; score: number }>();
    const key = (r: SearchResult) => `${r.source}::${r.title}`;

    for (const [i, r] of porterResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    for (const [i, r] of trigramResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({ ...result, rank: -score }));
  }

  // ── Proximity Reranking ──

  #applyProximityReranking(
    results: SearchResult[],
    query: string,
  ): SearchResult[] {
    const allTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    // Exclude stopwords from proximity/title scoring — they match everywhere
    // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
    const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
    const terms = filtered.length > 0 ? filtered : allTerms;

    return results
      .map((r) => {
        // Title-match boost: query terms found in the chunk title get a boost.
        // Code chunks get a stronger title boost (function/class names are high
        // signal) while prose chunks get a moderate one (headings are useful but
        // body carries more weight).
        const titleLower = r.title.toLowerCase();
        const titleHits = terms.filter((t) => titleLower.includes(t)).length;
        const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
        const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

        // Proximity boost for multi-term queries. minSpan picks the single
        // tightest window — frequency doesn't move it, so a long doc with one
        // tight occurrence outranks a short doc with several. Phrase-frequency
        // reward layers a saturating frequency signal on top: cap 0.5 (below
        // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
        let proximityBoost = 0;
        let phraseBoost = 0;
        if (terms.length >= 2) {
          const content = r.content.toLowerCase();
          const positions = terms.map((t) => findAllPositions(content, t));

          if (!positions.some((p) => p.length === 0)) {
            const minSpan = findMinSpan(positions);
            proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

            const adjacentPairs = countAdjacentPairs(positions, terms);
            phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
          }
        }

        return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
      })
      .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
      .map(({ result }) => result);
  }

  // ── Unified Fallback Search ──

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    // Step 1: RRF fusion (porter OR + trigram OR → merge)
    const rrfResults = this.#rrfSearch(query, limit, source, contentType, sourceMatchMode);
    if (rrfResults.length > 0) {
      const reranked = this.#applyProximityReranking(rrfResults.slice(0, limit), query);
      return reranked.map((r) => ({ ...r, matchLayer: "rrf" as const }));
    }

    // Step 2: Fuzzy correction → RRF re-run
    // Skip stopwords — they'll be filtered by sanitizeQuery anyway, and each
    // fuzzyCorrect call hits the vocab DB + runs levenshtein comparisons.
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzyResults = this.#rrfSearch(correctedQuery, limit, source, contentType, sourceMatchMode);
      if (fuzzyResults.length > 0) {
        const reranked = this.#applyProximityReranking(fuzzyResults.slice(0, limit), correctedQuery);
        return reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const }));
      }
    }

    return [];
  }

  // ── Sources ──

  getSourceMeta(label: string): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string } | null {
    const row = this.#stmtSourceMeta.get(label) as { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, codeChunkCount: row.code_chunk_count, indexedAt: row.indexed_at };
  }

  listSources(): Array<{ label: string; chunkCount: number }> {
    return this.#stmtListSources.all() as Array<{
      label: string;
      chunkCount: number;
    }>;
  }

  /**
   * Get all chunks for a given source by ID — bypasses FTS5 MATCH entirely.
   * Use this for inventory/listing where you need all sections, not search.
   */
  getChunksBySource(sourceId: number): SearchResult[] {
    const rows = this.#stmtChunksBySource.all(...ContentStore.#rowidRange(sourceId)) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: 0,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#stmtSourceChunkCount.get(sourceId) as
      | { chunk_count: number }
      | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    // Stream chunks one at a time to avoid loading all content into memory
    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of this.#stmtChunkContent.iterate(...ContentStore.#rowidRange(sourceId)) as Iterable<{ content: string }>) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries())
      .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

    // Score: IDF (rarity) + length bonus + identifier bonus (underscore/camelCase)
    const scored = filtered.map(([word, count]: [string, number]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const hasSpecialChars = /[_]/.test(word);
      const isCamelOrLong = word.length >= 12;
      const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a: { word: string; score: number }, b: { word: string; score: number }) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s: { word: string; score: number }) => s.word);
  }

  // ── Stats ──

  getStats(): StoreStats {
    const row = this.#stmtStats.get() as {
      sources: number;
      chunks: number;
      codeChunks: number;
    } | undefined;

    return {
      sources: row?.sources ?? 0,
      chunks: row?.chunks ?? 0,
      codeChunks: row?.codeChunks ?? 0,
    };
  }

  /** Merge FTS5 b-tree segments for both porter and trigram indexes. */
  optimize(): void {
    try {
      this.#db.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
      this.#db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')");
    } catch { /* best effort — don't block indexing */ }
  }

  close(): void {
    closeDB(this.#db); // WAL checkpoint before close — important for persistent DBs
  }

  // ── Vocabulary Extraction ──

  #extractAndStoreVocabulary(content: string): void {
    const words = content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const unique = [...new Set(words)];

    let inserted = 0;
    this.#db.transaction(() => {
      for (const word of unique) {
        const info = this.#stmtInsertVocab.run(word);
        inserted += info.changes;
      }
    })();

    // Invalidate fuzzy cache when new vocab words actually land. INSERT OR
    // IGNORE reports changes=0 for duplicates, so re-indexing identical
    // content does not thrash the cache during iterative workflows.
    if (inserted > 0) this.#fuzzyCache.clear();
  }

  // ── Chunking ──

  #chunkMarkdown(text: string, maxChunkBytes: number = MAX_CHUNK_BYTES): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;

      const title = this.#buildTitle(headingStack, currentHeading);
      const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

      // If under the cap, emit as-is (fast path — most chunks hit this)
      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({ title, content: joined, hasCode });
        currentContent = [];
        return;
      }

      // Split oversized chunk at paragraph boundaries (double newlines)
      const paragraphs = joined.split(/\n\n+/);
      let accumulator: string[] = [];
      let partIndex = 1;

      const flushAccumulator = () => {
        if (accumulator.length === 0) return;
        const part = accumulator.join("\n\n").trim();
        if (part.length === 0) return;
        const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
        partIndex++;
        chunks.push({
          title: partTitle,
          content: part,
          hasCode: part.includes("```"),
        });
        accumulator = [];
      };

      for (const para of paragraphs) {
        accumulator.push(para);
        const candidate = accumulator.join("\n\n");
        if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 1) {
          accumulator.pop();
          flushAccumulator();
          accumulator = [para];
        }
      }
      flushAccumulator();

      currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule separator (Context7 uses long dashes)
      if (/^[-_*]{3,}\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      // Heading (H1-H4)
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flush();

        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();

        // Pop deeper levels from stack
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading });
        currentHeading = heading;

        currentContent.push(line);
        i++;
        continue;
      }

      // Code block — collect entire block as a unit
      const codeMatch = line.match(/^(`{3,})(.*)?$/);
      if (codeMatch) {
        const fence = codeMatch[1];
        const codeLines: string[] = [line];
        i++;

        while (i < lines.length) {
          codeLines.push(lines[i]);
          if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
            i++;
            break;
          }
          i++;
        }

        currentContent.push(...codeLines);
        continue;
      }

      // Regular line
      currentContent.push(line);
      i++;
    }

    // Flush remaining content
    flush();

    return chunks;
  }

  /**
   * Return the largest prefix of `str` whose UTF-8 byte length does not exceed
   * `maxBytes`, walking by Unicode code point so multibyte sequences (CJK) and
   * surrogate pairs (emoji) are never cut mid-character. Guarantees forward
   * progress: if even the first code point exceeds `maxBytes`, it is still
   * returned whole (a 1-4 byte overshoot beats an infinite loop).
   */
  #byteCappedPrefix(str: string, maxBytes: number): string {
    if (Buffer.byteLength(str) <= maxBytes) return str;
    let prefix = "";
    let bytes = 0;
    for (const char of str) {
      const charBytes = Buffer.byteLength(char);
      if (bytes + charBytes > maxBytes) break;
      prefix += char;
      bytes += charBytes;
    }
    // Defensive: a single code point wider than the cap (only possible with a
    // pathologically small maxBytes) still advances by one character.
    if (prefix.length === 0) return [...str][0] ?? "";
    return prefix;
  }

  /**
   * Split a single oversized plain-text chunk into byte-capped sub-chunks
   * by accumulating lines until the byte count would exceed maxChunkBytes.
   * Falls back to byte-accurate splitting for extremely long single lines.
   */
  #splitOversizedPlainChunk(
    lines: string[],
    titlePrefix: string,
    maxChunkBytes: number,
  ): Array<{ title: string; content: string }> {
    const subChunks: Array<{ title: string; content: string }> = [];
    let accumulator: string[] = [];
    let partIndex = 1;

    const flushAccumulator = () => {
      if (accumulator.length === 0) return;
      const content = accumulator.join("\n");
      const partTitle = partIndex === 1 ? titlePrefix : `${titlePrefix} (${partIndex})`;
      subChunks.push({ title: partTitle, content });
      partIndex++;
      accumulator = [];
    };

    for (const line of lines) {
      // If a single line itself exceeds the cap (even as first line),
      // split it by character before accumulating
      if (Buffer.byteLength(line) > maxChunkBytes) {
        flushAccumulator();
        // Split the long line into byte-capped pieces
        let remaining = line;
        let linePart = 1;
        while (remaining.length > 0) {
          // Byte-accurate slice: never exceeds the cap, never cuts a multibyte
          // character (CJK) or surrogate pair (emoji) in half.
          let slice = this.#byteCappedPrefix(remaining, maxChunkBytes);
          // Try to break at a whitespace boundary near the end for readability,
          // but only when text remains after this slice.
          if (slice.length < remaining.length) {
            const lastSpace = slice.lastIndexOf(" ");
            const lastNewline = slice.lastIndexOf("\n");
            const breakPoint = Math.max(lastSpace, lastNewline);
            if (breakPoint > slice.length * WHITESPACE_BREAK_RATIO) {
              slice = slice.slice(0, breakPoint);
            }
          }
          const linePartTitle = partIndex === 1 && linePart === 1
            ? titlePrefix
            : `${titlePrefix} (${partIndex}.${linePart})`;
          subChunks.push({ title: linePartTitle, content: slice });
          remaining = remaining.slice(slice.length);
          linePart++;
          partIndex++;
        }
        continue;
      }

      const candidate = accumulator.length > 0
        ? accumulator.join("\n") + "\n" + line
        : line;

      // If adding this line would exceed the cap, flush accumulator first
      if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 0) {
        flushAccumulator();
      }
      accumulator.push(line);
    }
    flushAccumulator();
    return subChunks;
  }

  #chunkPlainText(
    text: string,
    linesPerChunk: number,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): Array<{ title: string; content: string }> {
    // Try blank-line splitting first for naturally-sectioned output
    const sections = text.split(/\n\s*\n/);
    if (
      sections.length >= MIN_BLANK_LINE_SECTIONS &&
      sections.length <= MAX_BLANK_LINE_SECTIONS &&
      sections.every((s) => Buffer.byteLength(s) < BLANK_SECTION_STRATEGY_MAX_BYTES)
    ) {
      return sections.flatMap((section, i) => {
        const trimmed = section.trim();
        if (trimmed.length === 0) return [];
        const title = trimmed.split("\n")[0].slice(0, CHUNK_TITLE_MAX_CHARS) || `Section ${i + 1}`;
        // A section may pass the strategy guard yet still exceed the byte cap
        // (4097–4999B band): sub-split it so no stored chunk breaks the cap.
        if (Buffer.byteLength(trimmed) <= maxChunkBytes) {
          return [{ title, content: trimmed }];
        }
        return this.#splitOversizedPlainChunk(trimmed.split("\n"), title, maxChunkBytes);
      });
    }

    const lines = text.split("\n");

    // Small enough for a single chunk — but still enforce byte cap
    if (lines.length <= linesPerChunk) {
      if (Buffer.byteLength(text) <= maxChunkBytes) {
        return [{ title: "Output", content: text }];
      }
      return this.#splitOversizedPlainChunk(lines, "Output", maxChunkBytes);
    }

    // Fixed-size line groups with 2-line overlap
    const chunks: Array<{ title: string; content: string }> = [];
    const overlap = 2;
    const step = Math.max(linesPerChunk - overlap, 1);

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + linesPerChunk);
      if (slice.length === 0) break;
      const startLine = i + 1;
      const endLine = Math.min(i + slice.length, lines.length);
      const firstLine = slice[0]?.trim().slice(0, CHUNK_TITLE_MAX_CHARS);
      const joined = slice.join("\n");

      // Enforce byte cap: sub-split oversized line-group chunks
      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({
          title: firstLine || `Lines ${startLine}-${endLine}`,
          content: joined,
        });
      } else {
        const subChunks = this.#splitOversizedPlainChunk(
          slice,
          firstLine || `Lines ${startLine}-${endLine}`,
          maxChunkBytes,
        );
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }

  #walkJSON(
    value: unknown,
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const title = path.length > 0 ? path.join(" > ") : "(root)";
    const serialized = JSON.stringify(value, null, 2);

    // Small enough — emit as a single chunk
    if (Buffer.byteLength(serialized) <= maxChunkBytes) {
      // Exception: objects with nested structure (object/array values) always
      // recurse so that key paths become chunk titles for searchability —
      // even when the subtree fits in one chunk. Flat objects (all primitive
      // values) stay as a single chunk since there's no hierarchy to expose.
      const shouldRecurse =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).some(
          (v) => typeof v === "object" && v !== null,
        );

      if (!shouldRecurse) {
        chunks.push({ title, content: serialized, hasCode: true });
        return;
      }
    }

    // Object — recurse into each key
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [key, val] of entries) {
          this.#walkJSON(val, [...path, key], chunks, maxChunkBytes);
        }
        return;
      }
      // Empty object — emit as-is
      chunks.push({ title, content: serialized, hasCode: true });
      return;
    }

    // Array — batch by size with identity-field-aware titles
    if (Array.isArray(value)) {
      this.#chunkJSONArray(value, path, chunks, maxChunkBytes);
      return;
    }

    // Primitive that exceeds maxChunkBytes (e.g., very long string)
    chunks.push({ title, content: serialized, hasCode: false });
  }

  /**
   * Scan the first element of an array of objects for a recognizable
   * identity field. Returns the field name or null.
   */
  #findIdentityField(arr: unknown[]): string | null {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) return null;

    const candidates = ["id", "name", "title", "path", "slug", "key", "label"];
    const obj = first as Record<string, unknown>;
    for (const field of candidates) {
      if (field in obj && (typeof obj[field] === "string" || typeof obj[field] === "number")) {
        return field;
      }
    }
    return null;
  }

  #jsonBatchTitle(
    prefix: string,
    startIdx: number,
    endIdx: number,
    batch: unknown[],
    identityField: string | null,
  ): string {
    const sep = prefix ? `${prefix} > ` : "";

    if (!identityField) {
      return startIdx === endIdx
        ? `${sep}[${startIdx}]`
        : `${sep}[${startIdx}-${endIdx}]`;
    }

    const getId = (item: unknown) =>
      String((item as Record<string, unknown>)[identityField]);

    if (batch.length === 1) {
      return `${sep}${getId(batch[0])}`;
    }
    if (batch.length <= 3) {
      return sep + batch.map(getId).join(", ");
    }
    return `${sep}${getId(batch[0])}\u2026${getId(batch[batch.length - 1])}`;
  }

  #chunkJSONArray(
    arr: unknown[],
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const prefix = path.length > 0 ? path.join(" > ") : "(root)";
    const identityField = this.#findIdentityField(arr);

    let batch: unknown[] = [];
    let batchStart = 0;

    const flushBatch = (batchEnd: number) => {
      if (batch.length === 0) return;
      const title = this.#jsonBatchTitle(prefix, batchStart, batchEnd, batch, identityField);
      chunks.push({
        title,
        content: JSON.stringify(batch, null, 2),
        hasCode: true,
      });
    };

    for (let i = 0; i < arr.length; i++) {
      batch.push(arr[i]);
      const candidate = JSON.stringify(batch, null, 2);

      if (Buffer.byteLength(candidate) > maxChunkBytes && batch.length > 1) {
        batch.pop();
        flushBatch(i - 1);
        batch = [arr[i]];
        batchStart = i;
      }
    }

    // Flush remaining
    flushBatch(batchStart + batch.length - 1);
  }

  #buildTitle(
    headingStack: Array<{ level: number; text: string }>,
    currentHeading: string,
  ): string {
    if (headingStack.length === 0) {
      return currentHeading || "Untitled";
    }
    return headingStack.map((h) => h.text).join(" > ");
  }
}
