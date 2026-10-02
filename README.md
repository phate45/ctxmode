# context-wrapper

Pre-warm wrapper for the [context-mode](https://github.com/mksglu/context-mode) MCP server. It keeps upstream storage in a temp sandbox, indexes configured markdown content before the first tool call, and exposes a narrow tool surface focused on sandbox execution and search.

## Requirements

- **Node.js** (v22+) — runtime (context-mode depends on `better-sqlite3`, a native addon [not yet supported](https://github.com/oven-sh/bun/issues/4290) by bun's runtime)
- A package manager: **bun** (preferred), pnpm, or npm

## Setup

```bash
cd context-wrapper/
node setup.js    # or: bun run setup.js
```

This installs dependencies and prints the `claude mcp add` command to wire up the wrapper. Run that command to register it with Claude Code.

If you already have a `context-mode` entry in your `.mcp.json`, replace it — this wrapper supersedes the direct bundle invocation.

## Project Configuration

Create `.claude/context-mode.json` in any project that should have pre-warmed content. To point at a config file outside the project tree, set `CONTEXT_WRAPPER_CONFIG` to its absolute path — the wrapper loads it verbatim and skips the upward `.claude/context-mode.json` search.

A relative source `path` resolves against the project the config belongs to: the directory holding `.claude/` for a discovered config, so every subdirectory launch indexes the same files, and the launch CWD for a config named by `CONTEXT_WRAPPER_CONFIG`. An exec or paths source that omits `path` uses that same directory.

Each source needs a `label` and a file selection strategy. Three strategies are available:

### Strategy 1: Glob (flat or recursive)

Match files by pattern in a directory.

```json
{
  "label": "work-logs",
  "path": "/absolute/path/to/logs",
  "glob": "*.md",
  "stripFrontmatter": true,
  "prefixDates": true
}
```

Add `"recursive": true` to scan subdirectories:

```json
{
  "label": "docs",
  "path": "/absolute/path/to/docs",
  "glob": "*.md",
  "recursive": true,
  "stripFrontmatter": true
}
```

### Strategy 2: Exec

Run a command that outputs a JSON array of file paths. The command runs in `path`, and relative output paths resolve from it.

```json
{
  "label": "curated",
  "path": "/project/root",
  "exec": "./list-indexable-files.sh",
  "stripFrontmatter": true
}
```

The command must print valid JSON to stdout, e.g.:

```json
["docs/guide.md", "docs/api/reference.md", "CHANGELOG.md"]
```

Timeout: 10 seconds.

### Strategy 3: Explicit Paths

Hardcode a list of file paths. Relative paths resolve from `path`.

```json
{
  "label": "key-docs",
  "paths": [
    "/absolute/path/to/architecture.md",
    "/absolute/path/to/decisions.md"
  ],
  "stripFrontmatter": true
}
```

### Source Fields Reference

| Field | Description |
|-------|-------------|
| `label` | **(required)** Source tag for scoped search (`source: "work-logs"`) |
| `description` | Short annotation of what the source is. Folded into the `search` tool description so the agent sees the pre-warmed corpus without a blind probe. |
| `path` | Base directory, absolute or relative to the config's project (see above). Required for glob, optional for exec/paths (used as CWD / base for relative paths) |
| `glob` | File pattern to match (e.g. `*.md`). Requires `path`. |
| `recursive` | Walk subdirectories when using glob. Default: `false` |
| `exec` | Shell command that outputs a JSON array of file paths |
| `paths` | Explicit array of file paths |
| `stripFrontmatter` | Remove YAML `---` frontmatter blocks from start of files. Default: `false` |
| `prefixDates` | For date-named files (`2026-02-28.md`): prefix `##` headings with `[YYYY-MM-DD]`. Default: `false` |

### Public Tool Surface

The wrapper exposes only:

- `execute`
- `index`
- `search`
- `fetch_and_index`
- `batch_execute`
- `batch_read`

Upstream meta/session tools such as stats, doctor, upgrade, purge, and insight are hidden.

### Searching Pre-Warmed Content

Pre-warmed content is searchable through the standard tools:

```
search(queries: ["tmux configuration"])
search(queries: ["authentication"], source: "work-logs")
search(queries: ["FTS5 schema"], source: "research-notes")
```

The `source` parameter matches against labels. A source labeled `"work-logs"` creates entries like `"work-logs: 2026-02-28.md"`, so `source: "work-logs"` matches all files in that source.

At startup the wrapper appends a manifest of the pre-warmed corpus to the `search` tool's description — each source's `label`, file count, and `description` (if set). Hosts that pass `tools/list` descriptions through to the model surface this automatically, so the agent knows what is already searchable.

## Runtime Indexing

Use `index(...)` for on-demand indexing.

### Index raw content

```
index(content: "# Notes\n\n...", source: "notes")
```

### Index a file or folder

```
index(path: "/path/to/doc.md")
index(path: "/path/to/docs", source: "docs")
index(path: "/path/to/docs", glob: "*.txt", recursive: true, source: "docs")
```

| Parameter | Applies To | Default | Description |
|-----------|------------|---------|-------------|
| `content` | raw content | — | Text/markdown to index directly |
| `path` | file or folder | — | File or directory to read relative to the current working directory if not absolute |
| `source` | both | path/basename | Source label. Directory indexing uses `"{source}: {relative/path}"` per file |
| `glob` | directory | `*.md` | Filename pattern for directory indexing |
| `recursive` | directory | `true` | Walk subdirectories |
| `stripFrontmatter` | path | `true` | Strip YAML frontmatter before indexing |
| `prefixDates` | path | `false` | For `YYYY-MM-DD.md`, prefix `##` headings with `[date]` |

Path-based indexing uses wrapper preprocessing, then forwards the transformed content to upstream indexing. Each file becomes its own searchable source.

## How It Works

The wrapper runs three phases on startup:

1. **Discover** — Walks up from CWD looking for `.claude/context-mode.json`. Set `CONTEXT_WRAPPER_CONFIG` to an exact config file path to skip the walk and load that file directly (a set-but-unreadable or invalid file is a hard error).
2. **Launch upstream in temp storage** — Spawns the upstream server with `CONTEXT_MODE_DIR` pointing at a wrapper-owned temp root under `/tmp/context-mode-*`
3. **Pre-warm** — Resolves the exact upstream content DB path inside that temp root and populates it with preprocessed content from the configured sources before the first search call

If no config file is found, the wrapper still launches the upstream server in temp storage but skips pre-warming.

## Preprocessing Details

### Frontmatter Stripping

Removes YAML frontmatter at the start of a file (between opening `---` and closing `---`). Does not affect horizontal rules mid-document.

### Date Prefixing

For files named `YYYY-MM-DD.md` (work logs):

- Bare date headings (`## 2026-02-28`) are removed
- Topic headings become `## [2026-02-28] Database Migration`
- This makes search results self-documenting — you can see when something happened without checking the source filename

## Search Reminder Control

The upstream context-mode server progressively throttles `search()` calls and appends warning messages after the third call in a 60-second window. If these warnings create unwanted cognitive overhead, you can control them:

```json
{
  "sources": [ ... ],
  "searchReminder": false
}
```

| Value | Effect |
|-------|--------|
| *(absent)* | Warnings pass through unchanged (default) |
| `false` | Strip all throttle warnings and block messages |
| `"custom text"` | Replace warnings with your own text |

**Note:** This only controls the *message* — the upstream throttling behavior (reduced results per query after 3 calls, hard block after 8) still applies.

## Subagent Hook (Optional)

The wrapper includes `subagent-hook.mjs` — a PreToolUse hook that teaches subagents to use context-mode tools instead of flooding the parent's context with raw output.

**What it does:**

- Injects routing instructions into every subagent prompt, directing them to use `batch_execute`, `search`, `execute_file`, etc.
- Tells subagents to keep responses under 500 words and index detailed findings into the shared knowledge base (the parent can `search()` for them afterward)
- Upgrades Bash subagents to general-purpose so they gain MCP tool access

**To enable it**, add a hook entry to `.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/context-wrapper/subagent-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace the path with the absolute path to your `context-wrapper/` directory.

**Note:** This hook nudges subagents toward context-mode tools but does not block standard tools. Subagents can still use Bash, Read, etc. when appropriate.

### Custom Subagent Profiles

By default, all subagents get a 500-word response cap and dead-drop instructions, except `Plan` agents (full output) and a few skip types. You can override this per agent type in your `.claude/context-mode.json`:

```json
{
  "sources": [ ... ],
  "subagentProfiles": {
    "review": { "ending": "plan" },
    "my-fetcher": { "skip": true },
    "custom-role": { "block": "<custom>Full replacement injection text</custom>" }
  }
}
```

Each profile key matches against `subagent_type`. Three modes (mutually exclusive):

| Field | Effect |
|-------|--------|
| `skip: true` | No routing injected — agent runs unmodified |
| `ending: "plan"` or `"concise"` | Uses the standard tool routing block with the named output constraints |
| `block: "..."` | Full custom text, replaces the entire routing injection |

Custom profiles take priority over all hardcoded defaults. You can override the built-in `Plan`, `Bash`, or skip-type behavior by defining a profile with that name.

## Portability

Copy this folder to another machine, run `node setup.js`, add the MCP server. The wrapper brings its own context-mode and better-sqlite3 as dependencies — only Node.js and a package manager (bun, pnpm, or npm) are required.
