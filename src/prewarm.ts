/**
 * Pre-warm + markdown ingest helpers for ctxmode.
 *
 * Discovers .claude/ctxmode.json, resolves source files, applies our
 * markdown-specific preprocessing, and indexes into the FTS5 content
 * database so search() works immediately.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, basename, resolve, relative } from "node:path";
import { ContentStore } from "./store.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface SourceConfig {
  label: string;
  /** Author annotation describing what this source is. Folded into the search manifest. */
  description?: string;
  path?: string;
  glob?: string;
  recursive?: boolean;
  exec?: string;
  paths?: string[];
  stripFrontmatter?: boolean;
  prefixDates?: boolean;
}

export interface SubagentProfile {
  /** Skip injection entirely — agent gets no routing block. */
  skip?: boolean;
  /** Use CORE_BLOCK + named ending. */
  ending?: "plan" | "concise";
  /** Full custom injection text, replaces entire routing block. */
  block?: string;
}

export interface Config {
  sources: SourceConfig[];
  /** Per-agent-type routing overrides for the subagent hook. */
  subagentProfiles?: Record<string, SubagentProfile>;
  /** Control search budget warnings: false strips them, a string replaces them. */
  searchReminder?: false | string;
}

export interface ResolvedFile {
  /** Display name — relative path from source base, for unique labeling. */
  name: string;
  path: string;
  content: string;
}

export interface IndexPathOptions {
  path: string;
  source?: string;
  glob?: string;
  recursive?: boolean;
  stripFrontmatter?: boolean;
  prefixDates?: boolean;
}

// ── Config Discovery ────────────────────────────────────────────────

// Env var pointing at an exact config file. When set, the upward walk is
// skipped and the file is loaded verbatim; an unreadable or invalid file is a
// hard error rather than a silent fallback, since setting it signals intent.
export const CONFIG_ENV_VAR = "CTXMODE_CONFIG";

export interface FoundConfig {
  config: Config;
  configPath: string;
  /**
   * What a relative source `path` resolves against. A discovered config
   * belongs to the directory holding its `.claude/`, so a launch from any
   * subdirectory resolves the same files. A config named by the env var
   * belongs to no project tree and resolves against `startDir`.
   */
  sourceBase: string;
}

export function findConfig(startDir: string): FoundConfig | null {
  const override = process.env[CONFIG_ENV_VAR];
  if (override) {
    const configPath = resolve(override);
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (err) {
      throw new Error(
        `${CONFIG_ENV_VAR} points at "${configPath}" but it could not be read: ${(err as Error).message}`,
      );
    }
    try {
      return { config: JSON.parse(raw), configPath, sourceBase: resolve(startDir) };
    } catch (err) {
      throw new Error(
        `${CONFIG_ENV_VAR} config at "${configPath}" is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, ".claude", "ctxmode.json");
    try {
      const raw = readFileSync(candidate, "utf-8");
      return { config: JSON.parse(raw), configPath: candidate, sourceBase: dir };
    } catch {
      // not found here, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// ── File Resolution ─────────────────────────────────────────────────

export function matchGlob(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(filename);
}

export function walkDir(dir: string, glob: string, recursive: boolean): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && recursive) {
          results.push(...walkDir(fullPath, glob, true));
        } else if (stat.isFile() && matchGlob(entry, glob)) {
          results.push(fullPath);
        }
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return results;
}

export function readFile(fullPath: string, baseDir?: string): ResolvedFile | null {
  try {
    const content = readFileSync(fullPath, "utf-8");
    if (content.trim().length === 0) return null;
    const name = baseDir ? relative(baseDir, fullPath) : basename(fullPath);
    return { name, path: fullPath, content };
  } catch {
    return null;
  }
}

function resolveSourceFiles(source: SourceConfig, sourceBase: string): ResolvedFile[] {
  const basePath = resolve(sourceBase, source.path || ".");

  // Strategy 1: explicit paths
  if (source.paths) {
    return source.paths
      .map((p) => resolve(basePath, p))
      .map((p) => readFile(p, basePath))
      .filter((f): f is ResolvedFile => f !== null);
  }

  // Strategy 2: exec command → JSON array of paths
  if (source.exec) {
    const cwd = basePath;
    try {
      const output = execSync(source.exec, {
        cwd,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      const paths = JSON.parse(output);
      if (!Array.isArray(paths)) {
        process.stderr.write(
          `[ctxmode] exec for "${source.label}" did not return an array\n`,
        );
        return [];
      }
      return paths
        .map((p: string) => resolve(cwd, p))
        .map((p) => readFile(p, cwd))
        .filter((f): f is ResolvedFile => f !== null);
    } catch (err: any) {
      process.stderr.write(
        `[ctxmode] exec for "${source.label}" failed: ${err.message}\n`,
      );
      return [];
    }
  }

  // Strategy 3: glob (flat or recursive)
  if (source.glob && source.path) {
    return walkDir(basePath, source.glob, !!source.recursive)
      .map((p) => readFile(p, basePath))
      .filter((f): f is ResolvedFile => f !== null);
  }

  process.stderr.write(
    `[ctxmode] source "${source.label}" has no file selection strategy (need glob+path, exec, or paths)\n`,
  );
  return [];
}

// ── Preprocessing ───────────────────────────────────────────────────

export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

export function prefixDates(text: string, filename: string): string {
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!dateMatch) return text;
  const date = dateMatch[1];

  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    if (/^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(line)) continue;
    const topicMatch = line.match(/^(##\s+)(.+)$/);
    if (topicMatch) {
      result.push(`${topicMatch[1]}[${date}] ${topicMatch[2]}`);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

export function preprocessText(
  text: string,
  filename: string,
  opts?: { stripFrontmatter?: boolean; prefixDates?: boolean },
): string {
  let next = text;
  if (opts?.stripFrontmatter) next = stripFrontmatter(next);
  if (opts?.prefixDates) next = prefixDates(next, filename);
  return collapseBlankLines(next);
}

function preprocessFile(file: ResolvedFile, source: SourceConfig): string {
  return preprocessText(file.content, file.name, {
    stripFrontmatter: source.stripFrontmatter,
    prefixDates: source.prefixDates,
  });
}

// ── Wrapper-side Path Indexing ──────────────────────────────────────

export function resolveIndexPathFiles(opts: IndexPathOptions): {
  basePath: string;
  isDirectory: boolean;
  files: ResolvedFile[];
  sourcePrefix: string;
} {
  const basePath = resolve(opts.path);
  const stat = statSync(basePath);
  const sourcePrefix = String(opts.source ?? basename(basePath));

  if (stat.isDirectory()) {
    const glob = opts.glob ?? "*.md";
    const recursive = opts.recursive !== false;
    const files = walkDir(basePath, glob, recursive)
      .map((p) => readFile(p, basePath))
      .filter((f): f is ResolvedFile => f !== null);
    return { basePath, isDirectory: true, files, sourcePrefix };
  }

  const file = readFile(basePath);
  return {
    basePath,
    isDirectory: false,
    files: file ? [file] : [],
    sourcePrefix,
  };
}

export function preprocessIndexPathFiles(
  files: ResolvedFile[],
  opts?: { stripFrontmatter?: boolean; prefixDates?: boolean },
): Array<{ source: string; content: string; file: ResolvedFile }> {
  const strip = opts?.stripFrontmatter !== false;
  const prefix = opts?.prefixDates === true;

  return files
    .map((file) => ({
      file,
      content: preprocessText(file.content, file.name, {
        stripFrontmatter: strip,
        prefixDates: prefix,
      }),
    }))
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      ...entry,
      source: entry.file.name,
    }));
}

// ── Pre-Warm ────────────────────────────────────────────────────────

/** Per-source-label rollup of what prewarm actually indexed. */
export interface PrewarmSourceSummary {
  label: string;
  description?: string;
  files: number;
  chunks: number;
}

/**
 * Index configured sources into the FTS5 database at `dbPath`.
 */
export function prewarm(
  config: Config,
  dbPath: string,
  sourceBase: string,
): {
  totalSources: number;
  totalChunks: number;
  sources: PrewarmSourceSummary[];
} {
  const store = new ContentStore(dbPath);

  let totalSources = 0;
  let totalChunks = 0;
  // Aggregate per source.label, preserving config order. Two source entries
  // sharing a label fold into one manifest entry.
  const summaries = new Map<string, PrewarmSourceSummary>();

  for (const source of config.sources) {
    const files = resolveSourceFiles(source, sourceBase);
    if (files.length === 0) continue;

    for (const file of files) {
      const text = preprocessFile(file, source);
      if (text.trim().length === 0) continue;
      const label = `${source.label}: ${file.name}`;
      const result = store.index({ content: text, source: label });
      totalSources++;
      totalChunks += result.totalChunks;

      const summary = summaries.get(source.label) ?? {
        label: source.label,
        description: source.description,
        files: 0,
        chunks: 0,
      };
      summary.files++;
      summary.chunks += result.totalChunks;
      summaries.set(source.label, summary);
    }
  }

  store.close();
  return {
    totalSources,
    totalChunks,
    sources: [...summaries.values()],
  };
}

/**
 * Render a one-line manifest of the pre-warmed corpus for the `search` tool
 * description. Returns null when nothing was indexed (caller falls back to the
 * static description).
 */
export function formatPrewarmManifest(
  sources: PrewarmSourceSummary[],
): string | null {
  if (sources.length === 0) return null;

  const entries = sources.map((s) => {
    const count = `\`${s.label}\` (${s.files} file${s.files === 1 ? "" : "s"})`;
    return s.description ? `${count} — ${s.description}` : count;
  });

  return (
    "Pre-warmed at startup and searchable now (no `index` call needed): " +
    `${entries.join("; ")}. Scope to one with \`source: "<label>"\`.`
  );
}
