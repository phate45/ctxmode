/**
 * Bump the upstream context-mode git dependency, reinstall, and check.
 *
 * Usage:  bun run bump v1.0.15
 *         bun run bump 1.0.15    (v prefix added automatically)
 *
 * Exit codes follow check-upstream.ts. Informational drift is accepted into
 * the manifest here, so a bump exits 0, 2 or 3, never 1. On 3 the bumped
 * package.json and lockfile stay in place: they are the work to review.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpstream, renderCheckResult, writeManifest } from "./check-upstream.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkgPath = join(root, "package.json");

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bun run bump <tag>  (e.g. bun run bump v1.0.15)");
  process.exit(2);
}

const tag = arg.startsWith("v") ? arg : `v${arg}`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const oldDep = pkg.dependencies["context-mode"];
const newDep = `github:mksglu/context-mode#${tag}`;

pkg.dependencies["context-mode"] = newDep;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`\n  ${oldDep}\n  → ${newDep}\n`);

console.log("  Installing...\n");
try {
  execSync("bun install", { cwd: root, stdio: "inherit" });
} catch {
  process.exit(2);
}

console.log("");
const result = await checkUpstream().catch((err) => {
  console.error(err);
  process.exit(2);
});
renderCheckResult(result);

if (result.blockingChanges.length > 0) {
  console.log(
    `  ${result.blockingChanges.length} blocking change(s) detected. Review above, then run bun run check --update to accept.\n`,
  );
  process.exit(3);
}

if (result.changes.length > 0) {
  writeManifest(result.tag, result.fingerprints);
  console.log("  Informational drift only; manifest auto-updated.\n");
}
