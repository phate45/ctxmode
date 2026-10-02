import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cw-e2e-"));
  const cwd = join(root, "worktrees", "feature");

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  mkdirSync(join(cwd, "docs"), { recursive: true });

  writeFileSync(join(cwd, "hello.md"), "# Alpha\n\nprewarm-token-xyz\n");
  writeFileSync(
    join(cwd, "docs", "guide.md"),
    "---\ntitle: Guide\n---\n\n# Guide\n\nfolder-token-abc\n",
  );
  writeFileSync(
    join(cwd, ".claude", "context-mode.json"),
    JSON.stringify(
      {
        sources: [
          {
            label: "vault",
            description: "test vault notes",
            path: cwd,
            glob: "*.md",
            recursive: false,
            stripFrontmatter: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "wrapper.bundle.mjs")],
    cwd,
    stderr: "inherit",
    env: { ...(process.env as Record<string, string>), PWD: cwd },
  });

  const client = new Client({ name: "context-wrapper-e2e", version: "0.0.0" });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "batch_execute",
      "batch_read",
      "execute",
      "fetch_and_index",
      "index",
      "search",
    ]);

    const searchDescription =
      tools.find((t) => t.name === "search")?.description ?? "";
    assert.match(searchDescription, /Pre-warmed at startup/);
    assert.match(searchDescription, /`vault` \(1 file\) — test vault notes/);

    // queries is advertised as array-OR-string so strict clients accept
    // the JSON-encoded form weak models emit.
    const searchQueriesSchema = (
      tools.find((t) => t.name === "search")?.inputSchema as any
    )?.properties?.queries;
    assert.ok(Array.isArray(searchQueriesSchema?.anyOf), "search.queries should be anyOf");
    assert.deepEqual(
      searchQueriesSchema.anyOf.map((b: any) => b.type),
      ["array", "string"],
    );

    const prewarm = await client.callTool({
      name: "search",
      arguments: { queries: ["prewarm-token-xyz"], limit: 3 },
    });
    const prewarmText = (prewarm as any).content?.[0]?.text ?? "";
    assert.match(prewarmText, /prewarm-token-xyz/);
    assert.match(prewarmText, /vault: hello\.md/);

    // JSON-encoded-string queries are coerced to a real array.
    const stringQueries = await client.callTool({
      name: "search",
      arguments: { queries: '["prewarm-token-xyz"]', limit: 3 },
    });
    const stringQueriesText = (stringQueries as any).content?.[0]?.text ?? "";
    assert.match(stringQueriesText, /prewarm-token-xyz/);

    // Malformed JSON-looking queries are rejected, not silently lifted.
    const badQueries = await client.callTool({
      name: "search",
      arguments: { queries: '["prewarm-token-xyz"', limit: 3 },
    });
    assert.equal((badQueries as any).isError, true);
    assert.match((badQueries as any).content?.[0]?.text ?? "", /looks like a JSON array/);

    const exec = await client.callTool({
      name: "execute",
      arguments: { language: "shell", code: "pwd" },
    });
    const execText = (exec as any).content?.[0]?.text ?? "";
    assert.match(execText, /```shell\npwd\n```/);
    assert.match(execText, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

    const index = await client.callTool({
      name: "index",
      arguments: { path: "docs", source: "docs-src" },
    });
    const indexText = (index as any).content?.[0]?.text ?? "";
    assert.match(indexText, /Indexed 1 file \(1 chunks\)/);

    const search = await client.callTool({
      name: "search",
      arguments: { queries: ["folder-token-abc"], source: "docs-src", limit: 3 },
    });
    const searchText = (search as any).content?.[0]?.text ?? "";
    assert.match(searchText, /folder-token-abc/);
    assert.match(searchText, /docs-src: guide\.md/);
    assert.doesNotMatch(searchText, /title: Guide/);

    const batchRead = await client.callTool({
      name: "batch_read",
      arguments: {
        files: ["hello.md", "docs/guide.md"],
        queries: ["prewarm-token-xyz", "folder-token-abc"],
      },
    });
    const batchReadText = (batchRead as any).content?.[0]?.text ?? "";
    assert.match(batchReadText, /prewarm-token-xyz/);
    assert.match(batchReadText, /folder-token-abc/);
    assert.match(batchReadText, /Batch ID:/);
    assert.match(batchReadText, /hello\.md/);
    assert.match(batchReadText, /guide\.md/);

    // batch_read coerces JSON-encoded-string files and queries too.
    const batchReadStr = await client.callTool({
      name: "batch_read",
      arguments: {
        files: '["hello.md", "docs/guide.md"]',
        queries: '["prewarm-token-xyz", "folder-token-abc"]',
      },
    });
    const batchReadStrText = (batchReadStr as any).content?.[0]?.text ?? "";
    assert.match(batchReadStrText, /prewarm-token-xyz/);
    assert.match(batchReadStrText, /folder-token-abc/);

    console.log("e2e smoke: ok");
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }

  await configEnvOverride();
  await relativeSourcesFromASubdirectory();
}

// A discovered config's relative source paths resolve against the directory
// holding its `.claude/`, not the launch cwd: launched two levels below the
// config, a relative glob source and a relative exec source still pre-warm.
async function relativeSourcesFromASubdirectory(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cw-e2e-rel-"));
  const launchCwd = join(root, "pkg", "deep");
  mkdirSync(launchCwd, { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "rel.md"), "# Rel\n\nrelative-glob-token-456\n");
  writeFileSync(join(root, "listed.md"), "# Listed\n\nrelative-exec-token-654\n");
  writeFileSync(
    join(root, ".claude", "context-mode.json"),
    JSON.stringify({
      sources: [
        { label: "relglob", description: "relative glob", path: "docs", glob: "*.md" },
        {
          label: "relexec",
          description: "relative exec",
          path: ".",
          exec: `node -e 'console.log(JSON.stringify(["listed.md"]))'`,
        },
      ],
    }),
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "wrapper.bundle.mjs")],
    cwd: launchCwd,
    stderr: "inherit",
    env: { ...(process.env as Record<string, string>), PWD: launchCwd },
  });
  const client = new Client({ name: "context-wrapper-e2e-rel", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const searchDescription =
      tools.find((t) => t.name === "search")?.description ?? "";
    assert.match(searchDescription, /`relglob` \(1 file\) — relative glob/);
    assert.match(searchDescription, /`relexec` \(1 file\) — relative exec/);

    const found = await client.callTool({
      name: "search",
      arguments: { queries: ["relative-glob-token-456", "relative-exec-token-654"], limit: 3 },
    });
    const foundText = (found as any).content?.[0]?.text ?? "";
    assert.match(foundText, /relative-glob-token-456/);
    assert.match(foundText, /relative-exec-token-654/);

    console.log("e2e smoke (relative sources from a subdirectory): ok");
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

// Proves CONTEXT_WRAPPER_CONFIG loads an exact file and bypasses the CWD walk:
// the launch cwd has no .claude/context-mode.json anywhere up its tree, so a
// successful pre-warm can only come from the env-pointed config.
async function configEnvOverride(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cw-e2e-env-"));
  const launchCwd = join(root, "no-config");
  mkdirSync(launchCwd, { recursive: true });
  writeFileSync(join(launchCwd, "note.md"), "# Env\n\nenv-override-token-789\n");

  const configPath = join(root, "elsewhere", "ctx.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      sources: [
        {
          label: "envvault",
          description: "env-override notes",
          path: launchCwd,
          glob: "*.md",
          recursive: false,
        },
        {
          label: "envrelative",
          description: "relative to the launch cwd",
          path: ".",
          glob: "*.md",
          recursive: false,
        },
      ],
    }),
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "wrapper.bundle.mjs")],
    cwd: launchCwd,
    stderr: "inherit",
    env: {
      ...(process.env as Record<string, string>),
      PWD: launchCwd,
      CONTEXT_WRAPPER_CONFIG: configPath,
    },
  });
  const client = new Client({ name: "context-wrapper-e2e-env", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const searchDescription =
      tools.find((t) => t.name === "search")?.description ?? "";
    assert.match(searchDescription, /`envvault` \(1 file\) — env-override notes/);
    // A config named by the env var belongs to no project tree, so its
    // relative sources resolve against the launch cwd.
    assert.match(searchDescription, /`envrelative` \(1 file\) — relative to the launch cwd/);

    const prewarm = await client.callTool({
      name: "search",
      arguments: { queries: ["env-override-token-789"], limit: 3 },
    });
    const prewarmText = (prewarm as any).content?.[0]?.text ?? "";
    assert.match(prewarmText, /env-override-token-789/);
    assert.match(prewarmText, /envvault: note\.md/);

    console.log("e2e smoke (config env override): ok");
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
