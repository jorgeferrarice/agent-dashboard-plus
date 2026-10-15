#!/usr/bin/env python3
"""Host daemon for the Agent Dashboard.

Runs on each development machine to spawn and manage AI coding
agent sessions (Gemini, Claude, Bash) in pseudo-terminals,
relay I/O via Socket.IO, and receive OpenTelemetry data.
"""

import asyncio
import fcntl
import json
import logging
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from collections import deque
import urllib.error
import urllib.request
from typing import Dict, Optional

import socketio
from aiohttp import web

from agent.profiles import discover_variants, load_profiles, profile_logged_in
from agent.usage_probe import ProbeError, probe_usage

logging.basicConfig(
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("daemon")

# Default permission patterns — generic prompts that
# apply to all agent tools. Tool-specific patterns are
# loaded from agent profiles and merged at daemon startup.
_DEFAULT_PERMISSION_PATTERNS = [
    r"\[Y/n\]",
    r"\[y/N\]",
    r"\(yes/no\)",
    r"\(y/n\)",
    r"press enter to continue",
    r"Continue\?",
    r"Proceed\?",
]

# Directory names never scanned for projects, at any depth.
# Dependency trees are huge and never hold a project a user
# would start a session in.
_SCAN_SKIP_ANYWHERE = frozenset({"node_modules"})

# Directory names skipped only directly under a projects
# root. These are the macOS home folders that hold system and
# media data; scanning them is slow and lists nothing useful
# when PROJECTS_ROOT is a home directory.
_SCAN_SKIP_AT_ROOT = frozenset(
    {"Library", "Applications", "Movies", "Music", "Pictures", "Public"}
)

# Names accepted for a project folder created from the UI: a
# single path component that starts with a letter or digit.
# This rejects empty names, path separators, "..", hidden
# names and whitespace.
_PROJECT_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")

# Largest file the UI may send to a session. Keep in sync with
# MAX_UPLOAD_BYTES in backend/app/main.py.
MAX_UPLOAD_BYTES = 90 * 1024 * 1024

# Seconds to wait for a profile's model list endpoint.
_MODEL_LIST_TIMEOUT = 5

# Seconds of idle output after a pattern match before
# the status transitions to waiting_permission.
PERMISSION_IDLE_SECONDS = 2

# Regex to strip ANSI escape sequences from terminal
# output before pattern matching.
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# Terminal capability queries that tmux sends on startup.
# These trigger round-trip responses through Socket.IO →
# xterm.js → Socket.IO → daemon → PTY, causing visible
# jitter as tmux redraws after each response.  Stripping
# them from the output stream prevents the round-trip
# without affecting tmux functionality (it falls back to
# defaults for unresponded queries).
_TMUX_QUERIES = re.compile(
    rb"\x1b\[c"  # DA1 (Device Attributes)
    rb"|\x1b\[>c"  # DA2 (Secondary Device Attributes)
    rb"|\x1b\[>q"  # Terminal name query (XTVERSION)
    rb"|\x1b\]10;\?\x1b\\"  # Foreground color query
    rb"|\x1b\]11;\?\x1b\\"  # Background color query
)

# Mouse tracking escape sequences that tmux sends when
# mouse mode is enabled.  Stripping these from the
# output prevents xterm.js from entering application
# mouse mode, so the browser handles text selection,
# right-click, and copy/paste natively.  The frontend
# sends synthesized SGR mouse wheel sequences for
# scroll, which tmux processes normally.
_MOUSE_TRACKING = re.compile(
    rb"\x1b\[\?(?:1000|1002|1003|1004|1005|1006|1015|1016)[hl]"
)

# Seconds to buffer output after agent spawn before
# relaying to the frontend.  tmux emits several bursts
# of startup escape sequences over ~300 ms; buffering
# coalesces them into a single Socket.IO emit, which
# eliminates visible terminal jitter on connect.
_STARTUP_BUFFER_SECS = 0.5

# Seconds to pause output relay after a resize event.
# Gives xterm.js time to reflow its buffer without
# competing with incoming writes from the agent's
# SIGWINCH redraw and tmux's reflow output.
_RESIZE_PAUSE_SECS = 0.3


def _split_utf8(data: bytes) -> tuple:
    """Splits a byte string at the last complete UTF-8 character boundary.

    If the final 1-3 bytes of `data` form an incomplete UTF-8 lead or
    continuation sequence, they are returned separately so they can be
    prepended to the next read.

    Returns:
        A (complete, remainder) tuple of bytes. `remainder` is empty
        when the data ends on a valid character boundary.
    """
    if not data:
        return (b"", b"")

    # Check up to the last 3 bytes for an incomplete sequence.
    # A UTF-8 lead byte tells us how many bytes the character needs:
    #   110xxxxx -> 2 bytes, 1110xxxx -> 3 bytes, 11110xxx -> 4 bytes
    for i in range(1, min(4, len(data) + 1)):
        byte = data[-i]
        if byte < 0x80:
            # ASCII — the string is complete
            return (data, b"")
        if byte >= 0xC0:
            # This is a lead byte. Determine expected length.
            if byte < 0xE0:
                expected = 2
            elif byte < 0xF0:
                expected = 3
            else:
                expected = 4
            if i < expected:
                # Not enough continuation bytes — split here
                return (data[:-i], data[-i:])
            # Enough bytes present — sequence is complete
            return (data, b"")
    # All trailing bytes are continuation bytes with no lead
    # — should not happen in valid UTF-8; pass through as-is.
    return (data, b"")


class HostDaemon:
    """Manages agent sessions on a single development host.

    Connects to the hub via Socket.IO, spawns agent processes
    in PTY sessions, relays I/O, and collects OpenTelemetry data.
    """

    def __init__(self, server_url: str, host_token: str):
        self.server_url = server_url
        self.host_token = host_token
        # Parse PROJECTS_ROOT as a colon-separated list of
        # directories to scan for git repositories. A single
        # path (no colon) works as before.
        roots_str = os.getenv("PROJECTS_ROOT", "/git")
        self.projects_roots = [r.strip() for r in roots_str.split(":") if r.strip()]
        # First root used as default for backward compat
        self.projects_root = self.projects_roots[0]
        # OTLP receiver port — configurable to allow multiple
        # daemons on the same host via Network=host
        self.otlp_port = int(os.getenv("OTLP_PORT", "4318"))
        # Maximum directory depth to scan for git repositories
        # below each PROJECTS_ROOT entry. Default of 6 covers
        # most GitLab org hierarchies without being unlimited.
        self.projects_depth = int(os.getenv("PROJECTS_DEPTH", "6"))
        # Maximum depth below each root at which a plain
        # directory (no .git) is listed as a project. The
        # default of 0 lists git repositories only.
        self.projects_folder_depth = int(os.getenv("PROJECTS_FOLDER_DEPTH", "0"))
        # Projects from the last scan that are not git repos.
        self.non_git_projects: list = []
        # Directory where folders created from the UI are
        # placed. Defaults to the first projects root.
        self.new_projects_dir = os.getenv("NEW_PROJECTS_DIR", self.projects_root)
        # Model names offered per tool at the last detection,
        # used to validate the model named in a spawn request.
        self._tool_models: Dict[str, list] = {}
        # Load agent profiles from YAML/JSON configs
        self.profiles = load_profiles()
        # Last reading of each tool's plan limits, by tool name:
        # {"windows": [...], "updated_at": <epoch seconds of the
        # last good reading>, "ok": <whether the last try
        # worked>}. See update_usage().
        self._usage: Dict[str, dict] = {}
        # Seconds between readings; 0 turns the probe off.
        self.usage_poll_seconds = int(os.getenv("USAGE_POLL_SECONDS", "300"))
        # Empty folder the tools are opened in to be asked.
        self.usage_probe_dir = os.path.expanduser(
            os.getenv("USAGE_PROBE_DIR", "~/.cache/agent-dashboard/usage-probe")
        )
        # Build OTLP metric lookup tables from profiles
        # for fast matching in handle_otlp().
        self._token_metrics: set = set()
        self._cost_metrics: set = set()
        self._activity_metrics: set = set()
        self._runtime_metrics: dict = {}
        self._excluded_metrics: set = set()
        for prof in self.profiles.values():
            tel = prof.telemetry
            self._token_metrics.update(tel.token_metrics)
            if tel.cost_metric:
                self._cost_metrics.add(tel.cost_metric)
            self._activity_metrics.update(tel.activity_metrics)
            if tel.runtime_metric and tel.runtime_metric.name:
                self._runtime_metrics[tel.runtime_metric.name] = tel.runtime_metric.unit
            self._excluded_metrics.update(tel.excluded_metrics)
        # Merge permission patterns from profiles into
        # the default generic patterns.
        all_patterns = list(_DEFAULT_PERMISSION_PATTERNS)
        for prof in self.profiles.values():
            all_patterns.extend(prof.permission_patterns)
        self.permission_patterns = [re.compile(p, re.IGNORECASE) for p in all_patterns]
        # aiohttp refuses WebSocket messages over 4 MB by default;
        # an uploaded file arrives as one message.
        self.sio = socketio.AsyncClient(
            websocket_extra_options={"max_msg_size": MAX_UPLOAD_BYTES + 1024 * 1024}
        )
        self.agents: Dict[str, Dict] = (
            {}
        )  # agent_id -> {master_fd, pid, tool, history, telemetry}
        self.running = True
        self.cached_projects = []
        self.projects_lock = asyncio.Lock()
        self.otlp_runner = None
        # Event set once the OTLP HTTP server is
        # listening.  spawn_agent() awaits this so
        # pi-otel's 300 ms TCP probe at session_start
        # doesn't race against server startup.
        self._otlp_ready = asyncio.Event()

        @self.sio.on("*", namespace="/terminal")
        async def catch_all(event, data):
            if event in ("terminal_output", "terminal_input"):
                return
            # Summarize large payloads to avoid blocking
            # the event loop with synchronous logging calls.
            if event == "host_telemetry_update":
                tel = data.get("telemetry", {})
                n = len(tel.get("available_projects", []))
                hid = data.get("host_id")
                log.info(f"DEBUG: {event} host_id={hid}" f" projects={n}")
            elif event == "agent_telemetry_update":
                aid = data.get("agent_id", "?")[:8]
                tel = data.get("telemetry", {})
                log.info(
                    f"DEBUG: {event} agent={aid}"
                    f" model={tel.get('model', '?')}"
                    f" status={tel.get('agent_status', '?')}"
                )
            else:
                log.info(f"DEBUG: Received event" f" '{event}' with data: {data}")

        @self.sio.on("connect", namespace="/terminal")
        async def on_connect():
            log.info(f"Connected to dashboard at {self.server_url}")
            # Report available projects immediately on connection
            await self.report_projects()
            # Rejoin agent rooms so the backend can route
            # terminal_input and terminal_resize to us.
            for aid in self.agents:
                await self.sio.emit(
                    "join_room",
                    {"room": aid},
                    namespace="/terminal",
                )
                log.info(f"Rejoined agent room: {aid}")

        @self.sio.on("request_projects", namespace="/terminal")
        async def on_request_projects(data):
            # Force a rescan rather than reporting cached
            # data, so the user gets an up-to-date list.
            await self.scan_and_report_projects()

        @self.sio.on("restart_daemon", namespace="/terminal")
        async def on_restart_daemon(data):
            """Stops the daemon so its supervisor starts a new one.

            Sent by the dashboard's Restart button. The process
            exits once run() unwinds; the launchd KeepAlive job
            (or the container restart policy) brings it back.
            Every session on this host ends with it.
            """
            log.info("Restart requested from the dashboard.")
            self.stop()

        @self.sio.on("create_project", namespace="/terminal")
        async def on_create_project(data):
            """Creates a project folder requested from the UI.

            data: {'name': '...', 'git_init': bool}

            Returns:
                Acknowledgement dict: {'ok': True, 'path': ...}
                or {'ok': False, 'error': '...'}.
            """
            data = data or {}
            try:
                path = self.create_project(data.get("name"), bool(data.get("git_init")))
            except FileExistsError:
                return {
                    "ok": False,
                    "error": "A folder with that name already exists.",
                }
            except ValueError as e:
                return {"ok": False, "error": str(e)}
            except (OSError, subprocess.SubprocessError) as e:
                log.info(f"Failed to create project folder: {e}")
                return {"ok": False, "error": "Could not create the folder."}
            await self.scan_and_report_projects()
            return {"ok": True, "path": path}

        @self.sio.on("upload_file", namespace="/terminal")
        async def on_upload_file(data):
            """Saves a file dropped on a session's terminal.

            data: {'agent_id': '...', 'name': '...', 'data': bytes}

            Returns:
                Acknowledgement dict: {'ok': True, 'path': ...}
                or {'ok': False, 'error': '...'}.
            """
            data = data or {}
            try:
                path = self.save_upload(
                    data.get("agent_id"), data.get("name"), data.get("data")
                )
            except ValueError as e:
                return {"ok": False, "error": str(e)}
            except OSError as e:
                log.info(f"Failed to save uploaded file: {e}")
                return {"ok": False, "error": "Could not save the file."}
            return {"ok": True, "path": path}

        @self.sio.on("list_models", namespace="/terminal")
        async def on_list_models(data):
            """Fetches the current model list for one tool.

            Called when the spawn dialog opens, so the user
            always picks from what the model endpoint offers
            right now rather than a list cached at startup.

            data: {'tool': '...'}

            Returns:
                Acknowledgement dict: {'ok': True, 'models':
                [...], 'default_model': '...', 'error': str or
                None}, or {'ok': False, 'error': '...'} if the
                tool has no model picker.
            """
            tool = (data or {}).get("tool")
            profile = self.profiles.get(tool)
            if not profile or not profile.models or not profile.models.model_env:
                return {"ok": False, "error": "This tool has no model list."}
            loop = asyncio.get_running_loop()
            models, error = await loop.run_in_executor(
                None, self._refresh_tool_models, profile
            )
            return {
                "ok": True,
                "models": models,
                "default_model": profile.models.default,
                "error": error,
            }

        @self.sio.on("terminal_resize", namespace="/terminal")
        async def on_terminal_resize(data):
            agent_id = data.get("sid")
            cols = data.get("cols")
            rows = data.get("rows")
            if agent_id in self.agents and cols and rows:
                # Resize the outer PTY only.  TIOCSWINSZ
                # sends SIGWINCH to the tmux client, which
                # forwards the size change to the tmux
                # server automatically.  Do NOT also call
                # tmux resize-window — that causes a
                # redundant second full-screen redraw.
                master_fd = self.agents[agent_id]["master_fd"]
                size = struct.pack("HHHH", rows, cols, 0, 0)
                try:
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)
                except Exception as e:
                    log.info(f"Failed to resize PTY {agent_id}: {e}")

                # Pause output relay so xterm.js can handle
                # the resize reflow without competing
                # writes.  The agent TUI and tmux both
                # redraw after SIGWINCH, producing bursts
                # of escape sequences.  Without the pause,
                # xterm.js must process reflow AND incoming
                # writes simultaneously, which overwhelms
                # the DOM renderer in long sessions.
                # tmux buffers the output naturally —
                # nothing is lost.  After the pause, the
                # daemon reads the latest output which is
                # already rendered at the correct size.
                self.agents[agent_id]["resize_pause_until"] = (
                    time.monotonic() + _RESIZE_PAUSE_SECS
                )

        @self.sio.on("spawn_agent", namespace="/terminal")
        async def on_spawn_agent(data):
            """
            Triggered by the server to start a new AI agent session.
            data: {'agent_id': '...', 'tool': 'gemini|claude',
                    'project_dir': '...', 'task_description': '...',
                    'session_mode': 'resume'|'new'}
            """
            agent_id = data.get("agent_id")
            tool = data.get("tool", "bash")
            project_dir = data.get("project_dir")
            task_description = data.get("task_description")
            session_mode = data.get("session_mode", "resume")
            use_worktree = data.get("use_worktree", False)
            cols = data.get("cols", 120)
            rows = data.get("rows", 40)
            model = data.get("model")
            try:
                await self.spawn_agent(
                    agent_id,
                    tool,
                    project_dir,
                    task_description,
                    session_mode,
                    use_worktree,
                    cols,
                    rows,
                    model,
                )
            except Exception as e:
                log.info(f"Failed to spawn agent {agent_id}: {e}")
                if self.sio.connected:
                    await self.sio.emit(
                        "agent_status_update",
                        {
                            "agent_id": agent_id,
                            "status": "closed",
                        },
                        namespace="/terminal",
                    )

        @self.sio.on("stop_agent", namespace="/terminal")
        async def on_stop_agent(data):
            agent_id = data.get("agent_id")
            if agent_id in self.agents:
                log.info(f"Stopping agent {agent_id} by request.")
                pid = self.agents[agent_id]["pid"]
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
                self.close_agent(agent_id)

        @self.sio.on("update_task_description", namespace="/terminal")
        async def on_update_task_description(data):
            """Syncs a user-edited task description into
            the daemon's local telemetry dict so subsequent
            telemetry emits won't overwrite the edit.
            """
            agent_id = data.get("agent_id")
            desc = data.get("task_description", "")
            if agent_id in self.agents:
                self.agents[agent_id]["telemetry"]["task_description"] = desc

        @self.sio.on("request_history", namespace="/terminal")
        async def on_request_history(data):
            """Replays an agent's output history.

            data: {'agent_id': '...', 'requester': '<sid>'}

            ``requester`` is the Socket.IO session of the UI
            client that just attached. It is echoed on every
            replay message so the hub delivers the history to
            that client only; without it (older hubs) the
            replay goes to the whole agent room.
            """
            agent_id = data.get("agent_id")
            requester = data.get("requester")
            if agent_id in self.agents and self.sio.connected:
                log.info(f"Replaying history for agent: {agent_id}")
                # Concatenate history into batches to reduce
                # the number of Socket.IO emits.  Sending
                # 1000 individual chunks takes several seconds
                # due to per-emit async overhead; batching
                # into ~64 KB payloads cuts the replay to a
                # handful of emits.
                batch = ""
                batch_limit = 65536
                # Snapshot: the read loop appends to the deque
                # while this coroutine awaits between emits.
                for chunk in list(self.agents[agent_id]["history"]):
                    batch += chunk
                    if len(batch) >= batch_limit:
                        await self.sio.emit(
                            "terminal_output",
                            {
                                "sid": agent_id,
                                "output": batch,
                                "requester": requester,
                            },
                            namespace="/terminal",
                        )
                        batch = ""
                if batch:
                    await self.sio.emit(
                        "terminal_output",
                        {"sid": agent_id, "output": batch, "requester": requester},
                        namespace="/terminal",
                    )
                await self.sio.emit(
                    "history_complete",
                    {"agent_id": agent_id, "requester": requester},
                    namespace="/terminal",
                )

        @self.sio.on("terminal_input", namespace="/terminal")
        async def on_terminal_input(data):
            agent_id = data.get("target_sid")
            user_input = data.get("input", "")
            if agent_id in self.agents and user_input:
                # Clear permission state on user input —
                # the user has responded to any prompt.
                info = self.agents[agent_id]
                info["permission_waiting"] = False
                info["permission_candidate"] = 0
                master_fd = info["master_fd"]
                try:
                    os.write(master_fd, user_input.encode("utf-8"))
                except OSError:
                    pass

    def _scan_projects(self) -> list:
        """Scans all PROJECTS_ROOT directories for projects.

        A project is a git repository found up to
        PROJECTS_DEPTH levels below a root, or any plain
        directory up to PROJECTS_FOLDER_DEPTH levels below a
        root that is not inside a git repository. Hidden
        directories, dependency trees and the system folders
        of a home directory are never scanned.

        Synchronous method intended to be called from an
        executor to avoid blocking the event loop. Iterates
        over all configured roots and returns absolute paths.
        The subset of results that are not git repositories
        is stored in ``self.non_git_projects`` as a side
        effect, so the UI can disable git-only options.

        Returns:
            Sorted list of absolute project paths.
        """
        projects = []
        non_git = []
        for scan_root in self.projects_roots:
            if not os.path.exists(scan_root):
                continue
            # Directories known to be a git repo or inside one.
            in_repo = set()
            try:
                for dirpath, dirs, _files in os.walk(scan_root):
                    rel_path = os.path.relpath(dirpath, scan_root)
                    depth = 0 if rel_path == "." else len(rel_path.split(os.sep))
                    if depth > self.projects_depth:
                        dirs[:] = []
                        continue
                    is_git = ".git" in dirs
                    inside_repo = os.path.dirname(dirpath) in in_repo
                    if is_git or inside_repo:
                        in_repo.add(dirpath)
                    if rel_path != ".":
                        if is_git:
                            projects.append(dirpath)
                        elif not inside_repo and depth <= self.projects_folder_depth:
                            projects.append(dirpath)
                            non_git.append(dirpath)
                    dirs[:] = [
                        d
                        for d in dirs
                        if not d.startswith(".")
                        and d not in _SCAN_SKIP_ANYWHERE
                        and not (depth == 0 and d in _SCAN_SKIP_AT_ROOT)
                    ]
            except Exception as e:
                log.info(f"Error scanning projects root {scan_root}: {e}")
        projects.sort()
        self.non_git_projects = sorted(non_git)
        return projects

    async def update_projects_cache(self):
        """Continuously updates the project cache in the background every 60 seconds."""
        loop = asyncio.get_running_loop()
        while self.running:
            try:
                new_projects = await loop.run_in_executor(None, self._scan_projects)
                async with self.projects_lock:
                    self.cached_projects = new_projects

                # Immediately report if connected
                if self.sio.connected:
                    await self.report_projects()
            except Exception as e:
                log.info(f"Project cache update failed: {e}")

            await asyncio.sleep(60)

    def _find_project_root(self, project_path: str) -> str:
        """Finds which projects root contains a path.

        Checks each configured root to see if the path
        starts with it. Falls back to the first root if
        no match is found.

        Args:
            project_path: Absolute path to a project.

        Returns:
            The matching root directory path.
        """
        for root in self.projects_roots:
            if project_path.startswith(root + "/") or project_path == root:
                return root
        return self.projects_roots[0]

    def create_project(self, name, git_init: bool = False) -> str:
        """Creates an empty project folder under NEW_PROJECTS_DIR.

        The name comes from the UI and is untrusted: it must be
        a single path component, so the folder can never land
        outside NEW_PROJECTS_DIR. An existing folder is never
        touched.

        Args:
            name: Folder name requested by the user.
            git_init: If True, run ``git init`` in the new folder.

        Returns:
            Absolute path of the created folder.

        Raises:
            ValueError: If the name is not a valid folder name.
            FileExistsError: If the folder already exists.
            OSError: If the folder cannot be created.
            subprocess.SubprocessError: If ``git init`` fails.
        """
        if not isinstance(name, str) or not _PROJECT_NAME_RE.fullmatch(name):
            raise ValueError(
                "Invalid folder name. Use letters, digits, '.', '_' or '-', "
                "starting with a letter or digit."
            )
        path = os.path.join(self.new_projects_dir, name)
        os.makedirs(self.new_projects_dir, exist_ok=True)
        os.mkdir(path)
        if git_init:
            subprocess.run(
                ["git", "init", path],
                capture_output=True,
                timeout=30,
                check=True,
            )
        log.info(f"Created project folder {path} (git_init={git_init})")
        return path

    def _upload_dir(self, agent_id: str) -> str:
        """Returns the folder holding files sent to one session."""
        return os.path.join(tempfile.gettempdir(), "agent-dashboard-uploads", agent_id)

    def save_upload(self, agent_id, name, data) -> str:
        """Saves a file sent from the UI where the session can read it.

        The file goes to a per-session folder in the system
        temporary directory, outside the project, so it never
        shows up in git. The folder is removed when the session
        ends.

        The name comes from the UI and is untrusted: only its
        last path component is kept, and every character that is
        not a letter, digit, '.', '_' or '-' becomes '_'. The
        result can never leave the session's folder and needs no
        quoting when pasted into a terminal. A file that already
        exists is never overwritten; the new one gets a numeric
        prefix.

        Args:
            agent_id: ID of the running session the file is for.
            name: File name as given by the browser.
            data: File contents.

        Returns:
            Absolute path of the saved file.

        Raises:
            ValueError: If the session is not running here, the
                name is unusable, or the file is too large.
            OSError: If the file cannot be written.
        """
        if agent_id not in self.agents:
            raise ValueError("This session is not running.")
        if not isinstance(data, (bytes, bytearray)):
            raise ValueError("No file contents received.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise ValueError("The file is too large.")
        if not isinstance(name, str):
            raise ValueError("Invalid file name.")
        base = os.path.basename(name.replace("\\", "/"))
        safe = re.sub(r"[^\w.-]", "_", base).lstrip(".")[-200:]
        if not safe:
            raise ValueError("Invalid file name.")
        folder = self._upload_dir(agent_id)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        path = os.path.join(folder, safe)
        count = 1
        while os.path.exists(path):
            path = os.path.join(folder, f"{count}-{safe}")
            count += 1
        with open(path, "wb") as f:
            f.write(data)
        log.info(f"Saved uploaded file {path} ({len(data)} bytes)")
        return path

    def _fetch_models(self, profile) -> tuple:
        """Builds the model list offered for a profile.

        Combines the profile's static names with the names
        returned by its ``list_url`` endpoint, if any. The
        endpoint may return a JSON list or an object holding
        the list under ``combos``, ``data`` or ``models``;
        each entry is a string or an object with a ``name``
        or ``id``. Entries flagged ``isHidden`` are skipped.

        A failing endpoint is not fatal: the static names are
        still offered and the error is reported to the UI.

        Args:
            profile: AgentProfile with a ``models`` section.

        Returns:
            Tuple of (list of model names, error message or
            None).
        """
        cfg = profile.models
        names = list(cfg.static)
        if cfg.default and cfg.default not in names:
            names.insert(0, cfg.default)
        if not cfg.list_url:
            return names, None
        try:
            payload = self._get_json(profile, cfg.list_url)
        except urllib.error.HTTPError as e:
            return names, f"Model list request failed (HTTP {e.code})."
        except (OSError, ValueError) as e:
            log.info(f"Model list fetch failed for {profile.name}: {e}")
            return names, "Model list is unreachable."
        if isinstance(payload, dict):
            payload = next(
                (
                    payload[k]
                    for k in ("combos", "data", "models")
                    if isinstance(payload.get(k), list)
                ),
                [],
            )
        for item in payload if isinstance(payload, list) else []:
            if isinstance(item, dict):
                if item.get("isHidden"):
                    continue
                item = item.get("name") or item.get("id")
            if isinstance(item, str) and item and item not in names:
                names.append(item)
        return names, None

    def _get_json(self, profile, url: str):
        """GETs a JSON document with the profile's bearer token.

        Args:
            profile: AgentProfile with a ``models`` section.
            url: URL to fetch.

        Returns:
            The decoded JSON payload.

        Raises:
            urllib.error.HTTPError: On a non-2xx response.
            OSError: If the endpoint is unreachable.
            ValueError: If the body is not valid JSON.
        """
        cfg = profile.models
        headers = {"Accept": "application/json"}
        token = profile.env.get(cfg.auth_env) if cfg.auth_env else None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        # The URL comes from a profile file on disk, not from
        # user input.
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(  # nosec B310
            req, timeout=_MODEL_LIST_TIMEOUT
        ) as resp:
            return json.load(resp)

    def _refresh_tool_models(self, profile) -> tuple:
        """Fetches a profile's model list and remembers it.

        The remembered list is what a spawn request's model
        is validated against.

        Args:
            profile: AgentProfile with a ``models`` section.

        Returns:
            Tuple of (list of model names, error message or
            None).
        """
        models, error = self._fetch_models(profile)
        self._tool_models[profile.name] = models
        return models, error

    def _make_tool_info(self, profile) -> dict:
        """Builds a tool metadata dict from a profile for
        the available_tools payload sent to the frontend.

        Args:
            profile: AgentProfile instance.

        Returns:
            Dict with name, display_name, color,
            supports_resume, and has_model fields, plus
            models, default_model and models_error for
            profiles that define a model picker.
        """
        info = {
            "name": profile.name,
            "display_name": profile.display_name,
            "color": profile.color or "slate",
            "supports_resume": profile.supports_resume,
            "has_model": bool(profile.telemetry.token_metrics),
            # False when the tool is installed but no login
            # was found: the UI offers it with a warning.
            "authenticated": profile.always_available or profile_logged_in(profile),
            # The tool has plan limits (a usage section in its
            # profile), whether or not they can be read.
            "has_limits": profile.usage is not None,
        }
        # Tools with a model picker also report the names the
        # user may choose from. The list is remembered so a
        # spawn request can only name a model offered here.
        if profile.models and profile.models.model_env:
            models, error = self._refresh_tool_models(profile)
            info["models"] = models
            info["default_model"] = profile.models.default
            if error:
                info["models_error"] = error
        return info

    def _discover_variants(self):
        """Adds a profile for every extra account found on the
        host (see ``discover_variants``), plus the old names
        that now resolve to one.

        Profiles are only ever added: a variant whose directory
        disappeared stays known, so its running sessions keep
        working, and is simply no longer advertised. A profile
        written by hand wins over a discovered one of the same
        name.
        """
        for profile in list(self.profiles.values()):
            for variant in discover_variants(profile):
                if variant.name not in self.profiles:
                    self.profiles[variant.name] = variant
                    log.info(
                        f"Found account for {profile.display_name}: " f"{variant.name}"
                    )
            aliases = profile.config_dirs.aliases if profile.config_dirs else {}
            for old, current in aliases.items():
                if old not in self.profiles and current in self.profiles:
                    self.profiles[old] = self.profiles[current]

    def _detect_available_tools(self) -> list:
        """Detects which agent CLI tools are installed on this
        host using agent profiles.

        A tool is available when its binary is on the PATH.
        Whether it is signed in does not hide it: that is
        reported as ``authenticated`` so the UI can warn.
        Profiles with always_available=true (e.g. bash) are
        included unconditionally. Each extra account found for
        a tool is listed as a tool of its own, as long as its
        directory still holds a login.

        Returns:
            List of tool info dicts (see ``_make_tool_info``).
        """
        try:
            self._discover_variants()
        except Exception as e:  # pylint: disable=broad-exception-caught
            log.error(f"Account discovery failed: {e}")
        tools = []
        for key, profile in self.profiles.items():
            # An alias is another name for a profile listed
            # under its own.
            if key != profile.name:
                continue
            if not profile.always_available:
                if not profile.binary or not shutil.which(profile.binary):
                    continue
                if profile.is_variant and not profile_logged_in(profile):
                    continue
            tools.append(self._make_tool_info(profile))
        log.info(f"Available tools: {[t['name'] for t in tools]}")
        return tools

    async def scan_and_report_projects(self):
        """Rescans PROJECTS_ROOT and reports the updated
        project list to the Hub. Used for force-refresh
        requests from the UI.
        """
        loop = asyncio.get_running_loop()
        new_projects = await loop.run_in_executor(None, self._scan_projects)
        async with self.projects_lock:
            self.cached_projects = new_projects
        log.info(f"Force rescan: found {len(new_projects)} projects.")
        # Invalidate tool cache so force-refresh re-detects
        self._cached_tools = None
        await self.report_projects()

    async def report_projects(self):
        """Instantly reports cached projects and available
        tools to the Hub.
        """
        async with self.projects_lock:
            projects = list(self.cached_projects)

        # Use cached tools — _detect_available_tools() runs
        # synchronous subprocess calls that block the event
        # loop. Tools don't change at runtime so we detect
        # once at startup and on explicit refresh.
        if not hasattr(self, "_cached_tools") or not self._cached_tools:
            loop = asyncio.get_running_loop()
            self._cached_tools = await loop.run_in_executor(
                None, self._detect_available_tools
            )
        tools = self._cached_tools
        log.info(f"Reporting {len(projects)} projects, {len(tools)} tools to Hub.")
        if self.sio.connected:
            await self.sio.emit(
                "host_telemetry",
                {
                    "projects_root": self.projects_roots,
                    "available_projects": projects,
                    "non_git_projects": list(self.non_git_projects),
                    "new_projects_dir": self.new_projects_dir,
                    "available_tools": tools,
                    # Plan limits read so far, by tool name.
                    "usage": dict(self._usage),
                },
                namespace="/terminal",
            )

    async def update_usage(self):
        """Reads the plan limits of every advertised tool, every
        ``USAGE_POLL_SECONDS`` (default 300), and reports them
        with the host telemetry.

        Each reading opens the tool in a throwaway session (see
        ``agent.usage_probe``), one tool at a time, in a worker
        thread so sessions keep flowing. A failed reading keeps
        the previous values and marks them ``ok: False``: the UI
        shows them dimmed, with their age. Set
        ``USAGE_POLL_SECONDS=0`` to turn this off.
        """
        if self.usage_poll_seconds <= 0:
            log.info("Usage probe disabled (USAGE_POLL_SECONDS=0).")
            return
        # Let the first tool detection finish.
        await asyncio.sleep(15)
        while self.running:
            await self._read_usage_once()
            await asyncio.sleep(self.usage_poll_seconds)

    async def _read_usage_once(self):
        """Probes every advertised tool that has a way to read
        its limits, updates ``self._usage`` and reports it.
        """
        loop = asyncio.get_running_loop()
        names = [t["name"] for t in getattr(self, "_cached_tools", None) or []]
        for name in names:
            profile = self.profiles.get(name)
            if not profile or not profile.usage or not profile.usage.parser:
                continue
            entry = dict(self._usage.get(name) or {"windows": []})
            try:
                entry["windows"] = await loop.run_in_executor(
                    None, probe_usage, profile, self.usage_probe_dir
                )
                entry["updated_at"] = time.time()
                entry["ok"] = True
            except ProbeError as e:
                log.info(f"Usage probe failed: {e}")
                entry["ok"] = False
            except Exception as e:  # pylint: disable=broad-exception-caught
                log.error(f"Usage probe crashed for {name}: {e}")
                entry["ok"] = False
            self._usage[name] = entry
        # Forget tools that are no longer offered.
        for gone in set(self._usage) - set(names):
            del self._usage[gone]
        if names and self.sio.connected:
            await self.report_projects()

    @staticmethod
    def _remote_to_web_url(remote_url: str) -> Optional[str]:
        """Converts a git remote URL to an HTTPS web URL.

        Handles SSH and HTTPS formats:
        - git@github.com:user/repo.git → https://github.com/user/repo
        - https://github.com/user/repo.git → https://github.com/user/repo
        - git@gitlab.internal:group/repo.git → https://gitlab.internal/group/repo

        Returns None if the URL format is not recognized.
        """
        if not remote_url:
            return None
        url = remote_url.strip()
        # SSH format: git@host:path.git
        if url.startswith("git@"):
            url = url[4:]  # Remove git@
            url = url.replace(":", "/", 1)  # host:path → host/path
            url = "https://" + url
        # Ensure https://
        if not url.startswith("http"):
            return None
        # Remove .git suffix
        if url.endswith(".git"):
            url = url[:-4]
        return url

    def get_git_info(self, path: str):
        """Extracts git branch, project name, and remote web
        URL from a directory.

        The project name is derived from the remote origin URL
        when available, falling back to the git repository's
        root directory name. The web URL is the HTTPS version
        of the remote origin for linking in the UI.

        Returns:
            A (branch, project, remote_url) tuple.
        """
        if not path or not os.path.exists(path):
            return None, None, None

        branch = None
        project = None
        remote_url = None

        try:
            branch = (
                subprocess.check_output(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=path,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .strip()
            )
        except Exception:
            pass

        try:
            origin = (
                subprocess.check_output(
                    ["git", "config", "--get", "remote.origin.url"],
                    cwd=path,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .strip()
            )
            project = origin.rsplit("/", maxsplit=1)[-1].replace(".git", "")
            remote_url = self._remote_to_web_url(origin)
        except Exception:
            # No remote configured — use the repo root directory name
            try:
                toplevel = (
                    subprocess.check_output(
                        ["git", "rev-parse", "--show-toplevel"],
                        cwd=path,
                        stderr=subprocess.DEVNULL,
                    )
                    .decode()
                    .strip()
                )
                project = os.path.basename(toplevel)
            except Exception:
                pass

        return branch, project, remote_url

    @staticmethod
    def _merge_missing_keys(target, defaults):
        """Deep-merge default keys into target dict.

        Only adds keys that are missing in the target.
        For nested dicts, recurses so that sub-keys can
        be added without overwriting sibling keys.

        Args:
            target: Dict to update in place.
            defaults: Dict of keys/values to add if missing.

        Returns:
            True if any key was added, False otherwise.
        """
        changed = False
        for key, value in defaults.items():
            if key not in target:
                target[key] = value
                changed = True
            elif isinstance(value, dict) and isinstance(target[key], dict):
                if HostDaemon._merge_missing_keys(target[key], value):
                    changed = True
        return changed

    def _detect_mcp_servers(self, project_dir, tool):
        """Detects MCP servers configured for the given tool.

        Uses the agent profile's MCP config to find server
        definitions in project-level and user-level config
        files. Deduplicates server names across files.

        Args:
            project_dir: The project directory path.
            tool: The agent tool name.

        Returns:
            A list of MCP server name strings.
        """
        profile = self.profiles.get(tool)
        if not profile or not profile.mcp:
            return []

        servers = []
        try:
            # Project-level config file
            if profile.mcp.project_file and project_dir:
                mcp_path = os.path.join(project_dir, profile.mcp.project_file)
                if os.path.isfile(mcp_path):
                    with open(mcp_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    mcp_servers = data.get("mcpServers", {})
                    servers.extend(mcp_servers.keys())

            # User-level config files
            for user_file in profile.mcp.user_files:
                path = os.path.expanduser(user_file)
                if os.path.isfile(path):
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    mcp_servers = data.get("mcpServers", {})
                    for name in mcp_servers.keys():
                        if name not in servers:
                            servers.append(name)
        except Exception as e:
            log.info(f"MCP detection error for {tool}: {e}")

        return servers

    async def spawn_agent(
        self,
        agent_id: str,
        tool: str,
        project_dir: Optional[str] = None,
        task: Optional[str] = None,
        session_mode: str = "resume",
        use_worktree: bool = False,
        cols: int = 120,
        rows: int = 40,
        model: Optional[str] = None,
    ):
        """Spawns a new process in a pseudo-terminal with environmental context.

        Args:
            agent_id: Unique identifier for the agent session.
            tool: The CLI tool to spawn ('claude', 'gemini', 'bash').
            project_dir: Working directory for the agent.
            task: Optional task description for the session.
            session_mode: 'resume' to continue the latest session
                          (default), or 'new' for a fresh session.
            use_worktree: If True, create a git worktree for
                          isolation from other agents on the same
                          repo.
            cols: Initial terminal width in columns (default 120).
            rows: Initial terminal height in rows (default 40).
            model: Model name for tools whose profile defines
                   a model picker. Must be one of the names
                   the daemon offered; defaults to the
                   profile's default model.

        Raises:
            ValueError: If the model is not one the daemon
                        offered for this tool.
        """
        # Resolve the session model before anything is
        # created. The name comes from the UI and is
        # untrusted, so only names this daemon offered are
        # accepted.
        model_env = {}
        model_cfg = getattr(self.profiles.get(tool), "models", None)
        if model_cfg and model_cfg.model_env:
            chosen = model or model_cfg.default
            offered = self._tool_models.get(tool, [])
            if chosen != model_cfg.default and chosen not in offered:
                raise ValueError(f"Model {chosen!r} is not offered for {tool}.")
            if chosen:
                model_env[model_cfg.model_env] = chosen

        # Resolve full path (handles both absolute and relative from projects_root)
        full_path = project_dir
        if project_dir and not project_dir.startswith("/"):
            full_path = os.path.join(self.projects_root, project_dir)

        # Ensure we use an absolute path for working directory
        if full_path:
            full_path = os.path.abspath(full_path)

        # Create a git worktree for isolation if requested.
        # The worktree is stored under the project's root
        # directory in .agent-worktrees/ to keep the original
        # repo clean. MCP detection and companion matching
        # use the original project_dir.
        original_project_dir = full_path
        worktree_path = None
        worktree_branch = None
        if use_worktree and full_path:
            try:
                project_root = self._find_project_root(full_path)
                project_name = os.path.relpath(full_path, project_root)
                short_id = agent_id[:8]
                worktree_dir = os.path.join(
                    project_root,
                    ".agent-worktrees",
                    project_name,
                    f"agent-{short_id}",
                )
                worktree_branch = f"agent/{tool}-{short_id}"
                os.makedirs(os.path.dirname(worktree_dir), exist_ok=True)
                # Prune stale worktree refs before creating
                subprocess.run(
                    ["git", "worktree", "prune"],
                    cwd=full_path,
                    capture_output=True,
                    check=False,
                )
                subprocess.check_output(
                    [
                        "git",
                        "worktree",
                        "add",
                        "-b",
                        worktree_branch,
                        worktree_dir,
                    ],
                    cwd=full_path,
                    stderr=subprocess.STDOUT,
                )
                worktree_path = worktree_dir
                full_path = worktree_dir
                # Worktrees have no prior session state
                session_mode = "new"
                log.info(
                    f"Created worktree for {agent_id}: "
                    f"{worktree_dir} (branch {worktree_branch})"
                )
            except Exception as e:
                log.info(
                    f"Failed to create worktree for "
                    f"{agent_id}: {e}. "
                    f"Falling back to original directory."
                )
                full_path = original_project_dir
                worktree_path = None
                worktree_branch = None

        # Detect if full_path is inside an existing worktree
        # (e.g. companion session spawned into a parent's
        # worktree). Set worktree_path so the UI shows the
        # worktree indicator, and resolve the original
        # project_dir for MCP detection and companion matching.
        # Check all roots for worktree markers
        in_worktree = False
        if not worktree_path and full_path:
            for rt in self.projects_roots:
                marker = os.path.join(rt, ".agent-worktrees")
                if full_path.startswith(marker):
                    in_worktree = True
                    break
        if in_worktree:
            worktree_path = full_path
            # Resolve original project_dir from the worktree's
            # git configuration.
            try:
                git_common = (
                    subprocess.check_output(
                        ["git", "rev-parse", "--git-common-dir"],
                        cwd=full_path,
                        stderr=subprocess.DEVNULL,
                    )
                    .decode()
                    .strip()
                )
                # git-common-dir returns the .git dir of the
                # parent repo (e.g. /git/project/.git)
                if git_common and not git_common.startswith("/"):
                    git_common = os.path.normpath(os.path.join(full_path, git_common))
                original_project_dir = os.path.dirname(git_common)
            except Exception:
                pass

        # Wait for the OTLP receiver to be listening
        # before spawning the agent process.  pi-otel
        # probes the endpoint with a 300 ms TCP connect
        # at session_start; if the server isn't ready the
        # probe fails and telemetry is silently disabled
        # for the entire session.
        try:
            await asyncio.wait_for(self._otlp_ready.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            log.warning(
                f"OTLP server not ready after 5 s — "
                f"agent {agent_id} may not report "
                f"telemetry"
            )

        log.info(
            f"Spawning agent {agent_id} with tool: {tool} "
            f"mode: {session_mode} in {full_path}"
        )

        # Get git info from the original project directory
        # (not the worktree) so the card shows the real
        # project name and remote URL initially.
        git_info_path = original_project_dir or full_path
        branch, project, remote_url = self.get_git_info(git_info_path)
        mcp_servers = self._detect_mcp_servers(original_project_dir, tool)
        telemetry = {
            "tool_name": tool,
            "project_dir": original_project_dir,
            "task_description": task,
            "git_branch": branch,
            "git_project": project,
            "git_remote_url": remote_url,
            "model": "detecting...",
            "tokens": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "cost_usd": 0.0,
            "context_tokens": 0,
            "current_activity": "",
            "agent_status": "idle",
            "mcp_servers": mcp_servers,
            "run_time_seconds": 0,
            "worktree_path": worktree_path,
        }

        # Build command from the agent profile. Resume mode
        # uses a fallback command if defined, otherwise
        # falls back to the new-session command.
        profile = self.profiles.get(tool)
        if profile:
            if session_mode == "resume" and profile.commands.resume:
                cmd = profile.commands.resume
            else:
                cmd = profile.commands.new or [tool]
        else:
            cmd = [tool]

        # Patch spawn-time settings files before forking.
        # Some agent tools (e.g. agy) read settings from
        # JSON config files at startup, and those files
        # may be on host volume mounts that override the
        # container's built-in defaults.  spawn_settings
        # ensures required keys are present without
        # overwriting user customizations.
        if profile and profile.spawn_settings:
            for filepath, required_keys in profile.spawn_settings.items():
                filepath = os.path.expanduser(filepath)
                try:
                    existing = {}
                    if os.path.exists(filepath):
                        with open(filepath, "r", encoding="utf-8") as f:
                            existing = json.load(f)
                    changed = self._merge_missing_keys(existing, required_keys)
                    if changed:
                        os.makedirs(
                            os.path.dirname(filepath),
                            exist_ok=True,
                        )
                        with open(filepath, "w", encoding="utf-8") as f:
                            json.dump(existing, f, indent=2)
                            f.write("\n")
                        log.info(f"Patched spawn settings: " f"{filepath}")
                except Exception as e:
                    log.info(f"Failed to patch spawn settings " f"{filepath}: {e}")

        pid, fd = pty.fork()
        if pid == 0:  # Child process
            if full_path and os.path.exists(full_path):
                os.chdir(full_path)

            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"

            # Remove stale OTEL env vars inherited from
            # the daemon's own process environment. The
            # daemon may run inside a tmux session that
            # was spawned with a previous agent's OTEL
            # config (e.g. OTEL_SERVICE_NAME from a Pi
            # profile). Without this cleanup, agents
            # whose profiles don't explicitly set these
            # vars inherit incorrect values.
            for key in list(env):
                if key.startswith("OTEL_") or key.startswith("PI_OTEL"):
                    del env[key]

            # Inject OpenTelemetry standard configuration
            env["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"http://127.0.0.1:{self.otlp_port}"
            env["OTEL_RESOURCE_ATTRIBUTES"] = f"service.name={agent_id}"

            # Inject profile-specific environment variables.
            # Values can use {otlp_port} and {agent_id}
            # placeholders. Uses .replace() instead of
            # .format() to avoid KeyError if a value
            # contains literal curly braces.
            if profile:
                for key, value in profile.env.items():
                    env[key] = (
                        str(value)
                        .replace("{otlp_port}", str(self.otlp_port))
                        .replace("{agent_id}", agent_id)
                    )
            env.update(model_env)

            # Inject sidecar PROMPT_COMMAND if the profile
            # defines one (e.g. bash telemetry collection).
            if profile and profile.sidecar and profile.sidecar.prompt_command:
                sidecar_path = profile.sidecar.file_pattern.format(
                    agent_id=agent_id, tmpdir=tempfile.gettempdir()
                )
                env["PROMPT_COMMAND"] = (
                    f"{profile.sidecar.prompt_command} > {sidecar_path}"
                )

            # Wrap the agent command in a tmux session.
            # tmux manages the terminal buffer, handles
            # SIGWINCH natively, and persists across daemon
            # restarts (Phase 3).  The session name is the
            # agent_id so we can target it for resize and
            # cleanup.
            #
            # The tmux client must run ATTACHED (no -d
            # flag).  With -d, tmux forks a server and
            # the client exits immediately — the PTY
            # closes, the daemon sees EOF, and the agent
            # enters a crash/respawn loop.
            #
            # Environment variables are exported before
            # exec because tmux new-session does not
            # forward the child's env to the spawned
            # command — it inherits from the tmux server.
            # We use env(1) to inject them explicitly.
            tmux_session = agent_id
            tmux_cmd = [
                "tmux",
                "new-session",
                "-s",
                tmux_session,
                "-x",
                str(cols),
                "-y",
                str(rows),
                "env",
            ]
            # Pass all env vars through env(1) so the
            # agent process inherits them inside tmux.
            for k, v in env.items():
                tmux_cmd.append(f"{k}={v}")
            tmux_cmd.extend(cmd)

            try:
                os.execvpe(tmux_cmd[0], tmux_cmd, env)
            except Exception as e:
                log.info(f"Failed to execute {tmux_cmd}: {e}")
                os._exit(1)
        else:  # Parent process
            # Set initial PTY dimensions.  The tmux
            # new-session -x/-y flags set the window size,
            # but we also set the outer PTY so the first
            # output frame renders at the correct size.
            try:
                size = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
            except Exception as e:
                log.info(f"Failed to set initial PTY size " f"for {agent_id}: {e}")

            self.agents[agent_id] = {
                "master_fd": fd,
                "pid": pid,
                "tool": tool,
                "history": deque(maxlen=1000),
                "telemetry": telemetry,
                "last_otlp_time": 0.0,
                "last_output_time": time.monotonic(),
                "permission_waiting": False,
                "permission_candidate": 0,
                "utf8_buffer": b"",
                "startup_buffer": b"",
                "spawn_time": time.monotonic(),
                "worktree_path": worktree_path,
                "worktree_branch": worktree_branch,
                "original_project_dir": original_project_dir,
            }
            if self.sio.connected:
                await self.sio.emit(
                    "agent_telemetry",
                    {
                        "agent_id": agent_id,
                        "telemetry": telemetry,
                    },
                    namespace="/terminal",
                )
                # Join the agent's room so the backend
                # routes terminal_input to this daemon.
                await self.sio.emit(
                    "join_room",
                    {"room": agent_id},
                    namespace="/terminal",
                )
                log.info(f"Joined agent room: {agent_id}")
            os.write(fd, b"\n")

    async def watch_agents(self):
        """Monitors PTY file descriptors and relays agent output."""
        loop = asyncio.get_running_loop()
        while self.running:
            if not self.agents:
                await asyncio.sleep(0.5)
                continue
            fds = [a["master_fd"] for a in self.agents.values()]
            try:
                r, _, _ = await loop.run_in_executor(
                    None, select.select, fds, [], [], 0.02
                )
            except ValueError:
                self.cleanup_closed_agents()
                continue
            for fd in r:
                agent_entry = next(
                    (
                        item
                        for item in self.agents.items()
                        if item[1]["master_fd"] == fd
                    ),
                    None,
                )
                if not agent_entry:
                    continue
                agent_id, info = agent_entry
                try:
                    # Drain all available data from the PTY
                    # in a tight loop so that rapid bursts of
                    # output (e.g. Claude updating multiple
                    # status lines with cursor-movement escape
                    # sequences) are coalesced into a single
                    # socket emit.  This reduces partial escape
                    # sequence chunks reaching the frontend,
                    # which cause visible terminal jumping.
                    raw = os.read(fd, 65536)
                    if not raw:
                        self.close_agent(agent_id)
                        continue
                    while True:
                        rd, _, _ = select.select([fd], [], [], 0)
                        if not rd:
                            break
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        raw += chunk

                    # Strip tmux terminal capability queries
                    # and mouse tracking sequences.  Use a
                    # fast byte scan before running the regex
                    # to skip chunks that can't match.
                    if b"\x1b[" in raw or b"\x1b]" in raw:
                        raw = _TMUX_QUERIES.sub(b"", raw)
                        raw = _MOUSE_TRACKING.sub(b"", raw)
                        if not raw:
                            continue

                    # Buffer output during the startup
                    # window so tmux's initialization bursts
                    # are coalesced into one emit.
                    elapsed = time.monotonic() - info.get("spawn_time", 0)
                    if elapsed < _STARTUP_BUFFER_SECS:
                        info["startup_buffer"] += raw
                        continue

                    # Flush any buffered startup output.
                    if info.get("startup_buffer"):
                        raw = info.pop("startup_buffer") + raw

                    if self.sio.connected:
                        # Prepend any leftover bytes from a
                        # previously split UTF-8 character.
                        buf = info.get("utf8_buffer", b"")
                        data = buf + raw
                        complete, remainder = _split_utf8(data)
                        info["utf8_buffer"] = remainder
                        if not complete:
                            continue
                        decoded_data = complete.decode("utf-8", errors="replace")
                        self.agents[agent_id]["history"].append(decoded_data)
                        self.agents[agent_id]["last_output_time"] = time.monotonic()

                        # Check for permission prompts.
                        # Strip ANSI escapes before matching to
                        # avoid false positives on escape codes.
                        # Only run the expensive regex+search
                        # when the chunk contains a newline
                        # (prompts always end with one).
                        now = time.monotonic()
                        if "\n" in decoded_data or "?" in decoded_data:
                            stripped = _ANSI_ESCAPE.sub("", decoded_data)
                            if any(
                                p.search(stripped) for p in self.permission_patterns
                            ):
                                info["permission_candidate"] = now
                        # New output clears permission_waiting
                        # since the agent is actively producing
                        # output (not waiting for input).
                        if info.get("permission_waiting"):
                            info["permission_waiting"] = False

                        # Accumulate output in a per-agent
                        # buffer.  A separate flush coroutine
                        # sends it periodically, avoiding both
                        # per-chunk await latency (slow
                        # streaming) and unbounded create_task
                        # accumulation (resize starvation).
                        ob = info.get("output_buf", "")
                        info["output_buf"] = ob + decoded_data
                except OSError:
                    self.close_agent(agent_id)
            # When data was relayed, yield to the event
            # loop without wall-clock delay so other
            # coroutines run but the next read starts
            # immediately.  On idle cycles (select returned
            # nothing) we still fall through quickly since
            # select itself already waited up to 0.1 s.
            await asyncio.sleep(0)

    async def flush_output(self):
        """Periodically flushes per-agent output buffers.

        Runs as a separate task alongside watch_agents.
        Output is accumulated in info['output_buf'] by the
        read loop and flushed here every 15ms.  This avoids
        both per-chunk await latency (slow streaming) and
        unbounded create_task accumulation (event loop
        starvation during resize).
        """
        while self.running:
            if not self.agents or not self.sio.connected:
                await asyncio.sleep(0.05)
                continue
            now = time.monotonic()
            for agent_id, info in list(self.agents.items()):
                buf = info.get("output_buf", "")
                if not buf:
                    continue
                # During resize pause, keep accumulating
                # output in the buffer instead of emitting.
                # tmux and the agent continue producing
                # output which the read loop appends to
                # output_buf.  Once the pause expires, the
                # next flush cycle sends everything at once.
                pause_until = info.get("resize_pause_until", 0)
                if now < pause_until:
                    continue
                info["output_buf"] = ""
                try:
                    await self.sio.emit(
                        "terminal_output",
                        {
                            "sid": agent_id,
                            "output": buf,
                        },
                        namespace="/terminal",
                    )
                except Exception:
                    pass
            await asyncio.sleep(0.015)

    def close_agent(self, agent_id: str):
        """Closes the PTY fd, kills the tmux session, and
        removes an agent from tracking."""
        if agent_id in self.agents:
            log.info(f"Closing agent {agent_id}")
            fd = self.agents[agent_id]["master_fd"]
            try:
                os.close(fd)
            except OSError:
                pass
            # Kill the tmux session to clean up the
            # server-side window and processes.
            try:
                subprocess.run(
                    ["tmux", "kill-session", "-t", agent_id],
                    capture_output=True,
                    check=False,
                )
            except Exception:
                pass
            # Clean up sidecar telemetry file if the
            # profile defines one
            tool_name = self.agents[agent_id].get("tool")
            profile = self.profiles.get(tool_name)
            if profile and profile.sidecar:
                sidecar = profile.sidecar.file_pattern.format(
                    agent_id=agent_id, tmpdir=tempfile.gettempdir()
                )
                try:
                    os.unlink(sidecar)
                except OSError:
                    pass
            # Remove files the user sent to this session
            shutil.rmtree(self._upload_dir(agent_id), ignore_errors=True)
            # Clean up git worktree if one was created
            wt_path = self.agents[agent_id].get("worktree_path")
            wt_branch = self.agents[agent_id].get("worktree_branch")
            orig_dir = self.agents[agent_id].get("original_project_dir")
            if wt_path and orig_dir:
                try:
                    subprocess.run(
                        ["git", "worktree", "remove", "--force", wt_path],
                        cwd=orig_dir,
                        capture_output=True,
                        check=False,
                    )
                    log.info(f"Removed worktree {wt_path}")
                except Exception as e:
                    log.info(f"Failed to remove worktree {wt_path}: {e}")
                if wt_branch:
                    try:
                        subprocess.run(
                            ["git", "branch", "-D", wt_branch],
                            cwd=orig_dir,
                            capture_output=True,
                            check=False,
                        )
                    except Exception as e:
                        log.info(f"Failed to delete branch {wt_branch}: {e}")
                # Clean up empty parent directories
                try:
                    parent = os.path.dirname(wt_path)
                    if os.path.isdir(parent) and not os.listdir(parent):
                        os.rmdir(parent)
                except OSError:
                    pass
            del self.agents[agent_id]
            if self.sio.connected:
                asyncio.create_task(
                    self.sio.emit(
                        "agent_exit", {"agent_id": agent_id}, namespace="/terminal"
                    )
                )

    def cleanup_closed_agents(self):
        """Removes agents whose PTY file descriptors are closed."""
        to_delete = []
        for aid, info in self.agents.items():
            try:
                os.fstat(info["master_fd"])
            except OSError:
                to_delete.append(aid)
        for aid in to_delete:
            self.close_agent(aid)

    def _extract_otel_value(self, value_obj):
        """Extracts the actual value from an OTLP attribute value object.

        OTLP attribute values are wrapped in type-specific keys like
        'stringValue', 'intValue', 'doubleValue', etc. This helper
        returns the first non-None value found.
        """
        for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
            if key in value_obj:
                return value_obj[key]
        return None

    def _process_otel_attributes(self, attrs_list):
        """Converts a list of OTLP key/value attributes to a flat dict.

        Args:
            attrs_list: List of dicts with 'key' and 'value' fields
                        in OTLP attribute format.

        Returns:
            A dict mapping attribute keys to their extracted values.
        """
        result = {}
        for attr in attrs_list:
            key = attr.get("key", "")
            value = attr.get("value", {})
            result[key] = self._extract_otel_value(value)
        return result

    def _update_telemetry_from_attrs(self, tel, attrs):
        """Updates agent telemetry dict from parsed OTLP attributes.

        Looks for model name and token usage attributes using multiple
        naming conventions (Gemini and Claude use different schemas).

        Args:
            tel: The agent's telemetry dict to update in place.
            attrs: Flat dict of parsed OTLP attributes.

        Returns:
            True if any telemetry value was updated, False otherwise.
        """
        changed = False

        # Model detection — try common attribute names
        for key in ("model", "gen_ai.request.model", "gen_ai.response.model"):
            model = attrs.get(key)
            if model and isinstance(model, str) and tel.get("model") != model:
                tel["model"] = model
                changed = True
                break

        # Token detection — try common attribute names
        input_tokens = None
        output_tokens = None
        cache_tokens = None
        for key in ("input_token_count", "input_tokens", "gen_ai.usage.input_tokens"):
            val = attrs.get(key)
            if val is not None:
                input_tokens = int(val)
                break
        for key in (
            "output_token_count",
            "output_tokens",
            "gen_ai.usage.output_tokens",
        ):
            val = attrs.get(key)
            if val is not None:
                output_tokens = int(val)
                break
        # Cache tokens — check both short names (Claude)
        # and GenAI semconv names (pi-otel).
        cache_read = None
        cache_creation = None
        for key in (
            "cache_read_tokens",
            "gen_ai.usage.cache_read_input_tokens",
        ):
            val = attrs.get(key)
            if val is not None:
                cache_read = int(val)
                break
        for key in (
            "cache_creation_tokens",
            "gen_ai.usage.cache_creation_input_tokens",
            # pi-otel also emits cache_write_input_tokens
            "gen_ai.usage.cache_write_input_tokens",
        ):
            val = attrs.get(key)
            if val is not None:
                cache_creation = int(val)
                break
        if cache_read is not None or cache_creation is not None:
            cache_tokens = (cache_read or 0) + (cache_creation or 0)
        else:
            cache_tokens = None

        # Span attributes carry per-request token counts
        # (pi-otel) or cumulative totals (Claude Code logs).
        # Accumulate into _span_* tracking keys so the
        # per-request values from pi-otel sum correctly.
        # The metric-based path (cumulative histograms)
        # writes to input_tokens / output_tokens directly
        # and will supersede these when active.
        if input_tokens is not None or output_tokens is not None:
            inp = input_tokens or 0
            out = output_tokens or 0
            cch = cache_tokens or 0
            tel["_span_input_tokens"] = tel.get("_span_input_tokens", 0) + inp
            tel["_span_output_tokens"] = tel.get("_span_output_tokens", 0) + out
            tel["_span_cache_tokens"] = tel.get("_span_cache_tokens", 0) + cch
            # Use span-accumulated totals as floor;
            # metric-reported values win when higher.
            span_total = (
                tel["_span_input_tokens"]
                + tel["_span_output_tokens"]
                + tel["_span_cache_tokens"]
            )
            if span_total > tel.get("tokens", 0):
                tel["tokens"] = span_total
                changed = True

        # Track input_tokens as context_tokens — this is
        # the per-API-call value representing current context
        # window usage (accounts for compression/eviction).
        # Always overwrite with the latest value so it can
        # decrease after context compression.
        if input_tokens is not None and input_tokens > 0:
            tel["context_tokens"] = input_tokens
            changed = True

        # Cost — pi-otel puts per-request cost on each
        # pi.llm_request span as pi.cost.usd. Accumulate
        # with += since each span represents a single API
        # call. The _span_cost_usd tracker prevents the
        # metric path (cumulative) from conflicting.
        cost = attrs.get("pi.cost.usd")
        if cost is not None:
            cost_f = float(cost)
            if cost_f > 0:
                tel["_span_cost_usd"] = tel.get("_span_cost_usd", 0.0) + cost_f
                if tel["_span_cost_usd"] > tel.get("cost_usd", 0.0):
                    tel["cost_usd"] = tel["_span_cost_usd"]
                    changed = True

        # Current activity — extract the latest tool/function
        # name from span or log attributes.  Gemini uses
        # 'function_name', Claude uses 'tool_name', pi-otel
        # uses 'gen_ai.tool.name'.
        activity = None
        for key in (
            "function_name",
            "tool_name",
            "gen_ai.tool.name",
            "gen_ai.operation.name",
        ):
            val = attrs.get(key)
            if val and isinstance(val, str):
                activity = val
                break

        # Fall back to event.name for log records
        if not activity:
            event_name = attrs.get("event.name")
            if (
                event_name
                and isinstance(event_name, str)
                and event_name not in ("gen_ai_operation_details",)
            ):
                activity = event_name

        if activity:
            tel["current_activity"] = activity
            changed = True

        return changed

    def _resolve_agent_id(self, res_attrs):
        """Resolves an agent_id from OTLP resource attributes.

        First checks for the standard 'service.name' attribute (set
        via OTEL_RESOURCE_ATTRIBUTES for tools like Claude Code that
        use the standard OTEL SDK).  If not found, falls back to
        matching by tool type — Gemini CLI uses its own telemetry
        implementation and does not honour OTEL_RESOURCE_ATTRIBUTES.

        The fallback inspects the 'service.name' value and all
        resource attributes for tool-type hints, then matches to
        any active agent of that tool type.  When multiple agents of
        the same tool type are running, falls back to the most
        recently spawned one.

        Args:
            res_attrs: Flat dict of parsed OTLP resource attributes.

        Returns:
            A matching agent_id string, or None.
        """
        # Direct match via injected service.name (Claude Code path)
        agent_id = res_attrs.get("service.name")
        if agent_id and agent_id in self.agents:
            return agent_id

        # Fallback: infer tool type from resource attributes and
        # match to an active agent of that type.
        tool_hint = None
        svc = res_attrs.get("service.name", "") or ""
        all_vals = " ".join(str(v) for v in res_attrs.values() if v).lower()

        if "antigravity" in svc.lower() or "agy" in all_vals:
            tool_hint = "agy"
        elif "gemini" in svc.lower() or "gemini" in all_vals:
            # Antigravity (agy) is built on Gemini CLI and
            # shares its telemetry namespace.  Check for agy
            # agents first so "gemini" in resource attrs
            # can fall back to matching agy sessions.
            tool_hint = "gemini"
        elif "claude" in svc.lower() or "claude" in all_vals:
            tool_hint = "claude"
        elif "pi" == svc.lower() or "pi-otel" in all_vals:
            tool_hint = "pi"
        elif "opencode" in svc.lower() or "opencode" in all_vals:
            tool_hint = "opencode"
        elif "codex" in svc.lower() or "codex" in all_vals:
            tool_hint = "codex"

        if tool_hint:
            # Build candidate list.  When the hint is
            # "gemini", also include "agy" agents since
            # Antigravity shares Gemini's OTLP namespace
            # and resource attributes.
            match_tools = {"gemini", "agy"} if tool_hint == "gemini" else {tool_hint}
            candidates = [
                (aid, info)
                for aid, info in self.agents.items()
                if info.get("tool") in match_tools
            ]
            if len(candidates) == 1:
                return candidates[0][0]
            elif len(candidates) > 1:
                # Multiple agents of same type — use the most
                # recently spawned (highest last_output_time as
                # proxy for recency)
                return max(
                    candidates,
                    key=lambda c: c[1].get("last_output_time", 0),
                )[0]

        # Last resort: if there is exactly one agent, use it
        if len(self.agents) == 1:
            return next(iter(self.agents))

        return None

    async def handle_otlp(self, request):
        """Standardized OTLP HTTP receiver (JSON format).

        Handles logs (/v1/logs), traces (/v1/traces), and metrics
        (/v1/metrics). Extracts agent_id from the resource
        'service.name' attribute (injected at spawn time) and looks
        for model/token info in record or span attributes.  Falls
        back to tool-type matching for CLIs (like Gemini) that do
        not respect OTEL_RESOURCE_ATTRIBUTES.
        """
        try:
            data = await request.json()
            # Identify signal types present in the payload
            # for clearer logging (especially when requests
            # arrive on the root-path compatibility route).
            signals = [
                k.replace("resource", "").lower()
                for k in data
                if k.startswith("resource")
            ]
            log.info(
                f"OTLP received on {request.path}"
                f" signals={signals or list(data.keys())}"
            )

            # Optional verbose debug mode for inspecting
            # raw OTLP payloads from agent tools.
            if os.getenv("OTLP_DEBUG"):
                log.info(
                    f"OTLP DEBUG {request.path}:\n"
                    f"{json.dumps(data, indent=2, default=str)}"
                )

            # Process OTLP Logs (resourceLogs → scopeLogs → logRecords)
            for res_log in data.get("resourceLogs", []):
                resource = res_log.get("resource", {})
                res_attrs = self._process_otel_attributes(
                    resource.get("attributes", [])
                )
                agent_id = self._resolve_agent_id(res_attrs)

                if not agent_id:
                    log.info(
                        f"OTLP: no agent match for resource " f"attrs: {res_attrs}"
                    )
                    continue
                tel = self.agents[agent_id]["telemetry"]
                changed = False

                for scope_log in res_log.get("scopeLogs", []):
                    for record in scope_log.get("logRecords", []):
                        attrs = self._process_otel_attributes(
                            record.get("attributes", [])
                        )
                        if self._update_telemetry_from_attrs(tel, attrs):
                            changed = True

                if changed:
                    self.agents[agent_id]["last_otlp_time"] = time.monotonic()
                    if self.sio.connected:
                        await self.sio.emit(
                            "agent_telemetry",
                            {"agent_id": agent_id, "telemetry": tel},
                            namespace="/terminal",
                        )

            # Process OTLP Traces (resourceSpans → scopeSpans → spans)
            for res_span in data.get("resourceSpans", []):
                resource = res_span.get("resource", {})
                res_attrs = self._process_otel_attributes(
                    resource.get("attributes", [])
                )
                agent_id = self._resolve_agent_id(res_attrs)

                if not agent_id:
                    log.info("OTLP: no agent match for trace" f" resource: {res_attrs}")
                    continue
                tel = self.agents[agent_id]["telemetry"]
                changed = False

                # Keywords that indicate the agent is
                # waiting for user input / permission.
                _wait_keywords = (
                    "permission",
                    "user_input",
                    "approval",
                    "confirm",
                    "waiting",
                )

                for scope_span in res_span.get("scopeSpans", []):
                    for span in scope_span.get("spans", []):
                        attrs = self._process_otel_attributes(
                            span.get("attributes", [])
                        )
                        if self._update_telemetry_from_attrs(tel, attrs):
                            changed = True

                        # Extract activity from span names like
                        # "pi.tool.bash", "pi.tool.read", etc.
                        # when attributes didn't provide it.
                        span_name = span.get("name") or ""
                        if span_name.startswith("pi.tool."):
                            tool = span_name[len("pi.tool.") :]
                            if tool and tel.get("current_activity") != tool:
                                tel["current_activity"] = tool
                                changed = True

                        # Check span name for permission /
                        # waiting signals (future-proofing for
                        # when tools emit these via OTLP).
                        span_name = span_name.lower()
                        if any(kw in span_name for kw in _wait_keywords):
                            info = self.agents[agent_id]
                            info["permission_candidate"] = time.monotonic()
                            changed = True

                        # Check span events for waiting
                        # indicators.
                        for event in span.get("events", []):
                            event_name = (event.get("name") or "").lower()
                            if any(kw in event_name for kw in _wait_keywords):
                                info = self.agents[agent_id]
                                info["permission_candidate"] = time.monotonic()
                                changed = True

                if changed:
                    self.agents[agent_id]["last_otlp_time"] = time.monotonic()
                    if self.sio.connected:
                        await self.sio.emit(
                            "agent_telemetry",
                            {"agent_id": agent_id, "telemetry": tel},
                            namespace="/terminal",
                        )

            # Process OTLP Metrics
            # (resourceMetrics → scopeMetrics → metrics → dataPoints)
            # Claude Code sends token usage as counter metrics with
            # 'model' and 'type' (input/output) attributes.
            for res_metric in data.get("resourceMetrics", []):
                resource = res_metric.get("resource", {})
                res_attrs = self._process_otel_attributes(
                    resource.get("attributes", [])
                )
                agent_id = self._resolve_agent_id(res_attrs)

                if not agent_id:
                    log.info(
                        "OTLP: no agent match for metric" f" resource: {res_attrs}"
                    )
                    continue
                tel = self.agents[agent_id]["telemetry"]
                changed = False

                for scope_metric in res_metric.get("scopeMetrics", []):
                    for metric in scope_metric.get("metrics", []):
                        name = metric.get("name", "")

                        # Collect data points from sum, gauge, or
                        # histogram structures
                        data_points = []
                        for container in ("sum", "gauge", "histogram"):
                            section = metric.get(container, {})
                            data_points.extend(section.get("dataPoints", []))

                        for dp in data_points:
                            dp_attrs = self._process_otel_attributes(
                                dp.get("attributes", [])
                            )

                            # Model detection from any metric with a
                            # 'model' attribute. GenAI conventions
                            # also use gen_ai.response.model.
                            model = (
                                dp_attrs.get("model")
                                or dp_attrs.get("gen_ai.response.model")
                                or dp_attrs.get("gen_ai.request.model")
                            )
                            if (
                                model
                                and isinstance(model, str)
                                and tel.get("model") != model
                            ):
                                tel["model"] = model
                                changed = True

                            # Extract the data point value. Sum and
                            # Gauge metrics use asInt/asDouble.
                            # Histogram metrics store cumulative
                            # totals in the "sum" field instead.
                            dp_value = (
                                dp.get("asInt")
                                or dp.get("asDouble")
                                or dp.get("sum")
                                or 0
                            )

                            # Token, cost, activity, and runtime
                            # metrics are matched against the
                            # lookup tables built from agent
                            # profiles at startup. Metric names
                            # are defined in the profile YAML
                            # files under agent/profiles/.
                            #
                            # Token metrics may be OTLP cumulative
                            # Sum counters or Histograms (pi-otel
                            # uses histograms). Use max() not +=.
                            if (
                                name in self._token_metrics
                                and name not in self._excluded_metrics
                            ):
                                if dp_value:
                                    int_value = int(dp_value)
                                    # Claude uses "type", GenAI
                                    # semconv uses "gen_ai.token.type"
                                    token_type = (
                                        dp_attrs.get("type")
                                        or dp_attrs.get("gen_ai.token.type")
                                        or ""
                                    )
                                    if token_type == "input":
                                        tel["input_tokens"] = max(
                                            tel.get("input_tokens", 0),
                                            int_value,
                                        )
                                    elif token_type == "output":
                                        tel["output_tokens"] = max(
                                            tel.get("output_tokens", 0),
                                            int_value,
                                        )
                                    elif token_type == "cacheRead":
                                        tel["cache_read_tokens"] = max(
                                            tel.get("cache_read_tokens", 0),
                                            int_value,
                                        )
                                    elif token_type in (
                                        "cacheCreation",
                                        "cache",
                                    ):
                                        tel["cache_creation_tokens"] = max(
                                            tel.get("cache_creation_tokens", 0),
                                            int_value,
                                        )
                                    tel["tokens"] = (
                                        tel.get("input_tokens", 0)
                                        + tel.get("output_tokens", 0)
                                        + tel.get("cache_read_tokens", 0)
                                        + tel.get("cache_creation_tokens", 0)
                                    )
                                    changed = True

                            # Cost metrics (cumulative Sum, USD)
                            if name in self._cost_metrics:
                                if dp_value:
                                    tel["cost_usd"] = max(
                                        tel.get("cost_usd", 0.0),
                                        float(dp_value),
                                    )
                                    changed = True

                            # Activity metrics (tool/function name)
                            if name in self._activity_metrics:
                                fn = (
                                    dp_attrs.get("function_name")
                                    or dp_attrs.get("tool_name")
                                    or dp_attrs.get("gen_ai.tool.name")
                                )
                                if fn and isinstance(fn, str):
                                    tel["current_activity"] = fn
                                    changed = True

                            # Runtime duration metrics
                            if name in self._runtime_metrics:
                                if dp_value:
                                    unit = self._runtime_metrics[name]
                                    if unit == "milliseconds":
                                        tel["run_time_seconds"] = int(dp_value / 1000)
                                    else:
                                        tel["run_time_seconds"] = int(dp_value)
                                    changed = True

                if changed:
                    self.agents[agent_id]["last_otlp_time"] = time.monotonic()
                    if self.sio.connected:
                        await self.sio.emit(
                            "agent_telemetry",
                            {"agent_id": agent_id, "telemetry": tel},
                            namespace="/terminal",
                        )

            return web.Response(
                status=200,
                text="{}",
                content_type="application/json",
                headers={"Connection": "close"},
            )
        except Exception as e:
            log.info(f"OTLP Error: {e}")
            return web.Response(status=400)

    async def start_otlp_server(self):
        """Starts a local HTTP server for OpenTelemetry data."""
        app = web.Application()
        app.router.add_post("/v1/logs", self.handle_otlp)
        app.router.add_post("/v1/traces", self.handle_otlp)
        app.router.add_post("/v1/metrics", self.handle_otlp)
        # Compatibility route: accept OTLP payloads on the
        # root path for clients that send to the endpoint URL
        # directly instead of appending /v1/{signal}.  This is
        # harmless and keeps the receiver resilient regardless
        # of client implementation details.
        # History: https://github.com/NikiforovAll/pi-otel/issues/4
        app.router.add_post("/", self.handle_otlp)
        self.otlp_runner = web.AppRunner(app)
        await self.otlp_runner.setup()
        site = web.TCPSite(self.otlp_runner, "127.0.0.1", self.otlp_port)
        await site.start()
        self._otlp_ready.set()
        log.info(f"OTLP Receiver listening on " f"http://127.0.0.1:{self.otlp_port}")

    async def update_agent_status(self):
        """Periodically derives agent_status from OTLP and output activity.

        Runs every 5 seconds. Status logic:
        - permission_waiting flag set -> 'waiting_permission'
        - OTLP data received within last 15s -> 'working'
        - No recent activity -> 'idle'
        Emits agent_telemetry on status change.
        """
        while self.running:
            now = time.monotonic()
            for agent_id, info in list(self.agents.items()):
                try:
                    tel = info["telemetry"]
                    old_status = tel.get("agent_status")

                    # Promote permission candidate to
                    # permission_waiting if the agent has
                    # been idle (no output) since the match.
                    candidate_time = info.get("permission_candidate", 0)
                    if candidate_time > 0:
                        idle_since = now - info.get("last_output_time", 0)
                        if idle_since >= PERMISSION_IDLE_SECONDS:
                            info["permission_waiting"] = True

                    if info.get("permission_waiting"):
                        new_status = "waiting_permission"
                    elif (now - info.get("last_otlp_time", 0)) < 15:
                        new_status = "working"
                    elif (now - info.get("last_output_time", 0)) < 15:
                        new_status = "working"
                    else:
                        new_status = "idle"

                    if new_status != old_status:
                        tel["agent_status"] = new_status
                        if self.sio.connected:
                            await self.sio.emit(
                                "agent_telemetry",
                                {
                                    "agent_id": agent_id,
                                    "telemetry": tel,
                                },
                                namespace="/terminal",
                            )
                except Exception:
                    pass
            await asyncio.sleep(5)

    async def update_agents_git_info(self):
        """Periodically checks the current working directory
        of each agent and updates git info."""
        while self.running:
            for agent_id, info in list(self.agents.items()):
                try:
                    pid = info["pid"]
                    if not pid:
                        continue
                    # Try to read the cwd of the child process.
                    # For worktree agents, use the original
                    # project dir for project name and remote
                    # URL so the card doesn't show the worktree
                    # directory name.
                    cwd = subprocess.check_output(
                        [
                            "tmux",
                            "display-message",
                            "-p",
                            "-t",
                            agent_id,
                            "#{pane_current_path}",
                        ],
                        text=True,
                    ).strip()
                    orig = info.get("original_project_dir")
                    branch, project, remote_url = self.get_git_info(cwd)
                    if orig and orig != cwd:
                        _, orig_project, orig_url = self.get_git_info(orig)
                        if orig_project:
                            project = orig_project
                        if orig_url:
                            remote_url = orig_url

                    tel = info["telemetry"]
                    changed = False
                    if branch and tel.get("git_branch") != branch:
                        tel["git_branch"] = branch
                        changed = True
                    if project and tel.get("git_project") != project:
                        tel["git_project"] = project
                        changed = True
                    if remote_url and tel.get("git_remote_url") != remote_url:
                        tel["git_remote_url"] = remote_url
                        changed = True

                    # Read sidecar telemetry file if the
                    # profile defines one (e.g. bash uses
                    # PROMPT_COMMAND to write cwd, exit code,
                    # and last command to a JSON file).
                    tool_name = info.get("tool")
                    profile = self.profiles.get(tool_name)
                    if profile and profile.sidecar:
                        sidecar = profile.sidecar.file_pattern.format(
                            agent_id=agent_id, tmpdir=tempfile.gettempdir()
                        )
                        try:
                            with open(sidecar, "r", encoding="utf-8") as f:
                                sc_data = json.loads(f.read().strip())
                            # Map sidecar fields to telemetry
                            # using the profile's field mapping
                            for tel_key, sc_key in profile.sidecar.fields.items():
                                val = sc_data.get(sc_key)
                                if val is not None and tel.get(tel_key) != val:
                                    tel[tel_key] = val
                                    changed = True
                        except (FileNotFoundError, json.JSONDecodeError):
                            # Sidecar not yet written —
                            # fall back to /proc cwd
                            if cwd and tel.get("current_activity") != cwd:
                                tel["current_activity"] = cwd
                                changed = True

                    if changed and self.sio.connected:
                        await self.sio.emit(
                            "agent_telemetry",
                            {"agent_id": agent_id, "telemetry": tel},
                            namespace="/terminal",
                        )
                except Exception:
                    pass  # Process might have died or no permission
            await asyncio.sleep(5)

    async def _run_task(self, name, coro):
        """Runs a background task with error recovery.

        Catches exceptions and restarts the task instead of
        letting failures propagate through asyncio.gather()
        and crash the entire daemon.

        Args:
            name: Human-readable task name for logging.
            coro: Async callable (unbound method) to run.
        """
        while self.running:
            try:
                await coro()
                return
            except asyncio.CancelledError:
                # A cancel aimed at this task is a shutdown. A
                # CancelledError raised by something the task
                # awaited (e.g. a cancelled executor job) is not:
                # returning on it once stopped the PTY watcher
                # for good, without a log line, and every
                # terminal went blank.
                task = asyncio.current_task()
                if not self.running or (task and task.cancelling()):
                    return
                log.info(f"Background task '{name}' was cancelled from inside")
            except Exception as e:
                log.info(f"Background task '{name}' failed: {e}")
            log.info(f"Restarting '{name}' in 5 seconds...")
            await asyncio.sleep(5)

    async def run(self):
        """Connects to the hub and starts all background tasks."""
        try:
            await self.sio.connect(
                self.server_url,
                namespaces=["/terminal"],
                headers={"X-Host-Token": self.host_token},
            )
            # Start background tasks with error recovery.
            # Each task is wrapped in _run_task so a failure
            # in one doesn't crash the entire daemon. The
            # OTLP server uses aiohttp's own error handling.
            self.watcher_task = asyncio.create_task(
                self._run_task("watcher", self.watch_agents)
            )
            self.cache_task = asyncio.create_task(
                self._run_task("cache", self.update_projects_cache)
            )
            self.otlp_task = asyncio.create_task(self.start_otlp_server())
            self.git_task = asyncio.create_task(
                self._run_task("git_info", self.update_agents_git_info)
            )
            self.status_task = asyncio.create_task(
                self._run_task("status", self.update_agent_status)
            )
            self.flush_task = asyncio.create_task(
                self._run_task("flush", self.flush_output)
            )
            self.usage_task = asyncio.create_task(
                self._run_task("usage", self.update_usage)
            )

            await asyncio.gather(
                self.watcher_task,
                self.cache_task,
                self.otlp_task,
                self.git_task,
                self.status_task,
                self.flush_task,
                self.usage_task,
            )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.info(f"Daemon error: {e}")
        finally:
            self.running = False
            if self.otlp_runner:
                await self.otlp_runner.cleanup()
            for agent_id in list(self.agents.keys()):
                self.close_agent(agent_id)
            if self.sio.connected:
                await self.sio.disconnect()
            log.info("Daemon stopped.")

    def stop(self):
        """Signals all background tasks to stop."""
        log.info("\nShutting down daemon...")
        self.running = False
        # Every task run() gathers: one left sleeping (the usage
        # poll waits minutes) keeps the daemon alive, still
        # holding the OTLP port, after launchd starts a new one.
        for name in (
            "watcher_task",
            "cache_task",
            "otlp_task",
            "git_task",
            "status_task",
            "flush_task",
            "usage_task",
        ):
            task = getattr(self, name, None)
            if task and not task.done():
                task.cancel()


def _reap_zombies():
    """Reap zombie child processes.

    The daemon runs as PID 1 inside the container, which
    makes it the init process responsible for reaping
    orphaned children.  Agent tools (git, bash, compilers)
    spawn child processes that may outlive their parent
    and get reparented to PID 1.  Without reaping, these
    accumulate as zombies and eventually exhaust the
    container's PID limit (typically 2048 in rootless
    Podman).
    """
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
        except ChildProcessError:
            break


async def main():
    """Entry point: reads config from env vars and runs the daemon."""
    server_url = os.getenv("DASHBOARD_URL", "http://localhost:8000")
    host_token = os.getenv("HOST_TOKEN")
    if not host_token:
        log.info("Error: HOST_TOKEN environment variable is required.")
        sys.exit(1)
    daemon = HostDaemon(server_url, host_token)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, daemon.stop)
    # Reap zombie children automatically.  SIGCHLD fires
    # whenever a child process exits; the handler calls
    # waitpid() in a loop to collect all finished children.
    loop.add_signal_handler(signal.SIGCHLD, _reap_zombies)
    await daemon.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
