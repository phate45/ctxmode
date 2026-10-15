// Golden parity harness: drives an MCP server over stdio against a synthetic
// corpus and records (or checks) a normalized transcript of its answers.
//
//   bun test/golden/run.ts --record -- node wrapper.bundle.mjs
//   bun test/golden/run.ts --check [--strict] -- <cmd...>
//
// --strict ignores expected-differences.json, so every section must match.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = import.meta.dir;
const EXPECTED = join(HERE, "expected.json");
const DIFFERENCES = join(HERE, "expected-differences.json");

type Transcript = Record<string, Record<string, unknown>>;
type Args = Record<string, unknown>;

export interface Started {
  client: Client;
  stderr: () => string;
}

// Inherited agent/tool env would change upstream behaviour between a CC shell and a plain one.
const SCRUB = /^(CLAUDE|CODEX|CONTEXT_MODE|CONTEXT_WRAPPER|CTXMODE|GEMINI|CURSOR)/;

export async function startServer(cmd: string[], cwd: string, home: string): Promise<Started> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUB.test(k)) env[k] = v;
  Object.assign(env, {
    PWD: cwd,
    // Keeps upstream auto-memory and session dirs away from the real ~/.claude.
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    // The flood guard would otherwise cap results at 1 and block after 8 calls.
    CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER: "1000",
    CONTEXT_MODE_SEARCH_BLOCK_AFTER: "1000",
  });

  const [command, ...rest] = cmd;
  const transport = new StdioClientTransport({
    command,
    args: rest.map((a) => (existsSync(a) ? resolve(a) : a)),
    cwd,
    env,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d) => (err += d.toString()));
  const client = new Client({ name: "golden-parity", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    process.stderr.write(err);
    throw e;
  }
  return { client, stderr: () => err };
}

export function resultText(result: any): string {
  return (result?.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function writeConfig(project: string): void {
  const config = {
    sources: [
      { label: "notes", description: "Synthetic engineering notes", path: "corpus/notes", glob: "*.md", stripFrontmatter: true },
      { label: "logs", path: "corpus/logs", glob: "*.md", stripFrontmatter: true, prefixDates: true },
      { label: "wiki", path: "corpus/wiki", glob: "*.md", recursive: true },
      { label: "pinned", path: "corpus/pinned", paths: ["glossary.md", "faq.md"], stripFrontmatter: true },
      {
        label: "scripted",
        description: "Listed by an exec command",
        path: "corpus/scripted",
        exec: `printf '["changelog.md","roadmap.md"]'`,
      },
    ],
  };
  mkdirSync(join(project, ".claude"), { recursive: true });
  for (const name of ["context-mode.json", "ctxmode.json"]) {
    writeFileSync(join(project, ".claude", name), JSON.stringify(config, null, 2));
  }
}

function serveFixture(root: string): Promise<HttpServer> {
  const html = readFileSync(join(root, "web", "page.html"));
  const server = createServer((req, res) => {
    if (req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const search = (queries: unknown, extra: Args = {}): Args => ({ queries, ...extra });

// [section, step, tool, args]; order matters: later searches see what earlier steps indexed.
function steps(port: number): Array<[string, string, string, Args]> {
  return [
    ["search", "single", "search", search(["database migration"])],
    ["search", "multi", "search", search(["refresh token", "argon2id", "canary"])],
    ["search", "json-string-queries", "search", search('["idempotency key"]')],
    ["search", "source-wiki", "search", search(["cache"], { source: "wiki" })],
    ["search", "source-logs-prefixdates", "search", search(["deploy pipeline"], { source: "logs" })],
    ["search", "content-code", "search", search(["CREATE INDEX accounts"], { contentType: "code" })],
    ["search", "content-prose", "search", search(["rollback"], { contentType: "prose" })],
    ["search", "limit-1", "search", search(["deploy"], { limit: 1 })],
    ["search", "limit-5", "search", search(["deploy"], { limit: 5 })],
    ["search", "typo", "search", search(["kubernets operater", "configuratoin"])],
    ["search", "substring", "search", search(["onfigur", "serializ"])],
    ["search", "zero-hits", "search", search(["xylophone quantum walrus"])],
    ["search", "unicode", "search", search(["résumé", "日本語"])],
    ["search", "long-section", "search", search(["freeze calendar", "break-glass workflow"])],
    ["search", "identifiers", "search", search(["parseConfigBlob", "ERR_RATE_LIMITED"])],
    ["search", "frontmatter", "search", search(["Placeholder draft", "owner platform"])],

    ["index", "content", "index", { content: "# Inline Note\n\nThe inline token is puffin-amber-63.\n", source: "inline-note" }],
    ["index", "path-file", "index", { path: "corpus/ingest/single.md", source: "ingest-single" }],
    ["index", "path-dir", "index", { path: "corpus/ingest/dir", source: "ingest-dir", prefixDates: true }],
    [
      "index",
      "path-dir-options",
      "index",
      { path: "corpus/ingest/dir", source: "ingest-txt", glob: "*.txt", recursive: false, stripFrontmatter: false },
    ],
    [
      "index",
      "search-after",
      "search",
      search(["puffin-amber-63", "zephyr-quartz-41", "marlin-basalt-77", "heron-cobalt-12", "osprey-flint-99"]),
    ],
    ["index", "search-dir-scoped", "search", search(["Load Test"], { source: "ingest-dir" })],

    ["execute", "javascript", "execute", { language: "javascript", code: "console.log([1, 2, 3].map((x) => x * 2).join(','))" }],
    ["execute", "typescript", "execute", { language: "typescript", code: "const n: number = 21;\nconsole.log(`answer=${n * 2}`)" }],
    ["execute", "python", "execute", { language: "python", code: "print(sum(range(10)))" }],
    ["execute", "shell", "execute", { language: "shell", code: "echo hello && printf 'a\\nb\\n' | wc -l" }],
    [
      "execute",
      "intent-large",
      "execute",
      { language: "shell", code: "seq 1 1500 | sed 's/^/ledger line item /'", intent: "ledger line item 1234" },
    ],
    [
      "execute",
      "file",
      "execute",
      {
        language: "javascript",
        path: "corpus/data/metrics.csv",
        code: "const rows = FILE_CONTENT.trim().split('\\n').slice(1);\nconsole.log(`rows=${rows.length} first=${rows[0].split(',')[0]}`)",
      },
    ],
    ["execute", "search-after", "search", search(["ledger line item 1234"])],

    [
      "batch_execute",
      "run",
      "batch_execute",
      {
        commands: [
          { label: "Notes listing", command: "ls corpus/notes" },
          { label: "Deploy log", command: "cat corpus/logs/2026-01-12.md" },
        ],
        queries: ["deploy pipeline stages", "fuzzy-terms"],
      },
    ],

    ["fetch_and_index", "fetch", "fetch_and_index", { url: `http://127.0.0.1:${port}/page.html`, source: "fixture-web" }],
    ["fetch_and_index", "search-after", "search", search(["kestrel-garnet-58"], { source: "fixture-web" })],

    ["timeline", "search", "search", search(["deploy", "project instructions"], { sort: "timeline" })],
  ];
}

// Each rule erases one source of run-to-run noise; keep this list explicit.
function normalizer(roots: string[], port: number): (s: string) => string {
  const rules: Array<[RegExp, string]> = [
    ...roots.map((r): [RegExp, string] => [new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<ROOT>"]),
    [/\/tmp\/[\w.-]+/g, "<TMP>"],
    [new RegExp(`127\\.0\\.0\\.1:${port}`, "g"), "127.0.0.1:<PORT>"],
    [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?Z?)?/g, "<TS>"],
    [/\bpid \d+/g, "pid <PID>"],
    [/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<DUR>"],
  ];
  return (s) => rules.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

async function record(cmd: string[]): Promise<Transcript> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "golden-")));
  const project = join(root, "project");
  const home = join(root, "home");
  cpSync(join(HERE, "corpus"), join(project, "corpus"), { recursive: true });
  writeConfig(project);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# User Instructions\n\nSynthetic project instructions for the deploy checklist.\n");

  const http = await serveFixture(join(project, "corpus"));
  const port = (http.address() as AddressInfo).port;
  const norm = normalizer([root], port);
  const out: Transcript = {};
  const put = (section: string, step: string, value: unknown) => ((out[section] ??= {})[step] = value);

  const { client, stderr } = await startServer(cmd, project, home);
  try {
    const { tools } = await client.listTools();
    put("tools", "names", tools.map((t) => t.name).sort());
    for (const t of tools) put("tools", `${t.name}.properties`, Object.keys(t.inputSchema.properties ?? {}).sort());
    const manifest = (tools.find((t) => t.name === "search")?.description ?? "").split("\n").find((l) => l.startsWith("Pre-warmed"));
    put("tools", "search.manifest", manifest ?? null);

    const m = stderr().match(/Pre-warmed (\d+) chunks from (\d+) files/);
    put("prewarm", "counts", m ? { chunks: Number(m[1]), files: Number(m[2]) } : null);

    for (const [section, step, name, args] of steps(port)) {
      const result: any = await client.callTool({ name, arguments: args });
      put(section, step, { isError: !!result.isError, text: norm(resultText(result)).split("\n") });
    }
  } finally {
    await client.close().catch(() => {});
    http.close();
    rmSync(root, { recursive: true, force: true });
  }
  return out;
}

interface ExpectedDifference {
  key: string;
  reason: string;
}

// A key names a whole section ("timeline") or one step ("tools.search.manifest").
function skipped(section: string, step: string, list: ExpectedDifference[]): ExpectedDifference | undefined {
  return list.find((d) => d.key === section || d.key === `${section}.${step}`);
}

function lineDiff(a: string, b: string, context = 2, max = 12): string {
  const x = a.split("\n");
  const y = b.split("\n");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const lines = [`  @@ line ${i + 1}`];
  for (let k = Math.max(0, i - context); k < i; k++) lines.push(`    ${x[k]}`);
  for (const l of x.slice(i, i + max)) lines.push(`  - ${l}`);
  for (const l of y.slice(i, i + max)) lines.push(`  + ${l}`);
  return lines.join("\n");
}

function check(expected: Transcript, actual: Transcript, list: ExpectedDifference[]): number {
  let failures = 0;
  const sections = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const section of sections) {
    const steps = [...new Set([...Object.keys(expected[section] ?? {}), ...Object.keys(actual[section] ?? {})])];
    for (const step of steps) {
      const want = JSON.stringify(expected[section]?.[step] ?? null, null, 2);
      const got = JSON.stringify(actual[section]?.[step] ?? null, null, 2);
      if (want === got) continue;
      const allowed = skipped(section, step, list);
      if (allowed) {
        console.log(`skip ${section}.${step}: ${allowed.reason}`);
        continue;
      }
      if (++failures <= 10) console.log(`FAIL ${section}.${step}\n${lineDiff(want, got)}\n`);
    }
  }
  if (failures > 10) console.log(`... and ${failures - 10} more`);
  return failures;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const flags = new Set(sep === -1 ? argv : argv.slice(0, sep));
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);
  if (cmd.length === 0 || flags.has("--record") === flags.has("--check")) {
    console.error("usage: bun test/golden/run.ts --record|--check [--strict] -- <server cmd...>");
    process.exit(2);
  }

  const actual = await record(cmd);
  if (flags.has("--record")) {
    writeFileSync(EXPECTED, JSON.stringify(actual, null, 2) + "\n");
    console.log(`recorded ${EXPECTED}`);
    return;
  }

  const list: ExpectedDifference[] = flags.has("--strict") ? [] : JSON.parse(readFileSync(DIFFERENCES, "utf-8"));
  const failures = check(JSON.parse(readFileSync(EXPECTED, "utf-8")), actual, list);
  console.log(failures === 0 ? "golden: ok" : `golden: ${failures} mismatch(es)`);
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
