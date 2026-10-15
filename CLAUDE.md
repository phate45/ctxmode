# ctxmode

## What This Is

A context-saving MCP server for Claude Code, shipped as one compiled Bun binary. It is a hard fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169 (`442f1eb`), cut to six tools: `execute`, `index`, `search`, `fetch_and_index`, `batch_execute`, `batch_read`. Its own addition is the pre-warmed knowledge base: configured markdown is indexed before the first tool call and cached per repo, so a warm start takes tens of milliseconds.

See `README.md` for the user-facing guide and `MIGRATION.md` for moving consumers off context-wrapper.

## File Overview

| File | Purpose |
|------|---------|
| `src/main.ts` | Entry point. Subcommands: `serve` (default), `prewarm`, `hook`, `--version`. |
| `src/server.ts` | MCP server: tool definitions, descriptions, search throttle, fetch + HTML→markdown, path ingest for `index`. |
| `src/cache.ts` | Baseline DB lifecycle: restore, diff against the manifest, apply, write back, session DB cleanup. |
| `src/prewarm.ts` | Config discovery, source resolution (glob/exec/paths), preprocessing, `PREPROCESS_VERSION`. |
| `src/hook.ts` | PreToolUse subagent routing hook. |
| `src/store.ts` | `ContentStore`: FTS5 porter + trigram tables, chunking, search, `STORE_VERSION`. |
| `src/executor.ts`, `src/runtime.ts` | Sandboxed execution of JS/TS/Python/shell. |
| `src/security.ts`, `src/util/claude-config.ts` | Deny rules read from Claude Code settings. A trust boundary. |
| `src/db-base.ts` | `bun:sqlite` setup, WAL pragmas. |
| `test/golden/` | Synthetic corpus + recorded transcript of the pre-fork wrapper; the parity net. |
| `scripts/parity-rank.ts` | Ranking parity on a real corpus. Its outputs are private and never committed. |

Files that start with `// Vendored from mksglu/context-mode ...` came from upstream. Keep them recognizable when editing, so an upstream fix can still be ported by hand.

## Architecture

One process, no subprocess or proxy. `bun:sqlite` is the only database driver. JS/TS code runs through `process.execPath` with `BUN_BE_BUN=1`, so the binary is its own Bun; the variable is deleted before user code runs, because anything it spawns (Claude Code included) would otherwise start as Bun.

### Pre-warm cache

- Baseline: `<repo>/.ctxmode/baseline.db`. `<repo>` is the parent of `git --git-common-dir` (worktrees share it), else the config's `sourceBase`. The directory writes its own `.gitignore` of `*`.
- The manifest lives inside the baseline as tables: one cache key plus `(label, source, path, mtime_ns, size, sha256)` per file. One file means one atomic rename, so concurrent write-backs need no lock.
- Cache key = `STORE_VERSION` + hash of the config's `sources` + `PREPROCESS_VERSION`. **Bump `STORE_VERSION` when chunking, schema or ranking inputs change, and `PREPROCESS_VERSION` when preprocessing output changes**; otherwise baselines keep stale content.
- Session DB: `${XDG_CACHE_HOME:-~/.cache}/ctxmode/sessions/<pid>.db`, deleted on exit; dead-PID leftovers are swept at startup.
- FTS rowids are `sourceId * 2^20 + n`, so deleting a source is a rowid range, not a scan of the UNINDEXED `source_id` column. Full `optimize` runs only after a cold build.

### Config

Walk up from CWD for `.claude/ctxmode.json` (first match wins). `CTXMODE_CONFIG` names an exact file instead and hard-errors if unreadable. A relative source `path` resolves against `sourceBase`: the directory holding `.claude/`, or the launch CWD under `CTXMODE_CONFIG`. Each consuming project owns its config; none lives here.

| Strategy | Required Fields | Description |
|----------|----------------|-------------|
| **glob** | `path` + `glob` | Match filenames in a directory. `recursive: true` for subdirs. |
| **exec** | `exec` | Shell command outputting a JSON array of file paths. 10s timeout. |
| **paths** | `paths` | Explicit array of file paths. |

Preprocessing: `stripFrontmatter`, `prefixDates` (for `YYYY-MM-DD.md`), and blank-line collapsing (always).

## The loop

`just gate` → commit → `just release` → push. Exit codes are the interface: `0` ok, `1` action needed, `2` could not run.

- `just gate` is the bar for every commit: typecheck, unit/e2e tests, and the golden check.
- A deliberate behaviour change shows up as a golden mismatch. List it in `test/golden/expected-differences.json` with a reason; never re-record `expected.json` to hide one.
- `just release` publishes `release/ctxmode` + `.sha256` only after the compiled binary passes smoke. Fleet takes it through `just fleet-ready ctxmode` and `just artifact`.

**Done means released.** A change is finished when `just gate` passes on its commit, `origin/master` carries it, and `just release` has published a binary built from that commit.

**This doc holds what is true at HEAD.** A fact about code that is gone gets deleted; an explanation that belongs to one function moves into the comment beside it.
