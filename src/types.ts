// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/types.ts.
/**
 * Types shared by ContentStore, PolyglotExecutor and the server.
 */

// ─────────────────────────────────────────────────────────
// Execution result
// ─────────────────────────────────────────────────────────

/** Result returned by PolyglotExecutor after running a code snippet. */
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

/** Result returned after indexing content into the knowledge base. */
export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

/** A single search result returned from FTS5 BM25-ranked lookup. */
export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
  timestamp?: string;
}

/**
 * Aggregate statistics for a ContentStore instance.
 */
export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}
