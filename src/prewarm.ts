/**
 * Pre-warm + markdown ingest helpers for ctxmode.
 *
 * Discovers .claude/ctxmode.json, resolves source files and applies our
 * markdown-specific preprocessing; cache.ts indexes them.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, basename, resolve, relative } from "node:path";
import { z } from "zod";

/** Version of source resolution and preprocessing; a change invalidates baselines. */
export const PREPROCESS_VERSION = 1;

// ── Config ──────────────────────────────────────────────────────────

const Source = z
  .object({
    label: z.string().min(1),
    /** Author annotation describing what this source is. Folded into the search manifest. */
    description: z.string().optional(),
    path: z.string().optional(),
    glob: z.string().optional(),
    recursive: z.boolean().optional(),
    exec: z.string().optional(),
    paths: z.array(z.string()).optional(),
    stripFrontmatter: z.boolean().optional(),
    prefixDates: z.boolean().optional(),
  })
  .refine((s) => s.paths || s.exec || (s.glob && s.path), "needs `paths`, `exec`, or `glob` + `path`");

const ConfigFile = z
  .object({
    sources: z.array(z.unknown()).default([]),
    /** Per-agent-type routing overrides for the subagent hook: skip it, pick an ending, or replace the block. */
    subagentProfiles: z
      .record(z.object({ skip: z.boolean().optional(), ending: z.enum(["plan", "concise"]).optional(), block: z.string().optional() }))
      .optional(),
    /** Control search budget warnings: false strips them, a string replaces them. */
    searchReminder: z.union([z.literal(false), z.string()]).optional(),
  });

export type SourceConfig = z.infer<typeof Source>;
export type Config = Omit<z.infer<typeof ConfigFile>, "sources"> & { sources: SourceConfig[] };

const issues = (e: z.ZodError, what: string) => e.issues.map((i) => `${[what, ...i.path].join(".")}: ${i.message}`).join("; ");

/** Parse a config file; a malformed top level throws, a malformed source is skipped with a warning. */
export function parseConfig(raw: string, configPath: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }
  const top = ConfigFile.safeParse(json);
  if (!top.success) throw new Error(`config "${configPath}" is invalid: ${issues(top.error, "config")}`);
  const sources: SourceConfig[] = [];
  top.data.sources.forEach((entry, i) => {
    const source = Source.safeParse(entry);
    if (source.success) sources.push(source.data);
    else process.stderr.write(`[ctxmode] skipping a source in "${configPath}": ${issues(source.error, `sources[${i}]`)}\n`);
  });
  return { ...top.data, sources };
}

// ── Config Discovery ────────────────────────────────────────────────

// Names an exact config file and skips the upward walk; an unreadable file is
// an error rather than a fallback to discovery, since setting it signals intent.
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
    return { config: parseConfig(raw, configPath), configPath, sourceBase: resolve(startDir) };
  }

  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const configPath = join(dir, ".claude", "ctxmode.json");
    let raw: string | undefined;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch { /* not found here, keep walking */ }
    if (raw !== undefined) return { config: parseConfig(raw, configPath), configPath, sourceBase: dir };
    if (dirname(dir) === dir) return null;
  }
}

// ── File Resolution ─────────────────────────────────────────────────

export function matchGlob(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(filename);
}

export function walkDir(dir: string, glob: string, recursive: boolean, seen = new Set<string>()): string[] {
  const results: string[] = [];
  try {
    // A symlink back up the tree would otherwise be walked, and its files indexed, once per lap.
    const real = realpathSync(dir);
    if (seen.has(real)) return results;
    seen.add(real);
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && recursive) {
          results.push(...walkDir(fullPath, glob, true, seen));
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

/**
 * A configured source's files as `name` (relative to the source base) and
 * absolute `path`, or null when its exec command failed and the source's
 * previous files should be kept.
 */
export function resolveSourcePaths(
  source: SourceConfig,
  sourceBase: string,
): Array<{ name: string; path: string }> | null {
  const basePath = resolve(sourceBase, source.path || ".");
  const named = (paths: string[]) =>
    paths.map((p) => resolve(basePath, p)).map((p) => ({ name: relative(basePath, p), path: p }));

  if (source.paths) return named(source.paths);

  if (source.exec) {
    try {
      const paths = JSON.parse(execSync(source.exec, { cwd: basePath, encoding: "utf-8", timeout: 10000 }));
      if (Array.isArray(paths) && paths.every((p) => typeof p === "string")) return named(paths);
      process.stderr.write(`[ctxmode] exec for "${source.label}" did not print a JSON array of paths; keeping its previous files\n`);
    } catch (err) {
      process.stderr.write(`[ctxmode] exec for "${source.label}" failed; keeping its previous files: ${(err as Error).message}\n`);
    }
    return null;
  }

  return named(walkDir(basePath, source.glob!, !!source.recursive));
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

// ── Pre-Warm ────────────────────────────────────────────────────────

/** Per-source-label rollup of what prewarm indexed. */
export interface PrewarmSourceSummary {
  label: string;
  description?: string;
  files: number;
  chunks: number;
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
