#!/usr/bin/env bash
# Rebuild the host daemon image and (re)create its container with
# the host home directory and agent config mounts. Reads HOST_TOKEN
# from .env.
#
# The whole home directory is mounted at its own path, so a session
# can start in any folder under it and absolute host paths stored in
# agent configs (plugin registries, hooks, symlinks) resolve as-is.
# SECURITY: every agent session can read and write the entire home
# directory. ~/.ssh and ~/.claude.json are overlaid read-only.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
set -a && . ./.env && set +a

podman build -t agent-dashboard-daemon -f agent/Containerfile agent/

podman rm -f host-daemon 2>/dev/null || true
# The anonymous /root/.grok/bin volume keeps the container's Grok
# self-update from relinking the host's macOS binary.
podman run -d --name host-daemon --network=host \
    --restart unless-stopped \
    -e DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8000}" \
    -e HOST_TOKEN="$HOST_TOKEN" \
    -e PROJECTS_ROOT="$HOME" \
    -e PROJECTS_FOLDER_DEPTH=2 \
    -e NEW_PROJECTS_DIR="$HOME/git" \
    -v "$HOME:$HOME" \
    -v "$HOME/.ssh:$HOME/.ssh:ro" \
    -v "$HOME/.claude.json:$HOME/.claude.json:ro" \
    -v "$HOME/.ssh:/root/.ssh:ro" \
    -v "$HOME/.claude:/root/.claude" \
    -v "$HOME/.claude-infinite:/root/.claude-infinite" \
    -v "$HOME/.claude-omniroute:/root/.claude-omniroute" \
    -v "$HOME/.claude.json:/root/.claude.json:ro" \
    -v "$HOME/.codex:/root/.codex" \
    -v "$HOME/.grok:/root/.grok" \
    -v /root/.grok/bin \
    localhost/agent-dashboard-daemon:latest
