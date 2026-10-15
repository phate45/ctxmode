// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/types.ts.
/**
 * types — Shared type definitions for context-mode packages.
 *
 * Contains interfaces shared by ContentStore and PolyglotExecutor.
 * Import from "./types.js".
 */

// ─────────────────────────────────────────────────────────
// Execution result
// ─────────────────────────────────────────────────────────

/**
 * Result returned by PolyglotExecutor after running a code snippet.
 * Shared here so SessionDB can record execution outcomes without importing
 * the full executor module.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Process was detached and continues running in the background. */
  backgrounded?: boolean;
}

// ─────────────────────────────────────────────────────────
// Content store shared types
// ─────────────────────────────────────────────────────────

/**
 * Result returned after indexing content into the knowledge base.
 * Shared so session tooling can record what was indexed without importing
 * ContentStore.
 */
export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

/**
 * A single search result returned from FTS5 BM25-ranked lookup.
 * Shared for consumers that display or log results outside of ContentStore.
 */
export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
  timestamp?: string;
  /**
   * Session-id attribution copied from the `chunks.session_id` column
   * (legacy unattributed chunks carry an empty string). Used by the
   * `ctx_search` per-project filter (#737) to scope shared-DB results
   * to the current project via the 2-step IN-clause strategy.
   */
  sessionId?: string;
}

/**
 * Aggregate statistics for a ContentStore instance.
 */
export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}
