// End-to-end checks the golden transcript does not cover: config discovery,
// argument coercion, batch_read, searchReminder and the index deny policy.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cw-e2e-")));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function connect(cwd: string, env: Record<string, string> = {}): Promise<Client> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CLAUDE|CONTEXT_MODE|CONTEXT_WRAPPER)/.test(k)) base[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    cwd,
    env: { ...base, PWD: cwd, HOME: cwd, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  return { text: (result.content?.[0]?.text ?? "") as string, isError: !!result.isError };
}

function config(root: string, cfg: object): void {
  write(join(root, ".claude", "context-mode.json"), JSON.stringify(cfg));
}

describe("discovered config", async () => {
  const root = tempRoot();
  write(join(root, "hello.md"), "# Alpha\n\nprewarm-token-xyz\n");
  write(join(root, "docs", "guide.md"), "---\ntitle: Guide\n---\n\n# Guide\n\nfolder-token-abc\n");
  config(root, {
    sources: [{ label: "vault", description: "test vault notes", path: root, glob: "*.md", stripFrontmatter: true }],
  });
  const client = await connect(root);
  afterAll(() => client.close());

  test("tools, manifest and array-or-string schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "batch_execute", "batch_read", "execute", "fetch_and_index", "index", "search",
    ]);
    const search = tools.find((t) => t.name === "search")!;
    expect(search.description).toContain("`vault` (1 file) — test vault notes");
    const queries = (search.inputSchema.properties as any).queries;
    expect(queries.anyOf.map((b: any) => b.type)).toEqual(["array", "string"]);
  });

  test("search coerces JSON-string queries and rejects malformed ones", async () => {
    const ok = await call(client, "search", { queries: '["prewarm-token-xyz"]' });
    expect(ok.text).toContain("vault: hello.md");
    const bad = await call(client, "search", { queries: '["prewarm-token-xyz"' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("looks like a JSON array");
  });

  test("execute runs in the project dir", async () => {
    const r = await call(client, "execute", { language: "shell", code: "pwd" });
    expect(r.text).toContain("```shell\npwd\n```");
    expect(r.text.trim().endsWith(root)).toBe(true);
  });

  test("index path ingests a directory with preprocessing", async () => {
    const r = await call(client, "index", { path: "docs", source: "docs-src" });
    expect(r.text).toContain("Indexed 1 file (1 chunks)");
    const s = await call(client, "search", { queries: ["folder-token-abc"], source: "docs-src" });
    expect(s.text).toContain("docs-src: guide.md");
    expect(s.text).not.toContain("title: Guide");
  });

  test("batch_read indexes files and searches them, array or string args", async () => {
    for (const args of [
      { files: ["hello.md", "docs/guide.md"], queries: ["prewarm-token-xyz", "folder-token-abc"] },
      { files: '["hello.md", "docs/guide.md"]', queries: '["prewarm-token-xyz", "folder-token-abc"]' },
    ]) {
      const r = await call(client, "batch_read", args);
      expect(r.text).toContain("prewarm-token-xyz");
      expect(r.text).toContain("folder-token-abc");
      expect(r.text).toMatch(/Batch ID:\*\* `[0-9a-f]{6}`/);
    }
  });
});

test("relative sources resolve against the config's project dir", async () => {
  const root = tempRoot();
  const launch = join(root, "pkg", "deep");
  mkdirSync(launch, { recursive: true });
  write(join(root, "docs", "rel.md"), "# Rel\n\nrelative-glob-token-456\n");
  write(join(root, "listed.md"), "# Listed\n\nrelative-exec-token-654\n");
  config(root, {
    sources: [
      { label: "relglob", description: "relative glob", path: "docs", glob: "*.md" },
      { label: "relexec", description: "relative exec", path: ".", exec: `printf '["listed.md"]'` },
    ],
  });
  const client = await connect(launch);
  try {
    const r = await call(client, "search", { queries: ["relative-glob-token-456", "relative-exec-token-654"] });
    expect(r.text).toContain("relglob: rel.md");
    expect(r.text).toContain("relexec: listed.md");
  } finally {
    await client.close();
  }
});

test("CONTEXT_WRAPPER_CONFIG loads an exact file; relative paths follow the launch cwd", async () => {
  const root = tempRoot();
  const launch = join(root, "no-config");
  write(join(launch, "note.md"), "# Env\n\nenv-override-token-789\n");
  const cfg = join(root, "elsewhere", "ctx.json");
  write(cfg, JSON.stringify({ sources: [{ label: "envrelative", path: ".", glob: "*.md" }] }));
  const client = await connect(launch, { CONTEXT_WRAPPER_CONFIG: cfg });
  try {
    const r = await call(client, "search", { queries: ["env-override-token-789"] });
    expect(r.text).toContain("envrelative: note.md");
  } finally {
    await client.close();
  }
});

test("searchReminder false drops the throttle warning, a string replaces it", async () => {
  for (const [reminder, expectWarning] of [[false, null], ["Batch your searches.", "Batch your searches."]] as const) {
    const root = tempRoot();
    write(join(root, "a.md"), "# A\n\nreminder-token\n");
    config(root, { sources: [{ label: "a", path: ".", glob: "*.md" }], searchReminder: reminder });
    const client = await connect(root, { CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER: "1", CONTEXT_MODE_SEARCH_BLOCK_AFTER: "2" });
    try {
      const soft = await call(client, "search", { queries: ["reminder-token"] });
      expect(soft.text).not.toContain("⚠ search call");
      if (expectWarning) expect(soft.text.endsWith(`\n\n${expectWarning}`)).toBe(true);
      let blocked = soft;
      for (let i = 0; i < 5 && !blocked.isError; i++) blocked = await call(client, "search", { queries: ["reminder-token"] });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toBe(expectWarning ?? "");
    } finally {
      await client.close();
    }
  }
});

test("index path skips files matching a Read deny rule", async () => {
  const root = tempRoot();
  write(join(root, "notes", "open.md"), "# Open\n\nopen-token\n");
  write(join(root, "notes", "secret.md"), "# Secret\n\nsecret-token\n");
  write(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(**/secret.md)"] } }));
  const client = await connect(root);
  try {
    const r = await call(client, "index", { path: "notes", source: "n" });
    expect(r.text).toContain("Indexed 1 file");
    expect(r.text).toContain("secret.md: blocked by Read deny policy");
    const s = await call(client, "search", { queries: ["secret-token"], source: "n" });
    expect(s.text).not.toContain("# Secret");
  } finally {
    await client.close();
  }
});
