#!/usr/bin/env bash
# Run compose for this project with the container runtime chosen
# in .env (CONTAINER_RUNTIME=docker or podman). Arguments go to
# compose as-is, e.g.: scripts/compose.sh up -d --build
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

runtime="${CONTAINER_RUNTIME:-}"
if [[ -z "$runtime" && -f .env ]]; then
    runtime="$(sed -n 's/^CONTAINER_RUNTIME=//p' .env | tail -n 1)"
fi

if [[ "${runtime:-docker}" == podman ]]; then
    if command -v podman-compose >/dev/null 2>&1; then
        exec podman-compose "$@"
    fi
    exec podman compose "$@"
fi
exec docker compose "$@"
