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

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

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
