"""Tests for GitHub connections on the Git tab, against a fake GitHub."""

import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import pytest

from backend.app import git, git_review
from backend.tests.conftest import client, login_as

pytestmark = pytest.mark.usefixtures("tasks_app")

TOKEN = "ghp_secret"
DIFF = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-a\n+b\n"


def ago(days):
    """An ISO time ``days`` ago, as GitHub writes it."""
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def commit(oid, login, days):
    return {
        "commit": {
            "oid": oid,
            "messageHeadline": f"commit {oid}",
            "committedDate": ago(days),
            "url": f"https://github.com/octo/app/commit/{oid}",
            "author": {"user": {"login": login} if login else None},
        }
    }


def pr_node(number, repo="octo/app", **fields):
    node = {
        "number": number,
        "title": f"PR {number}",
        "url": f"https://github.com/{repo}/pull/{number}",
        "state": "OPEN",
        "isDraft": False,
        "reviewDecision": None,
        "updatedAt": ago(1),
        "headRefName": f"feat-{number}",
        "baseRefName": "main",
        "author": {"login": "me"},
        "repository": {"nameWithOwner": repo, "defaultBranchRef": {"name": "main"}},
        "last": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]},
    }
    node.update(fields)
    return node


class FakeGitHub:
    """A tiny GitHub."""

    def __init__(self):
        mine = pr_node(
            42,
            reviewDecision="CHANGES_REQUESTED",
            commits={
                "nodes": [
                    commit("a1", "me", 2),
                    commit("old", "me", 30),
                    commit("b2", "someone", 1),
                ]
            },
        )
        self.search = {
            "author": [
                mine,
                pr_node(7, state="MERGED", commits={"nodes": []}),
                pr_node(8, isDraft=True, last={"nodes": []}, commits={"nodes": []}),
            ],
            "assignee": [pr_node(42)],
            "reviewer": [
                pr_node(
                    5,
                    repo="octo/lib",
                    author={"login": "ana"},
                    reviewDecision="REVIEW_REQUIRED",
                    last={
                        "nodes": [
                            {"commit": {"statusCheckRollup": {"state": "FAILURE"}}}
                        ]
                    },
                ),
                {},
            ],
        }
        self.posted = []
        self.rate_limited = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"message": "Bad credentials"})
        if self.rate_limited:
            return httpx.Response(
                403,
                headers={
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": str(int(time.time()) + 600),
                },
                json={"message": "API rate limit exceeded"},
            )
        path, method = request.url.path, request.method
        if path == "/user":
            return httpx.Response(200, json={"login": "me", "name": "Me Myself"})
        if path == "/graphql":
            body = json.loads(request.content)
            if "viewer" in body["query"]:
                data = {"viewer": {"login": "me", "id": "U_me"}}
                for role, nodes in self.search.items():
                    data[role] = {"nodes": nodes}
                return httpx.Response(200, json={"data": data})
            assert body["variables"]["author"] == "U_me"
            assert body["variables"]["o0"] == "octo"
            history = {
                "nodes": [
                    commit("a1", "me", 2)["commit"],
                    commit("c3", "me", 3)["commit"],
                ]
            }
            return httpx.Response(
                200,
                json={
                    "data": {
                        "r0": {
                            "nameWithOwner": "octo/app",
                            "defaultBranchRef": {
                                "name": "main",
                                "target": {"history": history},
                            },
                        }
                    }
                },
            )
        if (
            path in ("/repos/octo/app/pulls/42", "/repos/octo/app/pulls/43")
            and method == "GET"
        ):
            if request.headers["Accept"] == "application/vnd.github.diff":
                if path.endswith("43"):
                    return httpx.Response(406, json={"message": "diff too large"})
                return httpx.Response(200, text=DIFF)
            return httpx.Response(
                200,
                json={
                    "title": "Fix it",
                    "body": "Corrige o bug",
                    "head": {"ref": "feat-42", "sha": "headsha"},
                    "base": {"ref": "main"},
                },
            )
        if path == "/repos/octo/app/pulls/42/comments":
            body = json.loads(request.content)
            self.posted.append(("inline", body))
            if body.get("line") == 999:
                return httpx.Response(422, json={"message": "line not in diff"})
            return httpx.Response(201, json={"html_url": "https://github.com/c/1"})
        if path == "/repos/octo/app/issues/42/comments":
            self.posted.append(("general", json.loads(request.content)))
            return httpx.Response(201, json={"html_url": "https://github.com/c/2"})
        return httpx.Response(404, json={"message": "Not Found"})


@pytest.fixture
def github(tracker):
    fake = FakeGitHub()
    tracker.handler = fake
    return fake


def connect(name="GitHub"):
    response = client.post(
        "/git/connections",
        json={"provider": "github", "name": name, "config": {}, "secret": TOKEN},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_connect_reads_prs_and_never_returns_the_token(github):
    created = connect()
    assert created["config"] == {"account": "Me Myself (me)", "user_id": "me"}
    assert TOKEN not in json.dumps(created)
    assert created["pr_count"] == 4
    listed = client.get("/git/connections").json()
    assert TOKEN not in json.dumps(listed)


def test_bad_token_is_refused(github):
    response = client.post(
        "/git/connections",
        json={"provider": "github", "name": "x", "config": {}, "secret": "nope"},
    )
    assert response.status_code == 400
    assert "rejected the credentials" in response.json()["detail"]


def test_pull_requests_states_roles_and_checks(github):
    cid = connect()["id"]
    prs = {pr["number"]: pr for pr in client.get("/git").json()["prs"]}
    assert set(prs) == {42, 7, 8, 5}
    assert prs[42]["id"] == f"github:{cid}:octo/app:42"
    # Found by two searches, listed once with both roles.
    assert prs[42]["roles"] == ["author", "assignee"]
    assert prs[42]["review"] == "changes_requested"
    assert prs[42]["checks"] == "success"
    assert prs[7]["state"] == "merged"
    assert prs[8]["state"] == "draft" and prs[8]["checks"] is None
    assert prs[5]["roles"] == ["reviewer"]
    assert prs[5]["review"] == "pending" and prs[5]["checks"] == "failure"
    assert prs[5]["author"] == "ana"


def test_commits_are_mine_recent_and_unique(github):
    connect()
    commits = client.get("/git").json()["commits"]
    shas = [c["sha"] for c in commits]
    # a1 is on the PR branch and on main: listed once. "old" is
    # past the window; b2 is someone else's.
    assert shas == ["a1", "c3"]
    assert commits[0]["branch"] == "feat-42"
    assert commits[1]["branch"] == "main"


def test_rate_limit_is_recorded_and_waited_for(github):
    cid = connect()["id"]
    github.rate_limited = True
    client.post("/git/refresh", json={"connection_id": cid})
    row = client.get("/git/connections").json()[0]
    assert "rate limiting" in row["last_error"]
    assert git._retry_at[cid] > datetime.now(timezone.utc)
    # The cached PRs are still shown.
    assert len(client.get("/git").json()["prs"]) == 4


def test_review_is_saved_and_posts_nothing(github, monkeypatch):
    cid = connect()["id"]
    seen = {}

    async def fake_review(context):
        seen["context"] = context
        return (
            git_review.ReviewResult(
                summary="Resumo",
                verdict="comment",
                language="pt-BR",
                comments=[
                    git_review.ReviewComment(path="app.py", line=1, body="Use x")
                ],
            ),
            "claude-sonnet-5-5",
        )

    monkeypatch.setattr(git_review, "review", fake_review)
    pr_id = f"github:{cid}:octo/app:42"
    assert client.get(f"/git/prs/{pr_id}/review").status_code == 404
    response = client.post(f"/git/prs/{pr_id}/review")
    assert response.status_code == 200, response.text
    review = response.json()
    assert review["summary"] == "Resumo" and review["head_sha"] == "headsha"
    assert review["comments"][0] == {"path": "app.py", "line": 1, "body": "Use x"}
    assert seen["context"].description == "Corrige o bug"
    assert seen["context"].diff == DIFF
    assert github.posted == []
    assert client.get(f"/git/prs/{pr_id}/review").json()["summary"] == "Resumo"
    # The UI sends the ID URL-encoded (it holds ":" and "/").
    encoded = quote(pr_id, safe="")
    assert client.get(f"/git/prs/{encoded}/review").json()["pr_id"] == pr_id


def test_review_without_api_key_explains(github, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cid = connect()["id"]
    response = client.post(f"/git/prs/github:{cid}:octo/app:42/review")
    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_diff_too_large_for_github(github, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    cid = connect()["id"]
    response = client.post(f"/git/prs/github:{cid}:octo/app:43/review")
    assert response.status_code == 422
    assert "too large" in response.json()["detail"]


def test_post_inline_comment(github):
    cid = connect()["id"]
    response = client.post(
        f"/git/prs/github:{cid}:octo/app:42/comments",
        json={"body": " Editado ", "path": "app.py", "line": 1},
    )
    assert response.json() == {"url": "https://github.com/c/1", "inline": True}
    kind, body = github.posted[0]
    assert kind == "inline"
    assert body == {
        "body": "Editado",
        "commit_id": "headsha",
        "path": "app.py",
        "line": 1,
        "side": "RIGHT",
    }


def test_comment_on_a_line_outside_the_diff_becomes_general(github):
    cid = connect()["id"]
    response = client.post(
        f"/git/prs/github:{cid}:octo/app:42/comments",
        json={"body": "Hmm", "path": "app.py", "line": 999},
    )
    assert response.json() == {"url": "https://github.com/c/2", "inline": False}
    assert github.posted[-1] == ("general", {"body": "`app.py:999`\n\nHmm"})


def test_general_and_file_comments(github):
    cid = connect()["id"]
    url = f"/git/prs/github:{cid}:octo/app:42/comments"
    assert client.post(url, json={"body": "Geral"}).json()["inline"] is False
    assert github.posted[-1] == ("general", {"body": "Geral"})
    client.post(url, json={"body": "Arquivo", "path": "app.py"})
    assert github.posted[-1][1]["subject_type"] == "file"
    assert client.post(url, json={"body": "  "}).status_code == 422


def test_pull_requests_of_other_users_are_hidden(github):
    cid = connect()["id"]
    login_as("other@example.com")
    pr_id = f"github:{cid}:octo/app:42"
    assert client.get(f"/git/prs/{pr_id}/review").status_code == 404
    assert (
        client.post(f"/git/prs/{pr_id}/comments", json={"body": "x"}).status_code == 404
    )
    assert client.get("/git").json() == {"prs": [], "commits": []}


@pytest.mark.parametrize(
    "pr_id",
    [
        "github:1:octo/app",
        "jira:1:octo/app:4",
        "github:x:octo/app:4",
        "github:1:../x:4",
    ],
)
def test_malformed_ids_are_not_found(github, pr_id):
    connect()
    assert (
        client.post(f"/git/prs/{pr_id}/comments", json={"body": "x"}).status_code == 404
    )
