// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/util/claude-config.ts.
/**
 * Claude Code config directory resolver — single source of truth.
 *
 * Issue #460 follow-up: every Claude-aware reader (adapters, security policy
 * loader, hook helpers) MUST agree on where global settings live. Hardcoding
 * `~/.claude` in any one reader silently breaks `CLAUDE_CONFIG_DIR` for that
 * code path, producing policy drift that is invisible until a user sets the
 * env var and watches their settings get ignored.
 *
 * Mirrors the contract of `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir`:
 *   - env unset, empty string, or whitespace-only → ~/.claude
 *   - env starts with `~`, `~/`, or `~\` → expanded against homedir()
 *   - otherwise → resolved to absolute (relative paths anchor to cwd)
 *
 * Whitespace guard: shells that quote-pad the env value (`CLAUDE_CONFIG_DIR=" "`)
 * would otherwise resolve to `cwd/<spaces>` — silently writing settings into
 * the project tree. Trim before the truthy check so quote-padding falls back
 * to `~/.claude` like a sane default.
 *
 * Cross-platform note: tilde regex strips a single leading `/` OR `\` so
 * `~\Users\foo` works on Windows. `path.resolve` handles drive-letter joining.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const envVal = env.CLAUDE_CONFIG_DIR;
  if (envVal && envVal.trim() !== "") {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

/** Resolve the global settings.json path, honoring CLAUDE_CONFIG_DIR. */
export function resolveClaudeGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(resolveClaudeConfigDir(env), "settings.json");
}

/** Global settings files the security policy reader consults. */
export function resolveAdapterGlobalSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [resolveClaudeGlobalSettingsPath(env)];
}
