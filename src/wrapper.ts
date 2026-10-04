/**
 * context-wrapper — Middleman MCP server for context-mode.
 *
 * Architecture:
 *   Claude Code ↔ Our Server (stdin/stdout) ↔ [MCP Client → child] ↔ Upstream Server
 *
 * Pre-warms the upstream FTS5 database before any tool call, keeps all
 * upstream storage under a wrapper-owned temp root, renames tools (drops
 * ctx_ prefix), merges execute + execute_file, and hides upstream's
 * session/meta surface.
 *
 * Uses the low-level Server class (not McpServer) so we can pass raw JSON
 * schemas through the proxy without converting to zod types.
 */

import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  findConfig,
  formatPrewarmManifest,
  getContentDbPath,
  prewarm,
  preprocessIndexPathFiles,
  resolveIndexPathFiles,
} from "./prewarm.ts";
import {
  applySearchReminderFilter,
  sanitizeUpstreamTextContent,
} from "./output-filter.ts";
import { TOOL_MAP } from "./tool-map.ts";

// ── Tool Mapping ────────────────────────────────────────────────────

/** Reverse lookup: upstream name → our name. */
const REVERSE_MAP = new Map(
  Object.entries(TOOL_MAP).map(([ours, upstream]) => [upstream, ours]),
);

/** Tools hidden from Claude Code entirely. */
const HIDDEN = new Set([
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
]);

const TOOL_DESCRIPTIONS = {
  execute:
    "Run code in the upstream sandbox. Use for derivation over files, command output, or fetched data without dumping raw bytes into context. When `path` is provided, the file is exposed inside the sandbox as FILE_CONTENT.",
  search:
    "Search indexed content with BM25/FTS5 ranking. Use after prewarm, index, fetch_and_index, batch_execute, or batch_read. Scope with `source` when you want results from a specific label or batch.",
  fetch_and_index:
    "Fetch one or more URLs, convert/index the content, and make it searchable. Use when the source is remote and you want retrieval via `search` instead of pasting raw page content into context.",
  batch_execute:
    "Run multiple shell commands, index their outputs, and optionally query the results in the same call. Use for multi-step collection where raw command output should converge into searchable indexed content.",
} as const;

// ── batch_read helpers ──────────────────────────────────────────────

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

function extractChunkCount(result: unknown): number {
  const text = (result as any)?.content?.[0]?.text ?? "";
  const match = text.match(/^Indexed (\d+) sections/);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Liberal array coercion ──────────────────────────────────────────
//
// Strict MCP clients validate tool args against the advertised JSON
// schema before dispatch. Weak models frequently emit array params as a
// JSON-encoded string (queries: "[\"a\",\"b\"]"), which those clients
// reject before the call ever reaches us. We advertise such params as
// "array OR string" (widenStringArrayParam) and normalize the value back
// to an array here, so the advertised contract matches what we accept.

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

/** True for a JSON-schema property shaped like `{ type: "array", items: { type: "string" } }`. */
function isStringArrayProp(prop: any): boolean {
  return (
    !!prop &&
    prop.type === "array" &&
    !!prop.items &&
    prop.items.type === "string"
  );
}

/**
 * Rewrite a string-array property to `anyOf: [array, string]` so strict
 * clients accept the JSON-encoded-string form. Array-form constraints
 * (`items`, `minItems`) are preserved on the array branch.
 */
function widenStringArrayParam(prop: any): any {
  const arrayBranch: any = { type: "array", items: prop.items ?? { type: "string" } };
  if (prop.minItems !== undefined) arrayBranch.minItems = prop.minItems;
  return {
    description:
      (prop.description ? prop.description + " " : "") +
      'Accepts either an array of strings or a JSON-encoded array string, e.g. "[\\"a\\",\\"b\\"]".',
    anyOf: [arrayBranch, { type: "string" }],
  };
}

/** Return a copy of `schema` with the named string-array properties widened. */
function widenSchemaArrays(schema: any, fields: string[]): any {
  if (!schema?.properties) return schema;
  const properties = { ...schema.properties };
  for (const field of fields) {
    if (isStringArrayProp(properties[field])) {
      properties[field] = widenStringArrayParam(properties[field]);
    }
  }
  return { ...schema, properties };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const configResult = findConfig(projectDir);
  const storageRoot = mkdtempSync(join(tmpdir(), "context-mode-"));

  // 1. Resolve the upstream server bundle relative to our install location,
  //    not CWD — the wrapper may be invoked from any project directory.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const wrapperRoot = __dirname.endsWith("/src")
    ? dirname(__dirname) // dev: src/wrapper.ts → project root
    : __dirname; // bundle: wrapper.bundle.mjs at project root
  const bundlePath = join(
    wrapperRoot,
    "node_modules",
    "context-mode",
    "server.bundle.mjs",
  );

  // 2. Spawn the upstream server as a subprocess. Force all upstream state
  //    under our temp root so persistent content/session machinery never
  //    escapes into the user's global adapter dirs.
  const clientTransport = new StdioClientTransport({
    command: "node",
    args: [bundlePath],
    cwd: projectDir,
    env: {
      ...(process.env as Record<string, string>),
      CONTEXT_MODE_DIR: storageRoot,
      CONTEXT_MODE_PROJECT_DIR: projectDir,
      CLAUDE_PROJECT_DIR: projectDir,
      PWD: projectDir,
      CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
    },
    stderr: "inherit",
  });

  // 3. Connect MCP client — this starts the subprocess and runs the
  //    MCP initialize handshake. The upstream ContentStore is lazy
  //    (created on first tool call), so we can pre-warm after connect.
  const client = new Client({ name: "context-wrapper", version: "0.2.0" });
  await client.connect(clientTransport);

  const upstreamPid = clientTransport.pid;
  if (!upstreamPid) {
    throw new Error("Failed to get upstream server PID");
  }
  process.stderr.write(
    `[context-wrapper] Connected to upstream server (pid ${upstreamPid})\n`,
  );

  // 4. Pre-warm the exact DB path the upstream child will open. Fold the
  //    resulting corpus manifest into the search description so the agent can
  //    see what is already searchable without a blind probe.
  let searchDescription = TOOL_DESCRIPTIONS.search;
  if (configResult) {
    const start = performance.now();
    const result = prewarm(
      configResult.config,
      storageRoot,
      projectDir,
      configResult.sourceBase,
    );
    const elapsed = (performance.now() - start).toFixed(0);
    process.stderr.write(
      `[context-wrapper] Pre-warmed ${result.totalChunks} chunks from ` +
        `${result.totalSources} files in ${elapsed}ms (${result.dbPath})\n`,
    );
    const manifest = formatPrewarmManifest(result.sources);
    if (manifest) searchDescription += `\n\n${manifest}`;
  }

  // 5. Fetch the upstream tool list and build our remapped version.
  const { tools: upstreamTools } = await client.listTools();

  // Find the execute_file tool — we merge its `path` param into execute
  const executeFileTool = upstreamTools.find(
    (t) => t.name === "ctx_execute_file",
  );

  // Build our tool list with remapped names
  const ourTools = upstreamTools
    .filter((t) => !HIDDEN.has(t.name))
    .filter((t) => t.name !== "ctx_execute_file") // merged into execute
    .filter((t) => REVERSE_MAP.has(t.name))
    .map((t) => {
      const ourName = REVERSE_MAP.get(t.name)!;

      if (ourName === "execute" && executeFileTool) {
        const mergedProperties = {
          ...(t.inputSchema.properties ?? {}),
        } as Record<string, unknown>;
        if (executeFileTool.inputSchema.properties?.path) {
          mergedProperties.path = executeFileTool.inputSchema.properties.path;
        } else {
          mergedProperties.path = {
            type: "string",
            description:
              "Absolute file path or relative to project root. When provided, " +
              "reads this file into a FILE_CONTENT variable inside the sandbox — " +
              "file contents stay in sandbox, only your printed output enters context.",
          };
        }

        return {
          ...t,
          name: ourName,
          description: TOOL_DESCRIPTIONS.execute,
          inputSchema: {
            ...t.inputSchema,
            properties: mergedProperties,
          },
        };
      }

      if (ourName === "index") {
        return {
          ...t,
          name: ourName,
          description:
            "Store content in the searchable BM25 knowledge base. When `content` is provided, it is indexed directly. When `path` is provided, the wrapper reads files relative to the agent cwd, applies markdown preprocessing, and indexes each file as its own source.",
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Raw text/markdown to index. Provide this OR path, not both.",
              },
              path: {
                type: "string",
                description:
                  "File or directory path to index. Relative paths resolve from the current working directory/worktree.",
              },
              source: {
                type: "string",
                description:
                  "Source label. For directories, each file gets \"{source}: {relative/path}\". Defaults to the directory basename or resolved file path.",
              },
              glob: {
                type: "string",
                description: 'Directory-only filename pattern. Defaults to "*.md".',
              },
              recursive: {
                type: "boolean",
                description: "Directory-only recursive walk flag. Defaults to true.",
              },
              stripFrontmatter: {
                type: "boolean",
                description: "Path-based indexing only. Strip YAML frontmatter before indexing. Defaults to true.",
              },
              prefixDates: {
                type: "boolean",
                description: "Path-based indexing only. For YYYY-MM-DD.md files, prefix ## headings with [date]. Defaults to false.",
              },
            },
          },
        };
      }

      if (ourName === "search") {
        return {
          ...t,
          name: ourName,
          description: searchDescription,
          inputSchema: widenSchemaArrays(t.inputSchema, ["queries"]),
        };
      }

      if (ourName === "fetch_and_index") {
        return { ...t, name: ourName, description: TOOL_DESCRIPTIONS.fetch_and_index };
      }

      if (ourName === "batch_execute") {
        return { ...t, name: ourName, description: TOOL_DESCRIPTIONS.batch_execute };
      }

      return { ...t, name: ourName };
    });

  // Append batch_read — wrapper-only tool with no upstream counterpart.
  ourTools.push({
    name: "batch_read",
    description:
      "Read multiple files, index them, and search across their contents. " +
      "Use instead of batch_execute when all inputs are known file paths (no shell commands needed). " +
      "Labels are auto-derived from file paths. Returns BM25 search results plus a batch ID — " +
      "pass the batch ID as `source` to `search` for follow-up questions scoped to exactly these files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: widenStringArrayParam({
          type: "array",
          items: { type: "string" },
          description:
            "File paths to read and index. Absolute paths preferred; " +
            "relative paths resolve from the current working directory.",
          minItems: 1,
        }),
        queries: widenStringArrayParam({
          type: "array",
          items: { type: "string" },
          description:
            "Search queries to run against the indexed content. Use 5–8 comprehensive queries. " +
            "Each returns top matching sections.",
          minItems: 1,
        }),
      },
      required: ["files", "queries"],
      additionalProperties: false,
    },
  });

  // 6. Create our low-level MCP server
  const server = new Server(
    { name: "context-wrapper", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ourTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // ── index(path=...): wrapper-owned markdown/file ingest ─────────
    if (name === "index" && args?.path !== undefined) {
      const targetPath = resolve(projectDir, String(args.path));
      let resolved;
      try {
        resolved = resolveIndexPathFiles({
          path: targetPath,
          source: typeof args.source === "string" ? args.source : undefined,
          glob: typeof args.glob === "string" ? args.glob : undefined,
          recursive: typeof args.recursive === "boolean" ? args.recursive : undefined,
          stripFrontmatter: typeof args.stripFrontmatter === "boolean" ? args.stripFrontmatter : undefined,
          prefixDates: typeof args.prefixDates === "boolean" ? args.prefixDates : undefined,
        });
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Index error: ${err.message}` }],
          isError: true,
        };
      }

      if (resolved.files.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: resolved.isDirectory
              ? `No files matched in ${resolved.basePath}.`
              : `Nothing indexable found at ${resolved.basePath}.`,
          }],
        };
      }

      const prepared = preprocessIndexPathFiles(resolved.files, {
        stripFrontmatter: typeof args.stripFrontmatter === "boolean" ? args.stripFrontmatter : undefined,
        prefixDates: typeof args.prefixDates === "boolean" ? args.prefixDates : undefined,
      });

      let indexed = 0;
      let totalChunks = 0;
      const errors: string[] = [];

      for (const entry of prepared) {
        const source = resolved.isDirectory
          ? `${resolved.sourcePrefix}: ${entry.source}`
          : String(args.source ?? resolved.basePath);
        try {
          const result = await client.callTool({
            name: "ctx_index",
            arguments: { content: entry.content, source },
          });
          totalChunks += extractChunkCount(result);
          indexed++;
        } catch (err: any) {
          errors.push(`${entry.file.name}: ${err.message}`);
        }
      }

      const summary = resolved.isDirectory
        ? `Indexed ${indexed} file${indexed === 1 ? "" : "s"} (${totalChunks} chunks) from ${resolved.basePath}`
        : `Indexed ${totalChunks} sections from: ${String(args.source ?? resolved.basePath)}`;

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

    // ── batch_read: wrapper-implemented, no upstream counterpart ────
    if (name === "batch_read") {
      const filesC = coerceStringArray(args?.files, "files");
      const queriesC = coerceStringArray(args?.queries, "queries");
      const argErrors = [
        ...(filesC.ok ? [] : [filesC.message]),
        ...(queriesC.ok ? [] : [queriesC.message]),
      ];
      if (argErrors.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid arguments for batch_read:\n${argErrors.map((m) => `  - ${m}`).join("\n")}`,
          }],
          isError: true,
        };
      }
      const files = (filesC as { value: string[] }).value;
      const queries = (queriesC as { value: string[] }).value;

      const batchId = randomBytes(3).toString("hex");
      const rawLabels = files.map((f) => deriveLabel(resolve(projectDir, f)));
      const labels = deduplicateLabels(rawLabels);

      const skipped: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const filePath = resolve(projectDir, files[i]);
        const source = `${batchId}/${labels[i]}`;

        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          skipped.push(filePath);
          continue;
        }

        await client.callTool({ name: "ctx_index", arguments: { content, source } });
      }

      const searchResult = await client.callTool({
        name: "ctx_search",
        arguments: { queries, source: batchId, limit: 3 },
      });

      const searchText =
        (searchResult as any).content?.[0]?.text ?? "(no results)";

      const errorNote =
        skipped.length > 0
          ? `\n\n⚠ Could not read ${skipped.length} file(s):\n${skipped.map((f) => `  - ${f}`).join("\n")}`
          : "";

      const followUpNote =
        `\n\n---\n**Batch ID:** \`${batchId}\`\n` +
        `To search only these files: \`search(queries: [...], source: "${batchId}")\``;

      return {
        content: [
          { type: "text" as const, text: searchText + errorNote + followUpNote },
        ],
      };
    }

    // ── Standard tool forwarding ───────────────────────────────────

    let forwardArgs = args;
    if (name === "search" && args?.queries !== undefined) {
      const coerced = coerceStringArray(args.queries, "queries");
      if (!coerced.ok) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid arguments for search:\n  - ${coerced.message}`,
          }],
          isError: true,
        };
      }
      forwardArgs = { ...args, queries: coerced.value };
    }

    let upstreamName: string;
    if (name === "execute" && args?.path !== undefined) {
      upstreamName = "ctx_execute_file";
    } else {
      upstreamName = TOOL_MAP[name];
    }

    if (!upstreamName) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const result = await client.callTool({
      name: upstreamName,
      arguments: forwardArgs,
    });

    sanitizeUpstreamTextContent(result);

    // Intercept search responses when searchReminder is configured
    if (
      name === "search" &&
      configResult?.config.searchReminder !== undefined
    ) {
      applySearchReminderFilter(result, configResult.config.searchReminder);
    }

    return result as any;
  });

  // 7. Connect our server to Claude Code's stdio
  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
  process.stderr.write(
    `[context-wrapper] MCP server ready (${ourTools.length} tools) [tmp=${storageRoot}]\n`,
  );

  // 8. Graceful shutdown
  const shutdown = async () => {
    await Promise.allSettled([client.close(), server.close()]);
  };

  process.stdin.on("end", () => process.exit(0));

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("exit", () => {
    try {
      process.kill(upstreamPid);
    } catch {
      /* already dead */
    }
    try {
      rmSync(storageRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}

main().catch((err) => {
  process.stderr.write(
    `[context-wrapper] Fatal: ${err.message}\n${err.stack}\n`,
  );
  process.exit(1);
});
