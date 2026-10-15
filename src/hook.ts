// PreToolUse hook: appends ctxmode routing instructions to subagent prompts.
//
// Settings register it on the "Task" matcher, but tool_name arrives as "Agent".
// Per-type overrides come from `subagentProfiles` in the ctxmode config; with
// no profile, claude-code-guide and statusline-setup pass through (no MCP
// tools), Plan keeps full output, Bash is upgraded to general-purpose, and
// every other agent gets the concise ending.
import { readFileSync } from "node:fs";
import { cwd, stdout } from "node:process";
import { findConfig, type Config } from "./prewarm.ts";

const CORE_BLOCK = `
<context_window_protection>
  <priority_instructions>
    Raw Bash/Read/WebFetch output floods your context window.
    You MUST use ctxmode MCP tools to keep raw data in the sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    1. GATHER: mcp__ctxmode__batch_execute(commands, queries)
       - Primary research tool. Runs all commands, auto-indexes, and searches in ONE call.
       - commands: [{label: "Name", command: "shell cmd"}, ...]
       - queries: ["q1", "q2", ...] — 5-8 queries covering everything you need.
    2. DRILL DOWN: mcp__ctxmode__search(queries: ["q1", "q2", ...])
       - Follow-up queries against indexed content. Batch all queries into one call.
    3. PROCESS: mcp__ctxmode__execute(language, code, path?)
       - API calls, log analysis, data processing. Only stdout enters context.
    4. FETCH: mcp__ctxmode__fetch_and_index(url) + search()
       - Web content. Fetches, converts to markdown, indexes. Raw page never enters context.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - DO NOT use Bash for commands producing large output — use batch_execute or execute.
    - DO NOT use Read for analysis — use execute(path). Read IS correct for files you intend to Edit.
    - DO NOT use WebFetch — use fetch_and_index instead.
    - Bash is ONLY for: git, mkdir, rm, mv, and other short-output mutation commands.
  </forbidden_actions>`;

const ENDINGS = {
  concise: `
  <output_constraints>
    <word_limit>Keep your final response under 500 words.</word_limit>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES, never return as inline text.
      Return only: file path + 1-line description.
    </artifact_policy>
    <dead_drop>
      For detailed findings, index into the shared knowledge base:
      mcp__ctxmode__index(content: "...", source: "descriptive-label")
      The parent agent shares the SAME knowledge base and can search() your indexed content.
    </dead_drop>
    <response_format>
      Your response must be a concise summary:
      - What you did (2-3 bullets)
      - File paths created/modified (if any)
      - Source labels you indexed (so parent can search)
      - Key findings in bullet points
      Do NOT return raw data, full file contents, or lengthy explanations.
    </response_format>
  </output_constraints>
</context_window_protection>`,
  plan: `
  <output_constraints>
    <plan_output>
      Return your full plan/analysis as your response. Do NOT compress or summarize —
      the parent needs the complete content for review.
    </plan_output>
    <overflow_policy>
      If raw research data is too large for the response, index it via
      mcp__ctxmode__index(content, source) for later retrieval.
      The plan itself must be in your response body.
    </overflow_policy>
  </output_constraints>
</context_window_protection>`,
};

const SKIP_TYPES = new Set(["claude-code-guide", "statusline-setup"]);

/** The hook's response for one PreToolUse payload, or null to let the call through unchanged. */
export function route(input: any, config: Config | null): object | null {
  if (input?.tool_name !== "Agent") return null;
  const toolInput = input.tool_input ?? {};
  const type: string = toolInput.subagent_type ?? "";
  const profile = config?.subagentProfiles?.[type];
  let routing: string;
  const updatedInput = { ...toolInput };
  if (profile) {
    if (profile.skip) return null;
    routing = profile.block || CORE_BLOCK + (ENDINGS[profile.ending!] ?? ENDINGS.concise);
  } else {
    if (SKIP_TYPES.has(type)) return null;
    routing = CORE_BLOCK + (type === "Plan" ? ENDINGS.plan : ENDINGS.concise);
    // Bash subagents have no MCP tools; general-purpose does.
    if (type === "Bash") updatedInput.subagent_type = "general-purpose";
  }
  updatedInput.prompt = (toolInput.prompt ?? "") + routing;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
}

export function runHook(): void {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return;
  }
  // Fail-soft: a broken config must not block subagent launches.
  let config: Config | null = null;
  try {
    config = findConfig(cwd())?.config ?? null;
  } catch { /* unreadable CTXMODE_CONFIG */ }
  const response = route(input, config);
  if (response) stdout.write(JSON.stringify(response));
}
