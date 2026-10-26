"""Shared fixtures for the Tasks and Git tab tests.

These tests use their own SQLite file and put back the
dependency overrides the other test modules installed, so test
modules can run in one pytest session in any order.
"""

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.app import git, providers, tasks
from backend.app.auth import get_current_user
from backend.app.database import Base, get_db
from backend.app.main import app, fastapi_app

engine = create_engine(
    "sqlite:///./test_tasks.db", connect_args={"check_same_thread": False}
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
client = TestClient(app)


def _db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


def login_as(email):
    """Makes the next requests come from ``email``."""
    fastapi_app.dependency_overrides[get_current_user] = lambda: {"email": email}


@pytest.fixture
def tasks_app(monkeypatch):
    """Fresh tables and a known user for one test; the other
    test modules' overrides are put back afterwards. Manual
    refreshes read every time (no cooldown)."""
    monkeypatch.setattr(tasks, "REFRESH_COOLDOWN", 0)
    monkeypatch.setattr(git, "REFRESH_COOLDOWN", 0)
    monkeypatch.setattr(git, "_retry_at", {})
    saved = dict(fastapi_app.dependency_overrides)
    Base.metadata.create_all(bind=engine)
    fastapi_app.dependency_overrides[get_db] = _db
    login_as("me@example.com")
    yield
    fastapi_app.dependency_overrides.clear()
    fastapi_app.dependency_overrides.update(saved)
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def tracker(monkeypatch):
    """Answers the trackers' HTTP requests with ``tracker.handler``.

    Tests set ``tracker.handler`` to a function taking an
    ``httpx.Request`` and returning an ``httpx.Response``; every
    request is kept in ``tracker.requests``.
    """

    class Tracker:
        handler = staticmethod(lambda request: httpx.Response(404))
        requests = []

    def handle(request):
        Tracker.requests.append(request)
        return Tracker.handler(request)

    monkeypatch.setattr(providers, "TRANSPORT", httpx.MockTransport(handle))
    return Tracker
