// Entry point: subcommand dispatch; with no subcommand, serve MCP over stdio.
import { argv, cwd, exit, stderr, stdout } from "node:process";

const [command = "serve"] = argv.slice(2);

switch (command) {
  case "serve":
    try {
      await (await import("./server.ts")).serve();
    } catch (err) {
      const e = err as Error;
      stderr.write(`[ctxmode] Fatal: ${e.message}\n${e.stack}\n`);
      exit(1);
    }
    break;
  case "hook":
    (await import("./hook.ts")).runHook();
    break;
  case "prewarm": {
    // Builds or refreshes the baseline for the config serve would load here.
    const { findConfig } = await import("./prewarm.ts");
    const { formatReport, prewarmSession, startSession } = await import("./cache.ts");
    const { deleteDBFiles } = await import("./db-base.ts");
    let found;
    try {
      found = findConfig(cwd());
    } catch (err) {
      stderr.write(`[ctxmode] ${(err as Error).message}\n`);
      exit(1);
    }
    if (!found) {
      stderr.write(`[ctxmode] no .claude/ctxmode.json above ${cwd()} and CTXMODE_CONFIG is unset\n`);
      exit(1);
    }
    const session = startSession();
    const start = performance.now();
    const report = prewarmSession(found, session);
    deleteDBFiles(session);
    if (report.writeBackError) stderr.write(`[ctxmode] baseline write-back failed: ${report.writeBackError}\n`);
    stdout.write(`${formatReport(report, performance.now() - start)}\n`);
    exit(report.writeBackError ? 1 : 0);
  }
  default:
    stderr.write(`unknown command: ${command}\nusage: ctxmode [serve|prewarm|hook]\n`);
    exit(2);
}
