import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from backend.app.main import fastapi_app, app
from backend.app.database import Base, get_db
from backend.app.auth import get_current_user

# Setup test database
SQLALCHEMY_DATABASE_URL = "sqlite:///./test.db"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def override_get_db():
    try:
        db = TestingSessionLocal()
        yield db
    finally:
        db.close()


fastapi_app.dependency_overrides[get_db] = override_get_db


def override_get_current_user():
    return {"email": "test@example.com", "name": "Test User"}


fastapi_app.dependency_overrides[get_current_user] = override_get_current_user

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_create_host():
    response = client.post(
        "/hosts", json={"name": "test-host", "host_token": "test-token"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "test-host"
    assert "id" in data


def test_read_hosts():
    response = client.get("/hosts")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    assert data[0]["name"] == "test-host"


def test_delete_host():
    r = client.post("/hosts", json={"name": "to-delete", "host_token": "del-token"})
    assert r.status_code == 200
    h_id = r.json()["id"]

    r_del = client.delete(f"/hosts/{h_id}")
    assert r_del.status_code == 200

    r_list = client.get("/hosts")
    assert not any(h["id"] == h_id for h in r_list.json())


def test_read_agents():
    response = client.get("/agents")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_update_task_description():
    """Test updating an agent's task description via
    PATCH endpoint.
    """
    # Create a host and spawn an agent to get a valid
    # agent record
    r_host = client.post(
        "/hosts",
        json={
            "name": "desc-host",
            "host_token": "desc-token",
        },
    )
    host_id = r_host.json()["id"]
    # Mark host online so spawn succeeds
    from backend.app import models

    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r_spawn = client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "bash",
        },
    )
    assert r_spawn.status_code == 200
    agent_id = r_spawn.json()["agent_id"]

    # Update task description
    r_patch = client.patch(
        f"/agents/{agent_id}/task-description",
        json={"task_description": "Fix the login bug"},
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["status"] == "updated"

    # Verify it persisted
    r_detail = client.get(f"/agents/{agent_id}/details")
    assert r_detail.status_code == 200
    tel = r_detail.json()["telemetry"]
    assert tel["task_description"] == "Fix the login bug"

    # Update again to verify overwrite
    r_patch2 = client.patch(
        f"/agents/{agent_id}/task-description",
        json={"task_description": "Refactor auth module"},
    )
    assert r_patch2.status_code == 200
    r_detail2 = client.get(f"/agents/{agent_id}/details")
    tel2 = r_detail2.json()["telemetry"]
    assert tel2["task_description"] == "Refactor auth module"

    # 404 for non-existent agent
    r_missing = client.patch(
        "/agents/nonexistent/task-description",
        json={"task_description": "nope"},
    )
    assert r_missing.status_code == 404


def test_update_session_name():
    """Renaming a session sets, trims and clears its name."""
    r_host = client.post(
        "/hosts",
        json={"name": "rename-host", "host_token": "rename-token"},
    )
    host_id = r_host.json()["id"]
    from backend.app import models

    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r_spawn = client.post(
        "/agents/spawn",
        json={"host_id": host_id, "tool_name": "bash", "session_name": "old"},
    )
    agent_id = r_spawn.json()["agent_id"]

    def name():
        r = client.get(f"/agents/{agent_id}/details")
        return r.json()["telemetry"]["session_name"]

    url = f"/agents/{agent_id}/session-name"
    assert client.patch(url, json={"session_name": "  api work "}).status_code == 200
    assert name() == "api work"

    # Blank clears the name.
    assert client.patch(url, json={"session_name": "  "}).status_code == 200
    assert name() is None

    assert client.patch(url, json={"session_name": "x" * 61}).status_code == 422
    r_missing = client.patch(
        "/agents/nonexistent/session-name", json={"session_name": "nope"}
    )
    assert r_missing.status_code == 404


def test_spawn_agent_host_offline():
    """Spawning on an offline host returns 400."""
    r_host = client.post(
        "/hosts",
        json={"name": "offline-host", "host_token": "off-token"},
    )
    host_id = r_host.json()["id"]
    # Host defaults to 'offline' status
    r = client.post(
        "/agents/spawn",
        json={"host_id": host_id, "tool_name": "bash"},
    )
    assert r.status_code == 400


def test_spawn_agent_host_not_found():
    """Spawning on a nonexistent host returns 400."""
    r = client.post(
        "/agents/spawn",
        json={"host_id": 99999, "tool_name": "bash"},
    )
    assert r.status_code == 400


def test_spawn_agent_with_task():
    """Verify telemetry_json persists project_dir and task."""
    from backend.app import models

    r_host = client.post(
        "/hosts",
        json={"name": "task-host", "host_token": "task-token"},
    )
    host_id = r_host.json()["id"]
    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r = client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "claude",
            "project_dir": "/git/myproject",
            "task_description": "Fix the bug",
            "session_name": "  login fix ",
        },
    )
    assert r.status_code == 200
    agent_id = r.json()["agent_id"]

    r_detail = client.get(f"/agents/{agent_id}/details")
    tel = r_detail.json()["telemetry"]
    assert tel["project_dir"] == "/git/myproject"
    assert tel["task_description"] == "Fix the bug"
    assert tel["session_name"] == "login fix"


def test_stop_agent():
    """Spawn then stop an agent, verify status=closed."""
    from backend.app import models

    r_host = client.post(
        "/hosts",
        json={"name": "stop-host", "host_token": "stop-token"},
    )
    host_id = r_host.json()["id"]
    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r_spawn = client.post(
        "/agents/spawn",
        json={"host_id": host_id, "tool_name": "bash"},
    )
    agent_id = r_spawn.json()["agent_id"]

    r_stop = client.post(f"/agents/{agent_id}/stop")
    assert r_stop.status_code == 200


def test_stop_agent_not_found():
    """Stopping a nonexistent agent returns 404."""
    r = client.post("/agents/nonexistent-id/stop")
    assert r.status_code == 404


def test_stop_agent_already_closed():
    """Stopping an already-closed agent is idempotent."""
    from backend.app import models

    r_host = client.post(
        "/hosts",
        json={
            "name": "idempotent-host",
            "host_token": "idem-token",
        },
    )
    host_id = r_host.json()["id"]
    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r_spawn = client.post(
        "/agents/spawn",
        json={"host_id": host_id, "tool_name": "bash"},
    )
    agent_id = r_spawn.json()["agent_id"]
    client.post(f"/agents/{agent_id}/stop")

    # Stop again — should be idempotent
    r2 = client.post(f"/agents/{agent_id}/stop")
    assert r2.status_code == 200
    assert r2.json()["status"] == "already stopped"


def test_get_agent_details_not_found():
    """Getting details for a nonexistent agent returns 404."""
    r = client.get("/agents/nonexistent-id/details")
    assert r.status_code == 404


def test_get_companions_with_match():
    """Two active agents on same host+project are companions."""
    from backend.app import models

    r_host = client.post(
        "/hosts",
        json={
            "name": "companion-host",
            "host_token": "comp-token",
        },
    )
    host_id = r_host.json()["id"]
    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r1 = client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "claude",
            "project_dir": "/git/shared",
        },
    )
    r2 = client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "gemini",
            "project_dir": "/git/shared",
        },
    )
    aid1 = r1.json()["agent_id"]
    aid2 = r2.json()["agent_id"]

    companions = client.get(f"/agents/{aid1}/companions")
    assert companions.status_code == 200
    companion_ids = [a["agent_id"] for a in companions.json()]
    assert aid2 in companion_ids


def test_get_companions_no_match():
    """Agents on different projects are not companions."""
    from backend.app import models

    r_host = client.post(
        "/hosts",
        json={
            "name": "nocomp-host",
            "host_token": "nocomp-token",
        },
    )
    host_id = r_host.json()["id"]
    db = next(override_get_db())
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    host.status = "online"
    db.commit()
    db.close()

    r1 = client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "claude",
            "project_dir": "/git/project-a",
        },
    )
    client.post(
        "/agents/spawn",
        json={
            "host_id": host_id,
            "tool_name": "gemini",
            "project_dir": "/git/project-b",
        },
    )
    aid1 = r1.json()["agent_id"]

    companions = client.get(f"/agents/{aid1}/companions")
    assert companions.status_code == 200
    assert len(companions.json()) == 0


def test_get_companions_not_found():
    """Getting companions for a nonexistent agent returns 404."""
    r = client.get("/agents/nonexistent-id/companions")
    assert r.status_code == 404


def test_read_agents_status_filter():
    """Filtering agents by status=active works."""
    r = client.get("/agents?status=active")
    assert r.status_code == 200
    for agent in r.json():
        assert agent["status"] == "active"


def test_delete_host_not_found():
    """Deleting a nonexistent host returns 404."""
    r = client.delete("/hosts/99999")
    assert r.status_code == 404


def test_cors_preflight():
    """Test that the OPTIONS preflight request is properly handled by CORSMiddleware."""
    headers = {
        "Origin": "http://localhost:8080",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
    }
    response = client.options("/hosts", headers=headers)
    assert response.status_code == 200
    assert (
        response.headers.get("access-control-allow-origin") == "http://localhost:8080"
    )
    assert response.headers.get("access-control-allow-credentials") == "true"


def test_cors_get_request():
    """Test that a GET request returns the proper CORS headers."""
    headers = {
        "Origin": "http://localhost:8080",
    }
    response = client.get("/hosts", headers=headers)
    assert response.status_code == 200
    assert "access-control-allow-origin" in response.headers
    assert (
        response.headers.get("access-control-allow-origin") == "http://localhost:8080"
    )
    assert response.headers.get("access-control-allow-credentials") == "true"


def _online_host(name):
    """Creates a host, marks it online and returns its ID."""
    from backend.app import models

    host_id = client.post(
        "/hosts", json={"name": name, "host_token": f"{name}-token"}
    ).json()["id"]
    db = next(override_get_db())
    db.query(models.Host).filter(models.Host.id == host_id).update({"status": "online"})
    db.commit()
    db.close()
    return host_id


def test_upload_file_relays_to_daemon(monkeypatch):
    """A dropped file reaches the session's daemon; failures map to HTTP."""
    from backend.app import main, models, socket

    host_id = _online_host("upload-host")
    db = TestingSessionLocal()
    db.add(models.Agent(agent_id="up-1", host_id=host_id, status="active"))
    db.commit()
    db.close()
    files = {"file": ("shot.png", b"png-bytes")}

    r = client.post("/agents/missing/files", files=files)
    assert r.status_code == 404
    r = client.post("/agents/up-1/files", files=files)
    assert r.status_code == 400  # no daemon connected

    monkeypatch.setitem(socket.host_sids, host_id, "sid-1")
    answers = iter(
        [
            {"ok": True, "path": "/tmp/agent-dashboard-uploads/up-1/shot.png"},
            {"ok": False, "error": "Invalid file name."},
        ]
    )
    sent = []

    async def fake_call(event, data, **kwargs):
        sent.append((event, data, kwargs.get("to")))
        return next(answers)

    monkeypatch.setattr(socket.sio, "call", fake_call)

    r = client.post("/agents/up-1/files", files=files)
    assert r.status_code == 200
    assert r.json() == {"path": "/tmp/agent-dashboard-uploads/up-1/shot.png"}
    assert sent == [
        (
            "upload_file",
            {"agent_id": "up-1", "name": "shot.png", "data": b"png-bytes"},
            "sid-1",
        )
    ]

    r = client.post("/agents/up-1/files", files=files)
    assert r.status_code == 400
    assert r.json()["detail"] == "Invalid file name."

    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 4)
    r = client.post("/agents/up-1/files", files=files)
    assert r.status_code == 413
    assert len(sent) == 2


def test_create_project_host_offline():
    """Creating a folder on a host with no daemon connected returns 400."""
    host_id = _online_host("folder-no-daemon")
    r = client.post(f"/hosts/{host_id}/projects", json={"name": "x"})
    assert r.status_code == 400


def test_create_project_relays_daemon_answer(monkeypatch):
    """The daemon's path is returned, and its refusal becomes a 400."""
    from backend.app import socket

    host_id = _online_host("folder-host")
    monkeypatch.setitem(socket.host_sids, host_id, "sid-1")
    answers = iter(
        [
            {"ok": True, "path": "/home/u/git/x"},
            {"ok": False, "error": "A folder with that name already exists."},
        ]
    )
    sent = []

    async def fake_call(event, data, **kwargs):
        sent.append((event, data, kwargs.get("to")))
        return next(answers)

    monkeypatch.setattr(socket.sio, "call", fake_call)

    r = client.post(f"/hosts/{host_id}/projects", json={"name": "x", "git_init": True})
    assert r.status_code == 200
    assert r.json() == {"path": "/home/u/git/x"}
    assert sent == [("create_project", {"name": "x", "git_init": True}, "sid-1")]

    r = client.post(f"/hosts/{host_id}/projects", json={"name": "x"})
    assert r.status_code == 400
    assert r.json()["detail"] == "A folder with that name already exists."


def test_restart_host_daemon(monkeypatch):
    """Restart reaches only the host's daemon; offline hosts get a 400."""
    from backend.app import socket

    host_id = _online_host("restart-host")
    r = client.post(f"/hosts/{host_id}/restart")
    assert r.status_code == 400

    monkeypatch.setitem(socket.host_sids, host_id, "sid-3")
    sent = []

    async def fake_emit(event, data, **kwargs):
        sent.append((event, kwargs.get("to")))

    monkeypatch.setattr(socket.sio, "emit", fake_emit)
    r = client.post(f"/hosts/{host_id}/restart")
    assert r.status_code == 200
    assert sent == [("restart_daemon", "sid-3")]


def test_list_tool_models_relays_daemon_answer(monkeypatch):
    """The daemon's live model list is returned; a refusal becomes a 400."""
    from backend.app import socket

    host_id = _online_host("models-host")
    monkeypatch.setitem(socket.host_sids, host_id, "sid-2")
    answers = iter(
        [
            {
                "ok": True,
                "models": ["auto", "x"],
                "default_model": "auto",
            },
            {"ok": False, "error": "This tool has no model list."},
        ]
    )
    sent = []

    async def fake_call(event, data, **kwargs):
        sent.append((event, data, kwargs.get("to")))
        return next(answers)

    monkeypatch.setattr(socket.sio, "call", fake_call)

    r = client.get(f"/hosts/{host_id}/tools/router/models")
    assert r.status_code == 200
    assert r.json() == {
        "models": ["auto", "x"],
        "default_model": "auto",
        "error": None,
    }
    assert sent == [("list_models", {"tool": "router"}, "sid-2")]

    r = client.get(f"/hosts/{host_id}/tools/bash/models")
    assert r.status_code == 400
    assert r.json()["detail"] == "This tool has no model list."


def test_open_tabs_are_saved_per_user():
    """Open tabs round-trip in order and stay private to a user."""
    assert client.get("/me/tabs").json() == {"tabs": None}

    saved = client.put("/me/tabs", json={"tabs": ["b", "a", "b", "c"]})
    assert saved.status_code == 200
    # Order is kept; a repeated ID is dropped.
    assert saved.json() == {"tabs": ["b", "a", "c"]}
    assert client.get("/me/tabs").json() == {"tabs": ["b", "a", "c"]}

    # Closing every tab is remembered as an empty list.
    client.put("/me/tabs", json={"tabs": []})
    assert client.get("/me/tabs").json() == {"tabs": []}
    client.put("/me/tabs", json={"tabs": ["a"]})

    assert client.put("/me/tabs", json={"tabs": ["x" * 201]}).status_code == 422

    fastapi_app.dependency_overrides[get_current_user] = lambda: {
        "email": "other@example.com"
    }
    try:
        assert client.get("/me/tabs").json() == {"tabs": None}
        client.put("/me/tabs", json={"tabs": ["z"]})
    finally:
        fastapi_app.dependency_overrides[get_current_user] = override_get_current_user
    assert client.get("/me/tabs").json() == {"tabs": ["a"]}


def test_tool_settings_disable_rename_and_cascade():
    """A tool can be renamed and disabled per host; a disabled
    tool cannot be spawned; deleting the host drops the rows."""
    from backend.app import models

    host = client.post(
        "/hosts", json={"name": "settings-host", "host_token": "settings-token"}
    ).json()
    hid = host["id"]
    assert host["tool_settings"] == []
    db = TestingSessionLocal()
    db.query(models.Host).filter(models.Host.id == hid).update({"status": "online"})
    db.commit()
    db.close()

    url = f"/hosts/{hid}/tools/claude-work/settings"
    assert client.put(url, json={"label": "  Trabalho "}).json() == [
        {"tool": "claude-work", "enabled": True, "label": "Trabalho"}
    ]
    # Fields left out keep their value; blank restores the default.
    assert client.put(url, json={"enabled": False}).json() == [
        {"tool": "claude-work", "enabled": False, "label": "Trabalho"}
    ]
    assert client.put(url, json={"label": ""}).json()[0]["label"] is None
    assert client.put(url, json={"label": "x" * 41}).status_code == 422
    assert client.put("/hosts/99999/tools/claude/settings", json={}).status_code == 404

    listed = [h for h in client.get("/hosts").json() if h["id"] == hid][0]
    assert listed["tool_settings"] == [
        {"tool": "claude-work", "enabled": False, "label": None}
    ]

    refused = client.post(
        "/agents/spawn", json={"host_id": hid, "tool_name": "claude-work"}
    )
    assert refused.status_code == 403
    assert "disabled" in refused.json()["detail"]
    # Another tool on the same host, and the same tool once
    # enabled again, still start.
    assert (
        client.post(
            "/agents/spawn", json={"host_id": hid, "tool_name": "bash"}
        ).status_code
        == 200
    )
    client.put(url, json={"enabled": True})
    assert (
        client.post(
            "/agents/spawn", json={"host_id": hid, "tool_name": "claude-work"}
        ).status_code
        == 200
    )

    assert client.delete(f"/hosts/{hid}").status_code == 200
    db = TestingSessionLocal()
    try:
        assert (
            db.query(models.HostToolSetting)
            .filter(models.HostToolSetting.host_id == hid)
            .count()
            == 0
        )
    finally:
        db.close()


def test_allowed_emails_limits_oidc_users(monkeypatch):
    """ALLOWED_EMAILS admits only the listed accounts, any case."""
    from backend.app import auth

    monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
    assert auth.is_allowed({"email": "anyone@gmail.com"})
    assert not auth.is_allowed(None)

    monkeypatch.setenv("ALLOWED_EMAILS", "me@example.com, Friend@Example.com")
    assert auth.is_allowed({"email": "ME@example.com"})
    assert auth.is_allowed({"email": "friend@example.com"})
    assert not auth.is_allowed({"email": "stranger@gmail.com"})
    assert not auth.is_allowed({})


def test_socket_ui_client_needs_allowed_email(monkeypatch):
    """A UI socket connects only with a session of an allowed user."""
    import asyncio
    import base64
    import json

    from itsdangerous import TimestampSigner

    from backend.app import socket

    monkeypatch.delenv("BYPASS_AUTH", raising=False)
    monkeypatch.setenv("SECRET_KEY", "test-key")
    monkeypatch.setenv("ALLOWED_EMAILS", "me@example.com")

    def environ_for(email):
        data = base64.b64encode(json.dumps({"user": {"email": email}}).encode())
        cookie = TimestampSigner("test-key").sign(data).decode()
        headers = [(b"cookie", f"session={cookie}".encode())]
        return {"asgi.scope": {"headers": headers}}

    async def connect(environ):
        return await socket.connect("sid-ui", environ, None)

    assert asyncio.run(connect(environ_for("me@example.com"))) is True
    assert asyncio.run(connect(environ_for("stranger@gmail.com"))) is False
    assert asyncio.run(connect({"asgi.scope": {"headers": []}})) is False
