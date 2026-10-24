"""Jira Cloud client for the Tasks tab.

Talks to the REST API v3 of a ``*.atlassian.net`` site with
HTTP Basic auth: the account's email and an API token.

Issues are found with the ``/rest/api/3/search/jql`` endpoint
(the older ``/search`` was removed from Jira Cloud). Jira never
sets a status directly: an issue moves through the transitions
its workflow allows.
"""

import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse

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
    StatusField,
    raise_for_response,
)
from . import normalize_filters as common_filters

NAME = "Jira"
# Fields asked for on every issue.
FIELDS = [
    "summary",
    "status",
    "priority",
    "duedate",
    "labels",
    "assignee",
    "updated",
    "description",
]
# Stop paging after this many issues: the board is for the
# user's own work, not a whole project.
MAX_ISSUES = 500

# Hosts of Jira Cloud sites.
CLOUD_DOMAINS = (".atlassian.net", ".jira.com")
# An issue key, e.g. "WEB-12".
_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]*-[0-9]+")

# Jira status category key -> board category.
_CATEGORY = {"new": "todo", "indeterminate": "in_progress", "done": "done"}

# Jira priority names, lowercased -> normalized priority.
_PRIORITY = {
    "highest": "urgent",
    "blocker": "urgent",
    "critical": "urgent",
    "urgent": "urgent",
    "high": "high",
    "major": "high",
    "medium": "medium",
    "normal": "medium",
    "low": "low",
    "lowest": "low",
    "minor": "low",
    "trivial": "low",
}


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validates and cleans a Jira connection's settings.

    Args:
        config: ``site`` (the Jira Cloud URL) and ``email``.

    Returns:
        The settings with the site as ``https://host``.

    Raises:
        ProviderError: 422 for a missing email or a site that is
            not an https URL.
    """
    site = str(config.get("site") or "").strip().rstrip("/")
    if site and "://" not in site:
        site = f"https://{site}"
    parsed = urlparse(site)
    host = (parsed.hostname or "").lower()
    # Jira Cloud only: the token is never sent to any other host.
    if parsed.scheme != "https" or not host.endswith(CLOUD_DOMAINS):
        raise ProviderError(
            "Site must be the https address of your Jira Cloud, "
            "e.g. https://your-team.atlassian.net",
            422,
        )
    email = str(config.get("email") or "").strip()
    if "@" not in email:
        raise ProviderError("Email of the Jira account is required", 422)
    return {"site": f"https://{parsed.netloc}", "email": email}


def _key(external_id: str) -> str:
    """An issue key fit for a URL path.

    Raises:
        ProviderError: 404 for anything that is not an issue key.
    """
    if not _KEY.fullmatch(external_id):
        raise ProviderError("Jira has no such issue", 404)
    return external_id


def _auth(conn: Conn) -> httpx.BasicAuth:
    return httpx.BasicAuth(conn.config["email"], conn.secret)


def _url(conn: Conn, path: str) -> str:
    return f"{conn.config['site']}/rest/api/3{path}"


async def _request(
    conn: Conn, http: httpx.AsyncClient, method: str, path: str, **kwargs
) -> httpx.Response:
    """Sends one request to the connection's Jira.

    Raises:
        ProviderError: When Jira cannot be reached or refuses.
    """
    try:
        response = await http.request(
            method,
            _url(conn, path),
            auth=_auth(conn),
            headers={"Accept": "application/json"},
            **kwargs,
        )
    except httpx.HTTPError as e:
        raise ProviderError(
            f"Could not reach Jira at {conn.config['site']}: {type(e).__name__}"
        ) from e
    raise_for_response(response, NAME)
    return response


def adf_to_text(node: Any) -> str:  # pylint: disable=too-many-return-statements
    """Flattens an Atlassian Document Format tree to plain text.

    Paragraphs, headings and list items end with a line break;
    every other node contributes its text only.

    Args:
        node: An ADF document or node, a plain string (older
            API versions), or None.

    Returns:
        The text, without trailing blank lines.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        return node.get("text", "")
    if kind == "hardBreak":
        return "\n"
    if kind in ("mention", "emoji"):
        attrs = node.get("attrs") or {}
        return attrs.get("text") or attrs.get("shortName") or ""
    inner = adf_to_text(node.get("content"))
    if kind == "listItem":
        return f"- {inner.strip()}\n"
    if kind in ("paragraph", "heading", "codeBlock", "blockquote"):
        return f"{inner}\n"
    return inner.rstrip("\n") if kind == "doc" else inner


def priority_of(name: Optional[str]) -> Optional[str]:
    """Normalizes a Jira priority name; None when unknown."""
    return _PRIORITY.get((name or "").strip().lower())


def category_of(status: Dict[str, Any]) -> str:
    """Board category of a Jira status object."""
    key = (status.get("statusCategory") or {}).get("key")
    return _CATEGORY.get(key, "todo")


def task_from_issue(conn: Conn, issue: Dict[str, Any]) -> ExternalTask:
    """Converts a Jira issue (with ``FIELDS``) to an ExternalTask."""
    fields = issue.get("fields") or {}
    status = fields.get("status") or {}
    assignee = fields.get("assignee") or {}
    key = issue["key"]
    return ExternalTask(
        external_id=key,
        key=key,
        title=fields.get("summary") or key,
        description=adf_to_text(fields.get("description")),
        status=status.get("name") or "Unknown",
        category=category_of(status),
        priority=priority_of((fields.get("priority") or {}).get("name")),
        due_date=fields.get("duedate"),
        tags=list(fields.get("labels") or []),
        assignee=assignee.get("displayName"),
        url=f"{conn.config['site']}/browse/{key}",
        updated_at=fields.get("updated"),
    )


def _quote(value: str) -> str:
    """A JQL string literal."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def build_jql(filters: Dict[str, Any]) -> str:
    """The JQL a connection's filters select.

    Args:
        filters: As ``providers.normalize_filters`` returns them;
            ``query``, when set, is used as it is.

    Returns:
        A JQL query, newest change first unless the user's own
        query orders it.
    """
    query = str(filters.get("query") or filters.get("jql") or "").strip()
    if query:
        return query
    clauses = []
    assignee = filters.get("assignee", "me")
    if assignee == "me":
        clauses.append("assignee = currentUser()")
    elif assignee == "unassigned":
        clauses.append("assignee is EMPTY")
    projects = filters.get("projects") or []
    if projects:
        clauses.append(f"project in ({', '.join(_quote(p) for p in projects)})")
    days = filters.get("done_days", DEFAULT_DONE_DAYS)
    if days:
        clauses.append(
            f"(statusCategory != Done OR statusCategoryChangedDate >= -{days}d)"
        )
    else:
        clauses.append("statusCategory != Done")
    return " AND ".join(clauses) + " ORDER BY updated DESC"


async def check(conn: Conn, http: httpx.AsyncClient) -> str:
    """Verifies the credentials.

    Returns:
        The Jira account's display name.
    """
    try:
        me = (await _request(conn, http, "GET", "/myself")).json()
    except ProviderError as e:
        if e.status_code == 404:
            raise ProviderError(
                f"No Jira Cloud site answers at {conn.config['site']}. "
                "Check the address.",
                422,
            ) from e
        raise
    return me.get("displayName") or me.get("emailAddress") or conn.config["email"]


async def fetch(conn: Conn, http: httpx.AsyncClient) -> List[ExternalTask]:
    """Reads the issues the connection's filter selects.

    Pages with ``nextPageToken`` until Jira says it is the last
    page, or ``MAX_ISSUES`` issues were read.
    """
    tasks: List[ExternalTask] = []
    token: Optional[str] = None
    while len(tasks) < MAX_ISSUES:
        body: Dict[str, Any] = {
            "jql": build_jql(conn.filters),
            "fields": FIELDS,
            "maxResults": 100,
        }
        if token:
            body["nextPageToken"] = token
        page = (await _request(conn, http, "POST", "/search/jql", json=body)).json()
        tasks += [task_from_issue(conn, issue) for issue in page.get("issues", [])]
        token = page.get("nextPageToken")
        if page.get("isLast", True) or not token:
            break
    return tasks[:MAX_ISSUES]


async def get_issue(conn: Conn, http: httpx.AsyncClient, key: str) -> ExternalTask:
    """Reads one issue as it is now."""
    issue = (
        await _request(
            conn,
            http,
            "GET",
            f"/issue/{_key(key)}",
            params={"fields": ",".join(FIELDS)},
        )
    ).json()
    return task_from_issue(conn, issue)


# Select-like field types: their value is ``{"id": ...}``.
_SELECT_TYPES = {
    "option",
    "priority",
    "resolution",
    "version",
    "component",
    "issuetype",
    "securitylevel",
}
# Text fields that Jira's API v3 takes as a document (ADF).
_RICH_SYSTEM = {"description", "environment"}


def field_kind(meta: Dict[str, Any]) -> str:
    """How the dashboard asks for a transition screen field.

    Args:
        meta: The field as ``expand=transitions.fields`` gives it.

    Returns:
        A ``StatusField`` kind.
    """
    # pylint: disable=too-many-return-statements
    schema = meta.get("schema") or {}
    kind = schema.get("type")
    custom = schema.get("custom") or ""
    if kind == "array":
        items = schema.get("items")
        if items in _SELECT_TYPES or meta.get("allowedValues"):
            return "multiselect"
        return "unsupported"
    if kind in _SELECT_TYPES or (meta.get("allowedValues") and kind != "user"):
        return "select"
    if kind == "string":
        if schema.get("system") in _RICH_SYSTEM or custom.endswith(":textarea"):
            return "richtext"
        return "text"
    if kind in ("user", "date", "number"):
        return kind
    return "unsupported"


def _choices(meta: Dict[str, Any]) -> List[Choice]:
    """A select field's allowed values."""
    return [
        Choice(id=str(v["id"]), name=str(v.get("name") or v.get("value") or v["id"]))
        for v in meta.get("allowedValues") or []
        if "id" in v
    ]


def _required_fields(transition: Dict[str, Any]) -> List[StatusField]:
    """The fields a transition's screen requires and has no
    default for."""
    fields = []
    for field_id, meta in (transition.get("fields") or {}).items():
        if not meta.get("required") or meta.get("hasDefaultValue"):
            continue
        fields.append(
            StatusField(
                id=field_id,
                name=meta.get("name") or field_id,
                kind=field_kind(meta),
                options=_choices(meta),
            )
        )
    return fields


async def _transitions(
    conn: Conn, http: httpx.AsyncClient, key: str
) -> List[Dict[str, Any]]:
    """The issue's transitions, with their screen fields."""
    data = (
        await _request(
            conn,
            http,
            "GET",
            f"/issue/{_key(key)}/transitions",
            params={"expand": "transitions.fields"},
        )
    ).json()
    return data.get("transitions", [])


async def statuses(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[ExternalStatus]:
    """The transitions the issue's workflow allows from where it is.

    Each option's ID is the transition's; its name is the status
    the transition leads to, which is what the user picks. Fields
    the transition's screen requires come with it.
    """
    options = []
    for transition in await _transitions(conn, http, external_id):
        target = transition.get("to") or {}
        options.append(
            ExternalStatus(
                id=str(transition["id"]),
                name=target.get("name") or transition.get("name") or "?",
                category=category_of(target),
                fields=_required_fields(transition),
            )
        )
    return options


def text_to_adf(text: str) -> Dict[str, Any]:
    """Wraps plain text in an ADF document, a paragraph per line."""
    return {
        "type": "doc",
        "version": 1,
        "content": [
            (
                {"type": "paragraph", "content": [{"type": "text", "text": line}]}
                if line
                else {"type": "paragraph", "content": []}
            )
            for line in text.split("\n")
        ],
    }


def field_value(  # pylint: disable=too-many-return-statements
    field: StatusField, value: Any
) -> Any:
    """Turns what the form sent into what Jira expects.

    Raises:
        ProviderError: 422 for an empty value, one not offered,
            or a field the dashboard cannot fill.
    """
    if value in (None, "", []):
        raise ProviderError(f"{field.name} is required", 422)
    allowed = {c.id for c in field.options}
    if field.kind == "select":
        if allowed and str(value) not in allowed:
            raise ProviderError(f"{field.name}: value not allowed", 422)
        return {"id": str(value)}
    if field.kind == "multiselect":
        values = [str(v) for v in (value if isinstance(value, list) else [value])]
        if allowed and not set(values) <= allowed:
            raise ProviderError(f"{field.name}: value not allowed", 422)
        return [{"id": v} for v in values]
    if field.kind == "richtext":
        return text_to_adf(str(value))
    if field.kind == "user":
        return {"accountId": str(value)}
    if field.kind == "number":
        try:
            return float(value)
        except (TypeError, ValueError) as e:
            raise ProviderError(f"{field.name} must be a number", 422) from e
    if field.kind in ("text", "date"):
        return str(value)
    raise ProviderError(
        f"{field.name} cannot be filled from the dashboard; " "move the issue in Jira.",
        422,
    )


async def set_status(
    conn: Conn,
    http: httpx.AsyncClient,
    external_id: str,
    status_id: str,
    fields: Optional[Dict[str, Any]] = None,
) -> ExternalTask:
    """Applies a transition and returns the issue as it is after.

    When the transition's screen requires fields, their values
    are checked against the screen and shaped as Jira expects.

    Args:
        conn: The connection.
        http: HTTP client.
        external_id: The issue key.
        status_id: A transition ID from ``statuses``.
        fields: Values for the required fields, by field ID, as
            the form sends them (IDs for selects, text, ...).

    Raises:
        ProviderError: 422 for a missing or invalid field value,
            or a transition that is no longer possible.
    """
    body: Dict[str, Any] = {"transition": {"id": status_id}}
    transition = next(
        (
            t
            for t in await _transitions(conn, http, external_id)
            if str(t.get("id")) == status_id
        ),
        None,
    )
    if transition is None:
        raise ProviderError(
            "This issue cannot make that move any more; refresh and try again.",
            422,
        )
    required = _required_fields(transition)
    if required:
        given = fields or {}
        body["fields"] = {f.id: field_value(f, given.get(f.id)) for f in required}
    await _request(
        conn, http, "POST", f"/issue/{_key(external_id)}/transitions", json=body
    )
    return await get_issue(conn, http, external_id)


async def search_users(
    conn: Conn, http: httpx.AsyncClient, external_id: str, query: str
) -> List[Choice]:
    """People the issue can be assigned to whose name matches.

    Args:
        conn: The connection.
        http: HTTP client.
        external_id: The issue key.
        query: Part of a name or email; may be empty.

    Returns:
        Up to 20 people, by account ID.
    """
    users = (
        await _request(
            conn,
            http,
            "GET",
            "/user/assignable/search",
            params={"issueKey": external_id, "query": query, "maxResults": 20},
        )
    ).json()
    return [
        Choice(id=u["accountId"], name=u.get("displayName") or u["accountId"])
        for u in users
        if u.get("accountId")
    ]


def normalize_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Validates a Jira connection's filters; ``query`` is JQL."""
    return common_filters(filters)


def _comment(raw: Dict[str, Any]) -> Comment:
    """Converts a Jira comment to a Comment."""
    return Comment(
        id=str(raw.get("id")),
        author=(raw.get("author") or {}).get("displayName") or "Someone",
        body=adf_to_text(raw.get("body")),
        created=raw.get("created"),
    )


async def comments(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[Comment]:
    """The issue's latest 100 comments, oldest first."""
    data = (
        await _request(
            conn,
            http,
            "GET",
            f"/issue/{_key(external_id)}/comment",
            params={"orderBy": "-created", "maxResults": 100},
        )
    ).json()
    return list(reversed([_comment(c) for c in data.get("comments", [])]))


async def add_comment(
    conn: Conn, http: httpx.AsyncClient, external_id: str, text: str
) -> Comment:
    """Adds a plain-text comment to the issue."""
    raw = (
        await _request(
            conn,
            http,
            "POST",
            f"/issue/{_key(external_id)}/comment",
            json={"body": text_to_adf(text)},
        )
    ).json()
    return _comment(raw)


async def assign(
    conn: Conn, http: httpx.AsyncClient, external_id: str, user_id: Optional[str]
) -> ExternalTask:
    """Assigns the issue to an account, or to nobody."""
    await _request(
        conn,
        http,
        "PUT",
        f"/issue/{_key(external_id)}/assignee",
        json={"accountId": user_id},
    )
    return await get_issue(conn, http, external_id)


async def create_options(conn: Conn, http: httpx.AsyncClient) -> CreateOptions:
    """The projects the account can see (up to 100) and Jira's
    priorities."""
    projects = (
        await _request(
            conn,
            http,
            "GET",
            "/project/search",
            params={"maxResults": 100, "orderBy": "name"},
        )
    ).json()
    priorities = (
        await _request(conn, http, "GET", "/priority/search", params={"maxResults": 50})
    ).json()
    return CreateOptions(
        projects=[
            Choice(id=p["key"], name=f"{p.get('name') or p['key']} ({p['key']})")
            for p in projects.get("values", [])
        ],
        priorities=[
            Choice(id=str(p["id"]), name=p.get("name") or str(p["id"]))
            for p in priorities.get("values", [])
        ],
        create_url=f"{conn.config['site']}/secure/CreateIssue!default.jspa",
    )


async def types(conn: Conn, http: httpx.AsyncClient, project: str) -> List[Choice]:
    """The issue types a project allows, sub-tasks left out."""
    data = (
        await _request(
            conn,
            http,
            "GET",
            f"/issue/createmeta/{quote(project, safe='')}/issuetypes",
            params={"maxResults": 50},
        )
    ).json()
    found = data.get("issueTypes") or data.get("values") or []
    return [
        Choice(id=str(t["id"]), name=t.get("name") or str(t["id"]))
        for t in found
        if not t.get("subtask")
    ]


async def create(conn: Conn, http: httpx.AsyncClient, task: NewTask) -> ExternalTask:
    """Creates an issue assigned to the connection's account.

    Without a type, the project's first type that is not a
    sub-task (usually "Task") is used.

    Raises:
        ProviderError: 422 when Jira asks for more fields; its
            message names them.
    """
    type_id = task.type
    if not type_id:
        found = await types(conn, http, task.project)
        if not found:
            raise ProviderError("This project has no issue type to create", 422)
        type_id = found[0].id
    me = (await _request(conn, http, "GET", "/myself")).json()
    fields: Dict[str, Any] = {
        "project": {"key": task.project},
        "issuetype": {"id": type_id},
        "summary": task.title,
        "assignee": {"accountId": me.get("accountId")},
    }
    if task.description.strip():
        fields["description"] = text_to_adf(task.description)
    if task.priority:
        fields["priority"] = {"id": task.priority}
    created = (
        await _request(conn, http, "POST", "/issue", json={"fields": fields})
    ).json()
    return await get_issue(conn, http, created["key"])
