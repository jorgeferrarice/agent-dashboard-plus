"""Tests for Jira connections on the Tasks tab, against a fake Jira."""

import asyncio
import base64
import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app import models
from backend.app import tasks as tasks_module
from backend.app.providers import jira
from backend.tests.conftest import TestingSessionLocal, client, login_as

pytestmark = pytest.mark.usefixtures("tasks_app")

SITE = "https://team.atlassian.net"
TOKEN = "secret-jira-token-123"


def issue(key, status="To Do", category="new", **fields):
    """A Jira issue as /search/jql returns it."""
    return {
        "key": key,
        "fields": {
            "summary": f"Issue {key}",
            "status": {"name": status, "statusCategory": {"key": category}},
            "priority": {"name": "Highest"},
            "duedate": "2026-11-01",
            "labels": ["backend"],
            "assignee": {"displayName": "Me Myself"},
            "updated": "2026-10-20T10:00:00.000+0000",
            "description": {
                "type": "doc",
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]}
                ],
            },
            **fields,
        },
    }


class FakeJira:
    """A tiny Jira Cloud: one user, some issues, two transitions."""

    def __init__(self):
        self.issues = {
            "P-1": issue("P-1"),
            "P-2": issue("P-2", "Code Review", "indeterminate"),
            "P-3": issue("P-3", "In Progress", "indeterminate"),
        }
        self.jql = []
        # Fields the "Done" transition requires, when set.
        self.done_fields = {}
        self.posted = []
        self.created = []
        self.comments = [
            {
                "id": "10",
                "author": {"displayName": "Ana"},
                "created": "2026-10-20T10:00:00.000+0000",
                "body": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "First!"}],
                        }
                    ],
                },
            }
        ]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("Authorization", "")
        expected = base64.b64encode(f"me@example.com:{TOKEN}".encode()).decode()
        if auth != f"Basic {expected}":
            return httpx.Response(401, json={"errorMessages": ["bad auth"]})
        path = request.url.path
        if path == "/rest/api/3/myself":
            return httpx.Response(
                200, json={"displayName": "Me Myself", "accountId": "acc-me"}
            )
        if path == "/rest/api/3/project/search":
            return httpx.Response(
                200,
                json={
                    "values": [
                        {"key": "P", "name": "Platform"},
                        {"key": "STRICT", "name": "Strict"},
                    ]
                },
            )
        if path == "/rest/api/3/priority/search":
            return httpx.Response(
                200, json={"values": [{"id": "1", "name": "Highest"}]}
            )
        if path.startswith("/rest/api/3/issue/createmeta/"):
            return httpx.Response(
                200,
                json={
                    "issueTypes": [
                        {"id": "5", "name": "Sub-task", "subtask": True},
                        {"id": "10", "name": "Task", "subtask": False},
                        {"id": "11", "name": "Bug", "subtask": False},
                    ]
                },
            )
        if path == "/rest/api/3/issue" and request.method == "POST":
            fields = json.loads(request.content)["fields"]
            self.created.append(fields)
            if fields["project"]["key"] == "STRICT":
                return httpx.Response(
                    400, json={"errors": {"customfield_9": "Team is required."}}
                )
            key = f"P-{len(self.issues) + 1}"
            self.issues[key] = issue(key, summary=fields["summary"])
            return httpx.Response(201, json={"id": "100", "key": key})
        if path == "/rest/api/3/search/jql":
            body = json.loads(request.content)
            self.jql.append(body["jql"])
            if "BROKEN" in body["jql"]:
                return httpx.Response(
                    400, json={"errorMessages": ["Error in the JQL Query: BROKEN"]}
                )
            keys = sorted(self.issues)
            # Two pages, to exercise nextPageToken.
            if body.get("nextPageToken") == "page2":
                return httpx.Response(
                    200,
                    json={"issues": [self.issues[k] for k in keys[2:]], "isLast": True},
                )
            return httpx.Response(
                200,
                json={
                    "issues": [self.issues[k] for k in keys[:2]],
                    "nextPageToken": "page2",
                    "isLast": False,
                },
            )
        if path == "/rest/api/3/user/assignable/search":
            assert request.url.params["issueKey"]
            return httpx.Response(
                200,
                json=[
                    {"accountId": "acc-1", "displayName": "Ana"},
                    {"accountId": "acc-2", "displayName": "Bruno"},
                ],
            )
        key = path.split("/")[5] if path.startswith("/rest/api/3/issue/") else None
        if key and path.endswith("/comment"):
            if request.method == "POST":
                body = json.loads(request.content)["body"]
                comment = {
                    "id": str(11 + len(self.comments)),
                    "author": {"displayName": "Me Myself"},
                    "created": "2026-10-21T10:00:00.000+0000",
                    "body": body,
                }
                self.comments.append(comment)
                return httpx.Response(201, json=comment)
            assert request.url.params["orderBy"] == "-created"
            return httpx.Response(200, json={"comments": self.comments[::-1]})
        if key and path.endswith("/assignee"):
            account = json.loads(request.content)["accountId"]
            if account == "forbidden":
                return httpx.Response(403, json={"errorMessages": ["no"]})
            names = {"acc-1": "Ana", None: None}
            self.issues[key]["fields"]["assignee"] = (
                {"displayName": names[account]} if account else None
            )
            return httpx.Response(204)
        if key and path.endswith("/transitions"):
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "transitions": [
                            {
                                "id": "31",
                                "name": "Finish",
                                "to": {
                                    "name": "Done",
                                    "statusCategory": {"key": "done"},
                                },
                                "fields": self.done_fields,
                            },
                            {
                                "id": "21",
                                "name": "Review it",
                                "to": {
                                    "name": "Code Review",
                                    "statusCategory": {"key": "indeterminate"},
                                },
                            },
                        ]
                    },
                )
            posted = json.loads(request.content)
            self.posted.append(posted)
            target = posted["transition"]["id"]
            name, category = {
                "31": ("Done", "done"),
                "21": ("Code Review", "indeterminate"),
            }[target]
            self.issues[key]["fields"]["status"] = {
                "name": name,
                "statusCategory": {"key": category},
            }
            return httpx.Response(204)
        if key:
            return httpx.Response(200, json=self.issues[key])
        return httpx.Response(404)


@pytest.fixture
def fake_jira(tracker):
    jira_server = FakeJira()
    tracker.handler = jira_server
    return jira_server


def connect(name="Work", token=TOKEN, site="team.atlassian.net/"):
    return client.post(
        "/tasks/connections",
        json={
            "provider": "jira",
            "name": name,
            "config": {"site": site, "email": "me@example.com"},
            "secret": token,
        },
    )


def test_connection_is_checked_saved_encrypted_and_synced(fake_jira):
    created = connect()
    assert created.status_code == 200, created.text
    conn = created.json()
    assert conn["config"] == {
        "site": SITE,
        "email": "me@example.com",
        "account": "Me Myself",
    }
    assert conn["task_count"] == 3
    assert conn["last_error"] is None
    # The token never comes back and is not stored in clear.
    assert TOKEN not in created.text
    db = TestingSessionLocal()
    row = db.get(models.TaskConnection, conn["id"])
    assert TOKEN not in row.secret_enc
    db.close()
    assert TOKEN not in client.get("/tasks/connections").text
    # The default filter is "assigned to me".
    assert "assignee = currentUser()" in fake_jira.jql[0]


def test_issues_appear_on_the_board_mapped_by_category(fake_jira):
    conn = connect().json()
    tasks = {t["key"]: t for t in client.get("/tasks").json()}
    assert set(tasks) == {"P-1", "P-2", "P-3"}
    one = tasks["P-1"]
    assert one["id"] == f"jira:{conn['id']}:P-1"
    assert one["source"] == "jira"
    assert one["connection_name"] == "Work"
    assert one["column"] == "todo"
    assert one["priority"] == "urgent"
    assert one["description"] == "Hi"
    assert one["url"] == f"{SITE}/browse/P-1"
    # A started status named like a review goes to "In review".
    assert tasks["P-2"]["column"] == "review"
    assert tasks["P-3"]["column"] == "in_progress"


def test_rejected_token_is_not_saved(fake_jira):
    response = connect(token="wrong")
    assert response.status_code == 400
    assert "rejected the credentials" in response.json()["detail"]
    assert client.get("/tasks/connections").json() == []


def test_site_must_be_https(fake_jira):
    response = connect(site="http://team.atlassian.net")
    assert response.status_code == 422


def test_failed_sync_keeps_cache_and_records_error(fake_jira, tracker, caplog):
    conn = connect().json()
    tracker.handler = lambda request: httpx.Response(503)
    with caplog.at_level(logging.WARNING):
        refreshed = client.post("/tasks/refresh", json={})
    assert refreshed.status_code == 200
    assert len(refreshed.json()) == 3
    listed = client.get("/tasks/connections").json()[0]
    assert listed["id"] == conn["id"]
    assert "HTTP 503" in listed["last_error"]
    assert TOKEN not in caplog.text


def test_status_change_uses_transitions(fake_jira):
    conn = connect().json()
    task_id = f"jira:{conn['id']}:P-1"
    options = client.get(f"/tasks/{task_id}/statuses").json()
    assert options == [
        {"id": "31", "name": "Done", "column": "done", "fields": []},
        {"id": "21", "name": "Code Review", "column": "review", "fields": []},
    ]
    moved = client.post(f"/tasks/{task_id}/status", json={"status_id": "31"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["column"] == "done"
    assert moved.json()["status"] == "Done"
    # The board shows the move without waiting for a sync.
    board = {t["key"]: t for t in client.get("/tasks").json()}
    assert board["P-1"]["column"] == "done"


def test_connections_are_private(fake_jira):
    conn = connect().json()
    login_as("other@example.com")
    assert client.get("/tasks/connections").json() == []
    assert client.get("/tasks").json() == []
    assert client.delete(f"/tasks/connections/{conn['id']}").status_code == 404
    assert client.get(f"/tasks/jira:{conn['id']}:P-1/statuses").status_code == 404


def test_rename_edit_and_delete_connection(fake_jira):
    conn = connect().json()
    renamed = client.patch(f"/tasks/connections/{conn['id']}", json={"name": "Job"})
    assert renamed.json()["name"] == "Job"
    # A wrong new token is refused and the old one kept.
    bad = client.patch(f"/tasks/connections/{conn['id']}", json={"secret": "nope"})
    assert bad.status_code == 400
    assert client.post("/tasks/refresh", json={}).status_code == 200
    assert client.get("/tasks/connections").json()[0]["last_error"] is None
    assert client.delete(f"/tasks/connections/{conn['id']}").json() == {"ok": True}
    assert client.get("/tasks").json() == []


def test_adf_to_text():
    doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "content": [{"type": "text", "text": "Title"}]},
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "a"},
                    {"type": "hardBreak"},
                    {"type": "mention", "attrs": {"text": "@Ana"}},
                ],
            },
            {
                "type": "bulletList",
                "content": [
                    {
                        "type": "listItem",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "x"}],
                            }
                        ],
                    }
                ],
            },
        ],
    }
    assert jira.adf_to_text(doc) == "Title\na\n@Ana\n- x"
    assert jira.adf_to_text(None) == ""
    assert jira.adf_to_text("plain") == "plain"


def _age(connection_id, minutes):
    """Pretends the connection was last read ``minutes`` ago."""
    db = TestingSessionLocal()
    row = db.get(models.TaskConnection, connection_id)
    row.last_sync_at = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    db.commit()
    db.close()


def test_poller_reads_stale_connections_and_notifies(fake_jira, tracker, monkeypatch):
    monkeypatch.setattr(tasks_module.database, "SessionLocal", TestingSessionLocal)
    tasks_module._retry_at.clear()  # pylint: disable=protected-access
    conn = connect().json()
    notified = []

    async def notify(email):
        notified.append(email)

    # Just read: nothing is due.
    assert asyncio.run(tasks_module.sync_due(notify)) == 0
    _age(conn["id"], 11)
    # Due, but nothing changed: read without notifying.
    assert asyncio.run(tasks_module.sync_due(notify)) == 1
    assert notified == []

    fake_jira.issues["P-4"] = issue("P-4")
    _age(conn["id"], 11)
    assert asyncio.run(tasks_module.sync_due(notify)) == 1
    assert notified == ["me@example.com"]
    assert len(client.get("/tasks").json()) == 4


def test_poller_waits_when_rate_limited(fake_jira, tracker, monkeypatch):
    monkeypatch.setattr(tasks_module.database, "SessionLocal", TestingSessionLocal)
    tasks_module._retry_at.clear()  # pylint: disable=protected-access
    conn = connect().json()
    tracker.handler = lambda request: httpx.Response(
        429, headers={"Retry-After": "3600"}
    )
    _age(conn["id"], 11)

    async def notify(email):
        pass

    assert asyncio.run(tasks_module.sync_due(notify)) == 1
    assert "rate limiting" in client.get("/tasks/connections").json()[0]["last_error"]
    # Still stale, but the tracker asked to wait an hour.
    _age(conn["id"], 11)
    assert asyncio.run(tasks_module.sync_due(notify)) == 0


def test_unexpected_answer_is_recorded_not_raised(fake_jira, tracker):
    connect()
    tracker.handler = lambda request: httpx.Response(200, json={"issues": [{}]})
    assert client.post("/tasks/refresh", json={}).status_code == 200
    error = client.get("/tasks/connections").json()[0]["last_error"]
    assert error == "Unexpected error while reading the tasks."


RESOLUTION = {
    "required": True,
    "name": "Resolution",
    "schema": {"type": "resolution", "system": "resolution"},
    "allowedValues": [{"id": "1", "name": "Fixed"}, {"id": "2", "name": "Won't do"}],
}


def test_transition_fields_are_offered_and_sent(fake_jira):
    fake_jira.done_fields = {
        "resolution": RESOLUTION,
        "customfield_1": {
            "required": True,
            "name": "Notes",
            "schema": {"type": "string", "custom": "x:textarea"},
        },
        "customfield_2": {
            "required": False,
            "name": "Optional",
            "schema": {"type": "string"},
        },
    }
    conn = connect().json()
    task_id = f"jira:{conn['id']}:P-1"
    done = client.get(f"/tasks/{task_id}/statuses").json()[0]
    assert done["fields"] == [
        {
            "id": "resolution",
            "name": "Resolution",
            "kind": "select",
            "options": [{"id": "1", "name": "Fixed"}, {"id": "2", "name": "Won't do"}],
        },
        {"id": "customfield_1", "name": "Notes", "kind": "richtext", "options": []},
    ]
    missing = client.post(f"/tasks/{task_id}/status", json={"status_id": "31"})
    assert missing.status_code == 422
    assert "Resolution is required" in missing.json()["detail"]
    bad = client.post(
        f"/tasks/{task_id}/status",
        json={
            "status_id": "31",
            "fields": {"resolution": "9", "customfield_1": "x"},
        },
    )
    assert bad.status_code == 422
    moved = client.post(
        f"/tasks/{task_id}/status",
        json={
            "status_id": "31",
            "fields": {"resolution": "1", "customfield_1": "line 1\nline 2"},
        },
    )
    assert moved.status_code == 200, moved.text
    sent = fake_jira.posted[-1]["fields"]
    assert sent["resolution"] == {"id": "1"}
    assert sent["customfield_1"]["type"] == "doc"
    assert len(sent["customfield_1"]["content"]) == 2


def test_field_kinds():
    assert jira.field_kind({"schema": {"type": "user"}}) == "user"
    assert jira.field_kind({"schema": {"type": "date"}}) == "date"
    assert jira.field_kind({"schema": {"type": "string"}}) == "text"
    assert (
        jira.field_kind({"schema": {"type": "array", "items": "version"}})
        == "multiselect"
    )
    assert jira.field_kind({"schema": {"type": "datetime"}}) == "unsupported"
    assert jira.field_kind({"schema": {"type": "array", "items": "user"}}) == (
        "unsupported"
    )


def test_search_users(fake_jira):
    conn = connect().json()
    found = client.get(f"/tasks/jira:{conn['id']}:P-1/users", params={"query": "a"})
    assert found.json() == [
        {"id": "acc-1", "name": "Ana"},
        {"id": "acc-2", "name": "Bruno"},
    ]
    assert client.get("/tasks/local:1/users").status_code == 404


def test_filters_change_the_query(fake_jira):
    conn = connect().json()
    url = f"/tasks/connections/{conn['id']}"
    saved = client.patch(
        url,
        json={"filters": {"assignee": "any", "projects": "WEB, API", "done_days": 0}},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["filters"] == {
        "assignee": "any",
        "projects": ["WEB", "API"],
        "done_days": 0,
        "query": "",
    }
    assert fake_jira.jql[-1] == (
        'project in ("WEB", "API") AND statusCategory != Done ORDER BY updated DESC'
    )
    assert client.patch(url, json={"filters": {"assignee": "boss"}}).status_code == 422
    assert client.patch(url, json={"filters": {"done_days": 99}}).status_code == 422


def test_advanced_query_errors_are_shown(fake_jira):
    conn = connect().json()
    saved = client.patch(
        f"/tasks/connections/{conn['id']}", json={"filters": {"query": "BROKEN"}}
    ).json()
    assert fake_jira.jql[-1] == "BROKEN"
    assert "Error in the JQL Query" in saved["last_error"]
    # The tasks read before stay on the board.
    assert len(client.get("/tasks").json()) == 3


def test_status_mapping_moves_cards_without_a_new_read(fake_jira):
    conn = connect().json()
    url = f"/tasks/connections/{conn['id']}"
    statuses = client.get(f"{url}/statuses").json()
    assert statuses == [
        {
            "name": "Code Review",
            "category": "in_progress",
            "auto_column": "review",
            "column": "review",
        },
        {
            "name": "In Progress",
            "category": "in_progress",
            "auto_column": "in_progress",
            "column": "in_progress",
        },
        {"name": "To Do", "category": "todo", "auto_column": "todo", "column": "todo"},
    ]
    reads = len(fake_jira.jql)
    saved = client.patch(url, json={"mapping": {"In Progress": "review"}})
    assert saved.json()["mapping"] == {"In Progress": "review"}
    board = {t["key"]: t for t in client.get("/tasks").json()}
    assert board["P-3"]["column"] == "review"
    assert len(fake_jira.jql) == reads
    by_name = {s["name"]: s for s in client.get(f"{url}/statuses").json()}
    assert by_name["In Progress"]["column"] == "review"
    assert by_name["In Progress"]["auto_column"] == "in_progress"
    # Transition options follow the mapping too.
    assert client.patch(url, json={"mapping": {"Done": "review"}}).status_code == 200
    options = client.get(f"/tasks/jira:{conn['id']}:P-1/statuses").json()
    assert options[0]["column"] == "review"
    # Bad columns are refused; an empty mapping resets.
    assert client.patch(url, json={"mapping": {"X": "later"}}).status_code == 422
    client.patch(url, json={"mapping": {}})
    board = {t["key"]: t for t in client.get("/tasks").json()}
    assert board["P-3"]["column"] == "in_progress"


def test_comments_are_listed_and_added(fake_jira):
    conn = connect().json()
    url = f"/tasks/jira:{conn['id']}:P-1/comments"
    assert client.get(url).json() == [
        {
            "id": "10",
            "author": "Ana",
            "body": "First!",
            "created": "2026-10-20T10:00:00.000+0000",
        }
    ]
    added = client.post(url, json={"body": "  Looks good\nShip it "})
    assert added.status_code == 200, added.text
    assert added.json()["body"] == "Looks good\nShip it"
    assert [c["author"] for c in client.get(url).json()] == ["Ana", "Me Myself"]
    assert client.post(url, json={"body": "  "}).status_code == 422
    assert client.get("/tasks/local:1/comments").status_code == 404


def test_reassign(fake_jira):
    conn = connect().json()
    url = f"/tasks/jira:{conn['id']}:P-1/assignee"
    moved = client.put(url, json={"user_id": "acc-1"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["assignee"] == "Ana"
    board = {t["key"]: t for t in client.get("/tasks").json()}
    assert board["P-1"]["assignee"] == "Ana"
    nobody = client.put(url, json={"user_id": None}).json()
    assert nobody["assignee"] is None
    refused = client.put(url, json={"user_id": "forbidden"})
    assert refused.status_code == 403
    assert "does not allow" in refused.json()["detail"]


def test_create_issue(fake_jira):
    conn = connect().json()
    base = f"/tasks/connections/{conn['id']}"
    options = client.get(f"{base}/create-options").json()
    assert options["projects"][0] == {"id": "P", "name": "Platform (P)"}
    assert options["priorities"] == [{"id": "1", "name": "Highest"}]
    assert options["create_url"].startswith(SITE)
    kinds = client.get(f"{base}/types", params={"project": "P"}).json()
    assert [k["name"] for k in kinds] == ["Task", "Bug"]

    created = client.post(
        f"{base}/tasks",
        json={
            "project": "P",
            "type": "11",
            "priority": "1",
            "title": " New bug ",
            "description": "Broken",
        },
    )
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["title"] == "New bug"
    assert item["id"] == f"jira:{conn['id']}:P-4"
    sent = fake_jira.created[-1]
    assert sent["issuetype"] == {"id": "11"}
    assert sent["priority"] == {"id": "1"}
    assert sent["assignee"] == {"accountId": "acc-me"}
    assert sent["description"]["type"] == "doc"
    # On the board without waiting for a read.
    assert "P-4" in {t["key"] for t in client.get("/tasks").json()}

    # Without a type, the first that is not a sub-task is used.
    client.post(f"{base}/tasks", json={"project": "P", "title": "Plain"})
    assert fake_jira.created[-1]["issuetype"] == {"id": "10"}


def test_create_issue_explains_missing_fields(fake_jira):
    conn = connect().json()
    refused = client.post(
        f"/tasks/connections/{conn['id']}/tasks",
        json={"project": "STRICT", "title": "Nope"},
    )
    assert refused.status_code == 422
    assert "Team is required" in refused.json()["detail"]
    blank = client.post(
        f"/tasks/connections/{conn['id']}/tasks", json={"project": "P", "title": " "}
    )
    assert blank.status_code == 422


def test_only_jira_cloud_hosts_are_accepted(fake_jira):
    for site in ("https://intranet.local", "https://atlassian.net.evil.io", "10.0.0.1"):
        assert connect(site=site).status_code == 422, site


def test_changing_the_site_needs_the_token_again(fake_jira):
    conn = connect().json()
    url = f"/tasks/connections/{conn['id']}"
    moved = client.patch(
        url, json={"config": {"site": "other.atlassian.net", "email": "me@example.com"}}
    )
    assert moved.status_code == 422
    assert "token again" in moved.json()["detail"]
    # Same settings, written differently, are fine.
    same = client.patch(
        url, json={"config": {"site": "team.atlassian.net/", "email": "me@example.com"}}
    )
    assert same.status_code == 200, same.text


def test_validation_errors_do_not_echo_the_token():
    response = client.post(
        "/tasks/connections", json={"provider": "jira", "secret": TOKEN}
    )
    assert response.status_code == 422
    assert TOKEN not in response.text


def test_bad_issue_ids_are_not_found(fake_jira, tracker):
    conn = connect().json()
    before = len(tracker.requests)
    for bad in ("../../myself", "P-1/../x", "²"):
        response = client.get(f"/tasks/jira:{conn['id']}:{bad}/comments")
        assert response.status_code == 404, bad
    assert client.get("/tasks/local:²/statuses").status_code == 404
    assert len(tracker.requests) == before


def test_unreadable_answer_is_a_502(fake_jira, tracker):
    conn = connect().json()
    tracker.handler = lambda request: httpx.Response(200, text="<html>")
    response = client.get(f"/tasks/jira:{conn['id']}:P-1/comments")
    assert response.status_code == 502


def test_non_web_links_are_dropped():
    from backend.app.providers import ExternalTask

    def task(url):
        return ExternalTask(
            external_id="1", title="t", status="s", category="todo", url=url
        )

    assert task("javascript:alert(1)").url is None
    assert task("https://x.io/1").url == "https://x.io/1"


def test_owner_email_is_case_insensitive(fake_jira):
    from backend.tests.conftest import login_as

    client.post("/tasks/local", json={"title": "Mine"})
    login_as("ME@Example.com")
    assert [t["title"] for t in client.get("/tasks").json()] == ["Mine"]


def test_unverified_email_is_refused():
    from backend.app.auth import get_current_user
    from backend.app.main import fastapi_app

    fastapi_app.dependency_overrides[get_current_user] = lambda: {
        "email": "me@example.com",
        "email_verified": False,
    }
    assert client.get("/tasks").status_code == 403


def test_refresh_cooldown(fake_jira, monkeypatch):
    from backend.app import tasks as tasks_mod

    connect()
    reads = len(fake_jira.jql)
    monkeypatch.setattr(tasks_mod, "REFRESH_COOLDOWN", 60)
    client.post("/tasks/refresh", json={})
    assert len(fake_jira.jql) == reads
