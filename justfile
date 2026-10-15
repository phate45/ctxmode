# The MCP server runs as one Bun process: `bun src/main.ts`.
#
# EXIT CODES ARE THE INTERFACE:
#   0  ok            1  action needed (a check failed)

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

[private]
default:
  @just --list

install:
  bun install

[doc("Run the MCP server over stdio")]
serve:
  bun src/main.ts

[doc("Typecheck, golden parity and e2e tests. 0 pass, 1 fail")]
gate:
  #!/usr/bin/env bash
  set -uo pipefail
  bun run typecheck || exit 1
  bun run test || exit 1
  echo "gate passed"
