"""Bitbucket Cloud client for the Git tab.

Talks to ``api.bitbucket.org`` with the user's Atlassian email
and an API token (HTTP Basic). App passwords no longer work.

Bitbucket Cloud has no search for "pull requests waiting for my
review" across a workspace, so those come from the
``MAX_REVIEW_REPOS`` most recently updated repositories of each
workspace. Pull requests the user wrote come from the workspace
listing for a user. Commits are read from the repositories of
those pull requests: their source branches and the branches
they merge into.
"""

import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx

from . import (
    Commit,
    Conn,
    PostedComment,
    PRContext,
    ProviderError,
    PullRequest,
    check_repo,
    general_body,
    merge_roles,
    newest_commits,
    raise_for_response,
    recent,
)

NAME = "Bitbucket"
API = "https://api.bitbucket.org/2.0"
# Repositories per workspace searched for reviews asked of the user.
MAX_REVIEW_REPOS = 10
# Repositories read for commits.
MAX_COMMIT_REPOS = 5
# Workspaces per connection.
MAX_WORKSPACES = 5
_SLUG = re.compile(r"[A-Za-z0-9_.-]{1,100}")
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
# Pull request fields beyond the listing's defaults.
_PR_FIELDS = "+values.participants,+values.draft"
_STATE = {"MERGED": "merged", "DECLINED": "closed", "SUPERSEDED": "closed"}


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validates a Bitbucket connection's settings.

    Args:
        config: ``email`` (the Atlassian account's) and
            ``workspaces`` (slugs, a list or comma-separated).

    Returns:
        The cleaned settings.

    Raises:
        ProviderError: 422 for a missing or malformed value.
    """
    email = str(config.get("email") or "").strip().lower()
    if not _EMAIL.fullmatch(email) or len(email) > 200:
        raise ProviderError("Enter the email of your Atlassian account", 422)
    workspaces = config.get("workspaces") or []
    if isinstance(workspaces, str):
        workspaces = workspaces.split(",")
    workspaces = list(
        dict.fromkeys(str(w).strip() for w in workspaces if str(w).strip())
    )
    if not workspaces or len(workspaces) > MAX_WORKSPACES:
        raise ProviderError(f"Enter 1 to {MAX_WORKSPACES} workspaces", 422)
    if not all(_SLUG.fullmatch(w) for w in workspaces):
        raise ProviderError("A workspace is its slug, as in bitbucket.org/<slug>", 422)
    return {"email": email, "workspaces": workspaces}


async def _request(
    conn: Conn,
    http: httpx.AsyncClient,
    method: str,
    path: str,
    accept: Tuple[int, ...] = (),
    **kwargs,
) -> httpx.Response:
    """Sends one request to the Bitbucket API.

    Args:
        path: Path under ``https://api.bitbucket.org/2.0``.
        accept: Error statuses returned to the caller instead of
            raised.

    Raises:
        ProviderError: When Bitbucket cannot be reached or refuses.
    """
    try:
        response = await http.request(
            method,
            f"{API}{path}",
            auth=(conn.config.get("email") or "", conn.secret),
            headers={"Accept": "application/json"},
            **kwargs,
        )
    except httpx.HTTPError as e:
        raise ProviderError(f"Could not reach Bitbucket: {type(e).__name__}") from e
    if response.status_code not in accept:
        raise_for_response(response, NAME)
    return response


async def _get(conn: Conn, http: httpx.AsyncClient, path: str, **kwargs) -> Any:
    return (await _request(conn, http, "GET", path, **kwargs)).json()


async def check(conn: Conn, http: httpx.AsyncClient) -> Dict[str, str]:
    """Verifies the token and that each workspace can be read.

    Returns:
        ``account`` (display name) and ``user_id`` (UUID).

    Raises:
        ProviderError: 422 naming a workspace that cannot be read.
    """
    user = await _get(conn, http, "/user")
    for workspace in conn.config.get("workspaces") or []:
        answer = await _request(
            conn, http, "GET", f"/workspaces/{workspace}", accept=(403, 404)
        )
        if answer.status_code in (403, 404):
            raise ProviderError(
                f"Workspace {workspace} not found, or this account cannot read it.", 422
            )
    return {
        "account": user.get("display_name") or user["uuid"],
        "user_id": user["uuid"],
    }


def _href(raw: Dict[str, Any]) -> Optional[str]:
    """The web link of a Bitbucket object."""
    return ((raw.get("links") or {}).get("html") or {}).get("href")


def _review(participants: List[Dict[str, Any]]) -> Optional[str]:
    """Where reviews of a pull request stand."""
    reviewers = [p for p in participants if p.get("role") == "REVIEWER"]
    if any(p.get("state") == "changes_requested" for p in participants):
        return "changes_requested"
    if reviewers and all(p.get("approved") for p in reviewers):
        return "approved"
    if reviewers:
        return "pending"
    return None


def _pull_request(raw: Dict[str, Any], role: str) -> PullRequest:
    """Converts a Bitbucket pull request."""
    state = _STATE.get(raw.get("state") or "") or (
        "draft" if raw.get("draft") else "open"
    )
    destination = raw.get("destination") or {}
    return PullRequest(
        repo=destination["repository"]["full_name"],
        number=raw["id"],
        title=raw.get("title") or "",
        url=_href(raw),
        author=(raw.get("author") or {}).get("display_name"),
        state=state,
        roles=[role],
        review=_review(raw.get("participants") or []),
        source_branch=((raw.get("source") or {}).get("branch") or {}).get("name"),
        target_branch=(destination.get("branch") or {}).get("name"),
        updated_at=raw.get("updated_on"),
    )


async def _authored(
    conn: Conn, http: httpx.AsyncClient, workspace: str, uuid: str
) -> List[PullRequest]:
    """Pull requests the user wrote in a workspace, open or
    recently closed."""
    page = await _get(
        conn,
        http,
        f"/workspaces/{workspace}/pullrequests/{quote(uuid, safe='')}",
        params=[
            ("state", "OPEN"),
            ("state", "MERGED"),
            ("state", "DECLINED"),
            ("pagelen", "50"),
            ("fields", _PR_FIELDS),
        ],
    )
    return [_pull_request(raw, "author") for raw in page.get("values") or []]


async def _to_review(
    conn: Conn, http: httpx.AsyncClient, workspace: str, uuid: str
) -> List[PullRequest]:
    """Open pull requests that list the user as a reviewer, in
    the workspace's most recently updated repositories."""
    repos = await _get(
        conn,
        http,
        f"/repositories/{workspace}",
        params={
            "role": "member",
            "sort": "-updated_on",
            "pagelen": str(MAX_REVIEW_REPOS),
            "fields": "values.full_name",
        },
    )
    found = []
    for repo in repos.get("values") or []:
        page = await _get(
            conn,
            http,
            f"/repositories/{check_repo(repo['full_name'])}/pullrequests",
            params={
                "q": f'reviewers.uuid="{uuid}" AND state="OPEN"',
                "pagelen": "30",
                "fields": _PR_FIELDS,
            },
        )
        found += [_pull_request(raw, "reviewer") for raw in page.get("values") or []]
    return found


async def _commits(
    conn: Conn, http: httpx.AsyncClient, prs: List[PullRequest], uuid: str
) -> List[Commit]:
    """The user's recent commits in the repositories of their pull
    requests, on those pull requests' branches."""
    branches: Dict[str, List[str]] = {}
    for pr in prs:
        names = branches.setdefault(pr.repo, [])
        wanted = [pr.target_branch] + (
            [pr.source_branch] if pr.state != "merged" else []
        )
        names += [b for b in wanted if b and b not in names]
    commits = []
    for repo, names in list(branches.items())[:MAX_COMMIT_REPOS]:
        answer = await _request(
            conn,
            http,
            "GET",
            f"/repositories/{check_repo(repo)}/commits",
            accept=(404,),
            params=[("include", b) for b in names] + [("pagelen", "50")],
        )
        if answer.status_code == 404:
            # A branch was deleted since the pull request was read.
            continue
        for raw in answer.json().get("values") or []:
            author = ((raw.get("author") or {}).get("user") or {}).get("uuid")
            if author != uuid or not recent(raw.get("date")):
                continue
            commits.append(
                Commit(
                    repo=repo,
                    sha=raw["hash"],
                    message=(
                        (raw.get("message") or "").splitlines()[0]
                        if raw.get("message")
                        else ""
                    ),
                    url=_href(raw),
                    date=raw.get("date"),
                )
            )
    return commits


async def fetch(
    conn: Conn, http: httpx.AsyncClient
) -> Tuple[List[PullRequest], List[Commit]]:
    """The user's pull requests and recent commits.

    Returns:
        Pull requests (each once, with every role it has) and
        commits of the last ``COMMIT_DAYS`` days, newest first.
    """
    uuid = conn.config.get("user_id") or ""
    authored: List[PullRequest] = []
    to_review: List[PullRequest] = []
    for workspace in conn.config.get("workspaces") or []:
        authored += await _authored(conn, http, workspace, uuid)
        to_review += await _to_review(conn, http, workspace, uuid)
    authored.sort(key=lambda pr: pr.updated_at or "", reverse=True)
    commits = await _commits(conn, http, authored, uuid)
    return merge_roles(authored + to_review), newest_commits(commits)


async def pr_context(
    conn: Conn, http: httpx.AsyncClient, repo: str, number: int
) -> PRContext:
    """A pull request's description and diff, for a review."""
    path = f"/repositories/{check_repo(repo)}/pullrequests/{number}"
    pr = await _get(conn, http, path)
    diff = (
        await _request(conn, http, "GET", f"{path}/diff", follow_redirects=True)
    ).text
    return PRContext(
        repo=repo,
        number=number,
        title=pr.get("title") or "",
        description=pr.get("description") or "",
        source_branch=((pr.get("source") or {}).get("branch") or {}).get("name"),
        target_branch=((pr.get("destination") or {}).get("branch") or {}).get("name"),
        head_sha=((pr.get("source") or {}).get("commit") or {}).get("hash"),
        diff=diff,
    )


async def post_comment(
    conn: Conn,
    http: httpx.AsyncClient,
    repo: str,
    number: int,
    body: str,
    path: Optional[str] = None,
    line: Optional[int] = None,
) -> PostedComment:
    """Posts a comment on a pull request, on a file's line when
    given. When Bitbucket refuses the place, it is posted as a
    general comment that names the place instead.

    Raises:
        ProviderError: As ``_request``.
    """
    url = f"/repositories/{check_repo(repo)}/pullrequests/{number}/comments"
    if path:
        inline: Dict[str, Any] = {"path": path}
        if line:
            inline["to"] = line
        answer = await _request(
            conn,
            http,
            "POST",
            url,
            accept=(400,),
            json={"content": {"raw": body}, "inline": inline},
        )
        if answer.status_code != 400:
            return PostedComment(url=_href(answer.json()), inline=True)
    general = {"content": {"raw": general_body(body, path, line)}}
    posted = await _request(conn, http, "POST", url, json=general)
    return PostedComment(url=_href(posted.json()), inline=False)
