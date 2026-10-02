# Proposal: surface the pre-warmed corpus in the `search` description

## Problem

The pre-warmed index is invisible to the agent. `search`'s description
(`wrapper.ts:69-70`) is a static const — it never says *what is actually
indexed*. A capable model blind-searches and discovers the corpus by accident;
a **weak** model (the driving case for the advisor integration) often never
searches at all, because nothing tells it there is anything to find.

The data to fix this is already on hand at the right moment:

- Each pre-warmed chunk is already labeled `"${source.label}: ${file.name}"`
  (`prewarm.ts:316`).
- `prewarm()` runs (`wrapper.ts:171`) **before** `ourTools` is built
  (`wrapper.ts:180+`), and `config.sources[].label` is right there.

So the index knows its own contents — it just doesn't advertise them.

## Proposal

**1. Make the `search` description dynamic — append a manifest of what is
pre-warmed.** After prewarm, enumerate the **distinct source labels** actually
indexed and fold them into the description the wrapper hands to the host:

> Pre-warmed and searchable now (no `index` call needed):
> `advisor-docs` — advisor's architecture/storage refs; `pi-docs` — pi's own
> documentation; `pi-examples`. Scope with `source: "<label>"`.

Enumerate **labels, not files**, so it stays bounded (a handful of sources, not
hundreds of paths). When no config is found (no prewarm), fall back to today's
static string.

**2. Add an optional `description?: string` to `SourceConfig`**
(`prewarm.ts:17-26`). Today a source carries only `label`; this lets the config
*author* annotate what each source is, and the wrapper folds those annotations
into the manifest above. The steering travels with the config instead of being
hard-coded, and any MCP host that passes `tools/list` descriptions through to
its model picks it up for free.

**3. (Optional, only if cheap) per-label counts.** `prewarm` already iterates
per source (`prewarm.ts:309-321`); have it return a
`Map<label, { files, chunks }>` so the manifest can read `advisor-docs
(4 files)`. Skip if it reads as noise — labels + descriptions are the 80%.

**Explicitly not doing:** a separate top-level `searchGuidance` knob. It would
overlap the existing `searchReminder` (a post-call result filter); items 1–2
cover the pre-call steer. YAGNI.

Net change: one new optional config field plus making one description string
dynamic from data already computed before the tool list is built.

## Related: CWD vs config-relative path resolution

Superseded: a discovered config's relative source paths now resolve against the directory holding its `.claude/` (`FoundConfig.sourceBase`), and a config named by `CONTEXT_WRAPPER_CONFIG` against the launch CWD. The note below records the earlier behavior.

Worth recording because it bites worktree setups. Source paths resolve against
the wrapper's **`process.cwd()`** (and each source's own `path`), **not** the
config file's directory — `findConfig` (`prewarm.ts:63-81`) uses `configPath`
only to read the JSON. Consequences:

- **Absolute** source paths and `exec` resolvers that emit absolute paths are
  CWD-independent and robust.
- **Relative** source paths resolve against CWD, so launching from a worktree
  indexes the worktree's copy, not the main checkout's. For a review tool that
  is arguably correct, but it is load-bearing behavior.

Recommendation for callers (e.g. a sandboxed advisor spawning the wrapper):
launch with `cwd = git-root-of-launch-dir` so `findConfig` reliably walks up to
the config and relative sources resolve from a stable base. A worktree placed
*outside* the main checkout breaks the walk-up; nested worktrees are fine.
