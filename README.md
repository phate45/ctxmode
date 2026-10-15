# ctxmode

A context-saving MCP server for Claude Code: sandboxed code execution whose output stays out of the context window, and an FTS5 knowledge base that is pre-warmed from configured markdown before the first tool call.

ctxmode is a hard fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169, cut down to six tools and rebuilt as a single Bun binary. See [NOTICE](NOTICE) and [LICENSE](LICENSE) (Elastic License 2.0). Moving off context-wrapper is covered in [MIGRATION.md](MIGRATION.md).

## Requirements

- **Bun** to build. The compiled binary needs nothing else: it embeds the Bun runtime and `bun:sqlite`, and runs JS/TS code as its own Bun. Python and shell code use whatever is on `PATH`.
- Linux x86_64, glibc 2.17 or newer.

## Setup

```bash
bun install
just release          # gate -> build -> smoke -> release/ctxmode + .sha256, tag v<version>
```

Install `release/ctxmode` somewhere stable (the fleet uses `~/.local/share/ctxmode/bin/ctxmode`) and register it in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ctxmode": { "type": "stdio", "command": "${HOME}/.local/share/ctxmode/bin/ctxmode" }
  }
}
```

For development, `bun src/main.ts` runs the same server from source.

## Project Configuration

Create `.claude/ctxmode.json` in any project that should have pre-warmed content. To point at a config file outside the project tree, set `CTXMODE_CONFIG` to its absolute path — ctxmode loads it verbatim and skips the upward `.claude/ctxmode.json` search.

A relative source `path` resolves against the project the config belongs to: the directory holding `.claude/` for a discovered config, so every subdirectory launch indexes the same files, and the launch CWD for a config named by `CTXMODE_CONFIG`. An exec or paths source that omits `path` uses that same directory.

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
| `exec` | Shell command that outputs a JSON array of file paths. If it fails, the source keeps the files it had in the baseline. |
| `paths` | Explicit array of file paths |
| `stripFrontmatter` | Remove YAML `---` frontmatter blocks from start of files. Default: `false` (unlike `index` with `path`, where it defaults to `true`) |
| `prefixDates` | For date-named files (`2026-02-28.md`): prefix `##` headings with `[YYYY-MM-DD]`. Default: `false` |

### Public Tool Surface

ctxmode exposes only:

- `execute`
- `index`
- `search`
- `fetch_and_index`
- `batch_execute`
- `batch_read`

Upstream's meta and session tools (stats, doctor, upgrade, purge, insight, timeline search) are not part of the fork.

Every tool that reads a file by path (`index`, `batch_read`, `execute` with `path`) refuses files that match a Claude Code `Read(...)` deny rule and anything that is not a regular file (FIFOs, devices). `execute` with `path` must also stay inside the working directory unless a `Read(...)` allow rule names the file.

`fetch_and_index` fetches http(s) URLs only and refuses link-local (including cloud metadata), multicast and reserved addresses, checked before the first request and before each redirect. Loopback and private addresses are allowed unless `CTXMODE_FETCH_STRICT=1`. The check runs before connecting, so a DNS answer that changes in between is not caught. `HTTP_PROXY`/`HTTPS_PROXY` are honoured.

### Searching Pre-Warmed Content

Pre-warmed content is searchable through the standard tools:

```
search(queries: ["tmux configuration"])
search(queries: ["authentication"], source: "work-logs")
search(queries: ["FTS5 schema"], source: "research-notes")
```

The `source` parameter matches against labels. A source labeled `"work-logs"` creates entries like `"work-logs: 2026-02-28.md"`, so `source: "work-logs"` matches all files in that source.

At startup ctxmode appends a manifest of the pre-warmed corpus to the `search` tool's description — each source's `label`, file count, and `description` (if set). Hosts that pass `tools/list` descriptions through to the model surface this automatically, so the agent knows what is already searchable.

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

Path-based indexing runs the same preprocessing as pre-warming, except that `stripFrontmatter` defaults to `true` here and to `false` for configured sources. Files matching a Read deny rule are skipped and reported. Each file becomes its own searchable source.

## How It Works

On startup ctxmode:

1. **Discovers** the config: walks up from CWD looking for `.claude/ctxmode.json`. Set `CTXMODE_CONFIG` to an exact config file path to skip the walk and load that file directly. A source without a `label` or a file-selection strategy is skipped with a warning; an unreadable `CTXMODE_CONFIG` or a malformed config is an error.
2. **Restores the baseline**: `<repo>/.ctxmode/<id>.db` holds the indexed corpus plus a manifest of every source file's path, mtime, size and sha256. `<repo>` is the main checkout found via `git --git-common-dir`, outside git the config's directory. `<id>` hashes the config's path inside its checkout, so each config in a repo has its own baseline and worktrees share their main checkout's; a config outside the repo is identified by its absolute path. The directory carries its own `.gitignore`.
3. **Applies the diff**: files whose mtime and size match are skipped, unless modified within a second of the last scan; the rest are hashed, and only changed, added or removed files are re-indexed, in a private session copy under `~/.cache/ctxmode/sessions/<pid>.db`.
4. **Writes back** an updated baseline when anything changed (`VACUUM INTO` a staging file, then an atomic rename), and serves.

A warm start takes tens of milliseconds; a cold build (first run, or a change to the sources other than their descriptions, or to the store format) indexes everything once. The session DB is deleted on exit, and session DBs of dead processes are swept at the next startup.

`ctxmode prewarm` runs the same build/refresh without serving, which is useful to warm a project ahead of its first session. It exits 1 on a config error or a failed build.

If no config file is found, or the config or the build fails, the server logs the error to stderr and serves with an empty knowledge base.

## Preprocessing Details

### Frontmatter Stripping

Removes YAML frontmatter at the start of a file (between opening `---` and closing `---`). Does not affect horizontal rules mid-document.

### Date Prefixing

For files named `YYYY-MM-DD.md` (work logs):

- Bare date headings (`## 2026-02-28`) are removed
- Topic headings become `## [2026-02-28] Database Migration`
- This makes search results self-documenting — you can see when something happened without checking the source filename

## Search Reminder Control

ctxmode progressively throttles `search()` calls and appends warning messages after the third call in a 60-second window. If these warnings create unwanted cognitive overhead, you can control them:

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

**Note:** This only controls the *message* — the throttling behavior (reduced results per query after 3 calls, hard block after 8) still applies.

## Subagent Hook (Optional)

`ctxmode hook` is a PreToolUse hook that teaches subagents to use the ctxmode tools instead of flooding the parent's context with raw output.

**What it does:**

- Injects routing instructions into every subagent prompt, directing them to use `batch_execute`, `search`, `execute`, etc.
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
            "command": "${HOME}/.local/share/ctxmode/bin/ctxmode hook"
          }
        ]
      }
    ]
  }
}
```

### Custom Subagent Profiles

By default, all subagents get a 500-word response cap and dead-drop instructions, except `Plan` agents (full output) and a few skip types. You can override this per agent type in your `.claude/ctxmode.json`:

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

## Building and Releasing

| Recipe | Does |
|--------|------|
| `just gate` | Typecheck and tests, including the golden parity check |
| `just build` | Compile `release/build/ctxmode`, check its glibc floor and linked libraries |
| `just smoke` | Golden check, `--version` and a hook round-trip against the compiled binary |
| `just release` | gate, build, smoke, then publish `release/ctxmode` and its `.sha256`, and tag `v<version>` if that version has no tag |
| `just fleet-ready ctxmode` / `just artifact` | Version, and path of a release that is current with HEAD, for fleet delivery |

`ctxmode --version` prints the package version and the git SHA it was built from.
