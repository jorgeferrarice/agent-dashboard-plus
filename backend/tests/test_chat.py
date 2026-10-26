"""Tests for the chat view's backend: relaying chat messages
between daemons and viewers, and serving images and videos."""

import asyncio

import pytest
import socketio

from backend.app import main, models, socket
from backend.tests.conftest import TestingSessionLocal, client

pytestmark = pytest.mark.usefixtures("tasks_app")

FILE = b"0123456789"


@pytest.fixture
def session(monkeypatch):
    """A session ``chat-1`` on a host whose daemon is ``sid-h``."""
    db = TestingSessionLocal()
    host = models.Host(name="h", host_token="tok", status="online")
    db.add(host)
    db.commit()
    db.add(models.Agent(agent_id="chat-1", host_id=host.id, status="active"))
    db.commit()
    host_id = host.id
    db.close()
    monkeypatch.setattr(socket.database, "SessionLocal", TestingSessionLocal)
    monkeypatch.setitem(socket.host_sids, host_id, "sid-h")
    return host_id


class Daemon:
    """Answers ``read_media`` calls from ``FILE`` and records them."""

    def __init__(self, answer=None):
        self.calls = []
        self.answer = answer

    async def __call__(self, event, data, **kwargs):
        self.calls.append((event, data, kwargs.get("to")))
        if self.answer is not None:
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer
        start, length = data["offset"], data["length"]
        return {
            "ok": True,
            "mime": "image/png",
            "size": len(FILE),
            "data": FILE[start : start + length],
        }


@pytest.fixture
def daemon(session, monkeypatch):
    fake = Daemon()
    monkeypatch.setattr(socket.sio, "call", fake)
    return fake


def media(src="shot.png", **headers):
    return client.get("/agents/chat-1/media", params={"src": src}, headers=headers)


def test_whole_file_is_assembled_from_pieces(daemon, monkeypatch):
    monkeypatch.setattr(main, "MEDIA_CHUNK_BYTES", 4)
    r = media()
    assert r.status_code == 200
    assert r.content == FILE
    assert r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]
    assert [c[1]["offset"] for c in daemon.calls] == [0, 4, 8]
    assert daemon.calls[0] == (
        "read_media",
        {"agent_id": "chat-1", "src": "shot.png", "offset": 0, "length": 4},
        "sid-h",
    )


@pytest.mark.parametrize("mime", ["application/pdf", "text/html"])
def test_documents_are_served_html_in_a_sandbox(session, monkeypatch, mime):
    """PDFs and HTML pages are served; a page runs its scripts,
    but never with the dashboard's origin."""
    answer = {"ok": True, "mime": mime, "size": 1, "data": b"%"}
    monkeypatch.setattr(socket.sio, "call", Daemon(answer))
    r = media("doc")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(mime)
    policy = r.headers["content-security-policy"]
    assert "sandbox" in policy and "allow-same-origin" not in policy
    assert ("allow-scripts" in policy) == (mime == "text/html")


def test_range_requests_get_one_piece(daemon):
    r = media(Range="bytes=2-5")
    assert r.status_code == 206
    assert r.content == b"2345"
    assert r.headers["content-range"] == "bytes 2-5/10"
    open_ended = media(Range="bytes=7-")
    assert open_ended.status_code == 206
    assert open_ended.headers["content-range"] == "bytes 7-9/10"
    assert media(Range="bytes=10-").status_code == 416
    assert media(Range="bytes=5-2").status_code == 416


@pytest.mark.parametrize(
    "answer, status",
    [
        ({"ok": False, "error": "The file is outside the session's folders."}, 404),
        ({"ok": True, "mime": "text/plain", "size": 1, "data": b"<"}, 502),
        ({"ok": True, "mime": "image/png", "size": 1, "data": "not bytes"}, 502),
        (socketio.exceptions.TimeoutError(), 504),
    ],
)
def test_daemon_failures(session, monkeypatch, answer, status):
    monkeypatch.setattr(socket.sio, "call", Daemon(answer))
    r = media()
    assert r.status_code == status
    if status == 404:
        assert r.json()["detail"] == "The file is outside the session's folders."


def test_too_large_unknown_offline_and_bad_src(daemon, session, monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 5)
    assert media().status_code == 413
    assert media(src="").status_code == 422
    assert media(src="x" * 5000).status_code == 422
    assert client.get("/agents/nope/media", params={"src": "a.png"}).status_code == 404
    socket.host_sids.pop(session)
    assert media().status_code == 400


@pytest.fixture
def emitted(monkeypatch):
    """Records Socket.IO emits and room changes; ``host-sid`` is
    a daemon's connection, any other is a viewer's."""
    log = []

    async def emit(event, data, **kwargs):
        log.append((event, data, kwargs.get("to")))

    async def enter_room(sid, room, **kwargs):
        log.append(("enter", sid, room))

    async def leave_room(sid, room, **kwargs):
        log.append(("leave", sid, room))

    async def get_session(sid, **kwargs):
        return {"is_host": sid == "host-sid"}

    monkeypatch.setattr(socket.sio, "emit", emit)
    monkeypatch.setattr(socket.sio, "enter_room", enter_room)
    monkeypatch.setattr(socket.sio, "leave_room", leave_room)
    monkeypatch.setattr(socket.sio, "get_session", get_session)
    return log


def test_chat_join_asks_the_daemon_for_the_conversation(session, emitted):
    asyncio.run(socket.handle_chat_join("viewer", {"agent_id": "chat-1"}))
    assert emitted == [
        ("enter", "viewer", "chat:chat-1"),
        ("chat_history", {"agent_id": "chat-1", "requester": "viewer"}, "sid-h"),
    ]
    emitted.clear()
    asyncio.run(socket.handle_chat_leave("viewer", {"agent_id": "chat-1"}))
    assert emitted == [("leave", "viewer", "chat:chat-1")]


def test_chat_join_without_a_daemon_gets_an_empty_chat(session, emitted):
    socket.host_sids.pop(session)
    asyncio.run(socket.handle_chat_join("viewer", {"agent_id": "chat-1"}))
    assert emitted[-1] == (
        "chat_messages",
        {"agent_id": "chat-1", "messages": [], "replace": True},
        "viewer",
    )
    emitted.clear()
    asyncio.run(socket.handle_chat_join("viewer", {"agent_id": None}))
    assert emitted == []


def test_chat_messages_only_come_from_daemons(emitted):
    message = {"id": "u1", "role": "user", "blocks": []}
    asyncio.run(
        socket.handle_chat_messages(
            "viewer", {"agent_id": "chat-1", "messages": [message]}
        )
    )
    assert emitted == []
    asyncio.run(
        socket.handle_chat_messages(
            "host-sid", {"agent_id": "chat-1", "messages": [message]}
        )
    )
    asyncio.run(
        socket.handle_chat_messages(
            "host-sid",
            {
                "agent_id": "chat-1",
                "messages": [],
                "replace": True,
                "requester": "viewer",
            },
        )
    )
    assert emitted == [
        (
            "chat_messages",
            {"agent_id": "chat-1", "messages": [message], "replace": False},
            "chat:chat-1",
        ),
        (
            "chat_messages",
            {"agent_id": "chat-1", "messages": [], "replace": True},
            "viewer",
        ),
    ]
