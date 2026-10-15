// Baseline cache: per-file diff, cold-miss rules, manifest stability, session sweep, concurrent write-back.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { baselinePath, prewarmSession, sweepDead } from "../src/cache.ts";
import { formatPrewarmManifest, parseConfig, type Config, type FoundConfig } from "../src/prewarm.ts";
import { ContentStore } from "../src/store.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function project(files: Record<string, string>, config?: Config): FoundConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ctxmode-cache-")));
  roots.push(root);
  mkdirSync(join(root, "notes"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "notes", name), body);
  config ??= { sources: [{ label: "notes", description: "test notes", path: "notes", glob: "*.md" }] };
  writeFileSync(join(root, "ctxmode.json"), JSON.stringify(config));
  return { config, configPath: join(root, "ctxmode.json"), sourceBase: root };
}

function run(found: FoundConfig) {
  const session = join(found.sourceBase, "session.db");
  const report = prewarmSession(found, session);
  const store = new ContentStore(session);
  const hits = (q: string) => store.search(q, 10).map((r) => r.source);
  return { report, manifest: formatPrewarmManifest(report.sources), hits, close: () => store.close() };
}

const counts = (r: { report: any }) => {
  const { warm, clean, changed, added, removed, refreshed } = r.report;
  return { warm, clean, changed, added, removed, refreshed };
};

describe("diff classification", () => {
  const found = project({
    "same.md": "# Same\n\nalpha\n",
    "touched.md": "# Touched\n\nbravo\n",
    "edited.md": "# Edited\n\ncharlie\n",
    "gone.md": "# Gone\n\ndelta\n",
    "empty.md": "\n",
  });
  const notes = join(found.sourceBase, "notes");

  test("cold build indexes everything and counts only non-empty files", () => {
    const r = run(found);
    expect(counts(r)).toEqual({ warm: false, clean: 0, changed: 0, added: 5, removed: 0, refreshed: 0 });
    expect(r.report.files).toBe(4);
    r.close();
  });

  test("unchanged, stat-only, changed, added and removed", () => {
    utimesSync(join(notes, "touched.md"), new Date(), new Date(Date.now() + 5000));
    writeFileSync(join(notes, "edited.md"), "# Edited\n\nechoes\n");
    writeFileSync(join(notes, "new.md"), "# New\n\nfoxtrot\n");
    unlinkSync(join(notes, "gone.md"));
    const r = run(found);
    expect(counts(r)).toEqual({ warm: true, clean: 2, changed: 1, added: 1, removed: 1, refreshed: 1 });
    expect(r.hits("charlie")).toEqual([]);
    expect(r.hits("echoes")).toEqual(["notes: edited.md"]);
    expect(r.hits("foxtrot")).toEqual(["notes: new.md"]);
    expect(r.hits("delta")).toEqual([]);
    expect(r.hits("bravo")).toEqual(["notes: touched.md"]);
    r.close();
  });

  test("the refreshed baseline is then fully clean", () => {
    const r = run(found);
    expect(counts(r)).toEqual({ warm: true, clean: 5, changed: 0, added: 0, removed: 0, refreshed: 0 });
    r.close();
  });
});

describe("cold misses", () => {
  test("a changed sources config is a cold build", () => {
    const found = project({ "a.md": "# A\n\nalpha\n" });
    run(found).close();
    const changed = { ...found, config: { sources: [{ ...found.config.sources[0], stripFrontmatter: true }] } };
    const r = run(changed);
    expect(r.report.warm).toBe(false);
    expect(r.hits("alpha")).toEqual(["notes: a.md"]);
    r.close();
  });

  test("a corrupt baseline is a cold build and gets replaced", () => {
    const found = project({ "a.md": "# A\n\nalpha\n" });
    run(found).close();
    writeFileSync(baselinePath(found.sourceBase), "not a database".repeat(500));
    const r = run(found);
    expect(r.report.warm).toBe(false);
    expect(r.hits("alpha")).toEqual(["notes: a.md"]);
    r.close();
    expect(run(found).report.warm).toBe(true);
  });
});

test("the search manifest line is identical cold, warm and after edits", () => {
  const found = project(
    { "a.md": "# A\n\nalpha\n", "b.md": "# B\n\nbravo\n", "blank.md": "---\ntitle: x\n---\n" },
    {
      sources: [
        { label: "first", description: "first source", path: "notes", glob: "a.md" },
        { label: "notes", description: "all notes", path: "notes", glob: "*.md", stripFrontmatter: true },
      ],
    },
  );
  const cold = run(found);
  cold.close();
  expect(cold.manifest).toContain("`first` (1 file) — first source; `notes` (2 files) — all notes");
  const warm = run(found);
  warm.close();
  expect(warm.report.warm).toBe(true);
  expect(warm.manifest).toBe(cold.manifest);

  writeFileSync(join(found.sourceBase, "notes", "c.md"), "# C\n\ncharlie\n");
  const edited = run(found);
  edited.close();
  rmSync(join(found.sourceBase, ".ctxmode"), { recursive: true });
  const rebuilt = run(found);
  rebuilt.close();
  expect(rebuilt.report.warm).toBe(false);
  expect(edited.manifest).toBe(rebuilt.manifest);
  expect(edited.report.chunks).toBe(rebuilt.report.chunks);
});

test("session sweep removes DBs of dead PIDs only", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctxmode-sessions-")));
  roots.push(dir);
  const dead = Bun.spawnSync(["true"]).pid;
  const names = [`${dead}.db`, `${dead}.db-wal`, `${dead}.db-shm`, `${process.ppid}.db`, `${process.pid}.db`, "notes.txt"];
  for (const n of names) writeFileSync(join(dir, n), "");
  expect(sweepDead(dir, /^(\d+)\.db(-wal|-shm)?$/)).toBe(3);
  expect(readdirSync(dir).sort()).toEqual([`${process.pid}.db`, `${process.ppid}.db`, "notes.txt"].sort());
});

test("two concurrent write-backs leave a valid baseline", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`n${i}.md`] = `# Note ${i}\n\nbody ${i} ${"lorem ipsum ".repeat(50)}\n`;
  const found = project(files);
  const env = { ...process.env, CTXMODE_CONFIG: found.configPath, XDG_CACHE_HOME: join(found.sourceBase, "cache") };
  const spawn = () => Bun.spawn([process.execPath, MAIN, "prewarm"], { cwd: found.sourceBase, env, stdout: "pipe", stderr: "pipe" });
  const procs = [spawn(), spawn()];
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);

  const db = new Database(baselinePath(found.sourceBase), { readonly: true });
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("SELECT COUNT(*) AS n FROM cache_files").get()).toEqual({ n: 200 });
  db.close();
  expect(readdirSync(join(found.sourceBase, ".ctxmode")).sort()).toEqual([".gitignore", "baseline.db"]);
  const r = run(found);
  expect(counts(r)).toEqual({ warm: true, clean: 200, changed: 0, added: 0, removed: 0, refreshed: 0 });
  r.close();
});

test("a failing exec source keeps its previous files", () => {
  const found = project({ "a.md": "# A\n\nalpha\n", "b.md": "# B\n\nbravo\n" });
  const flag = join(found.sourceBase, "exec-ok");
  writeFileSync(flag, "");
  found.config = { sources: [{ label: "ex", path: "notes", exec: `test -e ${flag} && printf '["a.md","b.md"]'` }] };
  run(found).close();
  unlinkSync(flag);
  const r = run(found);
  expect(counts(r)).toEqual({ warm: true, clean: 0, changed: 0, added: 0, removed: 0, refreshed: 0 });
  expect(r.report.files).toBe(2);
  expect(r.hits("bravo")).toEqual(["ex: b.md"]);
  r.close();
});

test("a recursive glob indexes each file once despite a symlink loop", () => {
  const found = project({ "a.md": "# A\n\nalpha\n" }, { sources: [{ label: "w", path: "notes", glob: "*.md", recursive: true }] });
  symlinkSync("..", join(found.sourceBase, "notes", "loop"));
  const r = run(found);
  expect(r.report.files).toBe(1);
  expect(r.hits("alpha")).toEqual(["w: a.md"]);
  r.close();
});

describe("config parsing", () => {
  test("sources default to empty and bad entries are skipped", () => {
    expect(parseConfig(`{"subagentProfiles":{"Plan":{"skip":true}}}`, "c.json").sources).toEqual([]);
    const sources = parseConfig(
      JSON.stringify({ sources: [{ label: "ok", paths: ["a.md"] }, { label: "no-strategy" }, { paths: ["b.md"] }, "junk"] }),
      "c.json",
    ).sources;
    expect(sources.map((s) => s.label)).toEqual(["ok"]);
  });

  test("a malformed top level is an error", () => {
    for (const raw of [`[]`, `{"sources":{}}`, `{"searchReminder":true}`, `{"sources":[`]) {
      expect(() => parseConfig(raw, "c.json")).toThrow(/c\.json/);
    }
  });
});
