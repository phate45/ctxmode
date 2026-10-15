import { describe, expect, test } from "bun:test";
import { route } from "../src/hook.ts";

const agent = (subagent_type: string) => ({
  tool_name: "Agent",
  tool_input: { prompt: "task", subagent_type, description: "d" },
});
const prompt = (r: any): string => r.hookSpecificOutput.updatedInput.prompt;

describe("hook route", () => {
  test("a default agent gets the concise routing block", () => {
    const r = route(agent("general-purpose"), null);
    expect(prompt(r)).toStartWith("task\n<context_window_protection>");
    expect(prompt(r)).toContain("mcp__ctxmode__batch_execute");
    expect(prompt(r)).toContain("<word_limit>");
    expect(prompt(r)).not.toContain("context-mode");
    expect((r as any).hookSpecificOutput.updatedInput.description).toBe("d");
  });

  test("a skip profile gets nothing", () => {
    expect(route(agent("Explore"), { sources: [], subagentProfiles: { Explore: { skip: true } } })).toBeNull();
  });

  test("a custom block replaces the routing block", () => {
    const r = route(agent("Explore"), { sources: [], subagentProfiles: { Explore: { block: "\nCUSTOM" } } });
    expect(prompt(r)).toBe("task\nCUSTOM");
  });

  test("Bash is upgraded to general-purpose and Plan keeps full output", () => {
    expect((route(agent("Bash"), null) as any).hookSpecificOutput.updatedInput.subagent_type).toBe("general-purpose");
    expect(prompt(route(agent("Plan"), null))).toContain("<plan_output>");
  });

  test("non-Agent tools and pass-through types are untouched", () => {
    expect(route({ tool_name: "Bash", tool_input: { command: "ls" } }, null)).toBeNull();
    expect(route(agent("statusline-setup"), null)).toBeNull();
  });
});
