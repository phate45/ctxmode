# ctxmode is one Bun program: `bun src/main.ts` from source, or the compiled
# binary that `just release` publishes to release/ for the fleet.
#
#     just gate     ->  0  typecheck and tests pass
#     just build    ->  0  glibc-checked binary in release/build/
#     just smoke    ->  0  that binary passes golden parity with no bun on PATH
#     just release  ->  0  gate, build, smoke, then release/ctxmode + .sha256
#
# EXIT CODES ARE THE INTERFACE:
#   0  ok            2  could not ask or could not run (missing tool, no binary)
#   1  action needed (a check failed, a dirty tree, a stale release)

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# release/build/ holds the binary under test; release/ctxmode only ever holds
# one that passed smoke, so a live server never runs a half-written build.
build_bin := "release/build/ctxmode"
release_dir := "release"

# The oldest glibc the binary must load on: Debian 13 ships 2.41.
glibc_max := "2.41"

[private]
default:
  @just --list --unsorted

install:
  bun install

[doc("Run the MCP server over stdio")]
serve:
  bun src/main.ts

[doc("Typecheck, golden parity and unit/e2e tests. 0 pass, 1 fail")]
gate:
  #!/usr/bin/env bash
  set -uo pipefail
  bun run typecheck || exit 1
  bun run test || exit 1
  echo "gate passed"

# Bun's own runtime is the glibc floor: the scan guards against a Bun upgrade
# raising it, and NEEDED is an allowlist because the scan cannot see other libs.
[doc("Compile the binary into release/build/. 0 ok, 2 could not build")]
build:
  #!/usr/bin/env bash
  set -uo pipefail
  command -v bun >/dev/null || { echo "building needs bun"; exit 2; }
  version=$(jq -r .version package.json) || exit 2
  sha=$(git rev-parse --short=12 HEAD) || exit 2
  [ -z "$(git status --porcelain)" ] || sha="$sha-dirty"
  mkdir -p "$(dirname "{{ build_bin }}")"
  bun build --compile --target=bun-linux-x64 src/main.ts --outfile "{{ build_bin }}" \
    --define "CTXMODE_SHA=\"$sha\"" > release/build.log 2>&1 \
    || { tail -30 release/build.log; echo "build failed; full log: release/build.log"; exit 2; }
  ceiling=$(objdump -T "{{ build_bin }}" | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' \
            | sed 's/GLIBC_//' | sort -V | tail -1)
  if [ "$(printf '%s\n%s\n' "$ceiling" "{{ glibc_max }}" | sort -V | tail -1)" != "{{ glibc_max }}" ]; then
    echo "the binary needs GLIBC_$ceiling, above the {{ glibc_max }} pin"; exit 2
  fi
  stray=$(readelf -dW "{{ build_bin }}" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' \
          | grep -vxE 'libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|ld-linux-x86-64\.so\.2' || true)
  [ -z "$stray" ] || { echo "unexpected dynamic dependencies: $stray"; exit 2; }
  "{{ build_bin }}" --version
  echo "{{ build_bin }} (needs glibc >= $ceiling, $(du -h "{{ build_bin }}" | cut -f1))"

# PATH drops every directory holding a `bun`, so JS/TS execution must come from
# the binary itself; bun runs the harness by absolute path.
[doc("Golden parity, --version and a hook round-trip on the built binary. 0 pass, 1 fail, 2 no binary")]
smoke:
  #!/usr/bin/env bash
  set -uo pipefail
  bin=$(realpath "{{ build_bin }}" 2>/dev/null) && [ -x "$bin" ] || { echo "no binary; run \`just build\`" >&2; exit 2; }
  bun=$(bun -e 'console.log(process.execPath)') || exit 2
  nobun=$(tr ':' '\n' <<<"$PATH" | while read -r d; do [ -x "$d/bun" ] || echo "$d"; done | paste -sd:)
  PATH="$nobun" "$bun" test/golden/run.ts --check -- "$bin" || { echo "SMOKE FAIL: golden"; exit 1; }
  "$bin" --version | grep -qE '^ctxmode [0-9.]+ \([0-9a-f]+(-dirty)?\)$' || { echo "SMOKE FAIL: --version"; exit 1; }
  payload='{"tool_name":"Agent","tool_input":{"prompt":"p","subagent_type":"Bash"}}'
  out=$(cd /tmp && CTXMODE_CONFIG= "$bin" hook <<<"$payload")
  jq -e '.hookSpecificOutput.updatedInput | .subagent_type == "general-purpose" and (.prompt | contains("mcp__ctxmode__search"))' \
    <<<"$out" >/dev/null || { echo "SMOKE FAIL: hook routing"; exit 1; }
  [ -z "$(cd /tmp && "$bin" hook <<<'{"tool_name":"Read","tool_input":{}}')" ] || { echo "SMOKE FAIL: hook pass-through"; exit 1; }
  echo "SMOKE PASS: $bin"

# A dirty tree would publish a binary whose SHA names no commit.
[doc("Gate, build, smoke, then publish release/ctxmode. 0 ok, 1 failed or dirty, 2 could not run")]
release:
  #!/usr/bin/env bash
  set -uo pipefail
  [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; refusing to release"; exit 1; }
  just gate || exit $?
  just build || exit $?
  just smoke || exit $?
  cd "{{ release_dir }}"
  cp build/ctxmode .ctxmode.incoming && mv .ctxmode.incoming ctxmode || exit 2
  sha256sum ctxmode > .ctxmode.sha256.incoming && mv .ctxmode.sha256.incoming ctxmode.sha256 || exit 2
  echo "released $(realpath ctxmode): $(./ctxmode --version)"
  cat ctxmode.sha256

# --- the fleet -----------------------------------------------------------

# The version is package.json's; two builds of one version share it, and the
# fleet tells them apart by the checksum.
[doc("Print the version the fleet may run. 0 ok, 2 nothing released")]
fleet-ready tool:
  #!/usr/bin/env bash
  set -uo pipefail
  [ "{{ tool }}" = "ctxmode" ] || { echo "this repo answers for ctxmode, not {{ tool }}" >&2; exit 2; }
  bin="{{ release_dir }}/ctxmode"
  [ -x "$bin" ] || { echo "nothing in {{ release_dir }}/; run \`just release\`" >&2; exit 2; }
  v=$("$bin" --version | awk '{print $2}')
  [ -n "$v" ] || { echo "$bin reports no version" >&2; exit 2; }
  echo "$v"

# Stale means the bytes no longer match their checksum, or the binary was built
# from a commit other than HEAD.
[doc("Print the release binary's path. 0 ok, 1 stale, 2 none")]
artifact:
  #!/usr/bin/env bash
  set -uo pipefail
  bin="{{ release_dir }}/ctxmode"
  [ -x "$bin" ] || { echo "nothing in {{ release_dir }}/; run \`just release\`" >&2; exit 2; }
  (cd "{{ release_dir }}" && sha256sum --check --status ctxmode.sha256) \
    || { echo "$bin does not match its checksum" >&2; exit 1; }
  head=$(git rev-parse --short=12 HEAD) || exit 2
  built=$("$bin" --version | sed -n 's/.*(\(.*\))$/\1/p')
  [ "$built" = "$head" ] || { echo "$bin was built from $built, HEAD is $head" >&2; exit 1; }
  realpath "$bin"
