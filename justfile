# Upkeep for the wrapper and its upstream pin.
#
#     just status   ->  1  a newer upstream release exists
#     just upgrade  ->  0  bumped, drift accepted, gate passed
#
# EXIT CODES ARE THE INTERFACE:
#   0  ok            2  could not ask (network, install, upstream won't start)
#   1  action needed 3  human or agent needed
#
# Only a 3 is a handoff. Every other non-zero is a stop.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

upstream_url := "https://github.com/mksglu/context-mode"

# A stable release is matched by shape, so a prerelease tag can never become
# the pin: version sorts rank `v1.2.3-rc.1` above `v1.2.3`.
stable_tag_re := '^v[0-9]+\.[0-9]+\.[0-9]+$'

[private]
default:
  @just --list

install:
  bun install

build:
  bun run build

# --- reading -------------------------------------------------------------

[doc("Print the upstream tag package.json pins")]
base:
  #!/usr/bin/env bash
  set -uo pipefail
  tag=$(jq -r '.dependencies["context-mode"] // "" | split("#")[1] // ""' package.json)
  [ -n "$tag" ] || { echo "package.json pins no context-mode tag" >&2; exit 2; }
  echo "$tag"

# git ls-remote rather than the GitHub API: no token, no rate limit.
[private]
latest:
  #!/usr/bin/env bash
  set -uo pipefail
  remote=$(git ls-remote --tags --refs "{{ upstream_url }}" 2>/dev/null) \
    || { echo "UNREACHABLE: {{ upstream_url }}" >&2; exit 2; }
  tag=$(echo "$remote" | awk '{print $2}' | sed 's|refs/tags/||' \
        | rg '{{ stable_tag_re }}' | sort -V | tail -1)
  [ -n "$tag" ] || { echo "UNREACHABLE: no stable tag in the answer" >&2; exit 2; }
  echo "$tag"

[doc("Is there a newer upstream release? 0 current, 1 update available, 2 could not ask")]
status:
  #!/usr/bin/env bash
  set -uo pipefail
  current=$(just base) || exit 2
  latest=$(just latest) || exit 2
  if [ "$current" = "$latest" ]; then echo "current: $current (latest)"; exit 0; fi
  echo "update available: $current -> $latest"
  exit 1

[doc("Compare upstream against upstream.manifest.json. 0 clean, 1 info drift, 2 could not ask, 3 risk drift")]
check:
  bun run check

update-manifest:
  bun run check --update

# --- the gate ------------------------------------------------------------

test:
  bun run test

# Consumers run the committed wrapper.bundle.mjs, not src/, so a bundle that
# lags the source ships stale behavior to every replica. The rebuild is left
# in place for the commit; the e2e smoke then runs against that bundle.
[doc("Bundle freshness, upstream check, smoke tests. 0 pass, 1 fail, 2 could not run, 3 risk drift")]
gate:
  #!/usr/bin/env bash
  set -uo pipefail
  before=$(sha256sum wrapper.bundle.mjs)
  bun run build || exit 1
  if [ "$before" != "$(sha256sum wrapper.bundle.mjs)" ]; then
    echo "wrapper.bundle.mjs was stale; rebuilt it, commit the result"; exit 1
  fi
  bun run check || exit $?
  bun run test || exit 1
  echo "gate passed"

# --- mutating ------------------------------------------------------------

# A 3 leaves the bumped package.json and lockfile in place: unlike a failed
# rebase, the bumped tree is exactly what the reviewer needs.
[doc("Bump to TAG (default: latest stable) and gate it. 0 clean, 1 gate failed, 2 could not run, 3 dirty tree or risk drift")]
upgrade tag="":
  #!/usr/bin/env bash
  set -uo pipefail
  if [ -n "$(git status --porcelain)" ]; then
    echo "working tree is dirty; refusing to upgrade"; exit 3
  fi
  tag="{{ tag }}"
  [ -n "$tag" ] || tag=$(just latest) || exit 2
  if [ "$(just base)" = "$tag" ]; then echo "already on $tag"; just gate; exit $?; fi
  bun run bump "$tag" || exit $?
  just gate
