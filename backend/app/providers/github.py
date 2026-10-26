"""GitHub client for the Git tab.

Talks to ``api.github.com`` with a personal access token
(classic or fine-grained) as a Bearer token.

Pull requests come from one GraphQL request with three
searches: ones the user wrote, ones assigned to them and ones
waiting for their review. A second GraphQL request reads the
user's recent commits on the default branch of the repositories
of their pull requests; commits on the pull requests' own
branches come with the first request.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import (
    COMMIT_DAYS,
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

NAME = "GitHub"
API = "https://api.github.com"
# Pull requests per search.
SEARCH_SIZE = 30
# Repositories whose default branch is read for commits.
MAX_REPOS = 10

_SEARCHES = {
    "author": "is:pr author:@me archived:false sort:updated-desc",
    "assignee": "is:pr is:open assignee:@me archived:false sort:updated-desc",
    "reviewer": "is:pr is:open review-requested:@me archived:false sort:updated-desc",
}

_PR_FIELDS = """
fragment pr on PullRequest {
  number title url state isDraft reviewDecision updatedAt
  headRefName baseRefName
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  last: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment prCommits on PullRequest {
  commits(last: 30) {
    nodes { commit { oid messageHeadline committedDate url author { user { login } } } }
  }
}
"""

_PRS_QUERY = """
query($author: String!, $assignee: String!, $reviewer: String!) {
  viewer { login id }
  author: search(query: $author, type: ISSUE, first: %d) {
    nodes { ...pr ...prCommits }
  }
  assignee: search(query: $assignee, type: ISSUE, first: %d) { nodes { ...pr } }
  reviewer: search(query: $reviewer, type: ISSUE, first: %d) { nodes { ...pr } }
}
""" % (SEARCH_SIZE, SEARCH_SIZE, SEARCH_SIZE) + _PR_FIELDS

_STATE = {"MERGED": "merged", "CLOSED": "closed"}
_REVIEW = {
    "APPROVED": "approved",
    "CHANGES_REQUESTED": "changes_requested",
    "REVIEW_REQUIRED": "pending",
}
_CHECKS = {
    "SUCCESS": "success",
    "FAILURE": "failure",
    "ERROR": "failure",
    "PENDING": "pending",
    "EXPECTED": "pending",
}


def normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """A GitHub connection needs no settings besides its token.

    Args:
        config: Ignored.

    Returns:
        An empty dict.
    """
    del config
    return {}


def _raise_for_rate_limit(response: httpx.Response) -> None:
    """GitHub answers 403 (not 429) when the hourly quota is spent.

    Raises:
        ProviderError: 429 with the seconds until the quota resets.
    """
    if (
        response.status_code != 403
        or response.headers.get("x-ratelimit-remaining") != "0"
    ):
        return
    try:
        wait = max(
            0.0, float(response.headers.get("x-ratelimit-reset", "0")) - time.time()
        )
    except ValueError:
        wait = 60.0
    raise ProviderError(
        f"GitHub is rate limiting requests. Try again in {wait:.0f} seconds.",
        429,
        retry_after=wait,
    )


async def _request(
    conn: Conn,
    http: httpx.AsyncClient,
    method: str,
    path: str,
    accept: Tuple[int, ...] = (),
    **kwargs,
) -> httpx.Response:
    """Sends one request to the GitHub API.

    Args:
        path: Path under ``https://api.github.com``.
        accept: Error statuses returned to the caller instead of
            raised.
        kwargs: Passed to httpx; ``headers`` are added to the
            defaults.

    Raises:
        ProviderError: When GitHub cannot be reached or refuses.
    """
    headers = {
        "Authorization": f"Bearer {conn.secret}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        **kwargs.pop("headers", {}),
    }
    try:
        response = await http.request(method, f"{API}{path}", headers=headers, **kwargs)
    except httpx.HTTPError as e:
        raise ProviderError(f"Could not reach GitHub: {type(e).__name__}") from e
    _raise_for_rate_limit(response)
    if response.status_code not in accept:
        raise_for_response(response, NAME)
    return response


async def _graphql(
    conn: Conn, http: httpx.AsyncClient, query: str, variables: Dict[str, Any]
) -> Dict[str, Any]:
    """Runs a GraphQL query.

    GitHub answers HTTP 200 with ``errors`` for problems inside
    the query. When some data came back anyway (e.g. one
    organization blocks the token), that data is used.

    Raises:
        ProviderError: When no data came back.
    """
    body = (
        await _request(
            conn,
            http,
            "POST",
            "/graphql",
            json={"query": query, "variables": variables},
        )
    ).json()
    data = body.get("data")
    if not data:
        errors = "; ".join(str(e.get("message")) for e in body.get("errors") or [])
        raise ProviderError(f"GitHub answered: {errors[:300] or 'no data'}")
    return data


async def check(conn: Conn, http: httpx.AsyncClient) -> Dict[str, str]:
    """Verifies the token.

    Returns:
        ``account`` (login and name) and ``user_id`` (login).
    """
    user = (await _request(conn, http, "GET", "/user")).json()
    login = user["login"]
    name = user.get("name")
    return {"account": f"{name} ({login})" if name else login, "user_id": login}


def _pull_request(node: Dict[str, Any], role: str) -> PullRequest:
    """Converts a GraphQL pull request node."""
    state = _STATE.get(node["state"]) or ("draft" if node.get("isDraft") else "open")
    rollup = None
    for last in (node.get("last") or {}).get("nodes") or []:
        rollup = ((last.get("commit") or {}).get("statusCheckRollup") or {}).get(
            "state"
        )
    return PullRequest(
        repo=node["repository"]["nameWithOwner"],
        number=node["number"],
        title=node["title"],
        url=node.get("url"),
        author=(node.get("author") or {}).get("login"),
        state=state,
        roles=[role],
        review=_REVIEW.get(node.get("reviewDecision") or ""),
        checks=_CHECKS.get(rollup or ""),
        source_branch=node.get("headRefName"),
        target_branch=node.get("baseRefName"),
        updated_at=node.get("updatedAt"),
    )


def _commit(raw: Dict[str, Any], repo: str, branch: Optional[str]) -> Commit:
    """Converts a GraphQL commit."""
    return Commit(
        repo=repo,
        sha=raw["oid"],
        message=raw.get("messageHeadline") or "",
        url=raw.get("url"),
        branch=branch,
        date=raw.get("committedDate"),
    )


def _since() -> str:
    """Start of the commit window, as GitHub wants it."""
    start = datetime.now(timezone.utc) - timedelta(days=COMMIT_DAYS)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ")


async def _default_branch_commits(
    conn: Conn, http: httpx.AsyncClient, repos: List[str], author_id: str
) -> List[Commit]:
    """The user's recent commits on each repository's default
    branch, in one GraphQL request.

    Args:
        repos: ``owner/name`` of each repository.
        author_id: The user's GraphQL node ID.
    """
    if not repos:
        return []
    params = ["$since: GitTimestamp!", "$author: ID!"]
    fields = []
    variables: Dict[str, Any] = {"since": _since(), "author": author_id}
    for i, repo in enumerate(repos):
        owner, name = repo.split("/", 1)
        params += [f"$o{i}: String!", f"$n{i}: String!"]
        variables.update({f"o{i}": owner, f"n{i}": name})
        fields.append(
            f"r{i}: repository(owner: $o{i}, name: $n{i}) {{ nameWithOwner "
            "defaultBranchRef { name target { ... on Commit { "
            "history(first: 30, since: $since, author: {id: $author}) "
            "{ nodes { oid messageHeadline committedDate url } } } } } }"
        )
    query = f"query({', '.join(params)}) {{ {' '.join(fields)} }}"
    data = await _graphql(conn, http, query, variables)
    commits = []
    for repo in data.values():
        branch = (repo or {}).get("defaultBranchRef") or {}
        history = ((branch.get("target") or {}).get("history") or {}).get("nodes") or []
        commits += [
            _commit(c, repo["nameWithOwner"], branch.get("name")) for c in history
        ]
    return commits


async def fetch(
    conn: Conn, http: httpx.AsyncClient
) -> Tuple[List[PullRequest], List[Commit]]:
    """The user's pull requests and recent commits.

    Returns:
        Pull requests (each once, with every role it has) and
        commits of the last ``COMMIT_DAYS`` days, newest first.
    """
    data = await _graphql(conn, http, _PRS_QUERY, _SEARCHES)
    login = data["viewer"]["login"]
    prs: List[PullRequest] = []
    commits: List[Commit] = []
    for role in _SEARCHES:
        for node in (data.get(role) or {}).get("nodes") or []:
            if not node or "number" not in node:
                # A search hit the token cannot read comes back empty.
                continue
            prs.append(_pull_request(node, role))
            for item in (node.get("commits") or {}).get("nodes") or []:
                raw = item.get("commit") or {}
                author = ((raw.get("author") or {}).get("user") or {}).get("login")
                if author == login and recent(raw.get("committedDate")):
                    commits.append(
                        _commit(
                            raw,
                            node["repository"]["nameWithOwner"],
                            node.get("headRefName"),
                        )
                    )
    repos = list(dict.fromkeys(pr.repo for pr in prs if "author" in pr.roles))
    commits += await _default_branch_commits(
        conn, http, repos[:MAX_REPOS], data["viewer"]["id"]
    )
    return merge_roles(prs), newest_commits(commits)


async def pr_context(
    conn: Conn, http: httpx.AsyncClient, repo: str, number: int
) -> PRContext:
    """A pull request's description and diff, for a review.

    Raises:
        ProviderError: 422 when GitHub finds the diff too large
            to produce (HTTP 406); as ``_request`` otherwise.
    """
    path = f"/repos/{check_repo(repo)}/pulls/{number}"
    pr = (await _request(conn, http, "GET", path)).json()
    answer = await _request(
        conn,
        http,
        "GET",
        path,
        accept=(406,),
        headers={"Accept": "application/vnd.github.diff"},
    )
    if answer.status_code == 406:
        raise ProviderError(
            "GitHub cannot produce the diff of this pull request: it is too large.",
            422,
        )
    diff = answer.text
    return PRContext(
        repo=repo,
        number=number,
        title=pr.get("title") or "",
        description=pr.get("body") or "",
        source_branch=(pr.get("head") or {}).get("ref"),
        target_branch=(pr.get("base") or {}).get("ref"),
        head_sha=(pr.get("head") or {}).get("sha"),
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
    """Posts a comment on a pull request.

    With ``path`` (and ``line``) it is a review comment on that
    file (line) of the latest commit. When GitHub refuses the
    place, e.g. the line is not part of the diff, it is posted as
    a general comment that names the place instead.

    Raises:
        ProviderError: As ``_request``.
    """
    base = f"/repos/{check_repo(repo)}"
    if path:
        head = (await _request(conn, http, "GET", f"{base}/pulls/{number}")).json()
        place: Dict[str, Any] = {"path": path}
        if line:
            place.update(line=line, side="RIGHT")
        else:
            place["subject_type"] = "file"
        answer = await _request(
            conn,
            http,
            "POST",
            f"{base}/pulls/{number}/comments",
            accept=(422,),
            json={"body": body, "commit_id": head["head"]["sha"], **place},
        )
        if answer.status_code != 422:
            return PostedComment(url=answer.json().get("html_url"), inline=True)
    posted = (
        await _request(
            conn,
            http,
            "POST",
            f"{base}/issues/{number}/comments",
            json={"body": general_body(body, path, line)},
        )
    ).json()
    return PostedComment(url=posted.get("html_url"), inline=False)
