"""Clients for the external trackers the Tasks tab reads.

Each tracker is a module here (``jira``, ...) exposing the same
async functions, each taking a ``Conn`` and an ``httpx`` client:

- ``check(conn, http) -> str``: verifies the credentials and
  returns who they belong to, for the connection list.
- ``fetch(conn, http) -> List[ExternalTask]``: the tasks the
  connection's filter selects.
- ``statuses(conn, http, external_id) -> List[ExternalStatus]``:
  what the task can move to now.
- ``set_status(conn, http, external_id, status_id, fields)
  -> ExternalTask``: moves it and returns it as it is now.
- ``search_users(conn, http, external_id, query) -> List[Choice]``.
- ``comments(conn, http, external_id) -> List[Comment]``, oldest
  first, and ``add_comment(conn, http, external_id, text)``.
- ``assign(conn, http, external_id, user_id) -> ExternalTask``;
  ``user_id`` None leaves it unassigned.
- ``create_options(conn, http) -> CreateOptions``,
  ``types(conn, http, project) -> List[Choice]`` and
  ``create(conn, http, task: NewTask) -> ExternalTask``: a new task
  assigned to the connection's account.

They raise ``ProviderError`` with a message fit for the user.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, field_validator

Category = Literal["todo", "in_progress", "done"]

# Requests to a tracker give up after this many seconds.
TIMEOUT = 20.0
# Set by tests to answer requests without a network.
TRANSPORT: Optional[httpx.AsyncBaseTransport] = None


class ProviderError(Exception):
    """A tracker refused or failed a request.

    Attributes:
        message: What went wrong, in words for the user. Never
            contains the token.
        status_code: HTTP status the dashboard API answers with.
        retry_after: Seconds the tracker asked to wait, if any.
    """

    def __init__(self, message: str, status_code: int = 502, retry_after: float = 0):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        # Seconds the tracker asked to wait before the next try.
        self.retry_after = retry_after


@dataclass
class Conn:
    """A connection with its token decrypted, ready to use."""

    id: int
    name: str
    provider: str
    config: Dict[str, Any]
    # Left out of repr() so a logged Conn never shows the token.
    secret: str = field(repr=False)
    filters: Dict[str, Any] = field(default_factory=dict)


Priority = Literal["low", "medium", "high", "urgent"]


class TaskFields(BaseModel):
    """What every task has, wherever it comes from.

    Attributes:
        key: The tracker's own key (e.g. ``PROJ-12``), if any.
        title: One line summary.
        description: Longer text, as plain text; may be empty.
        status: The tracker's own status name.
        priority: Normalized priority, if any.
        due_date: Deadline as ``YYYY-MM-DD``, if any.
        tags: Free labels.
        assignee: Display name of who it is assigned to.
        url: Where to open it in the tracker.
        updated_at: Last change, ISO 8601.
    """

    key: Optional[str] = None
    title: str
    description: str = ""
    status: str
    priority: Optional[Priority] = None
    due_date: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    assignee: Optional[str] = None
    url: Optional[str] = None
    updated_at: Optional[str] = None

    @field_validator("url")
    @classmethod
    def _web_url(cls, value: Optional[str]) -> Optional[str]:
        """Keeps only http(s) links: the UI renders them as links,
        and a tracker could send e.g. a ``javascript:`` URL."""
        if value and urlparse(value).scheme in ("http", "https"):
            return value
        return None


class ExternalTask(TaskFields):
    """A task as a tracker reports it, before it is placed on
    the board (that depends on the user's status mapping).

    Attributes:
        external_id: Its ID in the tracker.
        category: The tracker's own kind of status: not
            started, started, done.
    """

    external_id: str
    category: Category


class Choice(BaseModel):
    """One allowed value of a field, or a person to pick."""

    id: str
    name: str


FieldKind = Literal[
    "select",
    "multiselect",
    "text",
    "richtext",
    "user",
    "date",
    "number",
    "unsupported",
]


class StatusField(BaseModel):
    """A field the tracker asks for when moving to a status.

    Attributes:
        id: The tracker's field ID.
        name: Its label.
        kind: How the dashboard asks for it; ``unsupported`` when
            it cannot, and the user must move the task in the
            tracker itself.
        options: Allowed values, for select kinds.
    """

    id: str
    name: str
    kind: FieldKind
    options: List[Choice] = Field(default_factory=list)


class Comment(BaseModel):
    """A comment on a tracker's task.

    Attributes:
        id: Its ID in the tracker.
        author: Display name of who wrote it.
        body: Its text, as plain text.
        created: When it was written, ISO 8601.
    """

    id: str
    author: str
    body: str
    created: Optional[str] = None


class CreateOptions(BaseModel):
    """What a new task in a tracker can be put in.

    Attributes:
        projects: Where it can go (Jira projects, Shortcut teams
            or workflows, Huly projects).
        priorities: The tracker's own priorities.
        create_url: Where to create it in the tracker itself,
            when the dashboard cannot (required extra fields).
    """

    projects: List[Choice] = Field(default_factory=list)
    priorities: List[Choice] = Field(default_factory=list)
    create_url: Optional[str] = None


class NewTask(BaseModel):
    """A task to create in a tracker.

    Attributes:
        project: A project ID from ``CreateOptions``.
        type: A type ID from ``types``; the tracker's default
            when None.
        priority: A priority ID from ``CreateOptions``, or None.
        title: One line summary.
        description: Plain text.
    """

    project: str = Field(..., min_length=1, max_length=200)
    type: Optional[str] = Field(None, max_length=200)
    priority: Optional[str] = Field(None, max_length=200)
    title: str = Field(..., max_length=300)
    description: str = Field("", max_length=20000)


class ExternalStatus(BaseModel):
    """A status a task can move to, as a tracker reports it.

    Attributes:
        fields: Required fields to fill on the way there.
    """

    id: str
    name: str
    category: Category
    fields: List[StatusField] = Field(default_factory=list)


# Filters every tracker understands (see ``normalize_filters``).
ASSIGNEES = ("me", "unassigned", "any")
DEFAULT_DONE_DAYS = 14


def normalize_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Validates and cleans a connection's filters.

    Args:
        filters: Any of:
            ``assignee``: ``me`` (default), ``unassigned`` or ``any``;
            ``projects``: project keys or names; empty for all;
            ``done_days``: show tasks finished in the last N days
            (0 to 90; 14 by default; 0 hides finished tasks);
            ``query``: the tracker's own query language (JQL for
            Jira, search syntax for Shortcut). When set, it is
            used instead of the fields above.

    Returns:
        The filters to save.

    Raises:
        ProviderError: 422 for a value out of range.
    """
    assignee = filters.get("assignee") or "me"
    if assignee not in ASSIGNEES:
        raise ProviderError("Assignee must be me, unassigned or any", 422)
    projects = filters.get("projects") or []
    if isinstance(projects, str):
        projects = projects.split(",")
    projects = list(dict.fromkeys(str(p).strip() for p in projects if str(p).strip()))
    if len(projects) > 20 or any(len(p) > 100 for p in projects):
        raise ProviderError("At most 20 projects of up to 100 characters", 422)
    try:
        done_days = int(filters.get("done_days", DEFAULT_DONE_DAYS))
    except (TypeError, ValueError) as e:
        raise ProviderError("Days of finished tasks must be a number", 422) from e
    if not 0 <= done_days <= 90:
        raise ProviderError("Days of finished tasks must be 0 to 90", 422)
    query = str(filters.get("query") or "").strip()
    if len(query) > 2000:
        raise ProviderError("The query is limited to 2000 characters", 422)
    return {
        "assignee": assignee,
        "projects": projects,
        "done_days": done_days,
        "query": query,
    }


def http_client() -> httpx.AsyncClient:
    """A client for talking to trackers."""
    return httpx.AsyncClient(timeout=TIMEOUT, transport=TRANSPORT)


def raise_for_response(response: httpx.Response, tracker: str) -> None:
    """Turns an HTTP error from a tracker into a ProviderError.

    Args:
        response: The tracker's answer.
        tracker: Its name, for the message (e.g. "Jira").

    Raises:
        ProviderError: For any status of 400 and above.
    """
    code = response.status_code
    if code < 400:
        return
    if code == 401:
        raise ProviderError(
            f"{tracker} rejected the credentials (HTTP 401). "
            "Check the token and its permissions.",
            status_code=400,
        )
    if code == 403:
        raise ProviderError(
            f"{tracker} does not allow this account to do that (HTTP 403).",
            status_code=403,
        )
    if code == 404:
        raise ProviderError(f"{tracker} has no such item (HTTP 404).", 404)
    if code == 429:
        try:
            wait = float(response.headers.get("Retry-After", "0"))
        except ValueError:
            wait = 0
        hint = f" Try again in {wait:.0f} seconds." if wait else ""
        raise ProviderError(
            f"{tracker} is rate limiting requests.{hint}", 429, retry_after=wait
        )
    detail = _error_detail(response)
    raise ProviderError(
        f"{tracker} answered HTTP {code}" + (f": {detail}" if detail else "."),
        status_code=422 if code == 400 else 502,
    )


def _error_detail(response: httpx.Response) -> str:
    """Best-effort error text from a tracker's JSON error body."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    messages = list(body.get("errorMessages") or [])
    errors = body.get("errors")
    if isinstance(errors, dict):
        messages += [f"{k}: {v}" for k, v in errors.items()]
    for key in ("message", "error"):
        if isinstance(body.get(key), str):
            messages.append(body[key])
    return "; ".join(str(m) for m in messages)[:300]


# ── Git tab ──────────────────────────────────────────────────
# GitHub and Bitbucket clients (``github``, ``bitbucket``) share
# the helpers above and expose these async functions, each
# taking a ``Conn`` and an ``httpx`` client:
#
# - ``normalize_config(config) -> dict`` (sync): settings to save.
# - ``check(conn, http) -> dict``: verifies the token; returns
#   ``account`` (who it belongs to) and ``user_id``, saved with
#   the settings.
# - ``fetch(conn, http) -> (List[PullRequest], List[Commit])``.
# - ``pr_context(conn, http, repo, number) -> PRContext``.
# - ``post_comment(conn, http, repo, number, body, path, line)
#   -> PostedComment``.

# "owner/name" (GitHub) or "workspace/slug" (Bitbucket). Checked
# before a repo name goes into an API path.
REPO_NAME = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}")
# Commits older than this many days are not listed.
COMMIT_DAYS = 14


def web_url(value: Optional[str]) -> Optional[str]:
    """Keeps only http(s) links, which the UI renders as links."""
    if value and urlparse(value).scheme in ("http", "https"):
        return value
    return None


def check_repo(repo: str) -> str:
    """Refuses a repo name that could reach another API path.

    Raises:
        ProviderError: 404 for a malformed name.
    """
    if not REPO_NAME.fullmatch(repo) or ".." in repo:
        raise ProviderError("No such repository.", 404)
    return repo


class _Linked(BaseModel):
    """A thing with a web link; only http(s) links are kept."""

    url: Optional[str] = None

    @field_validator("url")
    @classmethod
    def _web_url(cls, value: Optional[str]) -> Optional[str]:
        return web_url(value)


class PullRequest(_Linked):
    """A pull request as the Git tab shows it.

    Attributes:
        repo: ``owner/name`` or ``workspace/slug``.
        number: Its number in the repository.
        state: open, draft, merged or closed.
        roles: Why it is on the user's list: they wrote it
            (author), it is assigned to them (assignee), or their
            review is requested (reviewer).
        review: Where reviews stand: approved, changes_requested,
            pending; None when nobody was asked.
        checks: Combined CI status of the last commit; None when
            unknown (always for Bitbucket).
        updated_at: Last change, ISO 8601.
    """

    repo: str
    number: int
    title: str
    author: Optional[str] = None
    state: Literal["open", "draft", "merged", "closed"]
    roles: List[Literal["author", "assignee", "reviewer"]] = Field(default_factory=list)
    review: Optional[Literal["approved", "changes_requested", "pending"]] = None
    checks: Optional[Literal["success", "failure", "pending"]] = None
    source_branch: Optional[str] = None
    target_branch: Optional[str] = None
    updated_at: Optional[str] = None


class Commit(_Linked):
    """A commit the user wrote.

    Attributes:
        message: First line of the commit message.
        branch: Branch it was found on, when known.
        date: When it was committed, ISO 8601.
    """

    repo: str
    sha: str
    message: str
    branch: Optional[str] = None
    date: Optional[str] = None


class PRContext(BaseModel):
    """What a review of a pull request is based on.

    Attributes:
        diff: Unified diff of the changes, as text.
        head_sha: Last commit of the source branch.
    """

    repo: str
    number: int
    title: str
    description: str = ""
    source_branch: Optional[str] = None
    target_branch: Optional[str] = None
    head_sha: Optional[str] = None
    diff: str


class PostedComment(_Linked):
    """A comment posted on a pull request.

    Attributes:
        url: Where to see it, when the host says.
        inline: False when it was posted as a general comment
            (no line given, or the line is not in the diff).
    """

    inline: bool


def recent(date: Optional[str]) -> bool:
    """Whether an ISO 8601 time falls in the last ``COMMIT_DAYS``
    days. Unreadable or missing times count as old."""
    try:
        when = datetime.fromisoformat((date or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when >= datetime.now(timezone.utc) - timedelta(days=COMMIT_DAYS)


def general_body(body: str, path: Optional[str], line: Optional[int]) -> str:
    """A comment's text when it is posted as a general comment
    instead of on a line: the place it refers to goes first."""
    if not path:
        return body
    place = f"{path}:{line}" if line else path
    return f"`{place}`\n\n{body}"


def merge_roles(prs: List[PullRequest]) -> List[PullRequest]:
    """One entry per pull request, with the roles of every copy.

    A PR found by several searches (e.g. authored and assigned)
    is listed once.
    """
    merged: Dict[Tuple[str, int], PullRequest] = {}
    for pr in prs:
        key = (pr.repo.lower(), pr.number)
        if key in merged:
            roles = merged[key].roles + [
                r for r in pr.roles if r not in merged[key].roles
            ]
            merged[key] = merged[key].model_copy(update={"roles": roles})
        else:
            merged[key] = pr
    return list(merged.values())


def newest_commits(commits: List[Commit], limit: int = 100) -> List[Commit]:
    """Drops repeats (same repo and SHA), newest first."""
    seen: Dict[Tuple[str, str], Commit] = {}
    for commit in commits:
        seen.setdefault((commit.repo.lower(), commit.sha), commit)
    ordered = sorted(seen.values(), key=lambda c: c.date or "", reverse=True)
    return ordered[:limit]
