#!/usr/bin/env bash
# Run the host daemon directly on the host (no container). Reads
# its settings from .env. Run as a service by ./setup.sh: the
# LaunchAgent com.agent-dashboard.daemon on macOS, the systemd
# user unit agent-dashboard-daemon.service on Linux.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
set -a && . ./.env && set +a

export DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8000}"
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME}"
export PROJECTS_FOLDER_DEPTH="${PROJECTS_FOLDER_DEPTH:-2}"
export NEW_PROJECTS_DIR="${NEW_PROJECTS_DIR:-$HOME/git}"

# On the dashboard machine (CONTAINER_RUNTIME set by ./setup.sh)
# the backend and frontend run in containers. Start them (and the
# Podman VM on macOS); failures are ignored so the daemon still
# comes up and retries the dashboard connection on its own. A
# computer added with ./setup.sh --join runs no containers.
if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    if [[ $CONTAINER_RUNTIME == podman && "$(uname)" == Darwin ]]; then
        # The VM processes (vfkit, gvproxy) stay in the process
        # group of whoever starts them. When the daemon exits,
        # launchd kills its job's whole process group, and with
        # it the VM, the backend and the frontend. setpgrp gives
        # the VM a group of its own so it outlives the daemon.
        perl -e 'setpgrp(0, 0); exec @ARGV' podman machine start \
            2>/dev/null || true
    fi
    ./scripts/compose.sh up -d >/dev/null 2>&1 || true
fi

exec uv run --python 3.12 --with-requirements agent/requirements.txt \
    python -m agent.host_daemon
