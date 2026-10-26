"""Tests for marking a host offline when its daemon disconnects."""

import asyncio
from contextlib import asynccontextmanager

import pytest

from backend.app import models, socket
from backend.tests.conftest import TestingSessionLocal

pytestmark = pytest.mark.usefixtures("tasks_app")


@pytest.fixture
def host(monkeypatch):
    """An online host whose old daemon connection is ``sid-old``."""
    db = TestingSessionLocal()
    row = models.Host(name="h", host_token="tok", status="online")
    db.add(row)
    db.commit()
    host_id = row.id
    db.close()
    monkeypatch.setattr(socket.database, "SessionLocal", TestingSessionLocal)

    @asynccontextmanager
    async def session(sid, namespace=None):
        yield {"is_host": True, "host_id": host_id}

    monkeypatch.setattr(socket.sio, "session", session)
    return host_id


def _status(host_id):
    db = TestingSessionLocal()
    try:
        return db.get(models.Host, host_id).status
    finally:
        db.close()


def test_late_drop_of_old_connection_keeps_host_online(host, monkeypatch):
    """The daemon reconnected (``sid-new``) before the hub noticed
    that ``sid-old`` was gone: the host stays online."""
    monkeypatch.setitem(socket.host_sids, host, "sid-new")
    asyncio.run(socket.disconnect("sid-old"))
    assert _status(host) == "online"
    assert socket.host_sids[host] == "sid-new"


def test_drop_of_current_connection_marks_host_offline(host, monkeypatch):
    monkeypatch.setitem(socket.host_sids, host, "sid-old")
    asyncio.run(socket.disconnect("sid-old"))
    assert _status(host) == "offline"
    assert host not in socket.host_sids
