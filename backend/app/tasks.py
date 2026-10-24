"""Tasks tab API: one board for local and external tasks.

Every task, wherever it lives, reaches the UI in the same
shape (``TaskItem``), placed in one of four fixed board
columns. A task ID says where the task lives:

- ``local:<id>`` for a task kept in the dashboard;
- ``<provider>:<connection id>:<id in the tracker>`` for one
  read from Jira, Shortcut or Huly through a connection.

Tasks from trackers are read into a cache (``TaskCache``) by
``sync_connection`` and shown from there. Each is placed in a
column by its status: the user's mapping for that status name
if there is one, else the tracker's own category (see
``auto_column``).

Status changes go through two endpoints that work the same
for every source: one lists the statuses a task can move to,
the other moves it.
"""

import asyncio
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import auth, database, models, providers, secretbox
from .providers import huly, jira, shortcut

logger = logging.getLogger(__name__)

# Tracker modules by provider name (see ``providers``).
PROVIDERS: Dict[str, Any] = {"jira": jira, "shortcut": shortcut, "huly": huly}

# Each connection is read again this often, in seconds.
SYNC_INTERVAL = 600
# How often the poller looks for connections due a read.
POLL_TICK = 60
# A manual refresh skips connections read this recently (seconds).
REFRESH_COOLDOWN = 15
# Connection ID -> earliest time it may be read again, after a
# tracker asked to slow down (HTTP 429 with Retry-After).
_retry_at: Dict[int, datetime] = {}

router = APIRouter(prefix="/tasks", tags=["tasks"])

Column = Literal["todo", "in_progress", "review", "done"]
Priority = providers.Priority

# Board columns, left to right, with the name a status gets
# for local tasks (their status is their column).
COLUMNS = {
    "todo": "To do",
    "in_progress": "In progress",
    "review": "In review",
    "done": "Done",
}


class TaskItem(providers.TaskFields):
    """A task as the board shows it, whatever its source.

    Besides the fields every task has (see ``TaskFields``):

    Attributes:
        id: ``<source>:<id within the source>``.
        source: Where the task lives: local, jira, shortcut, huly.
        connection_id: The external connection it came from;
            None for local tasks.
        connection_name: That connection's name, for the badge.
        column: Board column the task is shown in.
    """

    id: str
    source: str
    connection_id: Optional[int] = None
    connection_name: Optional[str] = None
    column: Column


class StatusOption(BaseModel):
    """A status a task can be moved to.

    Attributes:
        id: What to send back to move the task there.
        name: The status as the tracker names it.
        column: Board column the status belongs to.
        fields: Required fields the move asks for, if any.
    """

    id: str
    name: str
    column: Column
    fields: List[providers.StatusField] = Field(default_factory=list)


class StatusChange(BaseModel):
    """Request to move a task to another status.

    Attributes:
        status_id: One of the IDs the statuses endpoint listed.
        fields: Values the tracker requires for this move.
    """

    status_id: str = Field(..., min_length=1, max_length=200)
    # Values for fields the tracker asks for on this move, by
    # field ID (Jira transition screens).
    fields: Dict[str, Any] = Field(default_factory=dict)


Tags = List[str]


def _clean_tags(tags: Optional[Tags]) -> Optional[Tags]:
    """Trims tags, drops blanks and repeats, keeps the order.

    Args:
        tags: Tags as the user typed them, or None.

    Returns:
        The cleaned list, or None when none was given.

    Raises:
        HTTPException: 422 for more than 20 tags or one longer
            than 40 characters.
    """
    if tags is None:
        return None
    cleaned = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
    if len(cleaned) > 20 or any(len(t) > 40 for t in cleaned):
        raise HTTPException(
            status_code=422, detail="At most 20 tags of up to 40 characters"
        )
    return cleaned


class LocalTaskCreate(BaseModel):
    """Fields of a new local task."""

    title: str = Field(..., max_length=300)
    description: str = Field("", max_length=20000)
    column: Column = "todo"
    priority: Optional[Priority] = None
    due_date: Optional[date] = None
    tags: Tags = Field(default_factory=list)


class LocalTaskChange(BaseModel):
    """Changes to a local task. Fields left out keep their value;
    an explicit null clears priority or due date."""

    title: Optional[str] = Field(None, max_length=300)
    description: Optional[str] = Field(None, max_length=20000)
    column: Optional[Column] = None
    priority: Optional[Priority] = None
    due_date: Optional[date] = None
    tags: Optional[Tags] = None


def _iso(value: Optional[datetime]) -> Optional[str]:
    """Formats a stored timestamp as ISO 8601 in UTC.

    SQLite gives naive datetimes back; they were written in UTC.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _local_item(task: models.LocalTask) -> TaskItem:
    """Converts a stored local task to the board's shape."""
    return TaskItem(
        id=f"local:{task.id}",
        source="local",
        title=task.title,
        description=task.description or "",
        column=task.column,
        status=task.column,
        priority=task.priority,
        due_date=task.due_date,
        tags=task.tags_json or [],
        updated_at=_iso(task.updated_at),
    )


def _own_local_task(db: Session, email: str, task_id: int) -> models.LocalTask:
    """Fetches a local task of the user.

    Raises:
        HTTPException: 404 when the task does not exist or
            belongs to someone else; the two look the same so
            IDs of other users' tasks are not revealed.
    """
    task = db.get(models.LocalTask, task_id)
    if task is None or task.owner_email != email:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


# Status names that count as "In review" when the tracker only
# says the work has started.
_REVIEW = re.compile(r"review|\bqa\b|\btest|verif|approv|valida", re.IGNORECASE)


def auto_column(category: str, status: str) -> str:
    """The column a status goes in when the user did not choose.

    The tracker's category decides, except that a started status
    whose name reads like a review step goes to "In review".

    Args:
        category: todo, in_progress or done.
        status: The tracker's status name.

    Returns:
        A board column.
    """
    if category == "in_progress" and _REVIEW.search(status):
        return "review"
    return category if category in COLUMNS else "todo"


def column_for(mapping: Dict[str, str], category: str, status: str) -> str:
    """The column for a status: the user's choice, else automatic."""
    chosen = (mapping or {}).get(status)
    return chosen if chosen in COLUMNS else auto_column(category, status)


def external_item(row: models.TaskConnection, task: providers.ExternalTask) -> TaskItem:
    """Places a tracker's task on the board."""
    return TaskItem(
        **task.model_dump(exclude={"external_id", "category"}),
        id=f"{row.provider}:{row.id}:{task.external_id}",
        source=row.provider,
        connection_id=row.id,
        connection_name=row.name,
        column=column_for(row.mapping_json, task.category, task.status),
    )


def open_conn(row: models.TaskConnection) -> providers.Conn:
    """Decrypts a stored connection for use.

    Raises:
        ProviderError: 400 when the token cannot be decrypted,
            i.e. SECRET_KEY changed since it was saved.
    """
    try:
        secret = secretbox.decrypt(row.secret_enc)
    except secretbox.SecretUnreadable as e:
        raise providers.ProviderError(
            "The saved token can no longer be read (the dashboard's "
            "SECRET_KEY changed). Edit the connection and enter it again.",
            400,
        ) from e
    return providers.Conn(
        id=row.id,
        name=row.name,
        provider=row.provider,
        config=row.config_json or {},
        secret=secret,
        filters=row.filters_json or {},
    )


def provider_of(row: models.TaskConnection) -> Any:
    """The tracker module for a connection.

    Raises:
        ProviderError: 400 for a provider this build lacks.
    """
    module = PROVIDERS.get(row.provider)
    if module is None:
        raise providers.ProviderError(f"Unknown tracker: {row.provider}", 400)
    return module


async def sync_connection(db: Session, row: models.TaskConnection) -> None:
    """Reads a connection's tasks into its cache.

    A failure is recorded on the connection (``last_error``) and
    the previous cache is kept, so the board still shows the
    last tasks read.

    Args:
        db: Database session; committed here.
        row: The connection.
    """
    now = datetime.now(timezone.utc)
    try:
        conn = open_conn(row)
        async with providers.http_client() as http:
            tasks = await provider_of(row).fetch(conn, http)
    except providers.ProviderError as e:
        row.last_error = e.message
        if e.retry_after:
            _retry_at[row.id] = now + timedelta(seconds=e.retry_after)
        logger.warning("Sync of task connection %s failed: %s", row.id, e.message)
    except Exception:  # pylint: disable=broad-exception-caught
        # A tracker answering in an unexpected shape must not
        # stop the other connections from being read.
        row.last_error = "Unexpected error while reading the tasks."
        logger.exception("Sync of task connection %s failed", row.id)
    else:
        items = [task.model_dump() for task in tasks]
        if row.cache is None:
            row.cache = models.TaskCache(items_json=items, synced_at=now)
        else:
            row.cache.items_json = items
            row.cache.synced_at = now
        row.last_error = None
    row.last_sync_at = now
    db.commit()


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    """A stored timestamp as an aware UTC datetime (SQLite gives
    naive ones back; they were written in UTC)."""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def due_connections(db: Session, now: datetime) -> List[models.TaskConnection]:
    """Connections whose tasks are older than ``SYNC_INTERVAL``
    and that no tracker asked to wait for."""
    stale = now - timedelta(seconds=SYNC_INTERVAL)
    due = []
    for row in db.query(models.TaskConnection).order_by(models.TaskConnection.id):
        last = _utc(row.last_sync_at)
        if last is not None and last > stale:
            continue
        if _retry_at.get(row.id, now) > now:
            continue
        due.append(row)
    return due


def _snapshot(row: models.TaskConnection) -> tuple:
    """What a board shows of a connection, to tell if a read
    changed anything."""
    return (row.cache.items_json if row.cache else None, row.last_error)


async def sync_due(notify: Callable[[str], Awaitable[None]]) -> int:
    """Reads every connection that is due, one after the other.

    The database work is synchronous SQLite, short next to the
    HTTP calls (which are awaited).

    Args:
        notify: Called with the email of each user whose board
            changed, to tell their open pages.

    Returns:
        How many connections were read.
    """
    db = database.SessionLocal()
    try:
        rows = due_connections(db, datetime.now(timezone.utc))
        changed = set()
        for row in rows:
            try:
                before = _snapshot(row)
                await sync_connection(db, row)
                if _snapshot(row) != before:
                    changed.add(row.owner_email)
            except Exception:  # pylint: disable=broad-exception-caught
                # E.g. the row was deleted mid-read: skip it, so
                # the connections after it still get read.
                db.rollback()
                logger.exception("Could not save the read of connection %s", row.id)
        for email in changed:
            await notify(email)
        return len(rows)
    finally:
        db.close()


async def poll_forever(notify: Callable[[str], Awaitable[None]]) -> None:
    """Keeps every connection's tasks fresh, for as long as the
    backend runs. Started once at startup.

    Args:
        notify: As for ``sync_due``.
    """
    while True:
        try:
            await sync_due(notify)
        except Exception:  # pylint: disable=broad-exception-caught
            logger.exception("Task connection poller failed; retrying")
        await asyncio.sleep(POLL_TICK)


def user_connections(db: Session, email: str) -> List[models.TaskConnection]:
    """The user's connections, oldest first."""
    return (
        db.query(models.TaskConnection)
        .filter(models.TaskConnection.owner_email == email)
        .order_by(models.TaskConnection.id)
        .all()
    )


def own_connection(db: Session, email: str, connection_id: int):
    """Fetches one of the user's connections.

    Raises:
        HTTPException: 404 when it is missing or someone else's.
    """
    row = db.get(models.TaskConnection, connection_id)
    if row is None or row.owner_email != email:
        raise HTTPException(status_code=404, detail="Connection not found")
    return row


def cached_items(row: models.TaskConnection) -> List[TaskItem]:
    """The board items of a connection's cache."""
    if row.cache is None:
        return []
    items = []
    for raw in row.cache.items_json or []:
        try:
            items.append(external_item(row, providers.ExternalTask(**raw)))
        except ValueError:
            # A cache written by another version: skip the item;
            # the next sync rewrites it.
            continue
    return items


async def board(db: Session, email: str) -> List[TaskItem]:
    """Every task on the user's board.

    Connections never read before are read now, so a new one
    shows its tasks at once.
    """
    items = [
        _local_item(task)
        for task in db.query(models.LocalTask).filter(
            models.LocalTask.owner_email == email
        )
    ]
    for row in user_connections(db, email):
        if row.cache is None and row.last_sync_at is None:
            await sync_connection(db, row)
        items += cached_items(row)
    return items


_NUMBER = re.compile(r"[0-9]{1,18}")


def _parse_task_id(task_id: str) -> Tuple[str, Optional[int], str]:
    """Splits a task ID into source, connection and the rest.

    Returns:
        ``("local", None, "<id>")`` or
        ``(<provider>, <connection id>, <id in the tracker>)``.

    Raises:
        HTTPException: 404 for an ID of no known shape.
    """
    source, _, rest = task_id.partition(":")
    if source == "local" and _NUMBER.fullmatch(rest):
        return source, None, rest
    connection, _, external = rest.partition(":")
    if source in PROVIDERS and _NUMBER.fullmatch(connection) and external:
        return source, int(connection), external
    raise HTTPException(status_code=404, detail="Task not found")


def http_error(e: providers.ProviderError) -> HTTPException:
    """The API answer for a tracker's failure."""
    return HTTPException(status_code=e.status_code, detail=e.message)


# What a tracker answering in an unexpected shape (not JSON, a
# missing key, a wrong type) raises while being read.
UNEXPECTED = (ValueError, KeyError, TypeError)


def unexpected_answer(e: Exception) -> HTTPException:
    """The API answer for a tracker answer that cannot be read."""
    logger.warning("Unexpected answer from a tracker: %s", type(e).__name__)
    return HTTPException(
        status_code=502, detail="The tracker answered in an unexpected way."
    )


@router.get("", response_model=List[TaskItem])
async def list_tasks(
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Lists every task on the user's board.

    Tasks from trackers come from the cache; see ``/refresh``.

    Args:
        db: Database session.
        email: The logged-in user. Requires UI login.

    Returns:
        The user's tasks, in no particular order: the board
        sorts them.
    """
    return await board(db, email)


class RefreshRequest(BaseModel):
    """Which connections to read again.

    Attributes:
        connection_id: Only this one; every connection when None.
    """

    connection_id: Optional[int] = None


@router.post("/refresh", response_model=List[TaskItem])
async def refresh_tasks(
    body: RefreshRequest,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Reads the user's connections again, then lists the board.

    A connection that fails keeps its previous tasks and records
    why on itself (see ``GET /tasks/connections``).

    Raises:
        HTTPException: 404 for a connection that is not the user's.
    """
    if body.connection_id is not None:
        rows = [own_connection(db, email, body.connection_id)]
    else:
        rows = user_connections(db, email)
    # A connection read moments ago is not read again, so clicking
    # refresh in a loop cannot keep the trackers busy.
    recent = datetime.now(timezone.utc) - timedelta(seconds=REFRESH_COOLDOWN)
    for row in rows:
        last = _utc(row.last_sync_at)
        if last is None or last < recent:
            await sync_connection(db, row)
    return await board(db, email)


@router.post("/local", response_model=TaskItem)
def create_local_task(
    body: LocalTaskCreate,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Creates a local task for the user.

    Args:
        body: The task's fields.
        db: Database session.
        email: The logged-in user. Requires UI login.

    Returns:
        The new task.

    Raises:
        HTTPException: 422 for a blank title or invalid tags.
    """
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Title is required")
    task = models.LocalTask(
        owner_email=email,
        title=title,
        description=body.description,
        column=body.column,
        priority=body.priority,
        due_date=body.due_date.isoformat() if body.due_date else None,
        tags_json=_clean_tags(body.tags),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _local_item(task)


@router.patch("/local/{task_id}", response_model=TaskItem)
def update_local_task(
    task_id: int,
    body: LocalTaskChange,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Changes fields of one of the user's local tasks.

    Args:
        task_id: The task's number (without ``local:``).
        body: The fields to change.
        db: Database session.
        email: The logged-in user. Requires UI login.

    Returns:
        The task as saved.

    Raises:
        HTTPException: 404 if the task is not the user's, 422
            for a blank title or invalid tags.
    """
    task = _own_local_task(db, email, task_id)
    given = body.model_fields_set
    if "title" in given:
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(status_code=422, detail="Title is required")
        task.title = title
    if "description" in given:
        task.description = body.description or ""
    if "column" in given and body.column:
        task.column = body.column
    if "priority" in given:
        task.priority = body.priority
    if "due_date" in given:
        task.due_date = body.due_date.isoformat() if body.due_date else None
    if "tags" in given:
        task.tags_json = _clean_tags(body.tags) or []
    db.commit()
    db.refresh(task)
    return _local_item(task)


@router.delete("/local/{task_id}")
def delete_local_task(
    task_id: int,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Deletes one of the user's local tasks.

    Raises:
        HTTPException: 404 if the task is not the user's.
    """
    db.delete(_own_local_task(db, email, task_id))
    db.commit()
    return {"ok": True}


@router.get("/{task_id}/statuses", response_model=List[StatusOption])
async def list_statuses(
    task_id: str,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Lists the statuses a task can be moved to right now.

    For a local task these are the four board columns; for a
    tracker's task, what its workflow allows from where it is.

    Args:
        task_id: ``<source>:<id>``.
        db: Database session.
        email: The logged-in user. Requires UI login.

    Raises:
        HTTPException: 404 if the task is not the user's; the
            tracker's error when it fails.
    """
    source, connection_id, external = _parse_task_id(task_id)
    if source == "local":
        _own_local_task(db, email, int(external))
        return [
            StatusOption(id=key, name=name, column=key) for key, name in COLUMNS.items()
        ]
    row = own_connection(db, email, connection_id)
    try:
        conn = open_conn(row)
        async with providers.http_client() as http:
            options = await provider_of(row).statuses(conn, http, external)
    except providers.ProviderError as e:
        raise http_error(e) from e
    except UNEXPECTED as e:
        raise unexpected_answer(e) from e
    return [
        StatusOption(
            id=o.id,
            name=o.name,
            column=column_for(row.mapping_json, o.category, o.name),
            fields=o.fields,
        )
        for o in options
    ]


@router.get("/{task_id}/users", response_model=List[providers.Choice])
async def search_users(
    task_id: str,
    query: str = "",
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """People a tracker's task can be assigned to, by name.

    Args:
        task_id: ``<provider>:<connection id>:<id>``.
        query: Part of a name or email; may be empty.
        db: Database session.
        email: The logged-in user. Requires UI login.

    Raises:
        HTTPException: 404 for a local task or one not the
            user's; the tracker's error when it fails.
    """
    _, found = await _external_call(
        db, email, task_id, lambda m, c, h, x: m.search_users(c, h, x, query[:100])
    )
    return found


async def _external_call(
    db: Session, email: str, task_id: str, action: Callable
) -> Tuple[models.TaskConnection, Any]:
    """Runs one call against the tracker a task lives in.

    Args:
        db: Database session.
        email: The logged-in user.
        task_id: ``<provider>:<connection id>:<id>``.
        action: ``action(module, conn, http, external_id)``,
            awaited; its result is returned.

    Returns:
        The connection and the action's result.

    Raises:
        HTTPException: 404 for a local task or one not the
            user's; the tracker's error when it fails.
    """
    source, connection_id, external = _parse_task_id(task_id)
    if source == "local":
        raise HTTPException(status_code=404, detail="Not available for local tasks")
    row = own_connection(db, email, connection_id)
    try:
        conn = open_conn(row)
        async with providers.http_client() as http:
            return row, await action(provider_of(row), conn, http, external)
    except providers.ProviderError as e:
        raise http_error(e) from e
    except UNEXPECTED as e:
        raise unexpected_answer(e) from e


@router.get("/{task_id}/comments", response_model=List[providers.Comment])
async def list_comments(
    task_id: str,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """A tracker's task's comments, oldest first.

    Raises:
        HTTPException: As ``_external_call``.
    """
    _, found = await _external_call(
        db, email, task_id, lambda m, c, h, x: m.comments(c, h, x)
    )
    return found


class NewComment(BaseModel):
    """A comment to add, as plain text."""

    body: str = Field(..., max_length=20000)


@router.post("/{task_id}/comments", response_model=providers.Comment)
async def create_comment(
    task_id: str,
    body: NewComment,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Adds a comment to a tracker's task.

    Raises:
        HTTPException: 422 for a blank comment; as ``_external_call``.
    """
    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Comment is empty")
    _, added = await _external_call(
        db, email, task_id, lambda m, c, h, x: m.add_comment(c, h, x, text)
    )
    return added


class AssigneeChange(BaseModel):
    """Who to assign a tracker's task to.

    Attributes:
        user_id: An ID from the users endpoint; None for nobody.
    """

    user_id: Optional[str] = Field(None, max_length=200)


@router.put("/{task_id}/assignee", response_model=TaskItem)
async def change_assignee(
    task_id: str,
    body: AssigneeChange,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Assigns a tracker's task to someone, or to nobody.

    Returns:
        The task as it is now. It stays on the board until the
        next read, even when the filter no longer selects it.

    Raises:
        HTTPException: As ``_external_call``.
    """
    row, task = await _external_call(
        db, email, task_id, lambda m, c, h, x: m.assign(c, h, x, body.user_id)
    )
    store_in_cache(row, task)
    db.commit()
    return external_item(row, task)


def store_in_cache(row: models.TaskConnection, task: providers.ExternalTask):
    """Puts a task's new state in the connection's cache, so the
    board keeps it until the next sync."""
    if row.cache is None:
        row.cache = models.TaskCache(items_json=[])
    items = [
        i
        for i in row.cache.items_json or []
        if i.get("external_id") != task.external_id
    ]
    # A new list: SQLAlchemy only notices a JSON column that is
    # assigned, not one changed in place.
    row.cache.items_json = items + [task.model_dump()]


@router.post("/{task_id}/status", response_model=TaskItem)
async def change_status(
    task_id: str,
    body: StatusChange,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Moves a task to another status.

    Args:
        task_id: ``<source>:<id>``.
        body: One of the IDs the statuses endpoint listed, and
            the fields the tracker asks for, if any.
        db: Database session.
        email: The logged-in user. Requires UI login.

    Returns:
        The task as it is now.

    Raises:
        HTTPException: 404 if the task is not the user's, 422
            for a status it cannot move to; the tracker's error
            when it refuses.
    """
    source, connection_id, external = _parse_task_id(task_id)
    if source == "local":
        task = _own_local_task(db, email, int(external))
        if body.status_id not in COLUMNS:
            raise HTTPException(status_code=422, detail="Unknown status")
        task.column = body.status_id
        db.commit()
        db.refresh(task)
        return _local_item(task)
    row = own_connection(db, email, connection_id)
    try:
        conn = open_conn(row)
        async with providers.http_client() as http:
            moved = await provider_of(row).set_status(
                conn, http, external, body.status_id, body.fields
            )
    except providers.ProviderError as e:
        raise http_error(e) from e
    except UNEXPECTED as e:
        raise unexpected_answer(e) from e
    store_in_cache(row, moved)
    db.commit()
    return external_item(row, moved)
