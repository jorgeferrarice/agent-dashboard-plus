#!/usr/bin/env bash
# Checks for setup.sh: .env editing, container runtime detection,
# and a dry run on a fresh checkout (which must change nothing).
# Usage: scripts/test-setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() {
    echo "FAIL: $*"
    exit 1
}

# shellcheck source=setup.sh
. "$ROOT/setup.sh"

# .env editing: replace in place, keep existing values, mode 600.
ENV_FILE="$tmp/.env"
set_env A 1
set_env B 2
set_env A 3
[[ "$(get_env A)" == 3 && "$(get_env B)" == 2 ]] || fail "set_env"
[[ "$(grep -c '^A=' "$ENV_FILE")" == 1 ]] || fail "set_env duplicated a key"
default_env B 9
[[ "$(get_env B)" == 2 ]] || fail "default_env overwrote a value"
default_env C 7
[[ "$(get_env C)" == 7 ]] || fail "default_env did not fill a value"
mode="$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")"
[[ $mode == 600 ]] || fail ".env mode is $mode"

# Runtime detection, with stub binaries on PATH.
mkdir "$tmp/bin"
for b in docker podman; do
    printf '#!/bin/sh\n' >"$tmp/bin/$b"
    chmod +x "$tmp/bin/$b"
done
runtimes="$(PATH="$tmp/bin" && detect_runtimes)"
[[ $runtimes == $'docker\npodman' ]] || fail "detected '$runtimes'"
rm "$tmp/bin/docker"
runtimes="$(PATH="$tmp/bin" && detect_runtimes)"
[[ $runtimes == podman ]] || fail "detected '$runtimes' with podman only"
rm "$tmp/bin/podman"
runtimes="$(PATH="$tmp/bin" && detect_runtimes)"
[[ -z $runtimes ]] || fail "detected '$runtimes' with nothing installed"

# A dry run on a fresh checkout takes every default, explains the
# OAuth redirect URI and writes nothing.
mkdir -p "$tmp/fresh/scripts"
cp "$ROOT/setup.sh" "$tmp/fresh/"
cp "$ROOT/scripts/compose.sh" "$tmp/fresh/scripts/"
out="$(bash "$tmp/fresh/setup.sh" --dry-run </dev/null 2>&1)" || fail "dry run failed: $out"
[[ ! -e "$tmp/fresh/.env" ]] || fail "dry run wrote .env"
grep -q 'redirect URI: http://localhost:8080/auth' <<<"$out" || fail "no redirect URI in: $out"

echo "setup.sh checks passed"
