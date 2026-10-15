// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/executor.ts and src/runtime.ts.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
export type { ExecResult } from "./types.js";
import type { ExecResult } from "./types.js";

export type Language = "javascript" | "typescript" | "python" | "shell";

const SCRIPT_EXT: Record<Language, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  shell: "sh",
};

// Combined stdout+stderr cap: `yes` or `cat /dev/urandom` would otherwise fill memory before any timeout.
const HARD_CAP_BYTES = 100 * 1024 * 1024;

// Deletes the variable that makes the binary act as bun before any user code runs, so its children start normally.
const PRELOAD = "ctxmode-preload.js";

// SHELL may only name a real shell, so it cannot redirect execution to an arbitrary binary.
const ALLOWED_SHELLS = /^(bash|sh|zsh|dash)$/;

let runtimes: { python: string | null; shell: string } | undefined;

function detectRuntimes(): { python: string | null; shell: string } {
  const user = process.env.SHELL;
  return {
    python: Bun.which("python3") ? "python3" : Bun.which("python") ? "python" : null,
    shell: user && existsSync(user) && ALLOWED_SHELLS.test(basename(user)) ? user : Bun.which("bash") ? "bash" : "sh",
  };
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Kill the process group, so children the script started die with it. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch { /* already dead */ }
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  /** Keep process running after timeout instead of killing it. */
  background?: boolean;
  /** Working directory; defaults to the server's cwd. The script file itself lives in a temp dir. */
  cwd?: string;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  /** PIDs of backgrounded processes — killed on cleanup to prevent zombies. */
  #backgroundedPids = new Set<number>();

  /** Kill all backgrounded processes to prevent zombie/port-conflict issues. */
  cleanupBackgrounded(): void {
    for (const pid of this.#backgroundedPids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch { /* already dead */ }
    }
    this.#backgroundedPids.clear();
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false, cwd = process.cwd() } = opts;
    // /tmp, not os.tmpdir(): some tools set TMPDIR to the project root, which would litter the tree.
    const tmpDir = mkdtempSync(join("/tmp", ".ctxmode-"));
    try {
      const result = await this.#spawn(this.#writeScript(tmpDir, code, language), cwd, tmpDir, timeout, background);
      // A backgrounded process may still need its script.
      if (!result.backgrounded) rmSync(tmpDir, { recursive: true, force: true });
      return result;
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, timeout } = opts;
    const absolutePath = resolve(process.cwd(), filePath);
    return this.execute({ language, code: this.#wrapWithFileContent(absolutePath, language, code), timeout });
  }

  /** Write the script and return the command that runs it. Prefixes stay on the script's first line, so error line numbers match the caller's code. */
  #writeScript(tmpDir: string, code: string, language: Language): string[] {
    runtimes ??= detectRuntimes();
    const fp = join(tmpDir, `script.${SCRIPT_EXT[language]}`);
    if (language === "shell") {
      // Restores the caller's PATH in case shell startup rewrote it.
      const path = process.env.PATH ? `export PATH=${quoteForPosixShell(process.env.PATH)};` : "";
      writeFileSync(fp, path + code, { encoding: "utf-8", mode: 0o700 });
      return [runtimes.shell, fp];
    }
    writeFileSync(fp, code, "utf-8");
    if (language === "python") {
      if (!runtimes.python) throw new Error("No Python runtime available. Install python3 or python.");
      return [runtimes.python, fp];
    }
    writeFileSync(join(tmpDir, PRELOAD), "delete process.env.BUN_BE_BUN;\n", "utf-8");
    return [process.execPath, "--preload", join(tmpDir, PRELOAD), fp];
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    timeout: number | undefined,
    background = false,
  ): Promise<ExecResult> {
    return new Promise((res) => {
      const env = this.#buildSafeEnv(sandboxTmpDir);
      // Lets a compiled binary act as the bun CLI when it runs JS/TS scripts.
      if (cmd[0] === process.execPath) env["BUN_BE_BUN"] = "1";
      // A new process group lets killTree reach the script's children.
      const proc = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env, detached: true });

      let timedOut = false;
      let resolved = false;
      // No timeout unless the caller asks: the MCP host's RPC timeout is the policy.
      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        if (background) {
          // Background mode: detach process, return partial output, keep running
          resolved = true;
          if (proc.pid) this.#backgroundedPids.add(proc.pid);
          proc.unref();
          // Do NOT destroy stdout/stderr — closing the read end of the pipe
          // sends SIGPIPE to the child on its next write, killing it.
          // Instead, replace the data listeners with no-op drains that
          // consume the stream without accumulating buffers. This keeps
          // the pipe open and prevents the child from blocking on a full
          // pipe buffer.
          if (proc.stdout) {
            proc.stdout.removeAllListeners("data");
            proc.stdout.on("data", () => {});
          }
          if (proc.stderr) {
            proc.stderr.removeAllListeners("data");
            proc.stderr.on("data", () => {});
          }
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          res({
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: 0,
            timedOut: true,
            backgrounded: true,
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;

      proc.stdout!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= HARD_CAP_BYTES) {
          stdoutChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= HARD_CAP_BYTES) {
          stderrChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        let stderr = Buffer.concat(stderrChunks).toString("utf-8");
        if (capExceeded) stderr += `\n[output capped at ${(HARD_CAP_BYTES / 1024 / 1024).toFixed(0)}MB — process killed]`;
        res({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  #buildSafeEnv(tmpDir: string): Record<string, string> {
    const realHome = process.env.HOME ?? tmpDir;

    // Denylist: env vars that corrupt sandbox stdout, inject code, or break
    // language runtimes. Each entry is backed by CVE, MITRE, or live testing.
    // See: https://www.elttam.com/blog/env/, MITRE T1574.006
    const DENIED = new Set([
      // Shell — auto-execute scripts, override builtins
      "BASH_ENV",             // sourced by non-interactive bash
      "ENV",                  // sourced by sh/dash
      "PROMPT_COMMAND",       // runs before each prompt
      "PS4",                  // $(cmd) expansion in xtrace
      "SHELLOPTS",            // enables xtrace/verbose, dumps to stdout
      "BASHOPTS",             // bash-specific shell options
      "CDPATH",               // makes cd print to stdout
      "INPUTRC",              // readline key rebinding
      "BASH_XTRACEFD",        // redirects debug output to stdout
      // Node.js — require injection, inspector
      "NODE_OPTIONS",         // --require, --loader, --inspect
      "NODE_PATH",            // module search path injection
      // Python — stdlib override, startup injection
      "PYTHONSTARTUP",        // auto-executes in interactive mode
      "PYTHONHOME",           // overrides stdlib location (breaks Python)
      "PYTHONWARNINGS",       // triggers module import chain → RCE
      "PYTHONBREAKPOINT",     // arbitrary callable
      "PYTHONINSPECT",        // enters interactive mode after script
      // Ruby — option/module injection
      "RUBYOPT",              // injects CLI options (-r loads files)
      "RUBYLIB",              // module search path injection
      // Perl — option/module injection
      "PERL5OPT",             // injects CLI options (-M runs code)
      "PERL5LIB",             // module search path injection
      "PERLLIB",              // legacy module search path
      "PERL5DB",              // debugger command injection
      // Elixir/Erlang — eval injection
      "ERL_AFLAGS",           // prepends erl flags (-eval runs code)
      "ERL_FLAGS",            // appends erl flags
      "ELIXIR_ERL_OPTIONS",   // Elixir-specific erl flags
      "ERL_LIBS",             // beam file loading
      // Go — compiler/linker injection
      "GOFLAGS",              // injects go command flags
      "CGO_CFLAGS",           // C compiler flag injection
      "CGO_LDFLAGS",          // linker flag injection
      // Rust — compiler substitution
      "RUSTC",                // arbitrary compiler binary
      "RUSTC_WRAPPER",        // compiler wrapper injection
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTFLAGS",            // compiler flag injection
      // PHP — config injection
      "PHPRC",                // auto_prepend_file → RCE
      "PHP_INI_SCAN_DIR",     // additional .ini loading
      // R — startup script injection
      "R_PROFILE",            // site-wide R profile
      "R_PROFILE_USER",       // user R profile
      "R_HOME",               // R installation override
      // .NET / C# — runtime/startup hooks, additional deps
      "DOTNET_STARTUP_HOOKS",       // injects managed assemblies on startup
      "DOTNET_ADDITIONAL_DEPS",     // additional .deps.json injection
      "DOTNET_SHARED_STORE",        // shared assembly probe path injection
      "DOTNET_ROOT",                // arbitrary .NET runtime override
      "DOTNET_ROOT(x86)",           // 32-bit override
      "DOTNET_HOST_PATH",           // host binary substitution
      // .NET / C# — profiler attach (loads arbitrary DLL into dotnet host)
      // and IPC-based debugger/IL injection. PR #546 follow-up.
      // learn.microsoft.com/en-us/dotnet/core/runtime-config/debugging-profiling
      "CORECLR_PROFILER",                 // CLSID of profiler to attach
      "CORECLR_PROFILER_PATH",            // path to profiler DLL
      "CORECLR_PROFILER_PATH_32",         // 32-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_64",         // 64-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM32",      // ARM32 specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM64",      // ARM64 specific profiler DLL
      "CORECLR_ENABLE_PROFILING",         // gates profiler load
      "DOTNET_PROFILER_PATH",             // cross-platform alias
      "DOTNET_PROFILER_PATH_32",
      "DOTNET_PROFILER_PATH_64",
      "DOTNET_PROFILER_PATH_ARM32",
      "DOTNET_PROFILER_PATH_ARM64",
      "DOTNET_DiagnosticPorts",           // peer attach via diagnostic IPC
      "DOTNET_BUNDLE_EXTRACT_BASE_DIR",   // single-file extraction hijack
      // Dynamic linker — shared library injection
      "LD_PRELOAD",           // loads .so before all others (Linux)
      "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD
      // OpenSSL — engine loading
      "OPENSSL_CONF",         // loads engine modules → .so exec
      "OPENSSL_ENGINES",      // engine directory override
      // Compiler — binary substitution
      "CC",                   // C compiler override
      "CXX",                  // C++ compiler override
      "AR",                   // archiver override
      // Git — command injection via hooks/config
      "GIT_TEMPLATE_DIR",     // hook injection on git init
      "GIT_CONFIG_GLOBAL",    // core.pager/editor runs commands
      "GIT_CONFIG_SYSTEM",    // system-level config injection
      "GIT_EXEC_PATH",        // substitute git subcommands
      "GIT_SSH",              // arbitrary command instead of ssh
      "GIT_SSH_COMMAND",      // arbitrary ssh command
      "GIT_ASKPASS",          // arbitrary credential command
    ]);

    // Start with parent env, then strip dangerous vars and apply overrides.
    // The `COMPlus_` prefix sweep covers every COMPlus_* synonym of the
    // DOTNET_* runtime knobs (.NET back-compat alias — case-insensitive).
    // PR #546 follow-up: closes the alias bypass for the explicit denylist
    // entries above.
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (
        val !== undefined &&
        !DENIED.has(key) &&
        !key.startsWith("BASH_FUNC_") &&
        !/^COMPlus_/i.test(key)
      ) {
        env[key] = val;
      }
    }

    // Sandbox overrides — forced values for correct sandbox behavior
    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";
    env["PATH"] ||= "/usr/local/bin:/usr/bin:/bin";

    // Ensure SSL_CERT_FILE is set so Python/Ruby HTTPS works in sandbox.
    if (!env["SSL_CERT_FILE"]) {
      const certPaths = [
        "/etc/ssl/cert.pem",                         // some Linux
        "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
        "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  /** Defines FILE_CONTENT_PATH, file_path and FILE_CONTENT on the code's first line; Python needs a line of its own. */
  #wrapWithFileContent(absolutePath: string, language: Language, code: string): string {
    const escaped = JSON.stringify(absolutePath);
    switch (language) {
      case "javascript":
      case "typescript":
        return `const FILE_CONTENT_PATH = ${escaped}, file_path = FILE_CONTENT_PATH, FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}; file_path = FILE_CONTENT_PATH; FILE_CONTENT = open(FILE_CONTENT_PATH, encoding="utf-8").read()\n${code}`;
      case "shell": {
        const sq = quoteForPosixShell(absolutePath);
        return `FILE_CONTENT_PATH=${sq}; file_path=${sq}; FILE_CONTENT=$(cat ${sq});${code}`;
      }
    }
  }
}
