"""Tests for the Tasks tab API (local tasks and status changes)."""

import pytest

from backend.tests.conftest import client, login_as

pytestmark = pytest.mark.usefixtures("tasks_app")


def test_create_and_list_local_task():
    created = client.post(
        "/tasks/local", json={"title": "  Write docs ", "description": "All of it"}
    )
    assert created.status_code == 200
    task = created.json()
    assert task["id"].startswith("local:")
    assert task["source"] == "local"
    assert task["title"] == "Write docs"
    assert task["column"] == "todo"
    assert client.get("/tasks").json() == [task]


def test_blank_title_is_rejected():
    assert client.post("/tasks/local", json={"title": "   "}).status_code == 422


def test_tasks_are_private_to_their_owner():
    task = client.post("/tasks/local", json={"title": "Mine"}).json()
    number = task["id"].split(":")[1]
    login_as("other@example.com")
    assert client.get("/tasks").json() == []
    assert (
        client.patch(f"/tasks/local/{number}", json={"title": "x"}).status_code == 404
    )
    assert client.get(f"/tasks/{task['id']}/statuses").status_code == 404
    assert client.delete(f"/tasks/local/{number}").status_code == 404
    login_as("me@example.com")
    assert [t["title"] for t in client.get("/tasks").json()] == ["Mine"]


def test_status_change_moves_column():
    task = client.post("/tasks/local", json={"title": "Move me"}).json()
    options = client.get(f"/tasks/{task['id']}/statuses").json()
    assert [o["column"] for o in options] == ["todo", "in_progress", "review", "done"]
    moved = client.post(f"/tasks/{task['id']}/status", json={"status_id": "review"})
    assert moved.status_code == 200
    assert moved.json()["column"] == "review"
    bad = client.post(f"/tasks/{task['id']}/status", json={"status_id": "nope"})
    assert bad.status_code == 422


def test_update_fields_and_delete():
    task = client.post(
        "/tasks/local",
        json={"title": "T", "priority": "high", "due_date": "2026-11-01"},
    ).json()
    number = task["id"].split(":")[1]
    changed = client.patch(
        f"/tasks/local/{number}",
        json={"tags": [" a ", "b", "a", ""], "priority": None},
    ).json()
    assert changed["tags"] == ["a", "b"]
    assert changed["priority"] is None
    # Fields left out keep their value.
    assert changed["due_date"] == "2026-11-01"
    assert client.delete(f"/tasks/local/{number}").json() == {"ok": True}
    assert client.get("/tasks").json() == []


def test_unknown_task_id_is_not_found():
    assert client.get("/tasks/nope:1/statuses").status_code == 404
    assert client.get("/tasks/local:abc/statuses").status_code == 404


def test_invalid_fields_are_rejected():
    base = {"title": "T"}
    assert (
        client.post("/tasks/local", json={**base, "priority": "huge"}).status_code
        == 422
    )
    assert (
        client.post("/tasks/local", json={**base, "due_date": "soon"}).status_code
        == 422
    )
    many = [f"t{i}" for i in range(21)]
    assert client.post("/tasks/local", json={**base, "tags": many}).status_code == 422
    long_tag = ["x" * 41]
    assert (
        client.post("/tasks/local", json={**base, "tags": long_tag}).status_code == 422
    )


def test_language_preference_follows_the_user():
    assert client.get("/me/preferences").json() == {"language": None}
    assert client.put("/me/preferences", json={"language": "en"}).status_code == 200
    assert client.get("/me/preferences").json() == {"language": "en"}
    assert client.put("/me/preferences", json={"language": "fr"}).status_code == 422
    login_as("other@example.com")
    assert client.get("/me/preferences").json() == {"language": None}
