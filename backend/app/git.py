"""Git tab API: pull requests and commits from GitHub and
Bitbucket Cloud, and reviews of pull requests by Claude.

A connection is one GitHub or Bitbucket account a UI user added
with a personal token. Like the Tasks tab's connections, the
token is checked before it is saved, stored encrypted and never
returned. Each connection is read every ``SYNC_INTERVAL``
seconds into a cache (``GitCache``) that the tab shows; open
pages hear about changes over Socket.IO (``git_updated``).

IDs the tab uses:

- pull request: ``<provider>:<connection id>:<repo>:<number>``,
  e.g. ``github:3:octo/app:42``;
- commit: ``<provider>:<connection id>:<sha>``.

Reviews (``git_review``) are written only on request and saved
per user and pull request. Comments are posted only by the
comments endpoint, i.e. when the user clicks to post one.
"""

import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import auth, connections, database, git_review, models, providers
from . import secretbox, tasks
from .providers import bitbucket, github

# Host modules by provider name (see ``providers``, "Git tab").
PROVIDERS: Dict[str, Any] = {"github": github, "bitbucket": bitbucket}
# Each connection is read again this often, in seconds.
SYNC_INTERVAL = 120
# How often the poller looks for connections due a read.
POLL_TICK = 30
# A manual refresh skips connections read this recently (seconds).
REFRESH_COOLDOWN = 15
# Settings saved with a connection that come from its token,
# not from the user.
_IDENTITY = ("account", "user_id")
# Connection ID -> earliest time it may be read again, after the
# host asked to slow down.
_retry_at: Dict[int, datetime] = {}

router = APIRouter(prefix="/git", tags=["git"])

ProviderName = Literal["github", "bitbucket"]


class Source(BaseModel):
    """Where an item of the Git tab came from."""

    id: str
    provider: str
    connection_id: int
    connection_name: str


class PullRequestItem(providers.PullRequest, Source):
    """A pull request as the tab shows it."""


class CommitItem(providers.Commit, Source):
    """A commit as the tab shows it."""


class Board(BaseModel):
    """Everything the Git tab lists."""

    prs: List[PullRequestItem]
    commits: List[CommitItem]


class ConnectionOut(connections.ConnectionInfo):
    """A connection as the UI sees it: everything but the token
    (see ``ConnectionInfo``), plus how many items it last read."""

    pr_count: int = 0
    commit_count: int = 0


class ConnectionCreate(connections.NewConnection):
    """A new connection: ``config`` is empty for GitHub;
    ``email`` and ``workspaces`` for Bitbucket."""

    provider: ProviderName


def _out(row: models.GitConnection) -> ConnectionOut:
    cache = row.cache
    return ConnectionOut(
        **connections.info(row),
        pr_count=len(cache.prs_json or []) if cache else 0,
        commit_count=len(cache.commits_json or []) if cache else 0,
    )


def provider_of(row: models.GitConnection) -> Any:
    """The host module for a connection.

    Raises:
        ProviderError: 400 for a provider this build lacks.
    """
    module = PROVIDERS.get(row.provider)
    if module is None:
        raise providers.ProviderError(f"Unknown Git host: {row.provider}", 400)
    return module


def user_connections(db: Session, email: str) -> List[models.GitConnection]:
    """The user's connections, oldest first."""
    return connections.user_rows(db, models.GitConnection, email)


def own_connection(db: Session, email: str, connection_id: int):
    """Fetches one of the user's connections.

    Raises:
        HTTPException: 404 when it is missing or someone else's.
    """
    return connections.own_row(db, models.GitConnection, email, connection_id)


async def sync_connection(db: Session, row: models.GitConnection) -> None:
    """Reads a connection's pull requests and commits into its
    cache. A failure is recorded on the connection and the
    previous cache is kept (see ``connections.sync``)."""

    async def read(row):
        conn = tasks.open_conn(row)
        async with providers.http_client() as http:
            return await provider_of(row).fetch(conn, http)

    def store(row, found, now):
        prs = [pr.model_dump() for pr in found[0]]
        commits = [c.model_dump() for c in found[1]]
        if row.cache is None:
            row.cache = models.GitCache(prs_json=prs, commits_json=commits)
        else:
            row.cache.prs_json = prs
            row.cache.commits_json = commits
        row.cache.synced_at = now

    await connections.sync(db, row, read, store, _retry_at, "pull requests")


def due_connections(db: Session, now: datetime) -> List[models.GitConnection]:
    """Connections read longer than ``SYNC_INTERVAL`` ago that no
    host asked to wait for."""
    rows = db.query(models.GitConnection).order_by(models.GitConnection.id)
    return connections.due(rows, SYNC_INTERVAL, _retry_at, now)


def _snapshot(row: models.GitConnection) -> tuple:
    """What the tab shows of a connection, to tell if a read
    changed anything."""
    cache = row.cache
    return (
        cache.prs_json if cache else None,
        cache.commits_json if cache else None,
        row.last_error,
    )


async def sync_due(notify: Callable[[str], Awaitable[None]]) -> int:
    """Reads every connection that is due, one after the other.

    Args:
        notify: Called with the email of each user whose tab
            changed, to tell their open pages.

    Returns:
        How many connections were read.
    """
    return await connections.sync_due(
        due_connections, sync_connection, _snapshot, notify
    )


async def poll_forever(notify: Callable[[str], Awaitable[None]]) -> None:
    """Keeps every connection fresh while the backend runs.
    Started once at startup.

    Args:
        notify: As for ``sync_due``.
    """
    await connections.forever(lambda: sync_due(notify), POLL_TICK, "Git connection")


def _source(row: models.GitConnection, item_id: str) -> Dict[str, Any]:
    return {
        "id": f"{row.provider}:{row.id}:{item_id}",
        "provider": row.provider,
        "connection_id": row.id,
        "connection_name": row.name,
    }


def _cached(
    row: models.GitConnection,
) -> Tuple[List[PullRequestItem], List[CommitItem]]:
    """The tab's items from a connection's cache. Items written
    by another version that no longer parse are skipped; the
    next read rewrites them."""
    prs, commits = [], []
    if row.cache is None:
        return prs, commits
    for raw in row.cache.prs_json or []:
        try:
            pr = providers.PullRequest(**raw)
            prs.append(
                PullRequestItem(
                    **pr.model_dump(), **_source(row, f"{pr.repo}:{pr.number}")
                )
            )
        except (ValueError, TypeError):
            continue
    for raw in row.cache.commits_json or []:
        try:
            commit = providers.Commit(**raw)
            commits.append(
                CommitItem(**commit.model_dump(), **_source(row, commit.sha))
            )
        except (ValueError, TypeError):
            continue
    return prs, commits


async def board(db: Session, email: str) -> Board:
    """Everything on the user's Git tab. Connections never read
    before are read now, so a new one shows its items at once."""
    prs: List[PullRequestItem] = []
    commits: List[CommitItem] = []
    for row in user_connections(db, email):
        if row.cache is None and row.last_sync_at is None:
            await sync_connection(db, row)
        found_prs, found_commits = _cached(row)
        prs += found_prs
        commits += found_commits
    prs.sort(key=lambda pr: pr.updated_at or "", reverse=True)
    commits.sort(key=lambda c: c.date or "", reverse=True)
    return Board(prs=prs, commits=commits)


async def _verify(provider: str, config: Dict[str, Any], secret: str) -> Dict[str, Any]:
    """Validates settings and token against the host.

    Returns:
        The cleaned settings, with ``account`` and ``user_id``.

    Raises:
        HTTPException: As ``connections.verify``.
    """
    cleaned, identity = await connections.verify(
        PROVIDERS[provider], provider, config, secret
    )
    return {**cleaned, **identity}


@router.get("/connections", response_model=List[ConnectionOut])
def list_connections(
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Lists the user's Git connections, oldest first."""
    return [_out(row) for row in user_connections(db, email)]


@router.post("/connections", response_model=ConnectionOut)
async def create_connection(
    body: ConnectionCreate,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Adds a connection after checking its token, then reads it
    once so its items show up right away.

    Raises:
        HTTPException: 422 for a blank name or bad settings, 400
            when the host rejects the token.
    """
    connections.clean_name(body.name)
    config = await _verify(body.provider, body.config, body.secret)
    row = await connections.create(
        db, models.GitConnection, email, body, config, sync_connection
    )
    return _out(row)


@router.patch("/connections/{connection_id}", response_model=ConnectionOut)
async def update_connection(
    connection_id: int,
    body: connections.ConnectionEdit,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Renames a connection or changes its settings or token.

    New settings must come with the token again, so a saved token
    is never sent to an account or workspace it was not entered
    for. A new token or settings are checked before saving and
    the connection is read again.

    Raises:
        HTTPException: 404 if not the user's; 422 for settings
            changed without a token; as for creating.
    """
    row = own_connection(db, email, connection_id)
    given = body.model_fields_set
    if "name" in given:
        row.name = connections.clean_name(body.name)
    new_secret = (body.secret or "").strip()
    config = body.config if body.config is not None else None
    if config is not None and not new_secret:
        try:
            cleaned = provider_of(row).normalize_config(config)
        except providers.ProviderError as e:
            raise connections.http_error(e) from e
        saved = {k: v for k, v in (row.config_json or {}).items() if k not in _IDENTITY}
        if cleaned != saved:
            raise HTTPException(
                status_code=422,
                detail="Enter the token again when changing these settings",
            )
    resync = False
    if new_secret:
        settings = config if config is not None else row.config_json or {}
        row.config_json = await _verify(row.provider, settings, new_secret)
        row.secret_enc = secretbox.encrypt(new_secret)
        resync = True
    db.commit()
    if resync:
        await sync_connection(db, row)
    db.refresh(row)
    return _out(row)


def _reviews_of(db: Session, email: str, row: models.GitConnection):
    """The saved reviews of a connection's pull requests."""
    prefix = f"{row.provider}:{row.id}:"
    return db.query(models.GitReview).filter(
        models.GitReview.owner_email == email,
        models.GitReview.pr_id.startswith(prefix, autoescape=True),
    )


@router.delete("/connections/{connection_id}")
def delete_connection(
    connection_id: int,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Removes a connection, its token, its cached items and its
    saved reviews. Nothing changes on GitHub or Bitbucket.

    Raises:
        HTTPException: 404 if not the user's.
    """
    row = own_connection(db, email, connection_id)
    _reviews_of(db, email, row).delete(synchronize_session=False)
    db.delete(row)
    db.commit()
    _retry_at.pop(connection_id, None)
    return {"ok": True}


@router.get("", response_model=Board)
async def list_items(
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """The user's pull requests and commits, from the cache.

    Returns:
        Pull requests (newest change first) and commits (newest
        first) of every connection.
    """
    return await board(db, email)


@router.post("/refresh", response_model=Board)
async def refresh(
    body: connections.RefreshRequest,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Reads the user's connections again, then lists the tab.
    Connections read in the last ``REFRESH_COOLDOWN`` seconds are
    skipped, so clicking in a loop cannot flood the hosts.

    Raises:
        HTTPException: 404 for a connection that is not the user's.
    """
    await connections.refresh(
        db, models.GitConnection, email, body, sync_connection, REFRESH_COOLDOWN
    )
    return await board(db, email)


_NUMBER = re.compile(r"[0-9]{1,18}")


def _parse_pr_id(pr_id: str) -> Tuple[str, int, str, int]:
    """Splits a pull request ID.

    Returns:
        Provider, connection ID, repo and number.

    Raises:
        HTTPException: 404 for an ID of no known shape.
    """
    provider, _, rest = pr_id.partition(":")
    connection, _, rest = rest.partition(":")
    repo, _, number = rest.rpartition(":")
    if (
        provider in PROVIDERS
        and _NUMBER.fullmatch(connection)
        and _NUMBER.fullmatch(number)
        and providers.REPO_NAME.fullmatch(repo)
    ):
        return provider, int(connection), repo, int(number)
    raise HTTPException(status_code=404, detail="Pull request not found")


async def _pr_call(db: Session, email: str, pr_id: str, action: Callable):
    """Runs ``action(module, conn, http, repo, number)`` against
    the host of a pull request.

    Raises:
        HTTPException: 404 when the PR is not the user's; the
            host's error.
    """
    provider, connection_id, repo, number = _parse_pr_id(pr_id)
    row = own_connection(db, email, connection_id)
    if row.provider != provider:
        raise HTTPException(status_code=404, detail="Pull request not found")
    try:
        conn = tasks.open_conn(row)
        async with providers.http_client() as http:
            return await action(provider_of(row), conn, http, repo, number)
    except providers.ProviderError as e:
        raise connections.http_error(e) from e
    except connections.UNEXPECTED as e:
        raise connections.unexpected_answer(e) from e


class ReviewOut(git_review.ReviewResult):
    """A saved review of a pull request.

    Attributes:
        pr_id: The pull request's ID in the tab.
        head_sha: Its last commit when reviewed.
        model: The Claude model that wrote it.
        created_at: When it was written.
    """

    pr_id: str
    head_sha: Optional[str] = None
    model: str
    created_at: datetime


def _review_out(row: models.GitReview) -> ReviewOut:
    return ReviewOut(
        **row.result_json,
        pr_id=row.pr_id,
        head_sha=row.head_sha,
        model=row.model,
        created_at=connections.utc(row.created_at),
    )


def _saved_review(db: Session, email: str, pr_id: str) -> Optional[models.GitReview]:
    return (
        db.query(models.GitReview)
        .filter(models.GitReview.owner_email == email, models.GitReview.pr_id == pr_id)
        .one_or_none()
    )


@router.get("/prs/{pr_id:path}/review", response_model=ReviewOut)
def read_review(
    pr_id: str,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """The last review written of a pull request.

    Raises:
        HTTPException: 404 when there is none (or the pull
            request is not the user's).
    """
    _, connection_id, _, _ = _parse_pr_id(pr_id)
    own_connection(db, email, connection_id)
    row = _saved_review(db, email, pr_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No review yet")
    return _review_out(row)


@router.post("/prs/{pr_id:path}/review", response_model=ReviewOut)
async def write_review(
    pr_id: str,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Asks Claude to review a pull request and saves the review,
    replacing the previous one. Posts nothing.

    Can take a minute or two for a large pull request.

    Raises:
        HTTPException: 404 when the PR is not the user's; the
            host's error; 503 without a Claude API key; 422 for a
            diff too large or a declined review; 502 when Claude
            fails.
    """
    context = await _pr_call(
        db, email, pr_id, lambda m, c, h, repo, number: m.pr_context(c, h, repo, number)
    )
    try:
        result, used_model = await git_review.review(context)
    except git_review.ReviewError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e
    row = _saved_review(db, email, pr_id)
    if row is None:
        row = models.GitReview(owner_email=email, pr_id=pr_id)
        db.add(row)
    row.head_sha = context.head_sha
    row.model = used_model
    row.result_json = result.model_dump()
    row.created_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _review_out(row)


class NewComment(BaseModel):
    """A comment to post on a pull request.

    Attributes:
        body: Its text (Markdown, as the host renders it).
        path: File it is about; None for a general comment.
        line: Line in the new version of the file; None for the
            whole file.
    """

    body: str = Field(..., max_length=20000)
    path: Optional[str] = Field(None, max_length=1000)
    line: Optional[int] = Field(None, ge=1, le=10_000_000)


@router.post("/prs/{pr_id:path}/comments", response_model=providers.PostedComment)
async def post_comment(
    pr_id: str,
    body: NewComment,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Posts a comment on a pull request, as the connection's
    account. The only way the Git tab writes to a host.

    Raises:
        HTTPException: 422 for a blank comment; 404 when the PR
            is not the user's; the host's error.
    """
    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Comment is empty")
    path = (body.path or "").strip() or None
    return await _pr_call(
        db,
        email,
        pr_id,
        lambda m, c, h, repo, number: m.post_comment(
            c, h, repo, number, text, path, body.line if path else None
        ),
    )
