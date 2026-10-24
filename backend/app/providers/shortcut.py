"""Shortcut client for the Tasks tab.

Talks to the REST API v3 at ``api.app.shortcut.com`` with an
API token in the ``Shortcut-Token`` header.

Stories are found with Shortcut's search syntax
(``/search/stories``). A story's status is its workflow state;
any state of the story's workflow can be set directly.
"""

from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import (
    DEFAULT_DONE_DAYS,
    Choice,
    Comment,
    Conn,
    CreateOptions,
    ExternalStatus,
    ExternalTask,
    NewTask,
    ProviderError,
    raise_for_response,
)
from . import normalize_filters as common_filters
from .jira import priority_of

NAME = "Shortcut"
BASE = "https://api.app.shortcut.com/api/v3"
# Stop paging after this many stories.
MAX_STORIES = 500
# Workflow state type -> board category.
_CATEGORY = {
    "backlog": "todo",
    "unstarted": "todo",
    "started": "in_progress",
    "done": "done",
}
STORY_TYPES = [
    Choice(id="feature", name="Feature"),
    Choice(id="bug", name="Bug"),
    Choice(id="chore", name="Chore"),
]


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """A Shortcut connection needs no settings besides its token.

    Args:
        config: Ignored.

    Returns:
        An empty dict.
    """
    del config
    return {}


def normalize_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Validates filters; ``projects`` are team names and
    ``query`` uses Shortcut's search syntax."""
    return common_filters(filters)


async def _request(
    conn: Conn, http: httpx.AsyncClient, method: str, path: str, **kwargs
) -> httpx.Response:
    """Sends one request to Shortcut.

    Args:
        path: Either a path under ``/api/v3`` (``/member``), or a
            ``next`` link as Shortcut returns it (``/api/v3/...``).

    Raises:
        ProviderError: When Shortcut cannot be reached or refuses.
    """
    url = (
        f"https://api.app.shortcut.com{path}"
        if path.startswith("/api/")
        else f"{BASE}{path}"
    )
    try:
        response = await http.request(
            method,
            url,
            headers={"Shortcut-Token": conn.secret, "Accept": "application/json"},
            **kwargs,
        )
    except httpx.HTTPError as e:
        raise ProviderError(f"Could not reach Shortcut: {type(e).__name__}") from e
    raise_for_response(response, NAME)
    return response


async def _get(conn: Conn, http: httpx.AsyncClient, path: str, **kwargs) -> Any:
    return (await _request(conn, http, "GET", path, **kwargs)).json()


async def _send(
    conn: Conn, http: httpx.AsyncClient, method: str, path: str, body: Dict[str, Any]
) -> Any:
    """Sends a JSON body; returns Shortcut's JSON answer."""
    return (await _request(conn, http, method, path, json=body)).json()


class _Lookups:
    """Names Shortcut stories refer to by ID, read once per call:
    workflow states and members."""

    def __init__(self, workflows: List[Dict[str, Any]], members: List[Dict[str, Any]]):
        self.states: Dict[int, Tuple[str, str]] = {}
        self.workflow_states: Dict[int, List[Dict[str, Any]]] = {}
        for workflow in workflows:
            self.workflow_states[workflow["id"]] = workflow.get("states", [])
            for state in workflow.get("states", []):
                self.states[state["id"]] = (
                    state.get("name") or str(state["id"]),
                    _CATEGORY.get(state.get("type"), "todo"),
                )
        self.members = {
            m["id"]: (m.get("profile") or {}).get("name") or m["id"] for m in members
        }


async def _lookups(conn: Conn, http: httpx.AsyncClient) -> _Lookups:
    return _Lookups(
        await _get(conn, http, "/workflows"), await _get(conn, http, "/members")
    )


def _priority(story: Dict[str, Any]) -> Optional[str]:
    """The story's priority from its custom fields, normalized.

    Shortcut's built-in Priority field holds values like
    "Highest" or "Low"; any field value that names a priority
    counts.
    """
    for field in story.get("custom_fields") or []:
        found = priority_of(field.get("value"))
        if found:
            return found
    return None


def task_from_story(story: Dict[str, Any], lookups: _Lookups) -> ExternalTask:
    """Converts a Shortcut story to an ExternalTask."""
    name, category = lookups.states.get(
        story.get("workflow_state_id"), ("Unknown", "todo")
    )
    owners = [lookups.members.get(o, "Someone") for o in story.get("owner_ids") or []]
    deadline = story.get("deadline")
    return ExternalTask(
        external_id=str(story["id"]),
        key=f"sc-{story['id']}",
        title=story.get("name") or f"Story {story['id']}",
        description=story.get("description") or "",
        status=name,
        category=category,
        priority=_priority(story),
        due_date=deadline[:10] if deadline else None,
        tags=[
            label.get("name")
            for label in story.get("labels") or []
            if label.get("name")
        ],
        assignee=", ".join(owners) or None,
        url=story.get("app_url"),
        updated_at=story.get("updated_at"),
    )


def _quote(value: str) -> str:
    """A search term value, quoted when it has spaces."""
    value = value.replace('"', "")
    return f'"{value}"' if " " in value else value


def build_queries(filters: Dict[str, Any], mention_name: str) -> List[str]:
    """The searches a connection's filters select.

    Shortcut's search has no OR, so unfinished and recently
    finished stories are two searches.

    Args:
        filters: As ``providers.normalize_filters`` returns them.
        mention_name: The token owner's @mention name.

    Returns:
        One or two search queries.
    """
    query = str(filters.get("query") or "").strip()
    if query:
        return [query]
    terms = ["!is:archived"]
    assignee = filters.get("assignee", "me")
    if assignee == "me":
        terms.append(f"owner:{mention_name}")
    elif assignee == "unassigned":
        terms.append("!has:owner")
    teams = filters.get("projects") or []
    if len(teams) == 1:
        terms.append(f"team:{_quote(teams[0])}")
    base = " ".join(terms)
    queries = [f"{base} !is:done"]
    days = filters.get("done_days", DEFAULT_DONE_DAYS)
    if days:
        since = (date.today() - timedelta(days=days)).isoformat()
        queries.append(f"{base} is:done completed:{since}..*")
    return queries


async def check(conn: Conn, http: httpx.AsyncClient) -> str:
    """Verifies the token; returns the member's name."""
    me = await _get(conn, http, "/member")
    return me.get("name") or me.get("mention_name") or "Shortcut member"


async def fetch(conn: Conn, http: httpx.AsyncClient) -> List[ExternalTask]:
    """Reads the stories the connection's filters select."""
    me = await _get(conn, http, "/member")
    lookups = await _lookups(conn, http)
    teams = set(conn.filters.get("projects") or [])
    group_ids = None
    if len(teams) > 1:
        # The search takes one team; several are filtered here.
        groups = await _get(conn, http, "/groups")
        group_ids = {g["id"] for g in groups if g.get("name") in teams}
    found: Dict[str, ExternalTask] = {}
    for query in build_queries(conn.filters, me.get("mention_name", "")):
        page = await _get(
            conn,
            http,
            "/search/stories",
            params={"query": query, "page_size": 25, "detail": "full"},
        )
        while True:
            for story in page.get("data") or []:
                if group_ids is not None and story.get("group_id") not in group_ids:
                    continue
                task = task_from_story(story, lookups)
                found[task.external_id] = task
            if not page.get("next") or len(found) >= MAX_STORIES:
                break
            page = await _get(conn, http, page["next"])
    return list(found.values())[:MAX_STORIES]


def _story_id(external_id: str) -> int:
    """The numeric story ID.

    Raises:
        ProviderError: 404 for anything else.
    """
    if not (external_id.isascii() and external_id.isdigit()):
        raise ProviderError("Shortcut has no such story", 404)
    return int(external_id)


async def get_story(conn: Conn, http: httpx.AsyncClient, external_id: str):
    """Reads one story as it is now, with what names it needs."""
    story = await _get(conn, http, f"/stories/{_story_id(external_id)}")
    return story, await _lookups(conn, http)


async def statuses(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[ExternalStatus]:
    """Every state of the story's workflow."""
    story, lookups = await get_story(conn, http, external_id)
    return [
        ExternalStatus(
            id=str(state["id"]),
            name=state.get("name") or str(state["id"]),
            category=_CATEGORY.get(state.get("type"), "todo"),
        )
        for state in lookups.workflow_states.get(story.get("workflow_id"), [])
        if state["id"] != story.get("workflow_state_id")
    ]


async def _update(
    conn: Conn, http: httpx.AsyncClient, external_id: str, change: Dict[str, Any]
) -> ExternalTask:
    story = await _send(conn, http, "PUT", f"/stories/{_story_id(external_id)}", change)
    return task_from_story(story, await _lookups(conn, http))


async def set_status(
    conn: Conn,
    http: httpx.AsyncClient,
    external_id: str,
    status_id: str,
    fields: Optional[Dict[str, Any]] = None,
) -> ExternalTask:
    """Moves the story to a workflow state (no fields needed)."""
    del fields
    if not (status_id.isascii() and status_id.isdigit()):
        raise ProviderError("Unknown Shortcut workflow state", 422)
    return await _update(conn, http, external_id, {"workflow_state_id": int(status_id)})


async def search_users(
    conn: Conn, http: httpx.AsyncClient, external_id: str, query: str
) -> List[Choice]:
    """Active members whose name, @mention or email matches."""
    del external_id
    needle = query.strip().lower()
    found = []
    for member in await _get(conn, http, "/members"):
        profile = member.get("profile") or {}
        if member.get("disabled") or profile.get("deactivated"):
            continue
        text = " ".join(
            str(profile.get(k) or "") for k in ("name", "mention_name", "email_address")
        ).lower()
        if needle in text:
            found.append(
                Choice(id=member["id"], name=profile.get("name") or member["id"])
            )
    return sorted(found, key=lambda c: c.name.lower())[:20]


async def assign(
    conn: Conn, http: httpx.AsyncClient, external_id: str, user_id: Optional[str]
) -> ExternalTask:
    """Makes one member the story's owner, or leaves it with none."""
    return await _update(
        conn, http, external_id, {"owner_ids": [user_id] if user_id else []}
    )


async def comments(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[Comment]:
    """The story's comments, oldest first, deleted ones left out."""
    found = await _get(conn, http, f"/stories/{_story_id(external_id)}/comments")
    members = (await _lookups(conn, http)).members
    return [
        Comment(
            id=str(c["id"]),
            author=members.get(c.get("author_id"), "Someone"),
            body=c.get("text") or "",
            created=c.get("created_at"),
        )
        for c in sorted(found, key=lambda c: c.get("created_at") or "")
        if not c.get("deleted")
    ]


async def add_comment(
    conn: Conn, http: httpx.AsyncClient, external_id: str, text: str
) -> Comment:
    """Adds a comment to the story."""
    raw = await _send(
        conn,
        http,
        "POST",
        f"/stories/{_story_id(external_id)}/comments",
        {"text": text},
    )
    members = (await _lookups(conn, http)).members
    return Comment(
        id=str(raw["id"]),
        author=members.get(raw.get("author_id"), "Someone"),
        body=raw.get("text") or text,
        created=raw.get("created_at"),
    )


async def _priority_field(conn: Conn, http: httpx.AsyncClient) -> Optional[dict]:
    """Shortcut's built-in Priority custom field, when enabled."""
    for field in await _get(conn, http, "/custom-fields"):
        if field.get("canonical_name") == "priority" and field.get("enabled"):
            return field
    return None


async def create_options(conn: Conn, http: httpx.AsyncClient) -> CreateOptions:
    """Workflows as "projects" (the story starts in its first
    unstarted state) and the Priority field's values."""
    me = await _get(conn, http, "/member")
    workflows = await _get(conn, http, "/workflows")
    field = await _priority_field(conn, http)
    slug = (me.get("workspace2") or {}).get("url_slug")
    return CreateOptions(
        projects=[
            Choice(id=str(w["id"]), name=w.get("name") or str(w["id"]))
            for w in workflows
        ],
        priorities=[
            Choice(id=v["id"], name=v.get("value") or v["id"])
            for v in (field or {}).get("values") or []
        ],
        create_url=f"https://app.shortcut.com/{slug}/stories/new" if slug else None,
    )


async def types(conn: Conn, http: httpx.AsyncClient, project: str) -> List[Choice]:
    """Shortcut's story types; the same in every workflow."""
    del conn, http, project
    return STORY_TYPES


async def create(conn: Conn, http: httpx.AsyncClient, task: NewTask) -> ExternalTask:
    """Creates a story owned by the token's member.

    Raises:
        ProviderError: 422 for an unknown workflow or story type.
    """
    workflows = {str(w["id"]): w for w in await _get(conn, http, "/workflows")}
    workflow = workflows.get(task.project)
    if workflow is None:
        raise ProviderError("Unknown Shortcut workflow", 422)
    states = workflow.get("states") or []
    start = next(
        (s for s in states if s.get("type") == "unstarted"),
        {"id": workflow.get("default_state_id")},
    )
    story_type = task.type or "feature"
    if story_type not in {t.id for t in STORY_TYPES}:
        raise ProviderError("Story type must be feature, bug or chore", 422)
    me = await _get(conn, http, "/member")
    body: Dict[str, Any] = {
        "name": task.title,
        "description": task.description,
        "story_type": story_type,
        "workflow_state_id": start["id"],
        "owner_ids": [me["id"]],
    }
    if task.priority:
        field = await _priority_field(conn, http)
        if field is None:
            raise ProviderError("This workspace has no Priority field", 422)
        body["custom_fields"] = [{"field_id": field["id"], "value_id": task.priority}]
    story = await _send(conn, http, "POST", "/stories", body)
    return task_from_story(story, await _lookups(conn, http))
