#!/usr/bin/env bash
# Set up Agent Dashboard Plus on this machine: macOS, or Linux with
# apt or dnf. Installs what is missing (asking first), writes .env,
# builds and starts the backend and frontend containers, registers
# this machine as a host, and runs the host daemon as a service.
#
# Safe to run again: an existing .env is kept and only missing
# values are filled in.
#
# Usage: ./setup.sh [--dry-run] [--harness] [--help]
#   --harness  only the agent harness step (add-ons and skills for
#              Claude Code, Codex and Grok); see README "Agent harness"
#
# Written for the bash 3.2 that ships with macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
LABEL="com.agent-dashboard.daemon"
UNIT="agent-dashboard-daemon.service"
DRY_RUN=0

# ── Output and prompts ─────────────────────────────────────────

say() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die() {
    warn "$*"
    exit 1
}

# Run a command, or only print it in a dry run.
run() {
    if [[ $DRY_RUN == 1 ]]; then
        printf '    [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

# Ask a yes/no question. $2 is the default (y or n). A dry run
# takes the default.
ask_yn() {
    local question="$1" default="${2:-y}" reply hint="[Y/n]"
    [[ $default == n ]] && hint="[y/N]"
    if [[ $DRY_RUN == 1 ]]; then
        printf '    [dry-run] %s %s -> %s\n' "$question" "$hint" "$default"
        [[ $default == y ]]
        return
    fi
    read -r -p "    $question $hint " reply || reply=""
    reply="${reply:-$default}"
    [[ $reply == [yY]* ]]
}

# Ask for a value; prints it. $2 is the default.
ask() {
    local question="$1" default="${2:-}" reply
    if [[ $DRY_RUN == 1 ]]; then
        printf '    [dry-run] %s -> %s\n' "$question" "${default:-<value>}" >&2
        printf '%s' "${default:-<value>}"
        return
    fi
    if [[ -n $default ]]; then
        read -r -p "    $question [$default] " reply || reply=""
    else
        read -r -p "    $question " reply || reply=""
    fi
    printf '%s' "${reply:-$default}"
}

# Ask for a secret without echoing it; prints it.
ask_secret() {
    local question="$1" reply
    if [[ $DRY_RUN == 1 ]]; then
        printf '    [dry-run] %s -> <secret>\n' "$question" >&2
        printf '<secret>'
        return
    fi
    read -r -s -p "    $question " reply || reply=""
    printf '\n' >&2
    printf '%s' "$reply"
}

has() { command -v "$1" >/dev/null 2>&1; }

# ── .env ───────────────────────────────────────────────────────

# Print a key's value from .env (empty if unset).
get_env() {
    [[ -f $ENV_FILE ]] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# Set a key in .env, replacing an existing line. Secret values
# are never printed, not even in a dry run.
set_env() {
    local key="$1" value="$2" tmp
    if [[ $DRY_RUN == 1 ]]; then
        printf '    [dry-run] set %s in .env\n' "$key"
        return
    fi
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    tmp="$(mktemp)"
    grep -v "^$key=" "$ENV_FILE" >"$tmp" || true
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}

# Set a key only when .env has no value for it yet.
default_env() {
    [[ -n "$(get_env "$1")" ]] || set_env "$1" "$2"
}

# ── Platform and packages ──────────────────────────────────────

OS="$(uname -s)"
PKG=""

detect_platform() {
    case "$OS" in
    Darwin)
        PKG=brew
        has brew || die "Homebrew is required on macOS. Install it from https://brew.sh and run ./setup.sh again."
        ;;
    Linux)
        if has apt-get; then
            PKG=apt
        elif has dnf; then
            PKG=dnf
        else
            warn "No apt or dnf found: missing packages must be installed by hand."
        fi
        ;;
    *) die "Unsupported system: $OS (macOS and Linux only)." ;;
    esac
}

# Install packages with the system package manager.
pkg_install() {
    case "$PKG" in
    brew) run brew install "$@" ;;
    apt) run sudo apt-get update -qq && run sudo apt-get install -y "$@" ;;
    dnf) run sudo dnf install -y "$@" ;;
    *) die "Install by hand, then run ./setup.sh again: $*" ;;
    esac
}

install_uv() {
    if [[ $PKG == brew ]]; then
        pkg_install uv
    else
        # Official installer; puts uv in ~/.local/bin.
        run sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
        export PATH="$HOME/.local/bin:$PATH"
    fi
}

check_tools() {
    say "Checking required tools"
    local missing=() tool
    for tool in git tmux curl openssl uv; do
        if has "$tool"; then
            info "found $tool"
        else
            missing+=("$tool")
        fi
    done
    [[ ${#missing[@]} == 0 ]] && return
    ask_yn "Install ${missing[*]}?" y || die "Missing: ${missing[*]}"
    for tool in "${missing[@]}"; do
        if [[ $tool == uv ]]; then
            install_uv
        else
            pkg_install "$tool"
        fi
    done
}

# ── Container runtime ──────────────────────────────────────────

# Print the runtimes found on PATH: docker (OrbStack, Docker
# Desktop, Docker Engine) and podman, one per line.
detect_runtimes() {
    has docker && echo docker
    has podman && echo podman
    return 0
}

install_runtime() {
    if [[ $OS == Darwin ]]; then
        ask_yn "No container runtime found. Install OrbStack (docker)?" y ||
            die "A container runtime is required: OrbStack, Docker Desktop or Podman."
        run brew install --cask orbstack
        run open -a OrbStack
        RUNTIME=docker
    else
        ask_yn "No container runtime found. Install Podman?" y ||
            die "A container runtime is required: Docker or Podman."
        pkg_install podman podman-compose
        RUNTIME=podman
    fi
}

RUNTIME=""

choose_runtime() {
    say "Container runtime"
    local saved found=() rt
    saved="$(get_env CONTAINER_RUNTIME)"
    while IFS= read -r rt; do
        [[ -n $rt ]] && found+=("$rt")
    done < <(detect_runtimes)

    if [[ -n $saved ]] && has "$saved"; then
        RUNTIME="$saved"
        info "using $RUNTIME (from .env)"
    elif [[ ${#found[@]} == 0 ]]; then
        install_runtime
    elif [[ ${#found[@]} == 1 ]]; then
        RUNTIME="${found[0]}"
        info "using $RUNTIME"
    else
        info "found: ${found[*]}"
        RUNTIME="$(ask "Which one should run the dashboard (docker/podman)?" docker)"
        [[ $RUNTIME == docker || $RUNTIME == podman ]] || die "Unknown runtime: $RUNTIME"
    fi
    set_env CONTAINER_RUNTIME "$RUNTIME"
    export CONTAINER_RUNTIME="$RUNTIME"

    if [[ $RUNTIME == podman ]]; then
        if ! has podman-compose && ! podman compose version >/dev/null 2>&1; then
            ask_yn "Install podman-compose?" y && pkg_install podman-compose
        fi
        if [[ $OS == Darwin ]]; then
            podman machine inspect >/dev/null 2>&1 || run podman machine init
            run podman machine start 2>/dev/null || true
        fi
    else
        wait_for_docker
    fi
}

# Wait for the docker daemon, starting the macOS app if needed.
wait_for_docker() {
    [[ $DRY_RUN == 1 ]] && return
    docker info >/dev/null 2>&1 && return
    if [[ $OS == Darwin ]]; then
        open -a OrbStack 2>/dev/null || open -a Docker 2>/dev/null || true
    fi
    info "waiting for docker to start..."
    for _ in $(seq 1 60); do
        docker info >/dev/null 2>&1 && return
        sleep 2
    done
    die "docker is not reachable. Start it (on Linux, also add yourself to the docker group) and run ./setup.sh again."
}

# ── Login, tunnel, .env ────────────────────────────────────────

TUNNEL_TOKEN=""

configure_env() {
    say "Writing .env"
    default_env SECRET_KEY "$(openssl rand -hex 32)"
    default_env HOST_TOKEN "$(openssl rand -hex 24)"
    default_env DASHBOARD_URL "http://localhost:8000"
    default_env PROJECTS_FOLDER_DEPTH 2
    if [[ -z "$(get_env PROJECTS_ROOT)" ]]; then
        set_env PROJECTS_ROOT "$(ask "Folder to look for projects in:" "$HOME")"
    fi
    default_env NEW_PROJECTS_DIR "$HOME/git"

    local configured=0
    if [[ "$(get_env BYPASS_AUTH)" == true || -n "$(get_env OIDC_CLIENT_ID)" ]]; then
        configured=1
    fi
    if [[ $configured == 1 ]] && ask_yn "Keep the current login settings?" y; then
        return
    fi

    say "Login"
    info "1) Google sign-in (OAuth). Needed to reach the dashboard from"
    info "   other devices. Every session is a shell on this machine."
    info "2) No login. Only for a dashboard used on this machine alone."
    local mode
    mode="$(ask "Choose 1 or 2:" 1)"
    if [[ $mode == 2 ]]; then
        warn "Login is off: never expose port 8080 to a network."
        set_env BYPASS_AUTH true
        set_env VITE_API_URL "http://localhost:8080"
        return
    fi

    set_env BYPASS_AUTH false
    local origin="http://localhost:8080" domain
    if ask_yn "Reach the dashboard from anywhere through a Cloudflare Tunnel?" n; then
        info "In Cloudflare Zero Trust > Networks > Tunnels, create a tunnel,"
        info "add a public hostname pointing to http://localhost:8080 and copy"
        info "the tunnel token."
        domain="$(ask "Public hostname (e.g. dash.example.com):")"
        domain="${domain#https://}"
        domain="${domain%/}"
        [[ -n $domain ]] || die "A hostname is required for the tunnel."
        TUNNEL_TOKEN="$(ask_secret "Tunnel token:")"
        [[ -n $TUNNEL_TOKEN ]] || die "A tunnel token is required."
        origin="https://$domain"
    fi
    set_env VITE_API_URL "$origin"

    info "Create an OAuth client (type: Web application) at"
    info "https://console.cloud.google.com/apis/credentials"
    info "with this authorized redirect URI: $origin/auth"
    set_env OIDC_DISCOVERY_URL "https://accounts.google.com/.well-known/openid-configuration"
    set_env OIDC_CLIENT_ID "$(ask "OAuth client ID:")"
    set_env OIDC_CLIENT_SECRET "$(ask_secret "OAuth client secret:")"

    local emails
    emails="$(ask "E-mails allowed to sign in (comma-separated):" "$(git config user.email 2>/dev/null || true)")"
    [[ -n $emails ]] || die "At least one allowed e-mail is required with Google sign-in."
    set_env ALLOWED_EMAILS "$emails"
}

install_cloudflared() {
    has cloudflared && return
    local arch
    case "$PKG" in
    brew) pkg_install cloudflared ;;
    apt | dnf)
        arch="$(uname -m)"
        case "$arch" in
        x86_64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) die "No cloudflared package for $arch: install it by hand." ;;
        esac
        local ext=deb
        [[ $PKG == dnf ]] && ext=rpm
        local file="/tmp/cloudflared.$ext"
        run curl -fsSL -o "$file" \
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.$ext"
        if [[ $PKG == apt ]]; then
            run sudo apt-get install -y "$file"
        else
            run sudo dnf install -y "$file"
        fi
        ;;
    *) die "Install cloudflared by hand and run ./setup.sh again." ;;
    esac
}

configure_tunnel() {
    [[ -n $TUNNEL_TOKEN ]] || return 0
    [[ "$(get_env BYPASS_AUTH)" == true ]] && die "Refusing to expose the dashboard with login off."
    say "Cloudflare Tunnel"
    install_cloudflared
    if [[ -f /Library/LaunchDaemons/com.cloudflare.cloudflared.plist ]] ||
        systemctl is-enabled cloudflared >/dev/null 2>&1; then
        warn "A cloudflared service is already installed; leaving it as is."
        info "Point its public hostname to http://localhost:8080."
        return
    fi
    # Runs as a system service, so it needs sudo.
    run sudo cloudflared service install "$TUNNEL_TOKEN"
}

# ── Containers and host registration ───────────────────────────

compose() { run "$ROOT/scripts/compose.sh" "$@"; }

start_containers() {
    say "Building and starting the backend and frontend"
    compose up -d --build --force-recreate
    [[ $DRY_RUN == 1 ]] && return
    info "waiting for the backend..."
    for _ in $(seq 1 60); do
        curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && return
        sleep 2
    done
    die "The backend did not start. Check: scripts/compose.sh logs backend"
}

# Register this machine with the backend, or update its token.
# The token goes in through stdin, never on a command line.
register_host() {
    say "Registering this machine as a host"
    local name
    name="$(hostname -s 2>/dev/null || hostname)"
    if [[ $DRY_RUN == 1 ]]; then
        info "[dry-run] register host '$name' with HOST_TOKEN from .env"
        return
    fi
    printf '%s\n%s\n' "$name" "$(get_env HOST_TOKEN)" |
        "$ROOT/scripts/compose.sh" exec -T backend python3 -c '
import sys
from app import database, models
name, token = sys.stdin.read().split()
db = next(database.get_db())
Host = models.Host
host = (
    db.query(Host).filter(Host.host_token == token).first()
    or db.query(Host).filter(Host.name == name).first()
)
if host:
    host.host_token = token
else:
    host = Host(name=name, host_token=token)
    db.add(host)
db.commit()
print("    host registered:", host.name)
'
}

# ── Daemon service ─────────────────────────────────────────────

install_daemon_mac() {
    local plist="$HOME/Library/LaunchAgents/$LABEL.plist" domain
    domain="gui/$(id -u)"
    info "LaunchAgent $plist"
    if [[ $DRY_RUN == 0 ]]; then
        mkdir -p "$(dirname "$plist")"
        # A login shell gives the daemon the user's PATH (brew,
        # nvm, ~/.local/bin) so it finds the agent CLIs.
        cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lic</string>
        <string>exec "$ROOT/scripts/run-daemon-native.sh"</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/agent-dashboard-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/agent-dashboard-daemon.log</string>
</dict>
</plist>
EOF
    fi
    if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
        if ask_yn "Restart the running daemon now? This ends every session on this machine." n; then
            run launchctl kickstart -k "$domain/$LABEL"
        else
            info "The new settings apply at the next daemon restart."
        fi
    else
        run launchctl bootstrap "$domain" "$plist"
    fi
    info "logs: ~/Library/Logs/agent-dashboard-daemon.log"
}

install_daemon_linux() {
    local unit_dir="$HOME/.config/systemd/user"
    info "systemd user unit $unit_dir/$UNIT"
    if [[ $DRY_RUN == 0 ]]; then
        mkdir -p "$unit_dir"
        cat >"$unit_dir/$UNIT" <<EOF
[Unit]
Description=Agent Dashboard host daemon
After=network-online.target

[Service]
ExecStart=/bin/bash -lc 'exec "$ROOT/scripts/run-daemon-native.sh"'
# Restart on any exit: the dashboard's Restart button exits cleanly.
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    fi
    run systemctl --user daemon-reload
    if systemctl --user is-active "$UNIT" >/dev/null 2>&1; then
        if ask_yn "Restart the running daemon now? This ends every session on this machine." n; then
            run systemctl --user restart "$UNIT"
        fi
    else
        run systemctl --user enable --now "$UNIT"
    fi
    if ask_yn "Keep the daemon running after you log out (loginctl enable-linger)?" y; then
        run loginctl enable-linger "$USER"
    fi
    info "logs: journalctl --user -u $UNIT -f"
}

install_daemon() {
    say "Host daemon service"
    if [[ $OS == Darwin ]]; then
        install_daemon_mac
    else
        install_daemon_linux
    fi
}

# ── Agent CLIs ─────────────────────────────────────────────────

ensure_npm() {
    has npm && return
    ask_yn "Codex needs Node.js and npm. Install them?" y || return 1
    if [[ $PKG == brew ]]; then
        pkg_install node
    else
        pkg_install nodejs npm
    fi
}

install_agents() {
    say "Agent CLIs"
    if has claude; then
        info "found Claude Code"
    elif ask_yn "Install Claude Code?" y; then
        run sh -c 'curl -fsSL https://claude.ai/install.sh | bash'
    fi
    if has codex; then
        info "found Codex"
    elif ask_yn "Install Codex?" n && ensure_npm; then
        run npm install -g @openai/codex
    fi
    if has grok; then
        info "found Grok"
    elif ask_yn "Install Grok?" n; then
        run sh -c 'curl -fsSL https://x.ai/cli/install.sh | bash'
    fi
    info "Sign in to each CLI once in a terminal (e.g. run: claude)."
    info "The daemon offers every CLI it finds, one button per account."
}

# Agent harness (add-ons and skills): harness_step.
# shellcheck source=scripts/harness.sh
. "$ROOT/scripts/harness.sh"

# ── Main ───────────────────────────────────────────────────────

usage() {
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
    local arg harness_only=0
    for arg in "$@"; do
        case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --harness) harness_only=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *) die "Unknown option: $arg (see --help)" ;;
        esac
    done
    cd "$ROOT"
    [[ $DRY_RUN == 1 ]] && say "Dry run: nothing is installed or changed"

    detect_platform
    if [[ $harness_only == 1 ]]; then
        harness_step
        return
    fi
    check_tools
    choose_runtime
    configure_env
    configure_tunnel
    start_containers
    register_host
    install_daemon
    install_agents
    harness_step

    say "Done"
    info "Dashboard: $(get_env VITE_API_URL)"
    [[ "$(get_env BYPASS_AUTH)" == true ]] || info "Sign in with one of: $(get_env ALLOWED_EMAILS)"
}

# Sourcing the file (for tests) defines the functions only.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
