"""Reads an agent's own conversation log for the dashboard's chat view.

Claude Code writes every conversation to a JSON Lines file,
``<config dir>/projects/<folder>/<session id>.jsonl``: one JSON
object per line, holding the user's prompts, Claude's answers,
the tools it called and what they returned. The chat view shows
that conversation as web messages while the agent keeps running
in its terminal; nothing here writes to the file or the agent.

The file is read as it grows. Each entry becomes a small
"normalized" message the UI can render without knowing the
file's format::

    {"id": "...", "ts": "2026-10-25T12:00:00Z",
     "role": "user" | "assistant" | "system",
     "blocks": [...]}

Blocks are ``text``, ``image`` (a reference, never the bytes),
``tool_use``, ``tool_result``, ``command`` (a slash command) and
``notice`` (compaction, command output, interruption). Long
strings are cut, so a message stays a few kilobytes; the full
output is still in the terminal.

Images inside the file are not copied into messages. A message
holds ``src: "t:<line offset>:<block>[:<inner block>]"`` and the
bytes are read again from that line when the UI asks for them
(``image_at``), so nothing large stays in memory.

Files on the host (screenshots, videos an agent made) are served
by path through ``media_path``, which only accepts media file
types inside the session's own folders.
"""

import base64
import binascii
import glob
import json
import os
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

# File types the chat may show, by extension.
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    # Documents: previewed in the chat, and offered for download.
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
}

# Longest text kept from a tool's result, and from each string
# of a tool's input. The terminal still shows everything.
TEXT_LIMIT = 4000
INPUT_LIMIT = 2000

# Session IDs are UUIDs; anything else is refused before it
# reaches a file pattern.
_SESSION_ID = re.compile(r"[0-9A-Za-z-]{8,64}")

# Tags Claude Code wraps around what a slash command typed or
# printed, inside a user entry.
_TAG = re.compile(r"<([a-z-]+)>(.*?)</\1>", re.S)
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _cut(text: str, limit: int) -> Tuple[str, bool]:
    """Returns ``text`` cut to ``limit`` characters, and whether
    it was cut."""
    if len(text) <= limit:
        return text, False
    return text[:limit] + "…", True


def _cut_input(value: Any, depth: int = 0) -> Any:
    """Cuts every string of a tool's input to ``INPUT_LIMIT``,
    so a Write of a large file does not travel to the UI whole.
    Nesting deeper than a few levels is replaced by "…"."""
    if depth > 4:
        return "…"
    if isinstance(value, str):
        return _cut(value, INPUT_LIMIT)[0]
    if isinstance(value, list):
        return [_cut_input(v, depth + 1) for v in value[:50]]
    if isinstance(value, dict):
        return {str(k): _cut_input(v, depth + 1) for k, v in list(value.items())[:50]}
    return value


def _image(block: dict, src: str) -> Optional[dict]:
    """An ``image`` block for an image stored in the file, or
    None when it is not an inline image of a known type."""
    source = block.get("source") or {}
    mime = source.get("media_type")
    if (
        source.get("type") != "base64"
        or mime not in MEDIA_TYPES.values()
        or not str(mime).startswith("image/")
    ):
        return None
    return {"type": "image", "src": src, "mime": mime}


def _user_text(text: str) -> Tuple[str, List[dict]]:
    """Turns the text of a user entry into blocks.

    Most user text is a prompt. Slash commands, their output,
    background-task notices and interruptions are stored as
    user text too, wrapped in tags; those become ``system``
    blocks so the UI can show them apart from prompts.

    Returns:
        The role ("user" or "system") and the blocks.
    """
    tags = {name: body.strip() for name, body in _TAG.findall(text)}
    if "command-name" in tags or "command-message" in tags:
        name = tags.get("command-name") or "/" + tags.get("command-message", "")
        return "system", [
            {"type": "command", "name": name, "args": tags.get("command-args", "")}
        ]
    for tag in ("local-command-stdout", "local-command-stderr"):
        if tag in tags:
            output = _cut(_ANSI.sub("", tags[tag]), TEXT_LIMIT)[0]
            return "system", [
                {"type": "notice", "kind": "command_output", "text": output}
            ]
    if text.lstrip().startswith("<task-notification>"):
        summary = tags.get("summary") or tags.get("status") or ""
        return "system", [
            {"type": "notice", "kind": "task_notification", "text": summary}
        ]
    if text.startswith("[Request interrupted by user"):
        return "system", [{"type": "notice", "kind": "interrupted", "text": ""}]
    return "user", [{"type": "text", "text": text}]


def _tool_result(block: dict, src: str) -> dict:
    """A ``tool_result`` block: the result's text (cut) and its
    images, if any."""
    content = block.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    texts, images = [], []
    for j, inner in enumerate(content if isinstance(content, list) else []):
        if not isinstance(inner, dict):
            continue
        if inner.get("type") == "text":
            texts.append(str(inner.get("text") or ""))
        elif inner.get("type") == "image":
            image = _image(inner, f"{src}:{j}")
            if image:
                images.append({"src": image["src"], "mime": image["mime"]})
    text, truncated = _cut("\n".join(texts), TEXT_LIMIT)
    return {
        "type": "tool_result",
        "tool_use_id": block.get("tool_use_id"),
        "text": text,
        "is_error": bool(block.get("is_error")),
        "truncated": truncated,
        "images": images,
    }


def parse_entry(entry: Any, offset: int) -> Optional[dict]:
    """Turns one line of a Claude Code transcript into a chat
    message.

    Only conversation entries (``user`` and ``assistant``) are
    read. Entries the terminal does not show either are skipped:
    ``isMeta`` (text Claude Code adds for the model, such as a
    skill's instructions) and ``isSidechain`` (a subagent's own
    conversation). Thinking is skipped too. Every other kind of
    line (settings, titles, file snapshots, ...) is ignored, so
    new kinds added by later versions do no harm.

    Args:
        entry: The line, parsed from JSON.
        offset: Where the line starts in the file, in bytes;
            image references point at it.

    Returns:
        The message, or None when the line shows nothing.
    """
    if (
        not isinstance(entry, dict)
        or entry.get("type") not in ("user", "assistant")
        or entry.get("isMeta")
        or entry.get("isSidechain")
    ):
        return None
    kind = entry["type"]
    message = {
        "id": str(entry.get("uuid") or f"o{offset}"),
        "ts": entry.get("timestamp"),
    }
    if entry.get("isCompactSummary"):
        return {
            **message,
            "role": "system",
            "blocks": [{"type": "notice", "kind": "compacted", "text": ""}],
        }
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return None
    role, blocks = kind, []
    for i, block in enumerate(content):
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = str(block.get("text") or "")
            if not text.strip():
                continue
            if kind == "user":
                role, found = _user_text(text)
                blocks.extend(found)
            else:
                blocks.append({"type": "text", "text": text})
        elif btype == "image":
            image = _image(block, f"t:{offset}:{i}")
            if image:
                blocks.append(image)
        elif btype == "tool_use":
            blocks.append(
                {
                    "type": "tool_use",
                    "id": block.get("id"),
                    "name": str(block.get("name") or ""),
                    "input": _cut_input(block.get("input") or {}),
                }
            )
        elif btype == "tool_result":
            blocks.append(_tool_result(block, f"t:{offset}:{i}"))
    if not blocks:
        return None
    return {**message, "role": role, "blocks": blocks}


class TranscriptReader:
    """Follows one transcript file as the agent writes it.

    Attributes:
        path: The file.
        session_id: The conversation it holds.
        offset: How many bytes have been read; a line not yet
            finished is left for the next read.
        messages: Every message read so far, oldest first.
    """

    def __init__(self, path: str, session_id: str = ""):
        self.path = path
        self.session_id = session_id
        self.offset = 0
        self.messages: List[dict] = []

    def read_new(self) -> List[dict]:
        """Reads what was added to the file since the last call.

        A file that got shorter (rewritten) is read again from
        the start; its old messages are dropped.

        Returns:
            The new messages (also appended to ``messages``).

        Raises:
            OSError: The file cannot be read.
        """
        size = os.path.getsize(self.path)
        if size < self.offset:
            self.offset, self.messages = 0, []
        if size == self.offset:
            return []
        # ponytail: reads the rest of the file in one go; a
        # transcript with many images can be tens of MB on the
        # first read. Read in chunks if that ever hurts.
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(size - self.offset)
        end = data.rfind(b"\n")
        if end < 0:
            return []
        found, pos = [], self.offset
        for line in data[: end + 1].split(b"\n")[:-1]:
            start, pos = pos, pos + len(line) + 1
            try:
                message = parse_entry(json.loads(line), start)
            except ValueError:
                continue
            if message:
                found.append(message)
        self.offset += end + 1
        self.messages.extend(found)
        return found


def project_folder(config_dir: str, cwd: str) -> str:
    """Where Claude Code keeps the transcripts of one working
    directory: every character other than a letter or digit of
    the path becomes "-"."""
    name = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd))
    return os.path.join(config_dir, "projects", name)


def find_transcript(config_dir: str, session_id: str) -> Optional[str]:
    """The transcript of one conversation, or None if Claude
    Code has not written it yet."""
    if not _SESSION_ID.fullmatch(session_id or ""):
        return None
    found = glob.glob(
        os.path.join(glob.escape(config_dir), "projects", "*", f"{session_id}.jsonl")
    )
    return found[0] if found else None


def latest_transcript(config_dir: str, cwd: str) -> Optional[str]:
    """The most recently written transcript of a working
    directory: the conversation ``claude --continue`` resumes
    there. None when there is none."""
    files = glob.glob(
        os.path.join(glob.escape(project_folder(config_dir, cwd)), "*.jsonl")
    )
    try:
        return max(files, key=os.path.getmtime) if files else None
    except OSError:
        return None


def image_at(path: str, src: str) -> Tuple[str, bytes]:
    """Reads an image a message refers to, from its transcript.

    Args:
        path: The transcript.
        src: The image's reference, ``t:<offset>:<i>[:<j>]``.

    Returns:
        The image's MIME type and bytes.

    Raises:
        ValueError: The reference is malformed or does not point
            at an image.
        OSError: The file cannot be read.
    """
    parts = src.split(":")
    if len(parts) not in (3, 4) or parts[0] != "t":
        raise ValueError("Not an image reference.")
    try:
        offset, *indexes = (int(p) for p in parts[1:])
    except ValueError as e:
        raise ValueError("Not an image reference.") from e
    with open(path, "rb") as f:
        f.seek(offset)
        line = f.readline()
    try:
        block: Any = json.loads(line)["message"]["content"]
        for index in indexes:
            if isinstance(block, dict):
                block = block.get("content")
            block = block[index]
        image = _image(block, src)
        if not image:
            raise ValueError("Not an image.")
        return image["mime"], base64.b64decode(block["source"]["data"])
    except (KeyError, IndexError, TypeError, binascii.Error) as e:
        raise ValueError("Not an image.") from e


def media_path(path: str, cwd: str, roots: Iterable[str]) -> Tuple[str, str]:
    """Checks that a file may be shown in the chat.

    Only images, videos, PDFs and HTML pages are served, and only from the
    session's own folders (``roots``: its working directory,
    project, uploads and the system temp folder). Symbolic
    links are followed before the check, so a link cannot point
    outside them.

    Args:
        path: The path as the agent wrote it; relative paths are
            taken from ``cwd``. A leading ``file://`` and ``~``
            are accepted.

    Returns:
        The real path and the MIME type.

    Raises:
        ValueError: Not a media file, outside the roots, or
            missing.
    """
    if path.startswith("file://"):
        path = path[len("file://") :]
    real = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    mime = MEDIA_TYPES.get(os.path.splitext(real)[1].lower())
    if not mime:
        raise ValueError("Only images, videos, PDFs and HTML pages can be shown.")
    for root in roots:
        if not root:
            continue
        base = os.path.realpath(root)
        if os.path.commonpath([real, base]) == base:
            break
    else:
        raise ValueError("The file is outside the session's folders.")
    if not os.path.isfile(real):
        raise ValueError("File not found.")
    return real, mime


def read_slice(path: str, offset: int, length: int) -> Tuple[int, bytes]:
    """Reads ``length`` bytes from ``offset`` of a file.

    Returns:
        The file's size and the bytes read.
    """
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        f.seek(max(0, offset))
        return size, f.read(max(0, length))


def batches(messages: List[Dict], size: int = 100) -> List[List[Dict]]:
    """Splits messages into groups small enough for one
    Socket.IO message each. Always returns at least one group,
    so an empty conversation is still sent."""
    return [messages[i : i + size] for i in range(0, len(messages), size)] or [[]]
