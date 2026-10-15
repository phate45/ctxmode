// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/runtime.ts.
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Allowlist for SHELL env override. Only POSIX shells + Windows shells permit
 * arbitrary command interpretation; anything else (e.g., /usr/bin/python set
 * as SHELL) would let an attacker redirect the executor to a non-shell binary.
 *
 * basename split handles BOTH `/` and `\` separators so a Windows-style path
 * (`C:\Program Files\PowerShell\7\pwsh.exe`) classifies correctly even when
 * the runtime is on POSIX (where node:path.basename only splits on `/`).
 *
 * Match is case-insensitive; `.exe` extension tolerated for Windows binaries.
 */
const ALLOWED_SHELL_BASENAMES = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i;

function runtimeBasename(runtimePath: string): string {
  const segments = runtimePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? runtimePath;
}

export function isAllowlistedShell(shellPath: string): boolean {
  // Cross-OS basename: split on either separator, take the last segment.
  return ALLOWED_SHELL_BASENAMES.test(runtimeBasename(shellPath));
}

function isWindowsWslBash(shellPath: string): boolean {
  const lower = shellPath.toLowerCase().replace(/\//g, "\\");
  return /\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(lower) ||
    /\\microsoft\\windowsapps\\bash\.exe$/.test(lower);
}

function isWindowsSystemCmd(shellPath: string): boolean {
  const lower = shellPath.toLowerCase().replace(/\//g, "\\");
  return /\\windows\\(?:system32|sysnative)\\cmd\.exe$/.test(lower);
}

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "shell";

export interface RuntimeInfo {
  command: string;
  available: boolean;
  version: string;
  preferred: boolean;
}

export interface RuntimeMap {
  javascript: string;
  typescript: string;
  python: string | null;
  shell: string;
}

const isWindows = process.platform === "win32";

function commandExists(cmd: string): boolean {
  try {
    const check = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stricter probe than commandExists() — also verifies the resolved binary
 * actually runs. On Windows, `where python3` matches the Microsoft Store
 * App Execution Alias stub at C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\
 * even when no real Python is installed; the stub exits non-zero (9009) and
 * pops the Store. Filter those entries out and require `<cmd> --version` to
 * exit 0 before declaring the runtime available (#455).
 */
function runnableExists(cmd: string): boolean {
  if (isWindows) {
    // Reject if every `where` hit lives under Microsoft\WindowsApps (Store stubs).
    try {
      const out = execSync(`where ${cmd}`, { encoding: "utf-8", stdio: "pipe" });
      const hits = out.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      if (hits.length === 0) return false;
      const realHits = hits.filter(p => !/\\Microsoft\\WindowsApps\\/i.test(p));
      if (realHits.length === 0) return false;
    } catch {
      return false;
    }
  } else if (!commandExists(cmd)) {
    return false;
  }
  // Probe with --version. On Windows, allow 5s for cold-start (MS Store stub
  // fallthrough can be slow). On POSIX, 1500ms is plenty for a real binary
  // and keeps cold detection of python3 → python → py under ~5s total (#454).
  try {
    // DEP0190 fix: avoid args array with shell:true on Windows.
    // Use execSync with a command string when shell is required;
    // keep execFileSync (no shell) on POSIX.
    if (isWindows) {
      execSync(`"${cmd}" --version`, { stdio: "pipe", timeout: 5000 });
    } else {
      execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 1500 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Well-known Git-for-Windows bash.exe locations (MSYS bash that performs
 *  Windows→POSIX path conversion for native git — #826). */
const KNOWN_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

/**
 * On Windows, resolve the first non-WSL bash that is actually available.
 *
 * Availability is gated by `where bash` (#796): bash must be discoverable on
 * PATH for us to claim it. WSL bash (C:\Windows\System32\bash.exe) cannot
 * handle Windows paths, so we skip it and prefer Git Bash / MSYS2 bash.
 *
 * Routing the gate through `where bash` — rather than probing the known Git
 * Bash paths with existsSync first — is deliberate: when bash is genuinely
 * unavailable, the caller must fall through to pwsh (PR intent). Probing the
 * filesystem first re-detected a real Git Bash on the runner even though the
 * scenario was "bash unavailable", so pwsh was never reached.
 *
 * #826 is preserved: when `where bash` surfaces a Git Bash candidate we
 * canonicalize it to the absolute Git\usr\bin\bash.exe path (so native git
 * keeps MSYS path conversion) by preferring a matching known path that exists.
 */
function resolveWindowsBash(): string | null {
  let candidates: string[];
  try {
    const result = execSync("where bash", { encoding: "utf-8", stdio: "pipe" });
    candidates = result.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  } catch {
    // bash not on PATH → genuinely unavailable. Fall through to pwsh/etc.
    return null;
  }

  for (const p of candidates) {
    const lower = p.toLowerCase();
    if (lower.includes("system32") || lower.includes("windowsapps")) continue;
    // Prefer the canonical Git\usr\bin\bash.exe so native git retains MSYS
    // path conversion. `where bash` on a Git-for-Windows install may surface
    // the Git\cmd\bash shim or usr\bin path; upgrade to a known absolute path
    // when one exists on disk.
    for (const known of KNOWN_GIT_BASH_PATHS) {
      if (existsSync(known)) return known;
    }
    return p;
  }
  return null;
}

function resolveWindowsShell(windowsBash: string | null = resolveWindowsBash()): string {
  // Prefer Git Bash (#826) so native git keeps its MSYS path conversion.
  // The caller passes the already-resolved windowsBash to avoid probing the
  // filesystem twice (it also feeds the cmd.exe shellOverride guard above).
  // Fall back through POSIX sh, then PowerShell Core (pwsh) for proper UTF-8
  // handling, then Windows PowerShell, then cmd.exe as the last resort.
  return windowsBash
    ?? (commandExists("sh")
      ? "sh"
      : commandExists("pwsh")
        ? "pwsh"
        : commandExists("powershell")
          ? "powershell"
          : "cmd.exe");
}

export function detectRuntimes(): RuntimeMap {
  // Honor SHELL env var when it points at a real binary AND the basename is
  // an allowlisted shell. Lets users with non-standard setups (custom bash,
  // msys2, pwsh) pin context-mode to their preferred shell.
  //
  // Allowlist (PR #401 ops review): basename must match
  // /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/. Without this guard, an attacker
  // who controls SHELL (e.g., supply-chain compromise of a profile script)
  // could redirect the executor to /usr/bin/python or any arbitrary binary.
  const userShell = process.env.SHELL;
  const isWin = process.platform === "win32";
  const windowsBash = isWin ? resolveWindowsBash() : null;
  const shellOverride = userShell &&
    existsSync(userShell) &&
    isAllowlistedShell(userShell) &&
    !(isWin && isWindowsWslBash(userShell)) &&
    // Windows OpenSSH can inject the system cmd.exe as ambient SHELL. When
    // Git Bash is installed, treating that as an explicit override breaks the
    // POSIX shell executor path restored by #36/#384/#791.
    !(isWin && windowsBash && isWindowsSystemCmd(userShell))
    ? userShell
    : null;

  return {
    // JS/TS run on this process's own runtime: bun, or the compiled binary acting as bun.
    javascript: process.execPath,
    typescript: process.execPath,
    python: runnableExists("python3")
      ? "python3"
      : runnableExists("python")
        ? "python"
        : runnableExists("py")
          ? "py"
          : null,
    shell: shellOverride ?? (isWin
      ? resolveWindowsShell(windowsBash)
      : commandExists("bash") ? "bash" : "sh"),
  };
}

export function getAvailableLanguages(runtimes: RuntimeMap): Language[] {
  const langs: Language[] = ["javascript", "shell", "typescript"];
  if (runtimes.python) langs.push("python");
  return langs;
}

export function buildCommand(
  runtimes: RuntimeMap,
  language: Language,
  filePath: string,
): string[] {
  switch (language) {
    case "javascript":
    case "typescript":
      return [runtimes.javascript, filePath];

    case "python":
      if (!runtimes.python) {
        throw new Error(
          "No Python runtime available. Install python3 or python.",
        );
      }
      return [runtimes.python, filePath];

    case "shell": {
      // Re-evaluate platform per call so detection-time and command-build-time
      // can be tested independently (and to allow tests to stub process.platform).
      const winNow = process.platform === "win32";
      if (winNow) {
        const shellName = runtimes.shell.toLowerCase();
        if (shellName.includes("bash") || shellName.endsWith("/sh") || shellName.endsWith("\\sh.exe")) {
          // bash -c "source 'path'" — avoids MSYS2 path mangling on non-C:
          // drives. When bash.exe receives a script as a direct argument,
          // MSYS rewrites D:\tmp\script → D:\c\tmp\script and execution
          // breaks. The -c flag prevents MSYS from touching the file arg.
          // Single-quote escape: ' → '\''
          const escaped = filePath.replace(/'/g, "'\\''");
          return [runtimes.shell, "-c", `source '${escaped}'`];
        }
        if (shellName.includes("powershell") || shellName.includes("pwsh")) {
          // Windows PowerShell defaults to Restricted when no execution policy
          // is configured. Use process-scoped Bypass so generated temp scripts
          // run without changing machine/user policy.
          return [runtimes.shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath];
        }
        const shellBase = shellName.split(/[\\/]/).pop() ?? shellName;
        if (shellBase === "cmd" || shellBase === "cmd.exe") {
          return [runtimes.shell, "/d", "/s", "/c", filePath];
        }
        // Other Windows shells: direct file.
      }
      return [runtimes.shell, filePath];
    }
  }
}
