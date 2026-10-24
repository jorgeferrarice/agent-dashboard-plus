"""Tests for Huly connections on the Tasks tab, against a fake Huly 0.7.

The fake follows the protocol of Huly's own client: config.json,
JSON-RPC to the accounts service, REST find-all/tx on the
transactor, and the collaborator RPC for descriptions.
"""

import json
import time
from urllib.parse import parse_qs, unquote, urlparse

import httpx
import pytest

from backend.app.providers import huly
from backend.tests.conftest import client

pytestmark = pytest.mark.usefixtures("tasks_app")

URL = "https://huly.test"
PASSWORD = "huly-pass-123"
NOW = int(time.time() * 1000)
# Internal and public transactor addresses, as self-hosted lists them.
ENDPOINT = "ws://internal:3333;wss://huly.test/_transactor"


def matches(doc, query):
    """A tiny DocumentQuery: equality, $in, $nin, $gte, $like."""
    for key, want in query.items():
        have = doc.get(key)
        if isinstance(want, dict):
            if "$in" in want and have not in want["$in"]:
                return False
            if "$nin" in want and have in want["$nin"]:
                return False
            if "$gte" in want and not (have or 0) >= want["$gte"]:
                return False
            if "$like" in want:
                needle = want["$like"].strip("%").lower()
                if needle not in str(have or "").lower():
                    return False
        elif have != want:
            return False
    return True


class FakeHuly:
    """One workspace "acme" with a project WEB."""

    def __init__(self):
        person = {"_id": "p-me", "name": "Myself,Me", "personUuid": "acc-uuid"}
        ana = {"_id": "p-ana", "name": "Silva,Ana"}
        self.docs = {
            huly.STATUS: [
                {
                    "_id": "st-todo",
                    "name": "Todo",
                    "category": "task:statusCategory:ToDo",
                },
                {
                    "_id": "st-prog",
                    "name": "In Progress",
                    "category": "task:statusCategory:Active",
                },
                {
                    "_id": "st-review",
                    "name": "In Review",
                    "category": "task:statusCategory:Active",
                },
                {
                    "_id": "st-done",
                    "name": "Done",
                    "category": "task:statusCategory:Won",
                },
                {
                    "_id": "st-other",
                    "name": "Elsewhere",
                    "category": "task:statusCategory:ToDo",
                },
            ],
            huly.PROJECT_TYPE: [
                {
                    "_id": "pt1",
                    "statuses": [
                        {"_id": s}
                        for s in ("st-todo", "st-prog", "st-review", "st-done")
                    ],
                }
            ],
            huly.PROJECT: [
                {
                    "_id": "proj1",
                    "identifier": "WEB",
                    "name": "Website",
                    "sequence": 3,
                    "defaultIssueStatus": "st-todo",
                    "type": "pt1",
                },
            ],
            huly.PERSON: [person, ana],
            huly.EMPLOYEE: [person, ana],
            huly.SOCIAL_ID: [
                {"_id": "soc-me", "attachedTo": "p-me"},
                {"_id": "soc-ana", "attachedTo": "p-ana"},
            ],
            huly.ISSUE: [
                self.issue(
                    "i1", 1, "st-todo", "p-me", priority=2, dueDate=1793577600000
                ),
                self.issue("i2", 2, "st-review", "p-me"),
                self.issue("i3", 3, "st-done", "p-me"),
                self.issue("i9", 9, "st-todo", "p-ana"),
            ],
            huly.MESSAGE: [
                {
                    "_id": "m1",
                    "attachedTo": "i1",
                    "attachedToClass": huly.ISSUE,
                    "createdBy": "soc-ana",
                    "createdOn": NOW - 1000,
                    "message": json.dumps(
                        {
                            "type": "doc",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Hello"}],
                                }
                            ],
                        }
                    ),
                },
            ],
        }
        self.txs = []
        self.logins = 0
        self.descriptions = {}

    @staticmethod
    def issue(_id, number, status, assignee, **fields):
        return {
            "_id": _id,
            "space": "proj1",
            "identifier": f"WEB-{number}",
            "number": number,
            "title": f"Issue {number}",
            "status": status,
            "assignee": assignee,
            "priority": 0,
            "dueDate": None,
            "modifiedOn": NOW,
            **fields,
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        auth = request.headers.get("Authorization", "")
        if path == "/config.json":
            return httpx.Response(
                200,
                json={
                    "ACCOUNTS_URL": f"{URL}/_accounts",
                    "COLLABORATOR_URL": "wss://huly.test/_collaborator",
                },
            )
        if path == "/_accounts":
            body = json.loads(request.content)
            if body["method"] == "login":
                self.logins += 1
                if body["params"] != {"email": "me@example.com", "password": PASSWORD}:
                    return httpx.Response(
                        200, json={"error": {"code": "platform:status:InvalidPassword"}}
                    )
                return httpx.Response(
                    200,
                    json={
                        "result": {
                            "account": "acc-uuid",
                            "name": "Me",
                            "token": "login-tok",
                        }
                    },
                )
            if body["method"] == "selectWorkspace":
                assert auth == "Bearer login-tok"
                if body["params"]["workspaceUrl"] != "acme":
                    return httpx.Response(
                        200,
                        json={"error": {"code": "platform:status:WorkspaceNotFound"}},
                    )
                return httpx.Response(
                    200,
                    json={
                        "result": {
                            "token": "ws-tok",
                            "workspace": "ws-uuid",
                            "workspaceUrl": "acme",
                            "endpoint": ENDPOINT,
                        }
                    },
                )
        if path.startswith("/_collaborator/rpc/"):
            assert auth == "Bearer ws-tok"
            doc = unquote(path.removeprefix("/_collaborator/rpc/"))
            body = json.loads(request.content)
            assert body["method"] == "createContent"
            self.descriptions[doc] = body["payload"]["content"]["description"]
            return httpx.Response(200, json={"content": {"description": "blob-1"}})
        if not path.startswith("/_transactor/api/v1/"):
            return httpx.Response(404)
        assert auth == "Bearer ws-tok"
        if path == "/_transactor/api/v1/account/ws-uuid":
            return httpx.Response(
                200,
                json={
                    "uuid": "acc-uuid",
                    "primarySocialId": "soc-me",
                    "socialIds": ["soc-me"],
                },
            )
        if path == "/_transactor/api/v1/find-all/ws-uuid":
            params = parse_qs(urlparse(str(request.url)).query)
            cls = params["class"][0]
            query = json.loads(params.get("query", ["{}"])[0])
            options = json.loads(params.get("options", ["{}"])[0])
            found = [d for d in self.docs.get(cls, []) if matches(d, query)]
            if "createdOn" in (options.get("sort") or {}):
                found.sort(key=lambda d: d.get("createdOn", 0))
            # Like the server: no _class, and no field the query fixed.
            fixed = {k for k, v in query.items() if not isinstance(v, dict)}
            value = [{k: v for k, v in d.items() if k not in fixed} for d in found]
            return httpx.Response(
                200, json={"dataType": "TotalArray", "value": value, "total": -1}
            )
        if path == "/_transactor/api/v1/tx/ws-uuid":
            tx = json.loads(request.content)
            self.txs.append(tx)
            assert tx["modifiedBy"] == "soc-me" and len(tx["_id"]) == 24
            docs = self.docs.setdefault(tx["objectClass"], [])
            if tx["_class"] == "core:class:TxUpdateDoc":
                doc = next(d for d in docs if d["_id"] == tx["objectId"])
                for key, value in tx["operations"].items():
                    if key == "$inc":
                        for field, by in value.items():
                            doc[field] += by
                    else:
                        doc[key] = value
                return httpx.Response(
                    200, json={"object": doc} if tx.get("retrieve") else {}
                )
            if tx["_class"] == "core:class:TxCreateDoc":
                docs.append(
                    {
                        "_id": tx["objectId"],
                        "space": tx["objectSpace"],
                        "attachedTo": tx.get("attachedTo"),
                        "attachedToClass": tx.get("attachedToClass"),
                        "createdBy": tx["createdBy"],
                        "createdOn": tx["modifiedOn"],
                        "modifiedOn": tx["modifiedOn"],
                        **tx["attributes"],
                    }
                )
                return httpx.Response(200, json={})
        return httpx.Response(404)


@pytest.fixture
def fake_huly(tracker):
    huly._sessions.clear()  # pylint: disable=protected-access
    server = FakeHuly()
    tracker.handler = server
    return server


def connect(password=PASSWORD, workspace="acme"):
    return client.post(
        "/tasks/connections",
        json={
            "provider": "huly",
            "name": "Huly",
            "config": {
                "url": "huly.test",
                "workspace": workspace,
                "email": "me@example.com",
            },
            "secret": password,
        },
    )


def test_connect_and_read_my_issues(fake_huly):
    created = connect()
    assert created.status_code == 200, created.text
    conn = created.json()
    assert conn["config"]["account"] == "Me Myself"
    assert PASSWORD not in created.text
    board = {t["key"]: t for t in client.get("/tasks").json()}
    # Only mine: WEB-9 is Ana's.
    assert set(board) == {"WEB-1", "WEB-2", "WEB-3"}
    one = board["WEB-1"]
    assert one["id"] == f"huly:{conn['id']}:i1"
    assert one["status"] == "Todo"
    assert one["column"] == "todo"
    assert one["priority"] == "high"
    assert one["due_date"] == "2026-11-02"
    assert one["assignee"] == "Me Myself"
    assert one["url"] == "https://huly.test/workbench/acme/tracker/WEB-1"
    assert board["WEB-2"]["column"] == "review"
    assert board["WEB-3"]["column"] == "done"


def test_session_is_reused(fake_huly):
    connect()
    logins = fake_huly.logins
    client.post("/tasks/refresh", json={})
    assert fake_huly.logins == logins


def test_bad_password_and_workspace(fake_huly):
    bad = connect(password="nope")
    assert bad.status_code == 400
    assert "rejected the email or password" in bad.json()["detail"]
    assert connect(workspace="other").status_code == 422


def test_status_change(fake_huly):
    conn = connect().json()
    task_id = f"huly:{conn['id']}:i1"
    options = client.get(f"/tasks/{task_id}/statuses").json()
    # The project type's statuses, without the current one.
    assert [o["name"] for o in options] == ["In Progress", "In Review", "Done"]
    moved = client.post(f"/tasks/{task_id}/status", json={"status_id": "st-done"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["column"] == "done"
    tx = fake_huly.txs[-1]
    assert tx["_class"] == "core:class:TxUpdateDoc"
    assert tx["objectSpace"] == "proj1"
    assert tx["operations"] == {"status": "st-done"}
    refused = client.post(f"/tasks/{task_id}/status", json={"status_id": "st-other"})
    assert refused.status_code == 422


def test_comments_and_assignee(fake_huly):
    conn = connect().json()
    task_id = f"huly:{conn['id']}:i1"
    listed = client.get(f"/tasks/{task_id}/comments").json()
    assert [(c["author"], c["body"]) for c in listed] == [("Ana Silva", "Hello")]
    added = client.post(f"/tasks/{task_id}/comments", json={"body": "On it"})
    assert added.status_code == 200, added.text
    tx = fake_huly.txs[-1]
    assert tx["objectClass"] == huly.MESSAGE
    assert tx["attachedTo"] == "i1" and tx["collection"] == "comments"
    assert json.loads(tx["attributes"]["message"])["type"] == "doc"
    assert [c["body"] for c in client.get(f"/tasks/{task_id}/comments").json()] == [
        "Hello",
        "On it",
    ]
    users = client.get(f"/tasks/{task_id}/users", params={"query": "ana"}).json()
    assert users == [{"id": "p-ana", "name": "Ana Silva"}]
    moved = client.put(f"/tasks/{task_id}/assignee", json={"user_id": "p-ana"}).json()
    assert moved["assignee"] == "Ana Silva"
    nobody = client.put(f"/tasks/{task_id}/assignee", json={"user_id": None}).json()
    assert nobody["assignee"] is None


def test_create_issue(fake_huly):
    conn = connect().json()
    base = f"/tasks/connections/{conn['id']}"
    options = client.get(f"{base}/create-options").json()
    assert options["projects"] == [{"id": "proj1", "name": "Website (WEB)"}]
    assert [p["name"] for p in options["priorities"]] == [
        "Urgent",
        "High",
        "Medium",
        "Low",
    ]
    created = client.post(
        f"{base}/tasks",
        json={
            "project": "proj1",
            "priority": "2",
            "title": "New page",
            "description": "Text",
        },
    )
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["key"] == "WEB-4"
    assert item["priority"] == "high"
    assert item["assignee"] == "Me Myself"
    bump, create = fake_huly.txs[-2:]
    assert bump["operations"] == {"$inc": {"sequence": 1}} and bump["retrieve"]
    assert create["attachedTo"] == "tracker:ids:NoParent"
    assert create["collection"] == "subIssues"
    assert create["attributes"]["description"] == "blob-1"
    assert create["attributes"]["status"] == "st-todo"
    (doc,) = fake_huly.descriptions
    assert doc.startswith("ws-uuid|tracker:class:Issue|")
    assert "WEB-4" in {t["key"] for t in client.get("/tasks").json()}


def test_filters(fake_huly):
    conn = connect().json()
    url = f"/tasks/connections/{conn['id']}"
    client.patch(url, json={"filters": {"assignee": "any", "done_days": 0}})
    keys = {t["key"] for t in client.get("/tasks").json()}
    assert keys == {"WEB-1", "WEB-2", "WEB-9"}
    client.patch(url, json={"filters": {"projects": ["NOPE"]}})
    assert client.get("/tasks").json() == []
    assert client.patch(url, json={"filters": {"query": "x"}}).status_code == 422


def test_config_validation():
    with pytest.raises(huly.ProviderError):
        huly.normalize_config({"url": "ftp://x", "workspace": "a", "email": "a@b"})
    assert huly.normalize_config(
        {"url": "http://10.0.0.5:8087/", "workspace": "acme", "email": "a@b.c"}
    ) == {"url": "http://10.0.0.5:8087", "workspace": "acme", "email": "a@b.c"}
    assert len(huly.generate_id()) == 24
    assert (
        huly._http_base("ws://a;wss://b/x/") == "https://b/x"
    )  # pylint: disable=protected-access
