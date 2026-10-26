"""What the Tasks and Git tabs' connections have in common.

A connection is one external account a UI user added (a Jira
site, a GitHub account, ...). Each tab keeps its own table of
connections, but they share the columns used here
(``owner_email``, ``last_sync_at``, ``last_error``) and the same
life: read on a timer into a cache, read again on request, and
reachable only by their owner.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import database, providers, secretbox

logger = logging.getLogger(__name__)

Notify = Callable[[str], Awaitable[None]]


class ConnectionInfo(BaseModel):
    """A connection as the UI sees it: everything but the token.

    Attributes:
        id: Connection ID.
        provider: The service, e.g. jira or github.
        name: The user's name for it.
        config: Settings that are not secret (site, email, ...),
            plus ``account``: who the token belongs to.
        last_sync_at: When it was last read.
        last_error: Why the last read failed; None when it worked.
    """

    id: int
    provider: str
    name: str
    config: Dict[str, Any]
    last_sync_at: Optional[datetime] = None
    last_error: Optional[str] = None


def info(row: Any) -> Dict[str, Any]:
    """The ``ConnectionInfo`` fields of a stored connection."""
    return {
        "id": row.id,
        "provider": row.provider,
        "name": row.name,
        "config": row.config_json or {},
        "last_sync_at": row.last_sync_at,
        "last_error": row.last_error,
    }


class NewConnection(BaseModel):
    """A new connection; each tab adds its ``provider`` field."""

    name: str = Field(..., max_length=60)
    config: Dict[str, Any] = Field(default_factory=dict)
    secret: str = Field(..., max_length=4000)


class ConnectionEdit(BaseModel):
    """Changes to a connection. Fields left out keep their value;
    a blank secret keeps the saved one."""

    name: Optional[str] = Field(None, max_length=60)
    config: Optional[Dict[str, Any]] = None
    secret: Optional[str] = Field(None, max_length=4000)


class RefreshRequest(BaseModel):
    """Which connections to read again.

    Attributes:
        connection_id: Only this one; every connection when None.
    """

    connection_id: Optional[int] = None


def http_error(e: providers.ProviderError) -> HTTPException:
    """The API answer for a service's failure."""
    return HTTPException(status_code=e.status_code, detail=e.message)


# What a service answering in an unexpected shape (not JSON, a
# missing key, a wrong type) raises while being read.
UNEXPECTED = (ValueError, KeyError, TypeError)


def unexpected_answer(e: Exception) -> HTTPException:
    """The API answer for a service answer that cannot be read."""
    logger.warning("Unexpected answer from a service: %s", type(e).__name__)
    return HTTPException(
        status_code=502, detail="The tracker answered in an unexpected way."
    )


def utc(value: Optional[datetime]) -> Optional[datetime]:
    """A stored timestamp as an aware UTC datetime (SQLite gives
    naive ones back; they were written in UTC)."""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def user_rows(db: Session, model: Any, email: str) -> List[Any]:
    """A user's connections of one kind, oldest first."""
    return db.query(model).filter(model.owner_email == email).order_by(model.id).all()


def own_row(db: Session, model: Any, email: str, connection_id: int) -> Any:
    """Fetches one of the user's connections.

    Raises:
        HTTPException: 404 when it is missing or someone else's;
            the two look the same, so other users' IDs are not
            revealed.
    """
    row = db.get(model, connection_id)
    if row is None or row.owner_email != email:
        raise HTTPException(status_code=404, detail="Connection not found")
    return row


async def verify(
    module: Any, provider: str, config: Dict[str, Any], secret: str
) -> Tuple[Dict[str, Any], Any]:
    """Validates a connection's settings and token against the
    service, before anything is saved.

    Args:
        module: The service's client (see ``providers``).

    Returns:
        The cleaned settings and what ``module.check`` returned
        (who the token belongs to).

    Raises:
        HTTPException: 422 for bad settings or no token, 400 when
            the service rejects the token, or the service's error.
    """
    if not secret.strip():
        raise HTTPException(status_code=422, detail="Token is required")
    try:
        cleaned = module.normalize_config(config)
        conn = providers.Conn(
            id=0, name="", provider=provider, config=cleaned, secret=secret.strip()
        )
        async with providers.http_client() as http:
            return cleaned, await module.check(conn, http)
    except providers.ProviderError as e:
        raise http_error(e) from e
    except UNEXPECTED as e:
        raise unexpected_answer(e) from e


async def create(
    db: Session,
    model: Any,
    email: str,
    body: Any,
    config: Dict[str, Any],
    run: Callable[[Session, Any], Awaitable[None]],
    **columns: Any,
) -> Any:
    """Saves a new, verified connection and reads it once, so its
    items show up right away.

    Args:
        model: The tab's connection table.
        body: The request (``provider``, ``name``, ``secret``).
        config: Settings from ``verify``.
        run: ``await run(db, row)``: reads it.
        columns: Other columns of the tab's table.

    Returns:
        The saved connection.
    """
    row = model(
        owner_email=email,
        provider=body.provider,
        name=clean_name(body.name),
        config_json=config,
        secret_enc=secretbox.encrypt(body.secret.strip()),
        **columns,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    await run(db, row)
    return row


def clean_name(name: Optional[str]) -> str:
    """Trims a connection name.

    Raises:
        HTTPException: 422 when blank.
    """
    cleaned = (name or "").strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="Name is required")
    return cleaned


async def sync(
    db: Session,
    row: Any,
    read: Callable[[Any], Awaitable[Any]],
    store: Callable[[Any, Any, datetime], None],
    retry_at: Dict[int, datetime],
    what: str,
) -> None:
    """Reads a connection into its cache.

    A failure is recorded on the connection (``last_error``) and
    the previous cache is kept, so the tab still shows what was
    read last. When the service asks to slow down, the time it
    may be read again goes in ``retry_at``.

    Args:
        db: Database session; committed here.
        row: The connection.
        read: Reads it: ``await read(row)``.
        store: Saves what was read: ``store(row, result, now)``.
        retry_at: Connection ID -> earliest next read.
        what: What is read, for the error, e.g. "the tasks".
    """
    now = datetime.now(timezone.utc)
    try:
        result = await read(row)
    except providers.ProviderError as e:
        row.last_error = e.message
        if e.retry_after:
            retry_at[row.id] = now + timedelta(seconds=e.retry_after)
        logger.warning("Sync of %s %s failed: %s", row.__tablename__, row.id, e.message)
    except Exception:  # pylint: disable=broad-exception-caught
        # A service answering in an unexpected shape must not stop
        # the other connections from being read.
        row.last_error = f"Unexpected error while reading {what}."
        logger.exception("Sync of %s %s failed", row.__tablename__, row.id)
    else:
        store(row, result, now)
        row.last_error = None
    row.last_sync_at = now
    db.commit()


def due(
    rows: Iterable[Any], interval: float, retry_at: Dict[int, datetime], now: datetime
) -> List[Any]:
    """Connections read longer than ``interval`` seconds ago that
    no service asked to wait for."""
    stale = now - timedelta(seconds=interval)
    found = []
    for row in rows:
        last = utc(row.last_sync_at)
        if last is not None and last > stale:
            continue
        if retry_at.get(row.id, now) > now:
            continue
        found.append(row)
    return found


async def sync_due(
    pick: Callable[[Session, datetime], List[Any]],
    run: Callable[[Session, Any], Awaitable[None]],
    snapshot: Callable[[Any], Any],
    notify: Notify,
) -> int:
    """Reads every connection that is due, one after the other.

    The database work is synchronous SQLite, short next to the
    HTTP calls (which are awaited).

    Args:
        pick: ``pick(db, now)``: the connections due a read.
        run: ``await run(db, row)``: reads one.
        snapshot: What a page shows of a connection, to tell if
            a read changed anything.
        notify: Called with the email of each user whose page
            changed, to tell their open pages.

    Returns:
        How many connections were read.
    """
    db = database.SessionLocal()
    try:
        rows = pick(db, datetime.now(timezone.utc))
        changed = set()
        for row in rows:
            try:
                before = snapshot(row)
                await run(db, row)
                if snapshot(row) != before:
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


async def forever(step: Callable[[], Awaitable[Any]], tick: float, name: str) -> None:
    """Runs ``step`` every ``tick`` seconds for as long as the
    backend runs; a failing step is logged and retried.

    Args:
        name: What is polled, for the log.
    """
    while True:
        try:
            await step()
        except Exception:  # pylint: disable=broad-exception-caught
            logger.exception("%s poller failed; retrying", name)
        await asyncio.sleep(tick)


async def refresh(
    db: Session,
    model: Any,
    email: str,
    body: RefreshRequest,
    run: Callable[[Session, Any], Awaitable[None]],
    cooldown: float,
) -> None:
    """Reads a user's connections again on request: the one the
    body names, or all of them. Those read in the last
    ``cooldown`` seconds are skipped, so clicking in a loop cannot
    flood the services.

    Raises:
        HTTPException: 404 for a connection that is not the user's.
    """
    if body.connection_id is not None:
        rows = [own_row(db, model, email, body.connection_id)]
    else:
        rows = user_rows(db, model, email)
    recent = datetime.now(timezone.utc) - timedelta(seconds=cooldown)
    for row in rows:
        last = utc(row.last_sync_at)
        if last is None or last < recent:
            await run(db, row)
