"""Huly (self-hosted, 0.7) client for the Tasks tab. EXPERIMENTAL.

Huly has no documented public API. This speaks the same HTTP
protocol as Huly's own TypeScript client (``@hcengineering/
api-client``), so it may break when Huly changes it:

1. ``GET {url}/config.json`` gives the accounts service URL.
2. JSON-RPC to the accounts service: ``login`` (email and
   password), then ``selectWorkspace``, which gives a workspace
   token, the workspace UUID and the transactor endpoint.
3. REST on the transactor: ``/api/v1/find-all/{workspace}`` to
   read documents and ``/api/v1/tx/{workspace}`` to change them
   with transactions (``TxUpdateDoc``, ``TxCreateDoc``).
4. Issue descriptions are collaborative documents kept by the
   collaborator service; they are written through its RPC.

Sessions are kept in memory for a while, so a read does not log
in every time.
"""

import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from itertools import count
from typing import Any, Dict, List, Optional, Tuple
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
    raise_for_response,
)
from . import normalize_filters as common_filters
from .jira import adf_to_text

NAME = "Huly"
ISSUE = "tracker:class:Issue"
PROJECT = "tracker:class:Project"
STATUS = "tracker:class:IssueStatus"
PROJECT_TYPE = "task:class:ProjectType"
PERSON = "contact:class:Person"
EMPLOYEE = "contact:mixin:Employee"
SOCIAL_ID = "contact:class:SocialIdentity"
MESSAGE = "chunter:class:ChatMessage"
# Status categories -> board category.
_CATEGORY = {
    "task:statusCategory:UnStarted": "todo",
    "task:statusCategory:ToDo": "todo",
    "task:statusCategory:Active": "in_progress",
    "task:statusCategory:Won": "done",
    "task:statusCategory:Lost": "done",
}
# Huly's IssuePriority numbers <-> normalized priorities.
_PRIORITY = {1: "urgent", 2: "high", 3: "medium", 4: "low"}
PRIORITIES = [
    Choice(id="1", name="Urgent"),
    Choice(id="2", name="High"),
    Choice(id="3", name="Medium"),
    Choice(id="4", name="Low"),
]
MAX_ISSUES = 200
# A logged-in session is reused for this long.
SESSION_TTL = timedelta(minutes=30)


@dataclass
class Session:
    """A logged-in Huly workspace.

    Attributes:
        token: Workspace token for the transactor.
        workspace: Workspace UUID (used in REST paths).
        slug: Workspace URL name (used in web links).
        transactor: HTTP base URL of the transactor.
        collaborator: HTTP base URL of the collaborator, if any.
        social_id: The account's primary social ID (for txs).
        person: The account's Person ID; None if not found.
        person_name: Its display name.
        expires: When to log in again.
    """

    token: str
    workspace: str
    slug: str
    transactor: str
    collaborator: Optional[str]
    social_id: str
    person: Optional[str]
    person_name: str
    expires: datetime


# Connection ID -> (fingerprint of its settings, session).
_sessions: Dict[int, Tuple[str, Session]] = {}
_counter = count(secrets.randbelow(0xFFFFFF))


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validates a Huly connection's settings.

    Args:
        config: ``url`` (the Huly address; http allowed, as
            self-hosted instances often run on a LAN),
            ``workspace`` (its URL name) and ``email``.

    Raises:
        ProviderError: 422 for a missing or malformed value.
    """
    url = str(config.get("url") or "").strip().rstrip("/")
    if url and "://" not in url:
        url = f"https://{url}"
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ProviderError("Huly address must be an http(s) URL", 422)
    workspace = str(config.get("workspace") or "").strip()
    if not workspace or "/" in workspace:
        raise ProviderError("Workspace is its name as it appears in Huly's URL", 422)
    email = str(config.get("email") or "").strip()
    if "@" not in email:
        raise ProviderError("Email of the Huly account is required", 422)
    return {
        "url": f"{parsed.scheme}://{parsed.netloc}",
        "workspace": workspace,
        "email": email,
    }


def normalize_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Validates filters; ``projects`` are project identifiers
    (e.g. ``WEB``). Huly has no query language to pass on."""
    cleaned = common_filters(filters)
    if cleaned["query"]:
        raise ProviderError("Huly connections have no advanced query", 422)
    return cleaned


def generate_id() -> str:
    """A new document ID, as Huly makes them: 24 hex digits."""
    return (
        f"{int(time.time()):08x}"
        f"{secrets.token_hex(5)}"
        f"{next(_counter) & 0xFFFFFF:06x}"
    )


def _http_base(endpoint: str) -> str:
    """The HTTP URL of a ws(s):// service endpoint.

    The transactor endpoint may list an internal and an external
    address separated by ``;``; the last one is the public one.
    """
    endpoint = endpoint.split(";")[-1].strip().rstrip("/")
    if endpoint.startswith("ws"):
        endpoint = "http" + endpoint[2:]
    return endpoint


async def _json(response: httpx.Response) -> Any:
    """A Huly answer's JSON; ``{"error": ...}`` bodies raise.

    Raises:
        ProviderError: For HTTP errors, non-JSON or error bodies.
    """
    if response.status_code == 429 and "Retry-After" not in response.headers:
        wait = response.headers.get("Retry-After-ms")
        if wait and wait.isdigit():
            response.headers["Retry-After"] = str(int(wait) // 1000 + 1)
    raise_for_response(response, NAME)
    try:
        body = response.json()
    except ValueError as e:
        raise ProviderError("Huly answered something that is not JSON") from e
    if isinstance(body, dict) and body.get("error"):
        error = body["error"]
        code = error.get("code") if isinstance(error, dict) else error
        if code in (
            "platform:status:InvalidPassword",
            "platform:status:AccountNotFound",
        ):
            raise ProviderError("Huly rejected the email or password.", 400)
        if code == "platform:status:WorkspaceNotFound":
            raise ProviderError("Huly has no such workspace for this account.", 422)
        raise ProviderError(f"Huly refused the request: {code}", 502)
    return body


async def _call(
    http: httpx.AsyncClient, method: str, url: str, token: Optional[str] = None, **kw
) -> Any:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = await http.request(method, url, headers=headers, **kw)
    except httpx.HTTPError as e:
        raise ProviderError(f"Could not reach Huly: {type(e).__name__}") from e
    return await _json(response)


async def _rpc(
    http: httpx.AsyncClient, accounts: str, method: str, params: dict, token=None
) -> Any:
    """Calls the accounts service; returns its ``result``."""
    body = await _call(
        http, "POST", accounts, token, json={"method": method, "params": params}
    )
    return body.get("result") if isinstance(body, dict) else body


async def login(conn: Conn, http: httpx.AsyncClient) -> Session:
    """Logs in and opens the connection's workspace.

    Reuses a session younger than ``SESSION_TTL`` made with the
    same settings and password.
    """
    fingerprint = json.dumps([conn.config, conn.secret], sort_keys=True)
    cached = _sessions.get(conn.id)
    now = datetime.now(timezone.utc)
    if conn.id and cached and cached[0] == fingerprint and cached[1].expires > now:
        return cached[1]
    url = conn.config["url"]
    config = await _call(http, "GET", f"{url}/config.json")
    accounts = (config or {}).get("ACCOUNTS_URL")
    if not accounts:
        raise ProviderError(f"No Huly answers at {url} (no ACCOUNTS_URL).", 422)
    if accounts.startswith("/"):
        accounts = url + accounts
    info = await _rpc(
        http,
        accounts,
        "login",
        {"email": conn.config["email"], "password": conn.secret},
    )
    if not info or not info.get("token"):
        raise ProviderError("Huly rejected the email or password.", 400)
    workspace = await _rpc(
        http,
        accounts,
        "selectWorkspace",
        {
            "workspaceUrl": conn.config["workspace"],
            "kind": "external",
            "externalRegions": [],
        },
        token=info["token"],
    )
    if not workspace or not workspace.get("token"):
        raise ProviderError("Huly has no such workspace for this account.", 422)
    collaborator = config.get("COLLABORATOR_URL")
    session = Session(
        token=workspace["token"],
        workspace=workspace["workspace"],
        slug=workspace.get("workspaceUrl") or conn.config["workspace"],
        transactor=_http_base(workspace["endpoint"]),
        collaborator=_http_base(collaborator) if collaborator else None,
        social_id="",
        person=None,
        person_name=info.get("name") or conn.config["email"],
        expires=now + SESSION_TTL,
    )
    account = await _call(
        http,
        "GET",
        f"{session.transactor}/api/v1/account/{session.workspace}",
        session.token,
    )
    session.social_id = account.get("primarySocialId") or (
        (account.get("socialIds") or [""])[0]
    )
    people = await find_all(session, http, PERSON, {"personUuid": account.get("uuid")})
    if not people and account.get("socialIds"):
        ids = await find_all(
            session, http, SOCIAL_ID, {"_id": {"$in": account["socialIds"]}}
        )
        if ids:
            people = await find_all(
                session, http, PERSON, {"_id": ids[0]["attachedTo"]}
            )
    if people:
        session.person = people[0]["_id"]
        session.person_name = person_name(people[0]) or session.person_name
    if conn.id:
        _sessions[conn.id] = (fingerprint, session)
    return session


def person_name(person: Dict[str, Any]) -> str:
    """Huly stores names as "Last,First"; shown as "First Last"."""
    name = str(person.get("name") or "")
    if "," in name:
        last, first = name.split(",", 1)
        return f"{first} {last}".strip()
    return name


async def find_all(
    session: Session,
    http: httpx.AsyncClient,
    cls: str,
    query: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Reads documents of a class matching a query.

    The server leaves out ``_class`` and every field the query
    gave a plain value for; they are put back, as Huly's own
    client does.
    """
    params = {"class": cls}
    if query:
        params["query"] = json.dumps(query)
    if options:
        params["options"] = json.dumps(options)
    body = await _call(
        http,
        "GET",
        f"{session.transactor}/api/v1/find-all/{session.workspace}",
        session.token,
        params=params,
    )
    docs = body.get("value", []) if isinstance(body, dict) else body or []
    scalars = {k: v for k, v in query.items() if not isinstance(v, dict)}
    return [{"_class": cls, **scalars, **doc} for doc in docs]


async def _tx(session: Session, http: httpx.AsyncClient, tx: Dict[str, Any]) -> Any:
    """Sends one transaction."""
    now = int(time.time() * 1000)
    body = {
        "_id": generate_id(),
        "space": "core:space:Tx",
        "modifiedBy": session.social_id,
        "modifiedOn": now,
        **tx,
    }
    return await _call(
        http,
        "POST",
        f"{session.transactor}/api/v1/tx/{session.workspace}",
        session.token,
        json=body,
    )


async def _update(
    session: Session,
    http: httpx.AsyncClient,
    doc: Dict[str, Any],
    operations: Dict[str, Any],
    retrieve: bool = False,
) -> Any:
    return await _tx(
        session,
        http,
        {
            "_class": "core:class:TxUpdateDoc",
            "objectId": doc["_id"],
            "objectClass": doc.get("_class") or ISSUE,
            "objectSpace": doc["space"],
            "operations": operations,
            "retrieve": retrieve,
        },
    )


class _Statuses:
    """Issue statuses of the workspace, and which ones each
    project type allows."""

    def __init__(
        self, status_docs: List[Dict[str, Any]], type_docs: List[Dict[str, Any]]
    ):
        self.by_id = {s["_id"]: s for s in status_docs}
        self.by_type = {
            t["_id"]: [s.get("_id") for s in t.get("statuses") or []] for t in type_docs
        }

    def name(self, status_id: str) -> str:
        """A status's name."""
        return (self.by_id.get(status_id) or {}).get("name") or "Unknown"

    def category(self, status_id: str) -> str:
        """A status's board category."""
        cat = (self.by_id.get(status_id) or {}).get("category")
        return _CATEGORY.get(cat, "todo")

    def done_ids(self) -> List[str]:
        """IDs of the statuses that mean finished (won or lost)."""
        return [i for i in self.by_id if self.category(i) == "done"]


async def _statuses(session: Session, http: httpx.AsyncClient) -> _Statuses:
    return _Statuses(
        await find_all(session, http, STATUS, {}),
        await find_all(session, http, PROJECT_TYPE, {}),
    )


def _iso_ms(value: Any) -> Optional[str]:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def task_from_issue(
    conn: Conn,
    session: Session,
    issue: Dict[str, Any],
    known: _Statuses,
    names: Dict[str, str],
) -> ExternalTask:
    """Converts a Huly issue to an ExternalTask.

    The description is not read: it lives in the collaborator
    service, one request per issue.
    """
    identifier = issue.get("identifier") or issue["_id"]
    due = _iso_ms(issue.get("dueDate"))
    return ExternalTask(
        external_id=issue["_id"],
        key=identifier,
        title=issue.get("title") or identifier,
        status=known.name(issue.get("status")),
        category=known.category(issue.get("status")),
        priority=_PRIORITY.get(issue.get("priority")),
        due_date=due[:10] if due else None,
        assignee=names.get(issue.get("assignee")) if issue.get("assignee") else None,
        url=f"{conn.config['url']}/workbench/{session.slug}/tracker/{identifier}",
        updated_at=_iso_ms(issue.get("modifiedOn")),
    )


async def _names(
    session: Session, http: httpx.AsyncClient, person_ids: List[str]
) -> Dict[str, str]:
    ids = sorted({p for p in person_ids if p})
    if not ids:
        return {}
    people = await find_all(session, http, PERSON, {"_id": {"$in": ids}})
    return {p["_id"]: person_name(p) for p in people}


async def _tasks(
    conn: Conn, session: Session, http: httpx.AsyncClient, issues, known
) -> List[ExternalTask]:
    names = await _names(session, http, [i.get("assignee") for i in issues])
    return [task_from_issue(conn, session, i, known, names) for i in issues]


async def check(conn: Conn, http: httpx.AsyncClient) -> str:
    """Logs in; returns the account's name."""
    return (await login(conn, http)).person_name


async def fetch(conn: Conn, http: httpx.AsyncClient) -> List[ExternalTask]:
    """Reads the issues the connection's filters select: the
    unfinished ones, plus those finished in the last N days."""
    session = await login(conn, http)
    known = await _statuses(session, http)
    base: Dict[str, Any] = {}
    assignee = conn.filters.get("assignee", "me")
    if assignee == "me":
        if not session.person:
            raise ProviderError("Could not find this account's person in Huly.", 422)
        base["assignee"] = session.person
    elif assignee == "unassigned":
        base["assignee"] = None
    wanted = conn.filters.get("projects") or []
    if wanted:
        projects = await find_all(
            session, http, PROJECT, {"identifier": {"$in": wanted}}
        )
        base["space"] = {"$in": [p["_id"] for p in projects]}
    done = known.done_ids()
    options = {"sort": {"modifiedOn": -1}, "limit": MAX_ISSUES}
    issues = await find_all(
        session, http, ISSUE, {**base, "status": {"$nin": done}}, options
    )
    days = conn.filters.get("done_days", DEFAULT_DONE_DAYS)
    if days and done:
        since = int((time.time() - days * 86400) * 1000)
        issues += await find_all(
            session,
            http,
            ISSUE,
            {**base, "status": {"$in": done}, "modifiedOn": {"$gte": since}},
            options,
        )
    return await _tasks(conn, session, http, issues[: MAX_ISSUES * 2], known)


async def _issue(session: Session, http: httpx.AsyncClient, issue_id: str) -> dict:
    found = await find_all(session, http, ISSUE, {"_id": issue_id})
    if not found:
        raise ProviderError("Huly has no such issue", 404)
    return found[0]


async def _reread(conn: Conn, session: Session, http, issue_id: str) -> ExternalTask:
    issue = await _issue(session, http, issue_id)
    tasks = await _tasks(conn, session, http, [issue], await _statuses(session, http))
    return tasks[0]


async def statuses(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[ExternalStatus]:
    """The statuses the issue's project allows (all issue
    statuses when its project type cannot be read)."""
    session = await login(conn, http)
    issue = await _issue(session, http, external_id)
    known = await _statuses(session, http)
    allowed = list(known.by_id)
    projects = await find_all(session, http, PROJECT, {"_id": issue["space"]})
    if projects and known.by_type.get(projects[0].get("type")):
        allowed = [s for s in known.by_type[projects[0]["type"]] if s in known.by_id]
    return [
        ExternalStatus(id=s, name=known.name(s), category=known.category(s))
        for s in allowed
        if s != issue.get("status")
    ]


async def set_status(
    conn: Conn,
    http: httpx.AsyncClient,
    external_id: str,
    status_id: str,
    fields: Optional[Dict[str, Any]] = None,
) -> ExternalTask:
    """Moves the issue to a status (Huly has no transitions)."""
    del fields
    session = await login(conn, http)
    if status_id not in {o.id for o in await statuses(conn, http, external_id)}:
        raise ProviderError("This issue cannot move to that status", 422)
    await _update(
        session, http, await _issue(session, http, external_id), {"status": status_id}
    )
    return await _reread(conn, session, http, external_id)


async def search_users(
    conn: Conn, http: httpx.AsyncClient, external_id: str, query: str
) -> List[Choice]:
    """Workspace members whose name contains the query."""
    del external_id
    session = await login(conn, http)
    term = query.strip().replace("%", "")
    found = await find_all(
        session,
        http,
        EMPLOYEE,
        {"name": {"$like": f"%{term}%"}} if term else {},
        {"limit": 20},
    )
    return sorted(
        (Choice(id=p["_id"], name=person_name(p) or p["_id"]) for p in found),
        key=lambda c: c.name.lower(),
    )


async def assign(
    conn: Conn, http: httpx.AsyncClient, external_id: str, user_id: Optional[str]
) -> ExternalTask:
    """Assigns the issue to a person, or to nobody."""
    session = await login(conn, http)
    await _update(
        session, http, await _issue(session, http, external_id), {"assignee": user_id}
    )
    return await _reread(conn, session, http, external_id)


def text_to_markup(text: str) -> str:
    """Plain text as Huly markup (a ProseMirror document, as JSON)."""
    paragraphs = [
        (
            {"type": "paragraph", "content": [{"type": "text", "text": line}]}
            if line
            else {"type": "paragraph"}
        )
        for line in text.split("\n")
    ]
    return json.dumps({"type": "doc", "content": paragraphs})


def markup_to_text(markup: Any) -> str:
    """Huly markup (JSON string or object) as plain text."""
    if isinstance(markup, str):
        try:
            markup = json.loads(markup)
        except ValueError:
            return markup
    return adf_to_text(markup)


async def comments(
    conn: Conn, http: httpx.AsyncClient, external_id: str
) -> List[Comment]:
    """The issue's comments, oldest first."""
    session = await login(conn, http)
    messages = await find_all(
        session,
        http,
        MESSAGE,
        {"attachedTo": external_id, "attachedToClass": ISSUE},
        {"sort": {"createdOn": 1}, "limit": 100},
    )
    authors = await _authors(
        session, http, [m.get("createdBy") or m.get("modifiedBy") for m in messages]
    )
    return [
        Comment(
            id=m["_id"],
            author=authors.get(m.get("createdBy") or m.get("modifiedBy"), "Someone"),
            body=markup_to_text(m.get("message")),
            created=_iso_ms(m.get("createdOn") or m.get("modifiedOn")),
        )
        for m in messages
    ]


async def _authors(
    session: Session, http: httpx.AsyncClient, social_ids: List[str]
) -> Dict[str, str]:
    """Display names by social ID."""
    ids = sorted({s for s in social_ids if s})
    if not ids:
        return {}
    identities = await find_all(session, http, SOCIAL_ID, {"_id": {"$in": ids}})
    names = await _names(session, http, [i.get("attachedTo") for i in identities])
    return {i["_id"]: names.get(i.get("attachedTo"), "Someone") for i in identities}


async def add_comment(
    conn: Conn, http: httpx.AsyncClient, external_id: str, text: str
) -> Comment:
    """Adds a comment to the issue."""
    session = await login(conn, http)
    issue = await _issue(session, http, external_id)
    message_id = generate_id()
    await _tx(
        session,
        http,
        {
            "_class": "core:class:TxCreateDoc",
            "objectId": message_id,
            "objectClass": MESSAGE,
            "objectSpace": issue["space"],
            "attachedTo": issue["_id"],
            "attachedToClass": ISSUE,
            "collection": "comments",
            "createdBy": session.social_id,
            "attributes": {"message": text_to_markup(text)},
        },
    )
    return Comment(
        id=message_id,
        author=session.person_name,
        body=text,
        created=datetime.now(timezone.utc).isoformat(),
    )


async def create_options(conn: Conn, http: httpx.AsyncClient) -> CreateOptions:
    """The workspace's projects and Huly's fixed priorities."""
    session = await login(conn, http)
    projects = await find_all(session, http, PROJECT, {})
    return CreateOptions(
        projects=[
            Choice(
                id=p["_id"], name=f"{p.get('name') or p['_id']} ({p.get('identifier')})"
            )
            for p in projects
            if not p.get("archived")
        ],
        priorities=PRIORITIES,
        create_url=f"{conn.config['url']}/workbench/{session.slug}/tracker",
    )


async def types(conn: Conn, http: httpx.AsyncClient, project: str) -> List[Choice]:
    """Huly issues have one kind here."""
    del conn, http, project
    return [Choice(id="tracker:taskTypes:Issue", name="Issue")]


async def _description(
    session: Session, http: httpx.AsyncClient, issue_id: str, text: str
) -> Optional[str]:
    """Stores a description in the collaborator; returns its ref."""
    if not text.strip():
        return None
    if not session.collaborator:
        raise ProviderError("This Huly has no collaborator service for descriptions")
    doc = quote(f"{session.workspace}|{ISSUE}|{issue_id}|description", safe="")
    body = await _call(
        http,
        "POST",
        f"{session.collaborator}/rpc/{doc}",
        session.token,
        json={
            "method": "createContent",
            "payload": {"content": {"description": text_to_markup(text)}},
        },
    )
    return ((body or {}).get("content") or {}).get("description")


async def create(conn: Conn, http: httpx.AsyncClient, task: NewTask) -> ExternalTask:
    """Creates an issue assigned to the connection's account.

    Raises:
        ProviderError: 422 for an unknown project or priority.
    """
    session = await login(conn, http)
    found = await find_all(session, http, PROJECT, {"_id": task.project})
    if not found:
        raise ProviderError("Unknown Huly project", 422)
    project = {**found[0], "space": "core:space:Space"}
    if task.priority and task.priority not in {p.id for p in PRIORITIES}:
        raise ProviderError("Unknown priority", 422)
    bumped = await _update(session, http, project, {"$inc": {"sequence": 1}}, True)
    number = ((bumped or {}).get("object") or {}).get("sequence")
    if not isinstance(number, int):
        raise ProviderError("Huly did not give the new issue a number")
    issue_id = generate_id()
    identifier = f"{project.get('identifier')}-{number}"
    await _tx(
        session,
        http,
        {
            "_class": "core:class:TxCreateDoc",
            "objectId": issue_id,
            "objectClass": ISSUE,
            "objectSpace": project["_id"],
            "attachedTo": "tracker:ids:NoParent",
            "attachedToClass": ISSUE,
            "collection": "subIssues",
            "createdBy": session.social_id,
            "attributes": {
                "title": task.title,
                "description": await _description(
                    session, http, issue_id, task.description
                ),
                "status": project.get("defaultIssueStatus"),
                "priority": int(task.priority or 0),
                "assignee": session.person,
                "component": None,
                "number": number,
                "identifier": identifier,
                "kind": task.type or "tracker:taskTypes:Issue",
                "rank": "",
                "estimation": 0,
                "remainingTime": 0,
                "reportedTime": 0,
                "reports": 0,
                "subIssues": 0,
                "comments": 0,
                "parents": [],
                "childInfo": [],
                "relations": [],
                "dueDate": None,
                "startDate": None,
            },
        },
    )
    return await _reread(conn, session, http, issue_id)
