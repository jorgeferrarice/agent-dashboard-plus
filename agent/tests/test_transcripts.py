"""Tests for the chat view's transcript reading: the parser in
agent/transcripts.py and the daemon pieces that use it."""

import asyncio
import base64
import json
import os
from unittest.mock import AsyncMock

import pytest

from agent import transcripts
from agent.host_daemon import HostDaemon

PNG = b"\x89PNG fake"
PNG_B64 = base64.b64encode(PNG).decode()


def image(data=PNG_B64, mime="image/png"):
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": mime, "data": data},
    }


ENTRIES = [
    {"type": "permission-mode", "mode": "default"},
    {
        "type": "user",
        "uuid": "u1",
        "timestamp": "2026-10-25T10:00:00Z",
        "message": {"role": "user", "content": "Faça um gráfico"},
    },
    {
        "type": "user",
        "uuid": "meta",
        "isMeta": True,
        "message": {"content": [{"type": "text", "text": "skill text"}]},
    },
    {
        "type": "assistant",
        "uuid": "a1",
        "message": {
            "content": [
                {"type": "thinking", "thinking": "hmm"},
                {"type": "text", "text": "Vou rodar"},
                {
                    "type": "tool_use",
                    "id": "tu1",
                    "name": "Bash",
                    "input": {"command": "x" * 5000},
                },
            ]
        },
    },
    {
        "type": "user",
        "uuid": "r1",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tu1",
                    "is_error": True,
                    "content": [{"type": "text", "text": "y" * 5000}, image()],
                }
            ]
        },
    },
    {
        "type": "assistant",
        "uuid": "side",
        "isSidechain": True,
        "message": {"content": [{"type": "text", "text": "subagent"}]},
    },
    {
        "type": "user",
        "uuid": "c1",
        "message": {
            "content": "<command-message>review</command-message>\n"
            "<command-name>/review</command-name>\n"
            "<command-args>42</command-args>"
        },
    },
    {
        "type": "user",
        "uuid": "o1",
        "message": {
            "content": "<local-command-stdout>\x1b[1mdone\x1b[0m</local-command-stdout>"
        },
    },
    {
        "type": "user",
        "uuid": "i1",
        "message": {
            "content": [{"type": "text", "text": "[Request interrupted by user]"}]
        },
    },
    {
        "type": "user",
        "uuid": "s1",
        "isCompactSummary": True,
        "message": {"content": "x"},
    },
    {
        "type": "user",
        "uuid": "p1",
        "message": {"content": [image(), image(mime="text/html")]},
    },
]


def write(path, entries, tail=""):
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")
        f.write(tail)


@pytest.fixture
def transcript(tmp_path):
    path = tmp_path / "s.jsonl"
    write(path, ENTRIES, tail="not json\n")
    return str(path)


def test_parser_keeps_what_the_terminal_shows(transcript):
    messages = transcripts.TranscriptReader(transcript).read_new()
    by_id = {m["id"]: m for m in messages}
    assert list(by_id) == ["u1", "a1", "r1", "c1", "o1", "i1", "s1", "p1"]
    assert by_id["u1"]["role"] == "user"
    assert by_id["u1"]["ts"] == "2026-10-25T10:00:00Z"
    assert by_id["u1"]["blocks"] == [{"type": "text", "text": "Faça um gráfico"}]

    text, tool = by_id["a1"]["blocks"]
    assert text == {"type": "text", "text": "Vou rodar"}
    assert tool["name"] == "Bash" and tool["id"] == "tu1"
    assert len(tool["input"]["command"]) == transcripts.INPUT_LIMIT + 1

    (result,) = by_id["r1"]["blocks"]
    assert result["tool_use_id"] == "tu1"
    assert result["is_error"] and result["truncated"]
    assert len(result["text"]) == transcripts.TEXT_LIMIT + 1
    assert result["images"] == [
        {"src": result["images"][0]["src"], "mime": "image/png"}
    ]

    assert by_id["c1"] == {
        "id": "c1",
        "ts": None,
        "role": "system",
        "blocks": [{"type": "command", "name": "/review", "args": "42"}],
    }
    assert by_id["o1"]["blocks"][0]["text"] == "done"
    assert by_id["i1"]["blocks"][0]["kind"] == "interrupted"
    assert by_id["s1"]["blocks"][0]["kind"] == "compacted"
    # Only the image of a known type is kept.
    assert [b["mime"] for b in by_id["p1"]["blocks"]] == ["image/png"]


def test_images_are_read_back_from_their_line(transcript):
    messages = transcripts.TranscriptReader(transcript).read_new()
    by_id = {m["id"]: m for m in messages}
    for src in (
        by_id["r1"]["blocks"][0]["images"][0]["src"],
        by_id["p1"]["blocks"][0]["src"],
    ):
        assert transcripts.image_at(transcript, src) == ("image/png", PNG)
    for bad in ("t:0:0", "x:1:2", "t:a:b", "t:1"):
        with pytest.raises(ValueError):
            transcripts.image_at(transcript, bad)


def test_reader_follows_the_file_and_waits_for_whole_lines(tmp_path):
    path = tmp_path / "s.jsonl"
    write(path, ENTRIES[1:2], tail='{"type": "assistant", "uuid": "a9", "mess')
    reader = transcripts.TranscriptReader(str(path))
    assert [m["id"] for m in reader.read_new()] == ["u1"]
    assert reader.read_new() == []
    with open(path, "a", encoding="utf-8") as f:
        f.write('age": {"content": [{"type": "text", "text": "oi"}]}}\n')
    assert [m["id"] for m in reader.read_new()] == ["a9"]
    assert [m["id"] for m in reader.messages] == ["u1", "a9"]
    # Rewritten shorter: read again from the start.
    write(path, ENTRIES[1:2])
    assert [m["id"] for m in reader.read_new()] == ["u1"]
    assert [m["id"] for m in reader.messages] == ["u1"]


def test_finding_transcripts(tmp_path):
    cwd = tmp_path / "my.project"
    cwd.mkdir()
    folder = transcripts.project_folder(str(tmp_path), str(cwd))
    assert os.path.basename(folder) == "".join(
        c if c.isalnum() else "-" for c in os.path.realpath(cwd)
    )
    os.makedirs(folder)
    old, new = os.path.join(folder, "aaaaaaaa-1.jsonl"), os.path.join(
        folder, "bbbbbbbb-2.jsonl"
    )
    write(old, [])
    write(new, [])
    os.utime(old, (1, 1))
    assert transcripts.latest_transcript(str(tmp_path), str(cwd)) == new
    assert transcripts.find_transcript(str(tmp_path), "aaaaaaaa-1") == old
    assert transcripts.find_transcript(str(tmp_path), "cccccccc-3") is None
    assert transcripts.find_transcript(str(tmp_path), "../*") is None
    assert transcripts.latest_transcript(str(tmp_path), str(tmp_path / "none")) is None


def test_media_path_only_serves_media_inside_the_roots(tmp_path):
    root, outside = tmp_path / "proj", tmp_path / "other"
    root.mkdir()
    outside.mkdir()
    (root / "shot.PNG").write_bytes(PNG)
    (root / "notes.txt").write_text("secret")
    (outside / "x.png").write_bytes(PNG)
    os.symlink(outside / "x.png", root / "link.png")
    cwd, roots = str(root), [str(root), None]

    real, mime = transcripts.media_path("shot.PNG", cwd, roots)
    assert real == os.path.realpath(root / "shot.PNG") and mime == "image/png"
    assert (
        transcripts.media_path(f"file://{root}/shot.PNG", cwd, roots)[1] == "image/png"
    )
    (root / "report.pdf").write_bytes(b"%PDF")
    (root / "page.html").write_text("<p>")
    assert transcripts.media_path("report.pdf", cwd, roots)[1] == "application/pdf"
    assert transcripts.media_path("page.html", cwd, roots)[1] == "text/html"
    for path, words in (
        ("notes.txt", "Only images"),
        (str(outside / "x.png"), "outside"),
        ("../other/x.png", "outside"),
        ("link.png", "outside"),
        ("missing.mp4", "not found"),
    ):
        with pytest.raises(ValueError, match=words):
            transcripts.media_path(path, cwd, roots)
    assert transcripts.read_slice(str(root / "shot.PNG"), 2, 3) == (len(PNG), PNG[2:5])


def test_batches():
    assert transcripts.batches([]) == [[]]
    assert transcripts.batches(list(range(5)), size=2) == [[0, 1], [2, 3], [4]]


# ── The daemon's side ──────────────────────────────────────


@pytest.fixture
def daemon(tmp_path):
    """A daemon with one Claude session in ``tmp_path/proj``
    whose config directory is ``tmp_path/config``."""
    d = HostDaemon("http://dummy:8000", "dummy-token")
    cwd = tmp_path / "proj"
    cwd.mkdir()
    (cwd / "chart.png").write_bytes(PNG)
    d.agents["ag1"] = {
        "cwd": str(cwd),
        "original_project_dir": str(cwd),
        "chat": {"root": str(tmp_path / "config"), "session_id": None, "reader": None},
    }
    d.sio.connected = True
    d.sio.emit = AsyncMock()
    return d


def run_chat_once(d, monkeypatch):
    """Runs one pass of ``watch_chats``."""

    async def stop(_):
        d.running = False

    monkeypatch.setattr("agent.host_daemon.asyncio.sleep", stop)
    d.running = True
    asyncio.run(d.watch_chats())


def test_daemon_switches_to_the_session_telemetry_names(daemon, tmp_path, monkeypatch):
    chat = daemon.agents["ag1"]["chat"]
    daemon._note_chat_session("ag1", {"session.id": 42})
    daemon._note_chat_session("other", {"session.id": "x"})
    assert chat["session_id"] is None

    daemon._note_chat_session("ag1", {"session.id": "sess-0001"})
    run_chat_once(daemon, monkeypatch)  # transcript not written yet
    daemon.sio.emit.assert_not_awaited()

    folder = transcripts.project_folder(chat["root"], daemon.agents["ag1"]["cwd"])
    os.makedirs(folder)
    write(os.path.join(folder, "sess-0001.jsonl"), ENTRIES[1:2])
    run_chat_once(daemon, monkeypatch)
    event, payload = daemon.sio.emit.await_args.args
    assert event == "chat_messages"
    assert payload["replace"] is True
    assert [m["id"] for m in payload["messages"]] == ["u1"]

    with open(os.path.join(folder, "sess-0001.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(ENTRIES[3]) + "\n")
    run_chat_once(daemon, monkeypatch)
    payload = daemon.sio.emit.await_args.args[1]
    assert payload["replace"] is False
    assert [m["id"] for m in payload["messages"]] == ["a1"]


def test_read_media_serves_files_and_transcript_images(daemon, transcript):
    d = daemon
    answer = d.read_media("ag1", "chart.png", 1, 3)
    assert answer == {
        "ok": True,
        "mime": "image/png",
        "size": len(PNG),
        "data": PNG[1:4],
    }

    with pytest.raises(ValueError, match="Image not found"):
        d.read_media("ag1", "t:1:0", 0, 10)
    reader = transcripts.TranscriptReader(transcript)
    reader.read_new()
    d.agents["ag1"]["chat"]["reader"] = reader
    src = next(m for m in reader.messages if m["id"] == "p1")["blocks"][0]["src"]
    answer = d.read_media("ag1", src, 0, 10**9)
    assert answer["data"] == PNG and answer["mime"] == "image/png"

    with pytest.raises(ValueError, match="Session not found"):
        d.read_media("nope", "chart.png", 0, 1)
    with pytest.raises(ValueError, match="outside"):
        d.read_media("ag1", "/etc/hosts.png", 0, 1)
