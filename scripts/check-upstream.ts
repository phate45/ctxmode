/**
 * Check upstream context-mode for changes that affect our build/runtime.
 *
 * Compares current upstream state against a stored manifest. Flags:
 *   - Dependency additions/removals (runtime deps we inherit)
 *   - External changes (native/heavy deps that can't be bundled)
 *   - Export map changes (affects our import paths)
 *   - Wrapper coupling points (ContentStore + resolveContentStorePath)
 *   - Upstream tool inventory and per-tool input schema changes
 *
 * Usage:
 *   bun run check            — compare against manifest
 *   bun run check --update   — accept current state as new baseline
 *
 * Exit codes:
 *   0  no drift, or the baseline was written
 *   1  informational drift only; accept with --update
 *   2  could not ask: upstream is not installed or its server would not start
 *   3  risk drift; a human or agent must review it before accepting
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_MAP } from "../src/tool-map.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const upstream = join(root, "node_modules", "context-mode");
const manifestPath = join(root, "upstream.manifest.json");

// ── Types ──

interface Probe {
  name: string;
  description: string;
  severity: "risk" | "info";
  extract: () => Promise<string> | string;
}

interface Fingerprint {
  hash: string;
  value: string;
  description?: string;
  severity?: "risk" | "info";
}

interface Manifest {
  tag: string;
  generated: string;
  fingerprints: Record<string, Fingerprint>;
}

interface Change {
  name: string;
  description: string;
  severity: "risk" | "info";
  kind: "added" | "changed" | "removed";
  previous?: string;
  current?: string;
}

interface CheckResult {
  tag: string;
  manifest: Manifest | null;
  fingerprints: Record<string, Fingerprint>;
  changes: Change[];
  blockingChanges: Change[];
}

interface UpstreamTool {
  name: string;
  inputSchema?: unknown;
}

// ── Helpers ──

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * A missing file reads as empty, so a deleted coupling file surfaces as
 * fingerprint drift. A missing package.json still fails its JSON.parse,
 * which is the "upstream is not installed" case.
 */
function readUpstream(relPath: string): string {
  const full = join(upstream, relPath);
  return existsSync(full) ? readFileSync(full, "utf-8") : "";
}

function getCurrentTag(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const dep = pkg.dependencies?.["context-mode"] ?? "";
  return dep.match(/#(.+)$/)?.[1] ?? "unknown";
}

function loadManifest(): Manifest | null {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["description", "title", "$schema", "examples", "default"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, normalizeSchema(child)]);

  return Object.fromEntries(entries);
}

function diff(oldValue: string, currentValue: string): void {
  const oldLines = new Set(oldValue.split("\n"));
  const currentLines = new Set(currentValue.split("\n"));
  for (const line of oldLines) {
    if (!currentLines.has(line)) console.log(`      − ${line}`);
  }
  for (const line of currentLines) {
    if (!oldLines.has(line)) console.log(`      + ${line}`);
  }
}

function formatToolInventory(tools: UpstreamTool[]): string {
  return tools.map((tool) => tool.name).sort().join("\n");
}

function formatToolSchema(tool: UpstreamTool): string {
  return JSON.stringify(normalizeSchema(tool.inputSchema ?? {}), null, 2);
}

async function listUpstreamTools(): Promise<UpstreamTool[]> {
  const storageRoot = mkdtempSync(join(tmpdir(), "cw-check-upstream-"));
  const bundlePath = join(upstream, "server.bundle.mjs");
  const transport = new StdioClientTransport({
    command: "node",
    args: [bundlePath],
    cwd: root,
    stderr: "inherit",
    env: {
      ...(process.env as Record<string, string>),
      CONTEXT_MODE_DIR: storageRoot,
      CONTEXT_MODE_PROJECT_DIR: root,
      CLAUDE_PROJECT_DIR: root,
      PWD: root,
    },
  });
  const client = new Client({ name: "context-wrapper-check", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));
  } finally {
    await client.close().catch(() => {});
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

function buildStaticProbes(): Probe[] {
  return [
    {
      name: "dependencies",
      description: "Runtime deps (additions need install, removals may break imports)",
      severity: "risk",
      extract() {
        const pkg = JSON.parse(readUpstream("package.json"));
        return Object.entries(pkg.dependencies ?? {})
          .map(([key, value]) => `${key}@${value}`)
          .sort()
          .join("\n");
      },
    },
    {
      name: "externals",
      description: "esbuild externals from upstream bundle script (our build must match)",
      severity: "risk",
      extract() {
        const pkg = JSON.parse(readUpstream("package.json"));
        const script = pkg.scripts?.bundle ?? "";
        const hits = [...script.matchAll(/--external:(\S+)/g)].map((match) => match[1]);
        return [...new Set(hits)].sort().join("\n");
      },
    },
    {
      name: "exports",
      description: "Package exports map (affects our import resolution)",
      severity: "risk",
      extract() {
        const pkg = JSON.parse(readUpstream("package.json"));
        return JSON.stringify(pkg.exports ?? {}, null, 2);
      },
    },
    {
      name: "version",
      description: "Upstream package version",
      severity: "info",
      extract() {
        const pkg = JSON.parse(readUpstream("package.json"));
        return pkg.version ?? "unknown";
      },
    },
    {
      name: "coupling:ContentStore",
      description: "Wrapper import contract for ContentStore",
      severity: "risk",
      extract() {
        const storeSrc = readUpstream("src/store.ts");
        const hasExport = /export class ContentStore\b/.test(storeSrc);
        const ctor = storeSrc.match(/constructor\(([^)]*)\)/)?.[1]?.trim() ?? "<missing>";
        return [
          "file=src/store.ts",
          `exportClassContentStore=${hasExport}`,
          `constructor=${ctor}`,
        ].join("\n");
      },
    },
    {
      name: "coupling:resolveContentStorePath",
      description: "Wrapper import contract for resolveContentStorePath",
      severity: "risk",
      extract() {
        const sessionDbSrc = readUpstream("src/session/db.ts");
        const signatureRe = /export function resolveContentStorePath\(opts:\s*\{\s*projectDir:\s*string;\s*contentDir:\s*string;\s*\}\):\s*string/;
        return [
          "file=src/session/db.ts",
          `exportFunctionResolveContentStorePath=${signatureRe.test(sessionDbSrc)}`,
          "opts=projectDir:string,contentDir:string",
        ].join("\n");
      },
    },
  ];
}

async function buildProbes(): Promise<Probe[]> {
  const tools = await listUpstreamTools();
  const probes = [...buildStaticProbes()];

  probes.push({
    name: "tools:inventory",
    description: "Upstream MCP tool names exposed by server.bundle.mjs",
    severity: "risk",
    extract: () => formatToolInventory(tools),
  });

  probes.push({
    name: "tools:wrapper-map",
    description: "Wrapper-mapped upstream tools required by TOOL_MAP",
    severity: "risk",
    extract: () => {
      const names = new Set(tools.map((tool) => tool.name));
      return Object.entries(TOOL_MAP)
        .map(([wrapperName, upstreamName]) => `${wrapperName}=${names.has(upstreamName) ? upstreamName : "<missing>"}`)
        .join("\n");
    },
  });

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    probes.push({
      name: `tool-schema:${tool.name}`,
      description: `Normalized input schema for ${tool.name}`,
      severity: "risk",
      extract: () => formatToolSchema(tool),
    });
  }

  return probes;
}

export async function collectFingerprints(): Promise<Record<string, Fingerprint>> {
  const fingerprints: Record<string, Fingerprint> = {};
  for (const probe of await buildProbes()) {
    const value = await probe.extract();
    fingerprints[probe.name] = {
      hash: hash(value),
      value,
      description: probe.description,
      severity: probe.severity,
    };
  }
  return fingerprints;
}

export function compareFingerprints(
  previous: Record<string, Fingerprint> | undefined,
  current: Record<string, Fingerprint>,
): Change[] {
  const prev = previous ?? {};
  const names = new Set([...Object.keys(prev), ...Object.keys(current)]);
  const changes: Change[] = [];

  for (const name of [...names].sort()) {
    const oldEntry = prev[name];
    const currentEntry = current[name];

    if (!oldEntry && currentEntry) {
      changes.push({
        name,
        description: currentEntry.description ?? name,
        severity: currentEntry.severity ?? "risk",
        kind: "added",
        current: currentEntry.value,
      });
      continue;
    }

    if (oldEntry && !currentEntry) {
      changes.push({
        name,
        description: oldEntry.description ?? name,
        severity: oldEntry.severity ?? "risk",
        kind: "removed",
        previous: oldEntry.value,
      });
      continue;
    }

    if (oldEntry && currentEntry && oldEntry.hash !== currentEntry.hash) {
      changes.push({
        name,
        description: currentEntry.description ?? oldEntry.description ?? name,
        severity: currentEntry.severity ?? oldEntry.severity ?? "risk",
        kind: "changed",
        previous: oldEntry.value,
        current: currentEntry.value,
      });
    }
  }

  return changes;
}

export async function checkUpstream(): Promise<CheckResult> {
  const tag = getCurrentTag();
  const manifest = loadManifest();
  const fingerprints = await collectFingerprints();
  const changes = compareFingerprints(manifest?.fingerprints, fingerprints);
  const blockingChanges = changes.filter((change) => change.severity === "risk");
  return { tag, manifest, fingerprints, changes, blockingChanges };
}

export function writeManifest(tag: string, fingerprints: Record<string, Fingerprint>): void {
  const next: Manifest = {
    tag,
    generated: new Date().toISOString(),
    fingerprints,
  };
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
}

function renderChange(change: Change): void {
  const icon = change.kind === "added" ? "🆕" : change.kind === "removed" ? "🗑️" : "⚠️";
  const prefix = change.severity === "info" ? `${icon}ℹ️` : icon;
  console.log(`  ${prefix}  ${change.name}  — ${change.description}`);

  if (change.kind === "added" && change.current !== undefined) {
    for (const line of change.current.split("\n")) console.log(`      + ${line}`);
    return;
  }

  if (change.kind === "removed" && change.previous !== undefined) {
    for (const line of change.previous.split("\n")) console.log(`      − ${line}`);
    return;
  }

  diff(change.previous ?? "", change.current ?? "");
}

export function renderCheckResult(result: CheckResult): void {
  console.log(`\n  Checking upstream (${result.tag})\n`);

  if (result.changes.length === 0) {
    for (const name of Object.keys(result.fingerprints).sort()) {
      console.log(`  ✅  ${name}`);
    }
    console.log("\n  All clear.\n");
    return;
  }

  const changedNames = new Set(result.changes.map((change) => change.name));
  for (const name of Object.keys(result.fingerprints).sort()) {
    if (!changedNames.has(name)) console.log(`  ✅  ${name}`);
  }
  for (const change of result.changes) renderChange(change);
  console.log("");
}

async function runCli(): Promise<void> {
  const update = process.argv.includes("--update");
  const result = await checkUpstream();
  renderCheckResult(result);

  if (update || !result.manifest) {
    writeManifest(result.tag, result.fingerprints);
    console.log("  Manifest written → upstream.manifest.json\n");
    return;
  }

  if (result.blockingChanges.length > 0) {
    console.log(
      `  ${result.blockingChanges.length} blocking change(s) detected. Review above, then run with --update to accept.\n`,
    );
    process.exit(3);
  }

  if (result.changes.length > 0) {
    console.log("  Informational change(s) only. Run with --update to accept.\n");
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
