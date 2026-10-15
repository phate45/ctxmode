// Ranking parity on a real corpus: records each query's top results from one
// server, then compares two recordings. Outputs hold private titles; keep them
// out of git (write under .tmp/).
//
//   bun scripts/parity-rank.ts <corpus-root> <out.json> -- <server cmd...>
//   bun scripts/parity-rank.ts --compare a.json b.json

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resultText, startServer } from "../test/golden/run.ts";

const QUERIES = [
  "database migration",
  "authentication",
  "deploy",
  "error handling",
  "meeting notes",
  "performance",
  "testing strategy",
  "configuration",
  "refactor",
  "api design",
  "caching",
  "logging",
  "security",
  "documentation",
  "release",
  "debugging",
  "architecture decision",
  "code review feedback",
  "rate limiting retry backoff",
  "continuous integration pipeline",
  "weekly planning goals",
  "how to install dependencies",
  "TODO",
  "package.json",
  "README.md",
];

interface Hit {
  source: string;
  title: string;
}

type Recording = { prewarm: string | null; queries: Record<string, Hit[]> };

// Matches the upstream result header `--- [origin | ts | source] ---` and the `### title` after it.
function parseHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const re = /^--- \[(?:[^|\]]*\| )*([^\]]*)\] ---\n### (.*)$/gm;
  for (const m of text.matchAll(re)) hits.push({ source: m[1], title: m[2] });
  return hits;
}

async function rank(corpus: string, out: string, cmd: string[]): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "parity-rank-")));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  const config = JSON.stringify({
    sources: [{ label: "corpus", path: resolve(corpus), glob: "*.md", recursive: true, stripFrontmatter: true }],
  });
  for (const name of ["context-mode.json", "ctxmode.json"]) writeFileSync(join(project, ".claude", name), config);

  const started = performance.now();
  const { client, stderr } = await startServer(cmd, project, home);
  const connectMs = Math.round(performance.now() - started);
  const recording: Recording = { prewarm: null, queries: {} };
  try {
    recording.prewarm = stderr().match(/Pre-warmed .*? in \d+ms/)?.[0] ?? null;
    for (const q of QUERIES) {
      const result = await client.callTool({ name: "search", arguments: { queries: [q], limit: 5 } });
      recording.queries[q] = parseHits(resultText(result)).slice(0, 5);
    }
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }

  writeFileSync(out, JSON.stringify(recording, null, 2) + "\n");
  const hits = Object.values(recording.queries).map((h) => h.length);
  console.log(`prewarm: ${recording.prewarm ?? "(no prewarm line)"}; startup to ready: ${connectMs}ms`);
  console.log(`queries: ${hits.length}, hits: ${hits.reduce((a, b) => a + b, 0)}, empty: ${hits.filter((n) => n === 0).length}`);
  console.log(`wrote ${out}`);
}

function compare(aPath: string, bPath: string): void {
  const a: Recording = JSON.parse(readFileSync(aPath, "utf-8"));
  const b: Recording = JSON.parse(readFileSync(bPath, "utf-8"));
  const key = (h: Hit) => `${h.source}\u0000${h.title}`;
  let exact = 0;
  let overlapSum = 0;
  const queries = [...new Set([...Object.keys(a.queries), ...Object.keys(b.queries)])];
  for (const q of queries) {
    const x = (a.queries[q] ?? []).map(key);
    const y = (b.queries[q] ?? []).map(key);
    const shared = x.filter((k) => y.includes(k)).length;
    const denom = Math.max(x.length, y.length);
    const overlap = denom === 0 ? 1 : shared / denom;
    const same = x.length === y.length && x.every((k, i) => k === y[i]);
    overlapSum += overlap;
    if (same) exact++;
    console.log(`${same ? "=" : "~"} ${(overlap * 100).toFixed(0).padStart(3)}%  ${q}  (${x.length} vs ${y.length})`);
  }
  console.log(`exact order: ${exact}/${queries.length}, mean overlap: ${((overlapSum / queries.length) * 100).toFixed(1)}%`);
}

const argv = process.argv.slice(2);
if (argv[0] === "--compare" && argv.length === 3) {
  compare(argv[1], argv[2]);
} else {
  const sep = argv.indexOf("--");
  if (sep !== 2 || argv.length < 4) {
    console.error("usage: bun scripts/parity-rank.ts <corpus-root> <out.json> -- <server cmd...>\n       bun scripts/parity-rank.ts --compare a.json b.json");
    process.exit(2);
  }
  await rank(argv[0], argv[1], argv.slice(3));
}
