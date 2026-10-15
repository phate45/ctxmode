// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/server.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { cpus } from "node:os";
import { z } from "zod";
import pkg from "../package.json";
import { PolyglotExecutor, type ExecResult, type Language } from "./executor.js";
import { runPool, type PoolJob } from "./runPool.js";
import { ContentStore, deleteDBFiles, type IndexResult } from "./store.js";

import { formatReport, prewarmSession, startSession } from "./cache.js";
import { checkUrl, fetchLabel, fetchUrl, type Fetched } from "./fetch.js";
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolPermissionPatterns,
  evaluateFilePath,
  evaluateProjectContainment,
} from "./security.js";
import { classifyNonZeroExit } from "./exit-classify.js";
import { findConfig, formatPrewarmManifest, preprocessText, walkDir, type FoundConfig } from "./prewarm.js";

const TOOL_DESCRIPTIONS = {
  execute:
    "Run code in a subprocess and return what it prints. Use for derivation over files, command output, or fetched data without dumping raw bytes into context. When `path` is provided, the file's text is available to the code as FILE_CONTENT.",
  index:
    "Store content in the searchable BM25 knowledge base. When `content` is provided, it is indexed directly. When `path` is provided, ctxmode reads the file, or the matching files under a directory, relative to the working directory, applies markdown preprocessing, and indexes each file as its own source.",
  search:
    "Search indexed content with BM25/FTS5 ranking. Use after prewarm, index, fetch_and_index, batch_execute, or batch_read. Scope with `source` when you want results from a specific label or batch.",
  fetch_and_index:
    "Fetch one or more URLs, convert/index the content, and make it searchable. Use when the source is remote and you want retrieval via `search` instead of pasting raw page content into context.",
  batch_execute:
    "Run multiple shell commands, index their outputs, and optionally query the results in the same call. Use for multi-step collection where raw command output should converge into searchable indexed content.",
  batch_read:
    "Read multiple files, index them, and search across their contents. " +
    "Use instead of batch_execute when all inputs are known file paths (no shell commands needed). " +
    "Labels are auto-derived from file paths. Returns BM25 search results plus a batch ID — " +
    "pass the batch ID as `source` to `search` for follow-up questions scoped to exactly these files.",
} as const;

/** Config `searchReminder`: false drops the throttle warning, a string replaces it. */
let searchReminder: false | string | undefined;

// Prevent silent MCP server death from unhandled async errors.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[ctxmode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  try {
    writeSync(2, `[ctxmode] uncaughtException: ${err?.message ?? err}\n`);
  } finally {
    process.exit(1);
  }
});

const server = new McpServer({
  name: "ctxmode",
  version: pkg.version,
});

// Clients that list prompts and resources unconditionally get empty lists, not -32601.
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const executor = new PolyglotExecutor();

// A session DB per process, removed on exit without the close-time optimize.
const sessionPath = startSession();
process.on("exit", () => deleteDBFiles(sessionPath));

let store: ContentStore | null = null;
const getStore = (): ContentStore => (store ??= new ContentStore(sessionPath));

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * A deny result when shell code, or a shell command embedded in other code,
 * matches a Bash deny rule. Fails open: Claude Code's hooks are the primary
 * enforcement layer.
 */
function checkDenyPolicy(code: string, language: Language): ToolResult | null {
  try {
    const commands = language === "shell" ? [code] : extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.cwd());
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        const what = language === "shell" ? "" : `embedded shell command "${cmd}" `;
        return {
          content: [{ type: "text" as const, text: `Command blocked by security policy: ${what}matches deny pattern ${result.matchedPattern}` }],
          isError: true,
        };
      }
    }
  } catch { /* fail-open */ }
  return null;
}

/**
 * The one gate for every file a tool reads by path. Read deny rules apply to
 * all of them; `execute` (whose child process reads the file) must also stay
 * inside the project root unless a Read allow rule names the path. The file is
 * opened non-blocking and checked with fstat, so a FIFO or device cannot hang
 * the server and /dev/stdin cannot read the JSON-RPC stream. Returns the file's
 * text (empty for `execute`), or why it may not be used.
 */
function guardPath(path: string, forExecute = false): { path: string; text: string } | { path: string; error: string } {
  const dir = process.cwd();
  const abs = resolve(dir, path);
  try {
    if (forExecute && !evaluateProjectContainment(path, dir, readToolPermissionPatterns("Read", "allow", dir)).allowed) {
      return { path: abs, error: `resolves outside the project root (${dir}); to allow it, add "Read(${abs})" to permissions.allow in your Claude Code settings` };
    }
    const deny = evaluateFilePath(path, readToolPermissionPatterns("Read", "deny", dir), dir);
    if (deny.denied) return { path: abs, error: `blocked by Read deny policy ${deny.matchedPattern}` };
  } catch { /* fail-open: an unreadable settings file must not block in-project work */ }
  let fd: number | undefined;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { path: abs, error: "not a regular file" };
    return { path: abs, text: forExecute ? "" : readFileSync(fd, "utf-8") };
  } catch (err) {
    return { path: abs, error: (err as Error).message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

type BatchQueryScope = "batch" | "global";

function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
  scope: BatchQueryScope = "batch",
): string[] {
  const sections: string[] = [];
  let outputSize = 0;

  // When scope is "global", searchWithFallback receives `undefined` for the
  // source filter, which makes it query the entire persistent index instead
  // of only the chunks just produced by this batch's commands. Default
  // remains "batch" to preserve the historical behavior.
  const searchSource = scope === "global" ? undefined : source;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const results = store.searchWithFallback(query, 3, searchSource, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  if (scope === "global") {
    sections.push(`\n> **Scope:** Queries searched the entire persistent index (query_scope: "global").`);
  } else {
    sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`search(queries: [...])\` or call batch_execute with \`query_scope: "global"\`.`);
  }

  return sections;
}

// ─────────────────────────────────────────────────────────
// batch_execute runner — used by batch_execute handler
// ─────────────────────────────────────────────────────────

interface BatchCommand { label: string; command: string; }

interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

interface BatchRunOptions {
  /** Shared budget (concurrency=1) or per command (concurrency>1); undefined leaves timing to the MCP host. */
  timeout: number | undefined;
  concurrency: number;
  cwd?: string;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined; cwd?: string }): Promise<{ stdout: string; timedOut?: boolean }>;
}

/** The echoed `$ <command>` line is clipped so a large heredoc cannot dominate the response; the command runs in full. */
const COMMAND_ECHO_MAX = 500;

function truncateCommandForEcho(command: string): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  if (cleaned.length <= COMMAND_ECHO_MAX) return cleaned;
  return cleaned.slice(0, COMMAND_ECHO_MAX) + "…";
}


/** The code echo is clipped the same way, but keeps its lines so the program's shape stays readable. */
const CODE_ECHO_MAX = 2000;

function truncateCodeForEcho(code: string): string {
  if (code.length <= CODE_ECHO_MAX) return code;
  return code.slice(0, CODE_ECHO_MAX) + "\n… (truncated)";
}

/** The code that ran, fenced above its output, so indexed chunks keep their provenance. */
function buildExecuteEcho(language: string, code: string, path?: string): string {
  const header = path ? `path=${path}\n` : "";
  const fenced = `\`\`\`${language}\n${truncateCodeForEcho(code)}\n\`\`\``;
  return `${header}${fenced}\n\n`;
}

function formatCommandOutput(label: string, command: string, raw: string): string {
  const output = raw || "(no output)";
  const echoed = truncateCommandForEcho(command);
  return `# ${label}\n\n$ ${echoed}\n\n${output}\n`;
}

function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, cwd } = opts;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: cmd.command,
        timeout: perCmdTimeout,
        cwd,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result)));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: cmd.command,
        timeout,
        cwd,
      });
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result));
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ─────────────────────────────────────────────────────────
// Liberal string-array params
// ─────────────────────────────────────────────────────────
//
// Strict MCP clients validate tool args against the advertised JSON schema
// before dispatch, and weak models often send array params as a JSON-encoded
// string (queries: "[\"a\",\"b\"]"). Such params are advertised as
// "array OR string" and normalized back to an array by coerceStringArray.

function stringArrayParam(description: string, minItems?: number) {
  const array = z.array(z.string());
  return z
    .union([minItems === undefined ? array : array.min(minItems), z.string()])
    .describe(
      `${description} Accepts either an array of strings or a JSON-encoded array string, e.g. "[\\"a\\",\\"b\\"]".`,
    );
}

type CoerceResult =
  | { ok: true; value: string[] }
  | { ok: false; message: string };

/**
 * Normalize a string-array argument that may arrive as a real array, a
 * JSON-encoded array string, or a bare single value.
 *
 *   ["a","b"]   → ["a","b"]
 *   '["a","b"]' → ["a","b"]   (JSON-encoded array)
 *   "a"         → ["a"]       (bare value lifted to a single element)
 *   '["a"'      → error       (looks like JSON, won't parse — not masked)
 *   ""          → error
 */
function coerceStringArray(val: unknown, field: string): CoerceResult {
  if (Array.isArray(val)) {
    if (val.every((v) => typeof v === "string")) return { ok: true, value: val };
    return { ok: false, message: `${field} must be an array of strings.` };
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      return { ok: false, message: `${field} must not be empty.` };
    }
    // A leading "[" signals intent to pass an array; if it won't parse to
    // string[] that's malformed input, not a single bare query.
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          return { ok: true, value: parsed };
        }
      } catch {
        /* fall through to the error below */
      }
      return {
        ok: false,
        message: `${field} looks like a JSON array but did not parse to an array of strings: ${val}`,
      };
    }
    return { ok: true, value: [val] };
  }
  return { ok: false, message: `${field} must be an array of strings.` };
}

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "execute",
  {
    // The title is what Claude Code's approval prompt shows besides the arguments.
    title: "Run code in a subprocess (executes the supplied code)",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: TOOL_DESCRIPTIONS.execute,
    inputSchema: z.object({
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python), or echo (Shell) to output a summary to context.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
      background: z
        .preprocess(coerceBoolean, z.boolean())
        .optional()
        .default(false)
        .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE execute call instead of using background."),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for shell commands. Non-shell languages still execute from their sandbox temp directory."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
          "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
        ),
      path: z
        .string()
        .optional()
        .describe("Absolute file path or relative to project root"),
    }),
  },
  async ({ language, code, timeout, background, cwd, intent, path }) => {
    if (path !== undefined) {
      const guarded = guardPath(path, true);
      if ("error" in guarded) {
        return { content: [{ type: "text" as const, text: `File access blocked: "${path}" ${guarded.error}` }], isError: true };
      }
    }
    const denied = checkDenyPolicy(code, language);
    if (denied) return denied;

    try {
      let result: ExecResult;
      if (path !== undefined) {
        result = await executor.executeFile({ path, language, code, timeout });
      } else {
        // An async wrapper allows top-level await; it opens on the code's first line so line numbers match.
        const script = language === "javascript" || language === "typescript"
          ? `async function __cm_main(){${code}\n}\n__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? "\nsetInterval(()=>{},2147483647);" : ""}`
          : code;
        result = await executor.execute({ language, code: script, timeout, background, cwd });
      }
      return shapeExecResult(result, {
        echo: buildExecuteEcho(language, code, path),
        language,
        source: path !== undefined ? `file:${path}` : `execute:${language}`,
        timeout,
        intent,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Runtime error: ${message}` }], isError: true };
    }
  },
);

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

/** The answer to an execute call: the echo, then the output, or for large output what was indexed and matched. */
function shapeExecResult(
  result: ExecResult,
  { echo, language, source, timeout, intent }: { echo: string; language: Language; source: string; timeout?: number; intent?: string },
): ToolResult {
  const reply = (text: string, isError?: boolean): ToolResult => ({ content: [{ type: "text" as const, text: echo + text }], isError });
  if (result.timedOut) {
    const partial = result.stdout?.trim();
    if (!partial) return reply(`Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`, true);
    const note = result.backgrounded ? `process backgrounded after ${timeout}ms — still running` : `timed out after ${timeout}ms — partial output shown above`;
    return reply(`${partial}\n\n_(${note})_`);
  }
  const { isError, output } = result.exitCode === 0
    ? { isError: undefined, output: result.stdout || "(no output)" }
    : classifyNonZeroExit({ language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  const label = isError ? `${source}:error` : source;
  const bytes = Buffer.byteLength(output);
  if (intent?.trim() && bytes > INTENT_SEARCH_THRESHOLD) return reply(intentSearch(output, intent, label), isError);
  // Large output goes into the knowledge base instead of the context window.
  if (bytes > LARGE_OUTPUT_THRESHOLD) {
    return reply(result.exitCode === 0 ? indexedReply(getStore().index({ content: output, source })) : intentSearch(output, "errors failures exceptions", label), isError);
  }
  return reply(output, isError);
}

function indexedReply(r: IndexResult): string {
  return `Indexed ${r.totalChunks} sections (${r.codeChunks} with code) from: ${r.label}\nUse search(queries: ["..."]) to query this content. Use source: "${r.label}" to scope results.`;
}

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source);
  const results = persistent.searchWithFallback(intent, maxResults, source);
  // Vocabulary hints let the agent phrase follow-up searches.
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Titles and first-line previews only, not full content.
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

server.registerTool(
  "index",
  {
    title: "Index Content",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: TOOL_DESCRIPTIONS.index,
    inputSchema: z.object({
      content: z
        .string()
        .optional()
        .describe("Raw text/markdown to index. Provide this OR path, not both."),
      path: z
        .string()
        .optional()
        .describe("File or directory path to index. Relative paths resolve from the current working directory/worktree."),
      source: z
        .string()
        .optional()
        .describe('Source label. For directories, each file gets "{source}: {relative/path}". Defaults to the directory basename or resolved file path.'),
      glob: z
        .string()
        .optional()
        .describe('Directory-only filename pattern. Defaults to "*.md".'),
      recursive: z
        .boolean()
        .optional()
        .describe("Directory-only recursive walk flag. Defaults to true."),
      stripFrontmatter: z
        .boolean()
        .optional()
        .describe("Path-based indexing only. Strip YAML frontmatter before indexing. Defaults to true."),
      prefixDates: z
        .boolean()
        .optional()
        .describe("Path-based indexing only. For YYYY-MM-DD.md files, prefix ## headings with [date]. Defaults to false."),
    }),
  },
  async ({ content, path, source, glob, recursive, stripFrontmatter, prefixDates }) => {
    if (path !== undefined) {
      return indexPath({ path, source, glob, recursive, stripFrontmatter, prefixDates });
    }

    if (!content) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Either content or path must be provided",
          },
        ],
        isError: true,
      };
    }

    try {
      return { content: [{ type: "text" as const, text: indexedReply(getStore().index({ content, source })) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

/**
 * Index a file, or every glob-matched file under a directory, each as its own
 * source after markdown preprocessing. Files guardPath refuses are reported.
 */
function indexPath(args: {
  path: string;
  source?: string;
  glob?: string;
  recursive?: boolean;
  stripFrontmatter?: boolean;
  prefixDates?: boolean;
}): ToolResult {
  const basePath = resolve(process.cwd(), args.path);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(basePath).isDirectory();
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Index error: ${err.message}` }], isError: true };
  }
  const paths = isDirectory ? walkDir(basePath, args.glob ?? "*.md", args.recursive !== false) : [args.path];
  if (paths.length === 0) return { content: [{ type: "text" as const, text: `No files matched in ${basePath}.` }] };

  const store = getStore();
  const prefix = args.source ?? basename(basePath);
  const opts = { stripFrontmatter: args.stripFrontmatter !== false, prefixDates: args.prefixDates === true };
  let indexed = 0;
  let totalChunks = 0;
  const errors: string[] = [];
  for (const path of paths) {
    const name = isDirectory ? relative(basePath, path) : basename(path);
    const file = guardPath(path);
    if ("error" in file) {
      errors.push(`${name}: ${file.error}`);
      continue;
    }
    const content = preprocessText(file.text, name, opts);
    if (content.trim().length === 0) continue;
    try {
      totalChunks += store.index({ content, source: isDirectory ? `${prefix}: ${name}` : args.source ?? basePath }).totalChunks;
      indexed++;
    } catch (err: any) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  const summary = !isDirectory && indexed === 0 && errors.length === 0
    ? `Nothing indexable found at ${basePath}.`
    : isDirectory
      ? `Indexed ${indexed} file${indexed === 1 ? "" : "s"} (${totalChunks} chunks) from ${basePath}`
      : `Indexed ${totalChunks} sections from: ${args.source ?? basePath}`;

  return {
    content: [{
      type: "text" as const,
      text: errors.length > 0
        ? `${summary}\n\nErrors (${errors.length}):\n${errors.join("\n")}`
        : summary,
    }],
    isError: errors.length > 0 && indexed === 0,
  };
}

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

// Track search calls per N-second window for progressive throttling.
// Defaults preserve the historical behavior (60s window, soft-cap at 3
// calls, hard-block at 8). All three thresholds are overridable via env
// vars so users can loosen or tighten the policy without forking. Invalid
// values (non-positive numbers, NaN) fall back to the default to avoid
// silently disabling the protection.
function readPositiveEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SEARCH_WINDOW_MS = readPositiveEnv("CTXMODE_SEARCH_WINDOW_MS", 60_000);
const SEARCH_MAX_RESULTS_AFTER = readPositiveEnv("CTXMODE_SEARCH_MAX_RESULTS_AFTER", 3); // after N calls: 1 result per query
const SEARCH_BLOCK_AFTER = readPositiveEnv("CTXMODE_SEARCH_BLOCK_AFTER", 8); // after N calls: refuse, demand batching

// Search calls in the current window; the window restarts once it is older than SEARCH_WINDOW_MS.
let searchWindow = { start: 0, count: 0 };

/**
 * Accept an array param sent as a JSON-encoded string, or as one bare string
 * (lifted to a one-element array). An empty string is left for zod to reject.
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) return val; // let zod produce "non-empty" error
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON: a bare value */ }
    return [val];
  }
  return val;
}

/** Accept "true"/"false" strings as booleans; z.coerce.boolean() would read "false" as true. */
function coerceBoolean(val: unknown): unknown {
  if (typeof val === "string") {
    const t = val.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}

const searchTool = server.registerTool(
  "search",
  {
    title: "Search Indexed Content",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: TOOL_DESCRIPTIONS.search,
    inputSchema: z.object({
      queries: stringArrayParam("Array of search queries. Batch ALL questions in one call.").optional(),
      limit: z
        .coerce.number()
        .optional()
        .default(3)
        .describe("Results per query (default: 3)"),
      source: z
        .string()
        .optional()
        .describe("Filter to a specific indexed source (partial match)."),
      contentType: z
        .enum(["code", "prose"])
        .optional()
        .describe("Filter results by content type: 'code' or 'prose'."),
    }),
  },
  (params) => runSearch(params),
);

async function runSearch(params: {
  queries?: unknown;
  limit?: number;
  source?: string;
  contentType?: "code" | "prose";
}): Promise<ToolResult> {
  let queryList: string[] = [];
  if (params.queries !== undefined) {
    const coerced = coerceStringArray(params.queries, "queries");
    if (!coerced.ok) {
      return {
        content: [{ type: "text" as const, text: `Invalid arguments for search:\n  - ${coerced.message}` }],
        isError: true,
      };
    }
    queryList = coerced.value;
  }

  try {
    const store = getStore();

    // Guard: redirect when the index is empty — search is a follow-up
    // tool that requires prior indexing.
    if (store.getStats().chunks === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "Knowledge base is empty — no content has been indexed yet.\n\n" +
            "search is a follow-up tool that queries previously indexed content. " +
            "To gather and index content first, use:\n" +
            "  • batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
            "  • fetch_and_index(url) — fetch a URL, index it, then search with search\n" +
            "  • index(content, source) — manually index text content\n\n" +
            "After indexing, search becomes available for follow-up queries.",
        }],
        isError: true,
      };
    }

    if (queryList.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Error: provide query or queries." }],
        isError: true,
      };
    }

    const { limit = 3, source, contentType } = params;

    // Progressive throttling over a sliding window of calls.
    const now = Date.now();
    if (now - searchWindow.start > SEARCH_WINDOW_MS) searchWindow = { start: now, count: 0 };
    const searchCallCount = ++searchWindow.count;

    if (searchCallCount > SEARCH_BLOCK_AFTER) {
      return {
        content: [{
          type: "text" as const,
          text: searchReminder !== undefined
            ? searchReminder || ""
            : `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindow.start) / 1000)}s. ` +
              "You're flooding context. STOP making individual search calls. " +
              "Use batch_execute(commands, queries) for your next research step.",
        }],
        isError: true,
      };
    }

    // Determine per-query result limit based on throttle level
    const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
      ? 1 // after soft cap: only 1 result per query
      : Math.min(limit, 2); // normal: max 2

    const MAX_TOTAL = 40 * 1024; // 40KB total cap
    let totalSize = 0;
    const sections: string[] = [];

    for (const q of queryList) {
      if (totalSize > MAX_TOTAL) {
        sections.push(`## ${q}\n(output cap reached)\n`);
        continue;
      }

      const results = store.searchWithFallback(
        q,
        effectiveLimit,
        source,
        contentType,
        "like",
      );

      if (results.length === 0) {
        sections.push(`## ${q}\nNo results found.`);
        continue;
      }

      const formatted = results
        .map((r, i) => {
          const ts = r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "";
          const header = `--- [current-session${ts ? " | " + ts : ""} | ${r.source}] ---`;
          const heading = `### ${r.title}`;
          const snippet = extractSnippet(r.content, q, 1500, r.highlighted);
          return `${header}\n${heading}\n\n${snippet}`;
        })
        .join("\n\n");

      sections.push(`## ${q}\n\n${formatted}`);
      totalSize += formatted.length;
    }

    let output = sections.join("\n\n---\n\n");

    // Throttle counter — always surfaced so agents can pace themselves
    // proactively instead of discovering the limit only after results are
    // already truncated. Soft warning after SEARCH_MAX_RESULTS_AFTER calls;
    // gentle informational line before that.
    const throttleRemaining = Math.max(0, SEARCH_BLOCK_AFTER - searchCallCount);
    const softCapRemaining = Math.max(0, SEARCH_MAX_RESULTS_AFTER - searchCallCount);
    if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
      if (searchReminder === undefined) {
        output += `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
          `Results limited to ${effectiveLimit}/query. ${throttleRemaining} call(s) remaining before block. ` +
          `Batch queries: search(queries: ["q1","q2","q3"]) or use batch_execute.`;
      } else if (searchReminder !== false) {
        output += `\n\n${searchReminder}`;
      }
    } else {
      output += `\n\n> Throttle: call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
        `${softCapRemaining} call(s) before soft cap. ` +
        `Prefer search(queries: [...]) array form for multi-query workloads — it counts as a single call.`;
    }

    if (output.trim().length === 0) {
      const sources = store.listSources();
      const sourceList = sources.length > 0
        ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
        : "";
      return {
        content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Search error: ${message}` }],
      isError: true,
    };
  }
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

/** Cut at `maxChars` without splitting a surrogate pair: a lone surrogate is invalid in the JSON reply. */
function charSafePrefix(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  const code = str.charCodeAt(maxChars - 1);
  return str.slice(0, code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars);
}

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;
const TRANSIENT_NET = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM)\b/;

function formatFetchTtl(ttlMs: number): string {
  if (ttlMs === 0) return "0ms";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ttlMs % day === 0) return `${ttlMs / day}d`;
  if (ttlMs % hour === 0) return `${ttlMs / hour}h`;
  if (ttlMs % minute === 0) return `${ttlMs / minute}m`;
  return `${ttlMs}ms`;
}

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; url: string; source?: string; fetched: Fetched }
  | { kind: "fetch_error"; url: string; error: string };

/** Policy check, TTL cache lookup, then fetch. No store writes, so safe to run in parallel. */
async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined, ttl: number | undefined): Promise<FetchOneResult> {
  const fail = (error: string): FetchOneResult => ({
    kind: "fetch_error",
    url,
    // Keeps the agent from giving up on the first resolver hiccup.
    error: TRANSIENT_NET.test(error)
      ? `${error} — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled.`
      : error,
  });
  // Checked before the cache too, so a cached label never serves a URL the policy now refuses.
  const blocked = await checkUrl(url);
  if (blocked) return fail(blocked);

  if (!force && ttl !== 0) {
    const meta = getStore().getSourceMeta(fetchLabel(source, url));
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, ageStr, ttlStr: formatFetchTtl(cacheTtlMs) };
      }
    }
  }

  try {
    const fetched = await fetchUrl(url);
    fetched.text = fetched.text.trim();
    if (fetched.text.length === 0) return fail("empty content");
    return { kind: "fetched", url, source, fetched };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

/** One store write per call; the caller drains fetched results through it serially. */
function indexFetched({ url, source, fetched }: { url: string; source?: string; fetched: Fetched }): IndexedFetchResult {
  const store = getStore();
  const label = fetchLabel(source, url);
  const indexed = fetched.kind === "json" ? store.indexJSON(fetched.text, label)
    : fetched.kind === "text" ? store.indexPlainText(fetched.text, label)
    : store.index({ content: fetched.text, source: label });
  const preview = fetched.text.length > FETCH_PREVIEW_LIMIT
    ? charSafePrefix(fetched.text, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use search() for full content]"
    : fetched.text;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(fetched.text),
    preview,
  };
}

server.registerTool(
  "fetch_and_index",
  {
    title: "Fetch & Index URL(s)",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: TOOL_DESCRIPTIONS.fetch_and_index,
    inputSchema: z.object({
      url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content when using single `url` (e.g., 'React useEffect docs', 'Supabase Auth API'). For batch, put source in each requests entry.",
        ),
      requests: z
        .preprocess(
          coerceJsonArray,
          z.array(
            z.object({
              url: z.string().describe("URL to fetch"),
              source: z.string().optional().describe("Label for this URL's indexed content"),
            }),
          ).min(1),
        )
        .optional()
        .describe(
          "Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch. " +
          "Each request indexed under its own source label. Output preserves input order.",
        ),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max URLs to fetch in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound multi-URL batches (library docs, changelogs, pricing pages). " +
          "Capped by os.cpus().length on small machines (response notes when capped). " +
          "Indexing is always serial regardless — only fetches race.",
        ),
      force: z
        .preprocess(coerceBoolean, z.boolean())
        .optional()
        .describe("Skip cache and re-fetch even if content was recently indexed"),
      ttl: z
        .coerce.number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Override the cache freshness window for this call, in milliseconds. " +
          "`ttl: 0` bypasses the cache like `force: true`; omit to use the default 24h TTL.",
        ),
    }),
  },
  async ({ url, source, requests, concurrency, force, ttl }) => {
    // Normalize input: legacy {url} or new {requests: [...]}.
    // requests wins when both are provided (explicit batch intent).
    const batch: { url: string; source?: string }[] = requests
      ? requests
      : url
        ? [{ url, source }]
        : [];

    if (batch.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
        }],
        isError: true,
      };
    }

    const isLegacySingle = !requests && batch.length === 1;
    const requestedConcurrency = concurrency ?? 1;

    const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
      run: () => fetchOneUrl(req.url, req.source, force, ttl),
    }));
    const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
      concurrency: requestedConcurrency,
      capByCpuCount: true,
    });

    // Workers race on fetch; store writes drain one at a time here.
    type Finalized =
      | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
      | { kind: "fetched"; indexed: IndexedFetchResult }
      | { kind: "fetch_error"; url: string; error: string };

    const finalized: Finalized[] = settled.map((r, i) =>
      r.status === "rejected"
        ? { kind: "fetch_error", url: batch[i].url, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
        : r.value.kind === "fetched"
          ? { kind: "fetched", indexed: indexFetched(r.value) }
          : r.value,
    );

    if (isLegacySingle) {
      const r = finalized[0];
      if (r.kind === "cached") {
        return {
          content: [{
            type: "text" as const,
            text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: ${r.ttlStr}).\nTo refresh: call fetch_and_index again with \`force: true\`.\n\nYou MUST call search() to answer questions about this content — this cached response contains no content.\nUse: search(queries: [...], source: "${r.label}")`,
          }],
        };
      }
      if (r.kind === "fetched") {
        const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
        const text = [
          `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
          `Full content indexed in sandbox — use search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
          "",
          "---",
          "",
          r.indexed.preview,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Failed to fetch ${r.url}: ${r.error}` }],
        isError: true,
      };
    }

    // Batch response — aggregated summary; isError only when EVERY URL failed.
    // Tight per-URL previews keep an 8-URL batch from undoing the context savings.
    const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
    const lines: string[] = [];
    let totalSections = 0;
    let totalBytes = 0;
    let cachedCount = 0;
    let fetchedCount = 0;
    let errorCount = 0;
    const snippets: string[] = [];
    for (const r of finalized) {
      if (r.kind === "cached") {
        cachedCount++;
        lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
      } else if (r.kind === "fetched") {
        fetchedCount++;
        totalSections += r.indexed.totalChunks;
        totalBytes += r.indexed.totalBytes;
        const kb = (r.indexed.totalBytes / 1024).toFixed(1);
        lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
        const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
          ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
          : r.indexed.preview;
        snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
      } else {
        errorCount++;
        lines.push(`- [err]   ${r.url}: ${r.error}`);
      }
    }

    const totalKB = (totalBytes / 1024).toFixed(1);
    const cappedNote = capped
      ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
      : "";
    // Status line: counts + sections + size, with singular/plural agreement
    // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
    const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
    const headerLine =
      `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
      `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
      `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

    const text = [
      headerLine,
      "",
      ...lines,
      "",
      `search(queries: [...], source: "<label>") for full content.`,
      ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      isError: errorCount === batch.length, // only mark error if every URL failed
    };
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "batch_execute",
  {
    title: "Batch Execute & Search",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: TOOL_DESCRIPTIONS.batch_execute,
    inputSchema: z.object({
      commands: z.preprocess(coerceCommandsArray, z
        .array(
          z.object({
            label: z
              .string()
              .describe(
                "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
              ),
            command: z
              .string()
              .describe("Shell command to execute"),
          }),
        )
        .min(1)
        .describe(
          "Commands to execute as a batch. Output is labeled with the section header. " +
          "Default order is sequential; pass concurrency>1 to run in parallel (output stays in input order).",
        )),
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .min(1)
        .describe(
          "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
          "Each returns top 5 matching sections with full content. " +
          "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
        )),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs. With concurrency=1, the value (when set) is a shared budget across commands; with concurrency>1, it is applied per-command."),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max commands to run in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound batches (network, gh, curl, multi-repo git reads). " +
          "Keep at 1 for CPU-bound (npm test, build, lint) or stateful commands (ports, locks). " +
          ">1 switches to per-command timeouts (no shared budget) and " +
          "individual `(timed out)` blocks instead of cascading skip.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for all shell commands in this batch."),
      query_scope: z
        .enum(["batch", "global"])
        .optional()
        .default("batch")
        .describe(
          "Scope for `queries` (default: `batch`). " +
          "`batch` searches ONLY the chunks produced by this batch's commands " +
          "— useful when you want answers about the just-fetched output. " +
          "`global` searches the entire persistent index (same scope as search) " +
          "— useful when you want the batch commands to enrich context and " +
          "the queries to also surface related prior knowledge in one round trip.",
        ),
    }),
  },
  async ({ commands, queries, timeout, concurrency, cwd, query_scope }) => {
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "shell");
      if (denied) return denied;
    }

    try {
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(commands, { timeout, concurrency, cwd }, executor);

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${timeout}ms. No output captured.`,
            },
          ],
          isError: true,
        };
      }

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source });

      // What ran, listed above the sections it produced.
      const commandsInventory: string[] = ["## Commands", ""];
      for (const c of commands) {
        commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command)}\``);
      }

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — default scope is batch-local (legacy behavior).
      // When the caller passes query_scope: "global", searches reach the entire
      // persistent index in the same round trip. Cross-source search remains
      // available via explicit search() as well.
      const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms(indexed.sourceId);

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...commandsInventory,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_read
// ─────────────────────────────────────────────────────────

const ANCHOR_DIRS = new Set(["apps", "packages", "src", "lib"]);

function deriveLabel(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);

  let anchorIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (ANCHOR_DIRS.has(segments[i])) {
      anchorIdx = i;
      break;
    }
  }

  // Take everything after the last anchor dir; fall back to last two segments
  let relevant = anchorIdx >= 0 ? segments.slice(anchorIdx + 1) : segments.slice(-2);

  // Collapse intermediate 'src/' segments that add noise
  relevant = relevant.filter((s) => s !== "src");

  return relevant.join("/");
}

/** First occurrence keeps the clean label; subsequent duplicates get (2), (3), … */
function deduplicateLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n > 1 ? `${label} (${n})` : label;
  });
}

server.registerTool(
  "batch_read",
  {
    description: TOOL_DESCRIPTIONS.batch_read,
    inputSchema: z.object({
      files: stringArrayParam(
        "File paths to read and index. Absolute paths preferred; " +
        "relative paths resolve from the current working directory.",
        1,
      ),
      queries: stringArrayParam(
        "Search queries to run against the indexed content. Use 5–8 comprehensive queries. " +
        "Each returns top matching sections.",
        1,
      ),
    }),
  },
  async (args) => {
    const filesC = coerceStringArray(args.files, "files");
    const queriesC = coerceStringArray(args.queries, "queries");
    if (!filesC.ok || !queriesC.ok) {
      const argErrors = [filesC, queriesC].flatMap((c) => (c.ok ? [] : [c.message]));
      return {
        content: [{
          type: "text" as const,
          text: `Invalid arguments for batch_read:\n${argErrors.map((m) => `  - ${m}`).join("\n")}`,
        }],
        isError: true,
      };
    }
    const files = filesC.value;

    const batchId = randomBytes(3).toString("hex");
    const labels = deduplicateLabels(files.map((f) => deriveLabel(resolve(process.cwd(), f))));

    const store = getStore();
    const skipped: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = guardPath(files[i]);
      if ("error" in file) skipped.push(`${file.path}: ${file.error}`);
      else store.index({ content: file.text, source: `${batchId}/${labels[i]}` });
    }

    const searchResult = await runSearch({ queries: queriesC.value, source: batchId, limit: 3 });
    const searchText = searchResult.content[0]?.text ?? "(no results)";

    const errorNote =
      skipped.length > 0
        ? `\n\n⚠ Skipped ${skipped.length} file(s):\n${skipped.map((f) => `  - ${f}`).join("\n")}`
        : "";

    const followUpNote =
      `\n\n---\n**Batch ID:** \`${batchId}\`\n` +
      `To search only these files: \`search(queries: [...], source: "${batchId}")\``;

    return {
      content: [{ type: "text" as const, text: searchText + errorNote + followUpNote }],
    };
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

/** Pre-warm the configured sources, then serve MCP over stdio; a failed pre-warm serves an empty knowledge base. */
export async function serve(): Promise<void> {
  let found: FoundConfig | null = null;
  try {
    found = findConfig(process.cwd());
    if (found) {
      const start = performance.now();
      const report = prewarmSession(found, sessionPath);
      if (report.writeBackError) process.stderr.write(`[ctxmode] baseline write-back failed: ${report.writeBackError}\n`);
      process.stderr.write(`[ctxmode] ${formatReport(report, performance.now() - start)}\n`);
      // The search description lists the pre-warmed corpus so the agent needs no blind probe.
      const manifest = formatPrewarmManifest(report.sources);
      if (manifest) searchTool.update({ description: `${TOOL_DESCRIPTIONS.search}\n\n${manifest}` });
    }
  } catch (err) {
    deleteDBFiles(sessionPath);
    process.stderr.write(`[ctxmode] pre-warm failed, serving an empty knowledge base: ${(err as Error).message}\n`);
  }
  searchReminder = found?.config.searchReminder;

  process.on("exit", () => executor.cleanupBackgrounded());
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[ctxmode] MCP server ready [db=${sessionPath}]\n`);
}
