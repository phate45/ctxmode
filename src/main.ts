// Entry point: subcommand dispatch; with no subcommand, serve MCP over stdio.
import { argv, exit, stderr } from "node:process";

const [command = "serve"] = argv.slice(2);

switch (command) {
  case "serve":
    try {
      await (await import("./server.ts")).serve();
    } catch (err) {
      const e = err as Error;
      stderr.write(`[context-wrapper] Fatal: ${e.message}\n${e.stack}\n`);
      exit(1);
    }
    break;
  default:
    stderr.write(`unknown command: ${command}\nusage: main [serve]\n`);
    exit(2);
}
