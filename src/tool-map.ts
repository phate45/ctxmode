/** Tools we expose to Claude Code. Maps our name → upstream ctx_ name. */
export const TOOL_MAP: Record<string, string> = {
  execute: "ctx_execute",
  index: "ctx_index",
  search: "ctx_search",
  fetch_and_index: "ctx_fetch_and_index",
  batch_execute: "ctx_batch_execute",
};
