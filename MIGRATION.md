# Migrating from context-wrapper to ctxmode

context-wrapper ran the upstream context-mode server as a subprocess behind a Node proxy. ctxmode is one compiled binary with a new name everywhere: the MCP key, the tool prefix, the config file and the env var. Nothing reads the old names, so every consumer has to move in one go.

## Per machine

1. Install the binary at `~/.local/share/ctxmode/bin/ctxmode` (fleet: `just artifact` on the cook, sha256 verified on delivery).
2. Apply the per-project changes below to every consumer.
3. Delete leftovers of the old runtime: `/tmp/context-mode-*` directories, and the old checkout's `node_modules/` once nothing points at `wrapper.bundle.mjs`.

## Per project

| What | Before | After |
|------|--------|-------|
| `.mcp.json` server key | `"context-mode"` | `"ctxmode"` |
| `.mcp.json` command | `node .../context-wrapper/wrapper.bundle.mjs` | `${HOME}/.local/share/ctxmode/bin/ctxmode`, no `args` |
| Permission rules in `settings*.json` | `mcp__context-mode__*` | `mcp__ctxmode__*` |
| Subagent hook command | `node .../context-wrapper/subagent-hook.mjs` | `${HOME}/.local/share/ctxmode/bin/ctxmode hook` |
| Source config | `.claude/context-mode.json` | `.claude/ctxmode.json` (same contents) |
| Exact-config env var | `CONTEXT_WRAPPER_CONFIG` | `CTXMODE_CONFIG` |
| Search throttle env vars | `CONTEXT_MODE_SEARCH_*` | `CTXMODE_SEARCH_*` |
| Strict fetch env var | `CTX_FETCH_STRICT` | `CTXMODE_FETCH_STRICT` |

The first session in each repo builds `<repo>/.ctxmode/baseline.db`. To keep that cost out of a session, run `ctxmode prewarm` in the project once after migrating. The directory ignores itself; no `.gitignore` change is needed.

## Behaviour changes

- Timeline search (`search` with `sort: "timeline"`, cross-session memory) and the `project` parameter are gone.
- Tool output refers to ctxmode tool names, never `ctx_*`.
- `index` with a `path` skips files that match a Read deny rule and reports them.
- `searchReminder` also applies to the search inside `batch_read`.
- Content indexed during a session lives only in that session's DB; the pre-warmed corpus is shared through the baseline.

## Sweep

Before declaring a machine migrated, these must find nothing outside this repo's history:

```bash
rg -uu -l 'mcp__context-mode__|context-wrapper|wrapper\.bundle\.mjs|subagent-hook\.mjs|CONTEXT_WRAPPER_CONFIG|CONTEXT_MODE_SEARCH_|CTX_FETCH_STRICT' \
  ~/Projects ~/.claude ~/.config ~/.local/bin --glob '!**/node_modules/**' --glob '!**/.git/**'
fd -HI -t f '^context-mode\.json$' ~/Projects
```

Session transcripts under `~/.claude/projects/` mention the old names and can be ignored. Agent definitions, skills and rules that teach the old tool names count as hits.

## Fleet

- `projects.yaml`: the repo now only needs to live on the cook. Drop the `upstream:` block and the `bun-install` post_sync from the context-wrapper entry, and rename it once the GitHub repo is renamed.
- `tools.yaml`: add a `ctxmode` channel modelled on `cbm`, delivered from `just fleet-ready ctxmode` and `just artifact`.
