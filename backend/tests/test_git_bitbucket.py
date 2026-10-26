"""Tests for Bitbucket Cloud connections on the Git tab, against a
fake Bitbucket."""

import base64
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app import git_review
from backend.tests.conftest import client

pytestmark = pytest.mark.usefixtures("tasks_app")

EMAIL = "me@example.com"
TOKEN = "ATATT-secret"
ME = "{u-me}"
DIFF = "diff --git a/api.py b/api.py\n@@ -1 +1 @@\n-a\n+b\n"
CONFIG = {"email": "Me@Example.com", "workspaces": "acme"}
API = "https://api.bitbucket.org/2.0"


def ago(days):
    """An ISO time ``days`` ago, as Bitbucket writes it."""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def bb_pr(number, repo, state="OPEN", participants=(), **fields):
    raw = {
        "id": number,
        "title": f"PR {number}",
        "state": state,
        "author": {"display_name": "Me", "uuid": ME},
        "source": {"branch": {"name": f"feat-{number}"}, "commit": {"hash": "srcsha"}},
        "destination": {"branch": {"name": "main"}, "repository": {"full_name": repo}},
        "links": {
            "html": {"href": f"https://bitbucket.org/{repo}/pull-requests/{number}"}
        },
        "updated_on": ago(1),
        "participants": list(participants),
        "description": "Fixes the login",
    }
    raw.update(fields)
    return raw


def bb_commit(sha, uuid, days, message="msg\n\nbody"):
    return {
        "hash": sha,
        "message": message,
        "date": ago(days),
        "author": {"user": {"uuid": uuid}} if uuid else {"raw": "Someone <s@x>"},
        "links": {"html": {"href": f"https://bitbucket.org/acme/api/commits/{sha}"}},
    }


class FakeBitbucket:
    """A tiny Bitbucket Cloud with workspace "acme"."""

    def __init__(self):
        self.posted = []
        self.queries = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        expected = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
        if request.headers.get("Authorization") != f"Basic {expected}":
            return httpx.Response(401, json={"error": {"message": "Unauthorized"}})
        path = request.url.path.removeprefix("/2.0")
        params = request.url.params
        method = request.method
        if path == "/user":
            return httpx.Response(200, json={"uuid": ME, "display_name": "Me Myself"})
        if path == "/workspaces/acme":
            return httpx.Response(200, json={"slug": "acme"})
        if path.startswith("/workspaces/") and path.count("/") == 2:
            return httpx.Response(404, json={"error": {"message": "nope"}})
        if path == f"/workspaces/acme/pullrequests/{ME}":
            assert params.get_list("state") == ["OPEN", "MERGED", "DECLINED"]
            return httpx.Response(
                200,
                json={
                    "values": [
                        bb_pr(
                            5,
                            "acme/api",
                            participants=[
                                {
                                    "role": "REVIEWER",
                                    "approved": True,
                                    "state": "approved",
                                }
                            ],
                        ),
                        bb_pr(6, "acme/api", state="MERGED"),
                        bb_pr(
                            7,
                            "acme/api",
                            draft=True,
                            participants=[
                                {"role": "REVIEWER", "approved": False, "state": None}
                            ],
                        ),
                    ]
                },
            )
        if path == "/repositories/acme":
            assert params["sort"] == "-updated_on"
            return httpx.Response(
                200,
                json={"values": [{"full_name": "acme/api"}, {"full_name": "acme/web"}]},
            )
        if path.endswith("/pullrequests") and method == "GET":
            self.queries.append(params["q"])
            if path == "/repositories/acme/web/pullrequests":
                theirs = bb_pr(
                    9,
                    "acme/web",
                    author={"display_name": "Ana"},
                    participants=[
                        {
                            "role": "REVIEWER",
                            "state": "changes_requested",
                            "approved": False,
                        }
                    ],
                )
                return httpx.Response(200, json={"values": [theirs]})
            return httpx.Response(200, json={"values": []})
        if path == "/repositories/acme/api/commits":
            # Merged PR 6's source branch is gone: not asked for.
            assert sorted(params.get_list("include")) == ["feat-5", "feat-7", "main"]
            return httpx.Response(
                200,
                json={
                    "values": [
                        bb_commit("c1", ME, 1),
                        bb_commit("c0", ME, 40),
                        bb_commit("x9", "{u-other}", 1),
                        bb_commit("raw", None, 1),
                    ]
                },
            )
        if path == "/repositories/acme/api/pullrequests/5":
            return httpx.Response(200, json=bb_pr(5, "acme/api"))
        if path == "/repositories/acme/api/pullrequests/5/diff":
            return httpx.Response(
                302,
                headers={"Location": f"{API}/repositories/acme/api/diff/x"},
            )
        if path == "/repositories/acme/api/diff/x":
            return httpx.Response(200, text=DIFF)
        if path == "/repositories/acme/api/pullrequests/5/comments":
            body = json.loads(request.content)
            self.posted.append(body)
            if (body.get("inline") or {}).get("to") == 999:
                return httpx.Response(400, json={"error": {"message": "bad line"}})
            return httpx.Response(
                201, json={"links": {"html": {"href": "https://bitbucket.org/c/1"}}}
            )
        return httpx.Response(404, json={"error": {"message": "Not found"}})


@pytest.fixture
def bitbucket(tracker):
    fake = FakeBitbucket()
    tracker.handler = fake
    return fake


def connect(config=None):
    response = client.post(
        "/git/connections",
        json={
            "provider": "bitbucket",
            "name": "BB",
            "config": config or CONFIG,
            "secret": TOKEN,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_connect_saves_cleaned_settings_and_identity(bitbucket):
    created = connect()
    assert created["config"] == {
        "email": EMAIL,
        "workspaces": ["acme"],
        "account": "Me Myself",
        "user_id": ME,
    }
    assert TOKEN not in json.dumps(created)


@pytest.mark.parametrize(
    "config, message",
    [
        ({"email": "nope", "workspaces": "acme"}, "email"),
        ({"email": EMAIL, "workspaces": ""}, "workspaces"),
        ({"email": EMAIL, "workspaces": "ac me"}, "slug"),
        ({"email": EMAIL, "workspaces": "missing"}, "missing not found"),
    ],
)
def test_bad_settings_are_refused(bitbucket, config, message):
    response = client.post(
        "/git/connections",
        json={"provider": "bitbucket", "name": "BB", "config": config, "secret": TOKEN},
    )
    assert response.status_code == 422
    assert message in response.json()["detail"]


def test_pull_requests_and_reviews(bitbucket):
    cid = connect()["id"]
    prs = {pr["number"]: pr for pr in client.get("/git").json()["prs"]}
    assert set(prs) == {5, 6, 7, 9}
    assert prs[5]["id"] == f"bitbucket:{cid}:acme/api:5"
    assert prs[5]["roles"] == ["author"] and prs[5]["review"] == "approved"
    assert prs[6]["state"] == "merged" and prs[6]["review"] is None
    assert prs[7]["state"] == "draft" and prs[7]["review"] == "pending"
    assert prs[9]["roles"] == ["reviewer"]
    assert prs[9]["review"] == "changes_requested"
    assert prs[9]["author"] == "Ana"
    assert all(pr["checks"] is None for pr in prs.values())
    assert bitbucket.queries[0] == f'reviewers.uuid="{ME}" AND state="OPEN"'


def test_commits_are_mine_and_recent(bitbucket):
    connect()
    commits = client.get("/git").json()["commits"]
    assert [c["sha"] for c in commits] == ["c1"]
    assert commits[0]["message"] == "msg"
    assert commits[0]["repo"] == "acme/api"


def test_review_reads_the_diff_through_the_redirect(bitbucket, monkeypatch):
    cid = connect()["id"]
    seen = {}

    async def fake_review(context):
        seen["context"] = context
        return (
            git_review.ReviewResult(summary="ok", verdict="approve", language="en"),
            "claude-sonnet-5-5",
        )

    monkeypatch.setattr(git_review, "review", fake_review)
    response = client.post(f"/git/prs/bitbucket:{cid}:acme/api:5/review")
    assert response.status_code == 200, response.text
    assert seen["context"].diff == DIFF
    assert seen["context"].description == "Fixes the login"
    assert response.json()["head_sha"] == "srcsha"
    assert bitbucket.posted == []


def test_inline_comment_and_fallback(bitbucket):
    cid = connect()["id"]
    url = f"/git/prs/bitbucket:{cid}:acme/api:5/comments"
    first = client.post(url, json={"body": "Fix", "path": "api.py", "line": 3}).json()
    assert first == {"url": "https://bitbucket.org/c/1", "inline": True}
    assert bitbucket.posted[-1] == {
        "content": {"raw": "Fix"},
        "inline": {"path": "api.py", "to": 3},
    }
    second = client.post(
        url, json={"body": "Fix", "path": "api.py", "line": 999}
    ).json()
    assert second["inline"] is False
    assert bitbucket.posted[-1] == {"content": {"raw": "`api.py:999`\n\nFix"}}


def test_changing_settings_needs_the_token_again(bitbucket):
    cid = connect()["id"]
    url = f"/git/connections/{cid}"
    other = {"email": EMAIL, "workspaces": ["acme", "other"]}
    response = client.patch(url, json={"config": other})
    assert response.status_code == 422
    # The same settings, written differently, are no change.
    same = client.patch(
        url, json={"config": {"email": "ME@example.com", "workspaces": "acme"}}
    )
    assert same.status_code == 200
    renamed = client.patch(url, json={"name": " Work "}).json()
    assert renamed["name"] == "Work"
