"""Tests for Shortcut connections on the Tasks tab, against a fake Shortcut."""

import json
from datetime import date, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from backend.app.providers import shortcut
from backend.tests.conftest import client

pytestmark = pytest.mark.usefixtures("tasks_app")

TOKEN = "sc-token-xyz"


def story(sid, state=500, **fields):
    """A Shortcut story as the API returns it."""
    return {
        "id": sid,
        "name": f"Story {sid}",
        "description": "Do it",
        "workflow_id": 50,
        "workflow_state_id": state,
        "owner_ids": ["m-me"],
        "labels": [{"name": "web"}],
        "deadline": "2026-11-02T12:00:00Z",
        "updated_at": "2026-10-20T10:00:00Z",
        "app_url": f"https://app.shortcut.com/acme/story/{sid}",
        "custom_fields": [{"field_id": "f-pri", "value_id": "v-high", "value": "High"}],
        "group_id": "g-web",
        **fields,
    }


class FakeShortcut:
    """A tiny Shortcut workspace."""

    def __init__(self):
        self.stories = {1: story(1), 2: story(2, 501), 3: story(3, 502)}
        self.queries = []
        self.comments = {
            1: [
                {
                    "id": 9,
                    "author_id": "m-ana",
                    "text": "Hi",
                    "created_at": "2026-10-19T00:00:00Z",
                    "deleted": False,
                },
                {
                    "id": 8,
                    "author_id": "m-ana",
                    "text": "gone",
                    "created_at": "2026-10-18T00:00:00Z",
                    "deleted": True,
                },
            ]
        }
        self.created = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("Shortcut-Token") != TOKEN:
            return httpx.Response(401, json={"message": "Unauthorized"})
        path = request.url.path.removeprefix("/api/v3")
        method = request.method
        if path == "/member":
            return httpx.Response(
                200,
                json={
                    "id": "m-me",
                    "name": "Me Myself",
                    "mention_name": "me",
                    "workspace2": {"url_slug": "acme"},
                },
            )
        if path == "/workflows":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 50,
                        "name": "Engineering",
                        "default_state_id": 500,
                        "states": [
                            {"id": 499, "name": "Backlog", "type": "backlog"},
                            {"id": 500, "name": "Ready", "type": "unstarted"},
                            {"id": 501, "name": "In Review", "type": "started"},
                            {"id": 502, "name": "Shipped", "type": "done"},
                        ],
                    }
                ],
            )
        if path == "/members":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "m-me",
                        "disabled": False,
                        "profile": {
                            "name": "Me Myself",
                            "mention_name": "me",
                            "email_address": "me@x.io",
                            "deactivated": False,
                        },
                    },
                    {
                        "id": "m-ana",
                        "disabled": False,
                        "profile": {
                            "name": "Ana",
                            "mention_name": "ana",
                            "email_address": "ana@x.io",
                            "deactivated": False,
                        },
                    },
                    {
                        "id": "m-old",
                        "disabled": True,
                        "profile": {
                            "name": "Ana Old",
                            "mention_name": "anaold",
                            "email_address": "",
                            "deactivated": True,
                        },
                    },
                ],
            )
        if path == "/groups":
            return httpx.Response(
                200,
                json=[{"id": "g-web", "name": "Web"}, {"id": "g-api", "name": "API"}],
            )
        if path == "/custom-fields":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "f-pri",
                        "canonical_name": "priority",
                        "enabled": True,
                        "values": [{"id": "v-high", "value": "High"}],
                    }
                ],
            )
        if path == "/search/stories":
            params = parse_qs(urlparse(str(request.url)).query)
            query = params["query"][0]
            if "next" not in params:
                self.queries.append(query)
            if "BROKEN" in query:
                return httpx.Response(400, json={"message": "Bad query"})
            done = "is:done" in query and "!is:done" not in query
            ids = [
                i
                for i, s in self.stories.items()
                if (s["workflow_state_id"] == 502) == done
            ]
            if "next" in params:
                return httpx.Response(
                    200,
                    json={
                        "data": [self.stories[i] for i in ids[1:]],
                        "next": None,
                        "total": len(ids),
                    },
                )
            nxt = "/api/v3/search/stories?query=x&next=p2" if len(ids) > 1 else None
            return httpx.Response(
                200,
                json={
                    "data": [self.stories[i] for i in ids[:1]],
                    "next": nxt,
                    "total": len(ids),
                },
            )
        if path == "/stories" and method == "POST":
            body = json.loads(request.content)
            self.created.append(body)
            new = story(
                len(self.stories) + 1, body["workflow_state_id"], name=body["name"]
            )
            self.stories[new["id"]] = new
            return httpx.Response(201, json=new)
        if path.startswith("/stories/"):
            parts = path.split("/")
            sid = int(parts[2])
            if len(parts) == 4 and parts[3] == "comments":
                if method == "POST":
                    text = json.loads(request.content)["text"]
                    c = {
                        "id": 10,
                        "author_id": "m-me",
                        "text": text,
                        "created_at": "2026-10-21T00:00:00Z",
                        "deleted": False,
                    }
                    self.comments.setdefault(sid, []).append(c)
                    return httpx.Response(201, json=c)
                return httpx.Response(200, json=self.comments.get(sid, []))
            if method == "PUT":
                self.stories[sid].update(json.loads(request.content))
            return httpx.Response(200, json=self.stories[sid])
        return httpx.Response(404)


@pytest.fixture
def fake_shortcut(tracker):
    server = FakeShortcut()
    tracker.handler = server
    return server


def connect(token=TOKEN):
    return client.post(
        "/tasks/connections",
        json={"provider": "shortcut", "name": "Acme", "config": {}, "secret": token},
    )


def test_connect_and_read_stories(fake_shortcut):
    created = connect()
    assert created.status_code == 200, created.text
    conn = created.json()
    assert conn["config"] == {"account": "Me Myself"}
    assert conn["task_count"] == 3
    since = (date.today() - timedelta(days=14)).isoformat()
    assert fake_shortcut.queries == [
        "!is:archived owner:me !is:done",
        f"!is:archived owner:me is:done completed:{since}..*",
    ]
    board = {t["key"]: t for t in client.get("/tasks").json()}
    assert set(board) == {"sc-1", "sc-2", "sc-3"}
    one = board["sc-1"]
    assert one["id"] == f"shortcut:{conn['id']}:1"
    assert one["column"] == "todo"
    assert one["status"] == "Ready"
    assert one["priority"] == "high"
    assert one["due_date"] == "2026-11-02"
    assert one["assignee"] == "Me Myself"
    assert one["tags"] == ["web"]
    # A started state named like a review goes to "In review".
    assert board["sc-2"]["column"] == "review"
    assert board["sc-3"]["column"] == "done"
    assert TOKEN not in created.text


def test_bad_token_is_refused(fake_shortcut):
    response = connect(token="nope")
    assert response.status_code == 400
    assert "Shortcut rejected the credentials" in response.json()["detail"]


def test_status_change_sets_workflow_state(fake_shortcut):
    conn = connect().json()
    task_id = f"shortcut:{conn['id']}:1"
    options = client.get(f"/tasks/{task_id}/statuses").json()
    assert [(o["name"], o["column"]) for o in options] == [
        ("Backlog", "todo"),
        ("In Review", "review"),
        ("Shipped", "done"),
    ]
    moved = client.post(f"/tasks/{task_id}/status", json={"status_id": "502"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["column"] == "done"
    assert fake_shortcut.stories[1]["workflow_state_id"] == 502


def test_filters_build_queries(fake_shortcut):
    conn = connect().json()
    url = f"/tasks/connections/{conn['id']}"
    client.patch(
        url,
        json={"filters": {"assignee": "unassigned", "projects": "Web", "done_days": 0}},
    )
    assert fake_shortcut.queries[-1] == "!is:archived !has:owner team:Web !is:done"
    saved = client.patch(url, json={"filters": {"query": "BROKEN"}}).json()
    assert "Bad query" in saved["last_error"]


def test_several_teams_are_filtered_by_group(fake_shortcut):
    fake_shortcut.stories[2]["group_id"] = "g-other"
    conn = connect().json()
    client.patch(
        f"/tasks/connections/{conn['id']}",
        json={"filters": {"projects": ["Web", "API"], "done_days": 0}},
    )
    keys = {t["key"] for t in client.get("/tasks").json()}
    assert keys == {"sc-1"}


def test_rate_limit_is_reported(fake_shortcut, tracker):
    connect()
    tracker.handler = lambda r: httpx.Response(429, headers={"Retry-After": "30"})
    client.post("/tasks/refresh", json={})
    error = client.get("/tasks/connections").json()[0]["last_error"]
    assert "rate limiting" in error and "30 seconds" in error


def test_comments_owner_and_create(fake_shortcut):
    conn = connect().json()
    task_id = f"shortcut:{conn['id']}:1"
    assert [c["body"] for c in client.get(f"/tasks/{task_id}/comments").json()] == [
        "Hi"
    ]
    added = client.post(f"/tasks/{task_id}/comments", json={"body": "Done soon"}).json()
    assert added == {
        "id": "10",
        "author": "Me Myself",
        "body": "Done soon",
        "created": "2026-10-21T00:00:00Z",
    }
    users = client.get(f"/tasks/{task_id}/users", params={"query": "ana"}).json()
    assert users == [{"id": "m-ana", "name": "Ana"}]
    moved = client.put(f"/tasks/{task_id}/assignee", json={"user_id": "m-ana"}).json()
    assert moved["assignee"] == "Ana"
    nobody = client.put(f"/tasks/{task_id}/assignee", json={"user_id": None}).json()
    assert nobody["assignee"] is None

    base = f"/tasks/connections/{conn['id']}"
    options = client.get(f"{base}/create-options").json()
    assert options["projects"] == [{"id": "50", "name": "Engineering"}]
    assert options["priorities"] == [{"id": "v-high", "name": "High"}]
    assert options["create_url"] == "https://app.shortcut.com/acme/stories/new"
    kinds = client.get(f"{base}/types", params={"project": "50"}).json()
    assert [k["id"] for k in kinds] == ["feature", "bug", "chore"]
    created = client.post(
        f"{base}/tasks",
        json={"project": "50", "type": "bug", "priority": "v-high", "title": "Crash"},
    )
    assert created.status_code == 200, created.text
    assert created.json()["title"] == "Crash"
    sent = fake_shortcut.created[-1]
    assert sent["workflow_state_id"] == 500
    assert sent["owner_ids"] == ["m-me"]
    assert sent["story_type"] == "bug"
    assert sent["custom_fields"] == [{"field_id": "f-pri", "value_id": "v-high"}]
    bad = client.post(f"{base}/tasks", json={"project": "99", "title": "X"})
    assert bad.status_code == 422


def test_build_queries_uses_custom_query():
    assert shortcut.build_queries({"query": "label:x"}, "me") == ["label:x"]
