# context-wrapper

## What This Is

A middleman MCP server wrapping [context-mode](https://github.com/mksglu/context-mode). Pre-warms the FTS5 database with configured markdown content on startup (eliminating cold-start), keeps upstream storage in a temp sandbox, renames tools (drops `ctx_` prefix), merges `execute`+`execute_file`, and hides internal/session tools.

Includes subagent routing hooks for Claude Code.

See `README.md` for the user-facing integration guide.

## File Overview

| File | Purpose |
|------|---------|
| `src/wrapper.ts` | Entry point. Middleman MCP: spawns upstream server as subprocess, forces temp-scoped storage, pre-warms DB, forwards tool calls with name mapping, and intercepts path-based indexing. |
| `src/prewarm.ts` | Config discovery, file resolution (glob/exec/paths), preprocessing, content DB path resolution, ContentStore.index(). |
| `wrapper.bundle.mjs` | Built artifact. `esbuild` output of `src/wrapper.ts` — what users run via `node`. |
| `setup.js` | Install script. Detects package manager (bun/pnpm/npm), installs deps, prints `claude mcp add` command. |
| `subagent-hook.mjs` | Claude Code PreToolUse hook — injects routing instructions into subagent prompts. |
| `scripts/check-upstream.ts` | Validates upstream coupling points against `upstream.manifest.json`. |
| `scripts/bump.ts` | Updates git dep tag → installs → runs check. |
| `package.json` | Dependencies: `context-mode` (upstream server), `@modelcontextprotocol/sdk` (MCP protocol), `zod`. |

## Architecture

### Middleman MCP

```
Claude Code ↔ Our Server (stdin/stdout) ↔ [MCP Client → child process] ↔ Upstream Server
```

Our process is both:
- An MCP **server** facing Claude Code (low-level `Server` class, raw JSON schema passthrough)
- An MCP **client** facing the upstream context-mode subprocess (spawned via `StdioClientTransport`)

### Tool Mapping

| Exposed to CC | Upstream Call | Notes |
|---------------|-------------|-------|
| `execute` | `ctx_execute` or `ctx_execute_file` | `path` param → file variant |
| `index` | `ctx_index` | Direct for `content`; wrapper-owned path/file/folder ingest for `path` |
| `search` | `ctx_search` | Name only |
| `fetch_and_index` | `ctx_fetch_and_index` | Name only |
| `batch_execute` | `ctx_batch_execute` | Name only |

Hidden: `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`.

### Pre-Warm Phase
1. Walk up from CWD looking for `.claude/context-mode.json` (first match wins). `CONTEXT_WRAPPER_CONFIG`, if set, overrides discovery with an exact file path (skips the walk; hard-errors if unreadable/invalid)
2. Spawn upstream with `CONTEXT_MODE_DIR` pointing at a wrapper-owned temp root under `/tmp/context-mode-*`
3. Resolve source files via three strategies: glob, exec, or explicit paths. A relative source `path` resolves against `findConfig`'s `sourceBase`: the directory holding `.claude/` when discovered, the launch CWD under `CONTEXT_WRAPPER_CONFIG`
4. Preprocess (strip frontmatter, prefix dates, collapse blanks)
5. Resolve the exact upstream content DB path inside the temp root and index into it using `ContentStore`
6. Upstream's lazy `getStore()` opens that pre-warmed DB on first tool call

### Startup Sequence
1. Spawn upstream `server.bundle.mjs` as child process with temp-scoped `CONTEXT_MODE_DIR`
2. MCP client connect + initialize handshake
3. Pre-warm the resolved upstream content DB path inside that temp root
4. List upstream tools, build remapped tool list
5. Register `tools/list` and `tools/call` handlers with name mapping + wrapper-owned path indexing
6. Connect server transport to Claude Code's stdio

## Coupling Points

The middleman design currently couples to three points:

### 1. ContentStore Import (pre-warm only)
```typescript
import { ContentStore } from "../node_modules/context-mode/src/store.ts";
```
Used at startup to populate the FTS5 database. Constructor accepts optional `dbPath`.

### 2. Content DB Path Resolution
```typescript
import { resolveContentStorePath } from "../node_modules/context-mode/src/session/db.ts";
```
Used to compute the exact DB path the upstream child will open inside the wrapper-owned temp storage root.

### 3. Tool Name Mapping
The `TOOL_MAP` constant maps our names to upstream `ctx_*` names. If upstream renames tools, update the map.

All other upstream internals (sandbox execution, security checks, fetch behavior, search ranking, etc.) stay inside the subprocess — we don't reimplement them.

## Upgrading context-mode

1. Run `bun run bump v<new-tag>` — updates dep, installs, runs check
2. Verify `ContentStore` constructor still accepts `dbPath`
3. Verify `resolveContentStorePath` still exists and keeps the same `projectDir + contentDir -> dbPath` contract
4. Verify tool names haven't changed (check `server.ts` `registerTool` calls)
5. Run `just test` — prewarm, cwd routing, and wrapper-owned indexing should still pass

## Per-Project Configuration

Each project that uses context-wrapper creates `.claude/context-mode.json` defining its sources. This file does NOT live in this repo — it lives in each consuming project.

## File Resolution Strategies

| Strategy | Required Fields | Description |
|----------|----------------|-------------|
| **glob** | `path` + `glob` | Match filenames in a directory. `recursive: true` for subdirs. |
| **exec** | `exec` | Shell command outputting JSON array of file paths. 10s timeout. |
| **paths** | `paths` | Explicit array of file paths. |

## Preprocessing Options

Pure functions in `src/prewarm.ts`:
- `stripFrontmatter` — removes YAML `---`/`---` blocks from file start
- `prefixDates` — for `YYYY-MM-DD.md` files, prefixes topic headings with `[date]`
- Blank line collapsing (always applied)
