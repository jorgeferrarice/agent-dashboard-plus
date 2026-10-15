"""Reads an AI tool's subscription limits off its own screen.

The tools show how much of a plan's allowance is used (a five
hour window, a weekly one) only inside their interactive UI:
``/usage`` in Claude Code, ``/status`` in Codex. There is no
command that prints it. So the daemon opens the tool in a
throwaway tmux session, types the command, reads the screen and
closes it again.

This is screen scraping and breaks when a tool changes its
layout. A probe that cannot read the screen raises
``ProbeError``; the caller keeps the last good reading.

Each probe:

- runs in a dedicated empty folder, never in a user project;
- uses its own tmux server (``tmux -L``), so it cannot touch the
  sessions the daemon runs for the user, and that server is
  killed when the probe ends, whatever happened;
- starts a real session of the tool, so the user's global hooks
  and MCP servers for that tool do start, briefly;
- reads only percentages and reset times. No credential is read,
  returned or logged.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Callable, Dict, List

from agent.profiles import AgentProfile

log = logging.getLogger("host_daemon")

# Size of the throwaway terminal. Tall, so the limits are on
# screen without scrolling.
_COLS, _ROWS = "140", "60"


class ProbeError(Exception):
    """A probe could not read the limits."""


def parse_claude(screen: str) -> List[dict]:
    """Reads the limits from Claude Code's ``/usage`` screen.

    Each limit is drawn as three lines::

        Current week (all models)
        █████████████▌            51% used
        Resets Oct 8 at 12pm (America/Los_Angeles)

    Args:
        screen: Text of the terminal screen.

    Returns:
        One dict per limit, in screen order, with ``label``,
        ``used_percent`` (0-100) and ``resets`` (free text, ""
        if not shown). Empty if no limit is on the screen.
    """
    lines = [line.strip() for line in screen.splitlines()]
    lines = [line for line in lines if line]
    windows = []
    for i, line in enumerate(lines):
        match = re.search(r"(\d{1,3})% used$", line)
        if not match or i == 0:
            continue
        following = lines[i + 1] if i + 1 < len(lines) else ""
        windows.append(
            {
                "label": lines[i - 1],
                "used_percent": min(100, int(match.group(1))),
                "resets": (
                    following[len("Resets") :].strip()
                    if following.startswith("Resets")
                    else ""
                ),
            }
        )
    return windows


def parse_codex(screen: str) -> List[dict]:
    """Reads the limits from Codex's ``/status`` screen.

    Each limit is one line, and shows what is left::

        Weekly limit:   [██████████] 100% left (resets 09:52 on 15 Oct)

    Args:
        screen: Text of the terminal screen.

    Returns:
        One dict per limit, shaped as in ``parse_claude``.
        Limits Codex does not show are simply absent.
    """
    windows = []
    for match in re.finditer(
        r"^\W*([\w ]+?) limit:\s*\[[^\]]*\]\s*(\d{1,3})% left"
        r"(?:\s*\(resets ([^)]*)\))?",
        screen,
        re.MULTILINE,
    ):
        windows.append(
            {
                "label": match.group(1).strip(),
                "used_percent": max(0, 100 - int(match.group(2))),
                "resets": (match.group(3) or "").strip(),
            }
        )
    return windows


PARSERS: Dict[str, Callable[[str], List[dict]]] = {
    "claude": parse_claude,
    "codex": parse_codex,
}


def probe_usage(profile: AgentProfile, probe_dir: str, timeout: float = 45) -> list:
    """Opens a tool, asks for its limits and reads them.

    Blocks for several seconds: call it from a worker thread.

    Args:
        profile: Profile, or account variant, to probe. Its
            ``usage`` section says what to type and how to read
            the answer.
        probe_dir: Empty folder to start the tool in. Created
            if missing.
        timeout: Seconds to wait for the limits before giving up.

    Returns:
        The limits, as the profile's parser returns them.

    Raises:
        ProbeError: The tool did not start, or the limits never
            showed up on its screen.
    """
    usage = profile.usage
    parser = PARSERS.get(usage.parser) if usage else None
    if not parser:
        raise ProbeError(f"{profile.name} has no way to read limits")
    os.makedirs(probe_dir, exist_ok=True)

    # The tool runs as the user would run it, plus the variable
    # that selects the account. TMUX is dropped so tmux agrees
    # to start when the daemon itself runs inside tmux.
    env = {k: v for k, v in os.environ.items() if k != "TMUX"}
    cfg = profile.config_dirs
    if cfg and cfg.env in profile.env:
        env[cfg.env] = profile.env[cfg.env]

    # A tmux server of its own, on a socket in a private folder
    # that is removed afterwards.
    socket_dir = tempfile.mkdtemp(prefix="agent-dashboard-probe-")
    tmux = ["tmux", "-S", os.path.join(socket_dir, "tmux")]

    def run(*args: str) -> str:
        done = subprocess.run(
            tmux + list(args),
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return done.stdout

    try:
        started = subprocess.run(
            tmux
            + ["new-session", "-d", "-s", "probe", "-x", _COLS, "-y", _ROWS]
            + ["-c", probe_dir]
            + list(usage.command or profile.commands.new),
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if started.returncode != 0:
            raise ProbeError(f"could not start {profile.name} in tmux")

        deadline = time.monotonic() + timeout
        begun = time.monotonic()
        answered = set()
        asked = False
        previous = None
        while time.monotonic() < deadline:
            time.sleep(1)
            screen = run("capture-pane", "-p", "-t", "probe")
            if asked:
                windows = parser(screen)
                if windows:
                    return windows
                continue
            # Start-up questions (trust this folder?) each get
            # their configured answer, once, when the question
            # has finished drawing: a key sent while it is still
            # appearing can land on the wrong choice.
            settled = bool(screen.strip()) and screen == previous
            prompt = next(
                (
                    p
                    for i, p in enumerate(usage.prompts)
                    if i not in answered and p.get("match", "") in screen
                ),
                None,
            )
            if prompt and not settled:
                previous = screen
                continue
            if prompt:
                answered.add(usage.prompts.index(prompt))
                for key in prompt.get("keys", []):
                    run("send-keys", "-t", "probe", key)
                    time.sleep(0.3)
                previous = None
                continue
            # Type once the screen has settled, or after 15s for
            # a tool whose screen never stops moving.
            waited = time.monotonic() - begun
            if (settled and waited >= 3) or waited >= 15:
                run("send-keys", "-t", "probe", "-l", usage.keys)
                time.sleep(0.7)
                run("send-keys", "-t", "probe", "Enter")
                asked = True
            previous = screen
        raise ProbeError(f"{profile.name} did not show its limits in {timeout:.0f}s")
    except (OSError, subprocess.SubprocessError) as e:
        raise ProbeError(f"tmux failed while probing {profile.name}: {e}") from e
    finally:
        # Always: this is what ends the tool's session.
        try:
            subprocess.run(
                tmux + ["kill-server"],
                env=env,
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as e:
            log.error(f"Could not close the usage probe for {profile.name}: {e}")
        shutil.rmtree(socket_dir, ignore_errors=True)
