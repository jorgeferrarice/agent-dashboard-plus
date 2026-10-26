"""Tests for the Git tab's API that do not depend on one host:
the poller, deleting connections, and the Claude review call."""

import asyncio
import json
from types import SimpleNamespace

import anthropic
import pytest

from backend.app import git, git_review, models
from backend.app.providers import PRContext
from backend.tests.conftest import TestingSessionLocal, client
from backend.tests.test_git_github import TOKEN, FakeGitHub, connect

pytestmark = pytest.mark.usefixtures("tasks_app")


@pytest.fixture
def github(tracker):
    """A fake GitHub (see ``test_git_github``)."""
    fake = FakeGitHub()
    tracker.handler = fake
    return fake


CONTEXT = PRContext(
    repo="octo/app",
    number=4,
    title="Corrige login",
    description="Corrige o login quebrado",
    source_branch="fix",
    target_branch="main",
    diff=(
        "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n"
        "@@ -3,2 +3,3 @@\n x\n-y\n+z\n+w\n"
    ),
)


def test_number_lines_marks_new_file_lines():
    numbered = git_review.number_lines(CONTEXT.diff)
    assert numbered.splitlines() == [
        "diff --git a/a.py b/a.py",
        "--- a/a.py",
        "+++ b/a.py",
        "@@ -3,2 +3,3 @@",
        "     3 |  x",
        "       | -y",
        "     4 | +z",
        "     5 | +w",
    ]


def test_poller_reads_due_connections_and_tells_the_user(github, monkeypatch):
    connect()
    monkeypatch.setattr(git.database, "SessionLocal", TestingSessionLocal)
    told = []

    async def notify(email):
        told.append(email)

    # Just read: not due.
    assert asyncio.run(git.sync_due(notify)) == 0
    monkeypatch.setattr(git, "SYNC_INTERVAL", -1)
    # Due, but nothing changed: nobody is told.
    assert asyncio.run(git.sync_due(notify)) == 1
    assert told == []
    github.search["reviewer"] = []
    asyncio.run(git.sync_due(notify))
    assert told == ["me@example.com"]


def test_delete_removes_cache_and_reviews(github):
    cid = connect()["id"]
    db = TestingSessionLocal()
    db.add(
        models.GitReview(
            owner_email="me@example.com",
            pr_id=f"github:{cid}:octo/app:42",
            model="m",
            result_json={},
        )
    )
    db.commit()
    assert client.delete(f"/git/connections/{cid}").json() == {"ok": True}
    assert db.query(models.GitReview).count() == 0
    assert db.query(models.GitCache).count() == 0
    db.close()
    assert client.get("/git/connections").json() == []
    assert client.delete(f"/git/connections/{cid}").status_code == 404


def test_new_token_is_checked_before_saving(github):
    cid = connect()["id"]
    bad = client.patch(f"/git/connections/{cid}", json={"secret": "wrong"})
    assert bad.status_code == 400
    good = client.patch(f"/git/connections/{cid}", json={"secret": TOKEN})
    assert good.status_code == 200
    assert TOKEN not in json.dumps(good.json())


class FakeClaude:
    """Stands in for ``anthropic.AsyncAnthropic``."""

    def __init__(self, message=None, error=None):
        self.message = message
        self.error = error
        self.kwargs = None
        self.closed = False
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **kwargs):
        self.kwargs = kwargs
        fake = self

        class Stream:
            async def __aenter__(self):
                if fake.error:
                    raise fake.error
                return self

            async def __aexit__(self, *exc):
                return False

            async def get_final_message(self):
                return fake.message

        return Stream()

    async def close(self):
        self.closed = True


def answer(text, stop_reason="end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[
            SimpleNamespace(type="thinking"),
            SimpleNamespace(type="text", text=text),
        ],
        model="claude-sonnet-5-5",
    )


@pytest.fixture
def claude(monkeypatch):
    """A fake Claude; set ``.message`` or ``.error`` before calling."""
    fake = FakeClaude()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GIT_REVIEW_MODEL", raising=False)
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda: fake)
    return fake


def run_review(context=CONTEXT):
    return asyncio.run(git_review.review(context))


def test_review_asks_claude_for_structured_output(claude):
    claude.message = answer(
        json.dumps(
            {
                "summary": "Bom",
                "verdict": "request_changes",
                "language": "pt-BR",
                "comments": [{"path": "a.py", "line": 4, "body": "Trate o erro"}],
            }
        )
    )
    result, model = run_review()
    assert model == "claude-sonnet-5-5"
    assert result.verdict == "request_changes"
    assert result.comments[0].line == 4
    kwargs = claude.kwargs
    assert kwargs["model"] == "claude-sonnet-5-5"
    assert kwargs["fallbacks"] == "default"
    assert kwargs["betas"] == [git_review.FALLBACK_BETA]
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    prompt = kwargs["messages"][0]["content"]
    assert "<description>\nCorrige o login quebrado\n</description>" in prompt
    assert "     4 | +z" in prompt
    assert "language the pull request's description" in kwargs["system"]
    assert claude.closed


def test_review_model_comes_from_the_environment(claude, monkeypatch):
    monkeypatch.setenv("GIT_REVIEW_MODEL", "claude-opus-5-5")
    claude.message = answer(
        json.dumps(
            {"summary": "", "verdict": "approve", "language": "en", "comments": []}
        )
    )
    run_review()
    assert claude.kwargs["model"] == "claude-opus-5-5"


@pytest.mark.parametrize(
    "message, status, words",
    [
        (answer("", "refusal"), 422, "declined"),
        (answer("{", "max_tokens"), 502, "cut off"),
        (answer('{"summary": 1}'), 502, "unexpected shape"),
    ],
)
def test_review_failures_are_explained(claude, message, status, words):
    claude.message = message
    with pytest.raises(git_review.ReviewError) as caught:
        run_review()
    assert caught.value.status_code == status
    assert words in caught.value.message


def test_rejected_api_key(claude):
    response = SimpleNamespace(status_code=401, headers={}, request=None)
    claude.error = anthropic.AuthenticationError(
        "bad key", response=response, body=None
    )
    with pytest.raises(git_review.ReviewError) as caught:
        run_review()
    assert caught.value.status_code == 503
    assert claude.closed


def test_empty_and_huge_diffs_are_not_sent(claude):
    for diff, words in (
        ("  ", "no changes"),
        ("x" * (git_review.MAX_DIFF_CHARS + 1), "limited"),
    ):
        with pytest.raises(git_review.ReviewError) as caught:
            run_review(CONTEXT.model_copy(update={"diff": diff}))
        assert caught.value.status_code == 422
        assert words in caught.value.message
    assert claude.kwargs is None
