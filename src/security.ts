// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/security.ts.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

// ==============================================================================
// Types
// ==============================================================================

export interface SecurityPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

// ==============================================================================
// Pattern Parsing
// ==============================================================================

/**
 * Extract the glob from a Bash permission pattern.
 * "Bash(sudo *)" returns "sudo *", "Read(.env)" returns null.
 */
export function parseBashPattern(pattern: string): string | null {
  // .+ is greedy: for "Bash(echo (foo))" it captures "echo (foo)"
  // because $ forces the final \) to match only the last paren.
  const match = pattern.match(/^Bash\((.+)\)$/);
  return match ? match[1] : null;
}

/**
 * Parse any tool permission pattern like "ToolName(glob)".
 * Returns { tool, glob } or null if not a valid pattern.
 */
export function parseToolPattern(
  pattern: string,
): { tool: string; glob: string } | null {
  // .+ is greedy: for "Read(some(path))" it captures "some(path)"
  // because $ forces the final \) to match only the last paren.
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  return match ? { tool: match[1], glob: match[2] } : null;
}

// ==============================================================================
// Glob-to-Regex Conversion
// ==============================================================================

/** Escape all regex special characters (including *). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/\-]/g, "\\$&");
}

/** Escape regex specials except *, then convert * to .* */
function convertGlobPart(glob: string): string {
  return glob
    .replace(/[.+?^${}()|[\]\\\/\-]/g, "\\$&")
    .replace(/\*/g, ".*");
}

/**
 * Convert a Bash permission glob to a regex.
 *
 * Two formats:
 * - Colon: "tree:*" becomes /^tree(\s.*)?$/ (command with optional args)
 * - Space: "sudo *" becomes /^sudo .*$/  (literal glob match)
 */
export function globToRegex(glob: string): RegExp {
  let regexStr: string;

  const colonIdx = glob.indexOf(":");
  if (colonIdx !== -1) {
    // Colon format: "command:argsGlob"
    const command = glob.slice(0, colonIdx);
    const argsGlob = glob.slice(colonIdx + 1);
    const escapedCmd = escapeRegex(command);
    const argsRegex = convertGlobPart(argsGlob);
    // Match command alone OR command + space + args
    regexStr = `^${escapedCmd}(\\s${argsRegex})?$`;
  } else {
    // Plain glob: "sudo *", "ls*", "* commit *"
    regexStr = `^${convertGlobPart(glob)}$`;
  }

  return new RegExp(regexStr);
}

/**
 * Convert a file path glob to a regex.
 *
 * Unlike `globToRegex` (which handles command patterns with colon and
 * space semantics), this handles file path globs where:
 * - `**` matches any number of path segments (including zero)
 * - `*` matches anything except path separators
 */
export function fileGlobToRegex(glob: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < glob.length) {
    // Handle ** (globstar): match any number of directory segments
    if (glob[i] === "*" && glob[i + 1] === "*") {
      // **/ at the start or after a slash means "zero or more directories"
      if (i + 2 < glob.length && glob[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3; // skip "*" "*" "/"
      } else {
        // Trailing ** matches everything
        regexStr += ".*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      // Single * matches anything except /
      regexStr += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      // Escape regex-special characters
      regexStr += glob[i].replace(/[.+^${}()|[\]\\\/\-]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/**
 * Check if a command matches any Bash pattern in the list.
 * Returns the matching pattern string, or null.
 */
export function matchesAnyPattern(command: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const glob = parseBashPattern(pattern);
    if (!glob) continue;
    if (globToRegex(glob).test(command)) return pattern;
  }
  return null;
}

// ==============================================================================
// Chained Command Splitting & Subshell Extraction
// ==============================================================================

function isEscaped(command: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && command[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Split a shell command on chain operators (&&, ||, ;, |, \n, \r, &) while
 * respecting single/double quotes, backticks, subshells, and escape backslashes.
 *
 * "echo hello && sudo rm -rf /" → ["echo hello", "sudo rm -rf /"]
 *
 * This prevents bypassing deny patterns by prepending innocent commands.
 */
export function splitChainedCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let dollarParenDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const escaped = isEscaped(command, i);

    if (ch === "'" && !inDouble && !inBacktick && !escaped) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && !inBacktick && !escaped) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "`" && !inSingle && !inDouble && !escaped) {
      inBacktick = !inBacktick;
      current += ch;
    } else if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "$" && command[i + 1] === "(" && !escaped) {
        dollarParenDepth++;
        current += ch + command[i + 1];
        i++;
      } else if (dollarParenDepth > 0 && ch === "(" && !escaped) {
        dollarParenDepth++;
        current += ch;
      } else if (ch === ")" && dollarParenDepth > 0 && !escaped) {
        dollarParenDepth--;
        current += ch;
      } else if (
        dollarParenDepth === 0 &&
        (ch === ";" || ch === "\n" || ch === "\r") &&
        !escaped
      ) {
        parts.push(current.trim());
        current = "";
      } else if (dollarParenDepth === 0 && ch === "|" && command[i + 1] === "|") {
        parts.push(current.trim());
        current = "";
        i++; // skip second |
      } else if (dollarParenDepth === 0 && ch === "&" && command[i + 1] === "&") {
        parts.push(current.trim());
        current = "";
        i++; // skip second &
      } else if (dollarParenDepth === 0 && ch === "&" && !escaped) {
        parts.push(current.trim());
        current = "";
      } else if (dollarParenDepth === 0 && ch === "|") {
        // Single pipe — left side is a command too
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Recursively extract all nested subshell commands from `$()` and `` `...` ``.
 * Handles escaping and quote contexts to ensure correct command boundary detection.
 */
export function extractSubshellCommands(command: string): string[] {
  const subshells: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let backtickStart = -1;

  const dollarParenStarts: number[] = [];
  const dollarParenDepths: number[] = [];
  let parenDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const escaped = isEscaped(command, i);

    if (ch === "'" && !inDouble && backtickStart === -1 && !escaped) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && backtickStart === -1 && !escaped) {
      inDouble = !inDouble;
    } else if (ch === "`" && !inSingle && !inDouble && !escaped) {
      if (backtickStart === -1) {
        backtickStart = i + 1;
      } else {
        const sub = command.slice(backtickStart, i);
        subshells.push(sub);
        subshells.push(...extractSubshellCommands(sub));
        backtickStart = -1;
      }
    } else if (!inSingle && backtickStart === -1) {
      if (ch === "$" && command[i + 1] === "(" && !escaped) {
        if (command[i + 2] === "(") {
          // Arithmetic expansion is not command execution, but nested command
          // substitutions inside it still get discovered by the scanner.
          parenDepth += 2;
          i += 2; // skip '(('
        } else {
          dollarParenStarts.push(i + 2);
          dollarParenDepths.push(parenDepth);
          parenDepth++;
          i++; // skip '('
        }
      } else if (ch === "(" && !escaped) {
        parenDepth++;
      } else if (ch === ")" && !escaped) {
        if (parenDepth > 0) {
          parenDepth--;
        }
        if (
          dollarParenDepths.length > 0 &&
          parenDepth === dollarParenDepths[dollarParenDepths.length - 1]
        ) {
          dollarParenDepths.pop();
          const start = dollarParenStarts.pop()!;
          const sub = command.slice(start, i);
          subshells.push(sub);
        }
      }
    }
  }
  return subshells;
}

function collectCommandElements(command: string): string[] {
  const elements: string[] = [];
  const segments = splitChainedCommands(command);
  for (const segment of segments) {
    elements.push(segment);
    for (const subshell of extractSubshellCommands(segment)) {
      elements.push(...collectCommandElements(subshell));
    }
  }
  return elements;
}

// ==============================================================================
// Settings Reader
// ==============================================================================

/** Read one settings file and return a SecurityPolicy with only Bash patterns. */
function readSingleSettings(path: string): SecurityPolicy | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const perms = parsed?.permissions;
  if (!perms || typeof perms !== "object") return null;

  const filterBash = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is string => typeof p === "string" && parseBashPattern(p) !== null,
    );
  };

  return {
    allow: filterBash(perms.allow),
    deny: filterBash(perms.deny),
    ask: filterBash(perms.ask),
  };
}

/** Claude Code's settings files, most local first; CLAUDE_CONFIG_DIR moves the user-level one. */
function settingsPaths(projectDir: string): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = !env ? resolve(homedir(), ".claude")
    : env.startsWith("~") ? resolve(homedir(), env.replace(/^~\/?/, ""))
    : resolve(env);
  return [
    resolve(projectDir, ".claude", "settings.local.json"),
    resolve(projectDir, ".claude", "settings.json"),
    resolve(configDir, "settings.json"),
  ];
}

/** Bash permission policies from every settings file that parses, most local first. */
export function readBashPolicies(projectDir: string): SecurityPolicy[] {
  return settingsPaths(projectDir).flatMap((path) => readSingleSettings(path) ?? []);
}

/**
 * `permissions.{deny|allow}` globs for one tool, one array per settings file
 * that parses, most local first.
 */
export function readToolPermissionPatterns(toolName: string, kind: "deny" | "allow", projectDir: string): string[][] {
  const result: string[][] = [];
  for (const path of settingsPaths(projectDir)) {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const entries = parsed?.permissions?.[kind];
    if (!Array.isArray(entries)) {
      result.push([]);
      continue;
    }
    const globs: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const tp = parseToolPattern(entry);
      if (tp && tp.tool === toolName) globs.push(tp.glob);
    }
    result.push(globs);
  }
  return result;
}

// ==============================================================================
// Decision Engine
// ==============================================================================

/**
 * Server-side variant: only enforce deny patterns.
 *
 * The server has no UI for "ask" prompts, so allow/ask patterns are
 * irrelevant. Returns "deny" if any deny pattern matches, otherwise "allow".
 *
 * Also splits chained commands and nested subshells to prevent bypass.
 */
export function evaluateCommandDenyOnly(
  command: string,
  policies: SecurityPolicy[],
): { decision: "deny" | "allow"; matchedPattern?: string } {
  const allCommands = collectCommandElements(command);

  for (const cmdElement of allCommands) {
    for (const policy of policies) {
      const denyMatch = matchesAnyPattern(cmdElement, policy.deny);
      if (denyMatch) return { decision: "deny", matchedPattern: denyMatch };
    }
  }

  return { decision: "allow" };
}

// ==============================================================================
// File Path Evaluation
// ==============================================================================

/**
 * Does `filePath` match any of the globs? With `projectRoot`, the path is also
 * matched in its resolved absolute form and, when it exists, its realpath, so
 * neither `..` traversal nor a symlink out of the project evades an absolute
 * glob. A path that does not exist yet is matched lexically.
 */
export function evaluateFilePath(
  filePath: string,
  denyGlobs: string[][],
  projectRoot?: string,
): { denied: boolean; matchedPattern?: string } {
  const candidates = new Set([filePath]);
  if (projectRoot) {
    const lexical = resolve(projectRoot, filePath);
    candidates.add(lexical);
    try {
      candidates.add(realpathSync(lexical));
    } catch { /* does not exist yet */ }
  }

  for (const globs of denyGlobs) {
    for (const glob of globs) {
      const regex = fileGlobToRegex(glob);
      for (const candidate of candidates) {
        if (regex.test(candidate)) return { denied: true, matchedPattern: glob };
      }
    }
  }
  return { denied: false };
}

// ==============================================================================
// Project-Boundary Containment
// ==============================================================================

/**
 * Does `filePath` resolve inside `projectRoot`? The lexical form must, and
 * when the file exists its realpath must too, so a project-local symlink to
 * `~/.ssh/id_rsa` does not count as inside. The root itself counts as inside.
 */
export function isPathInsideProject(filePath: string, projectRoot: string): boolean {
  const within = (root: string, candidate: string): boolean => {
    const rel = relative(root, candidate);
    return rel !== ".." && !rel.startsWith(".." + sep);
  };
  const root = resolve(projectRoot);
  const lexical = resolve(projectRoot, filePath);
  if (!within(root, lexical)) return false;
  try {
    return within(realpathSync(root), realpathSync(lexical));
  } catch {
    return true; // does not exist yet: the lexical decision stands
  }
}

/**
 * May `filePath` be processed? Inside the project root it may; outside, only
 * when a Read allow rule the user already keeps for Claude Code matches it.
 */
export function evaluateProjectContainment(
  filePath: string,
  projectRoot: string,
  allowGlobs: string[][] = [],
): { allowed: boolean; reason: "inside" | "allow-rule" | "outside" } {
  if (isPathInsideProject(filePath, projectRoot)) return { allowed: true, reason: "inside" };
  // evaluateFilePath reports a match as `denied`; against allow globs that means allowed.
  if (evaluateFilePath(filePath, allowGlobs, projectRoot).denied) return { allowed: true, reason: "allow-rule" };
  return { allowed: false, reason: "outside" };
}

// ==============================================================================
// Shell-Escape Scanner
// ==============================================================================

// Regex patterns that detect shell-escape calls in non-shell languages.
// Each pattern uses capture groups so that the embedded command string
// can be extracted from the last non-quote group.
//
// NOTE: These regexes contain literal strings like "execSync" — they are
// patterns for *detecting* shell escapes in user code, not actual usage.
const SHELL_ESCAPE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /os\.system\(\s*(['"])(.*?)\1\s*\)/g,
    /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*(['"])(.*?)\1/g,
  ],
  javascript: [
    /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
    /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
  ],
  typescript: [
    /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
    /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
  ],
};

/**
 * Extract all string elements from a Python subprocess list call.
 *
 * subprocess.run(["rm", "-rf", "/"]) → "rm -rf /"
 *
 * This catches the list-of-strings form that the single-string regex misses.
 */
function extractPythonSubprocessListArgs(code: string): string[] {
  const commands: string[] = [];
  const pattern =
    /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[([^\]]+)\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const listContent = match[1];
    const args = [...listContent.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
    if (args.length > 0) {
      commands.push(args.join(" "));
    }
  }

  return commands;
}

/**
 * Scan non-shell code for shell-escape calls and extract the embedded
 * command strings.
 *
 * Returns an array of command strings found in the code. For unknown
 * languages or code without shell-escape calls, returns an empty array.
 */
export function extractShellCommands(
  code: string,
  language: string,
): string[] {
  const patterns = SHELL_ESCAPE_PATTERNS[language];
  if (!patterns && language !== "python") return [];

  const commands: string[] = [];

  if (patterns) {
    for (const pattern of patterns) {
      // Reset lastIndex since we reuse the global regex
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(code)) !== null) {
        // The command string is the last capture group; the first is its quote.
        const command = match[match.length - 1];
        if (command) commands.push(command);
      }
    }
  }

  // Python: also extract subprocess list-form args
  if (language === "python") {
    commands.push(...extractPythonSubprocessListArgs(code));
  }

  return commands;
}
