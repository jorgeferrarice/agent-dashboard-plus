"""Connections of the Tasks tab to external trackers.

A connection is one account of Jira, Shortcut or Huly that a
UI user added, with a name of their choice. Its token is
checked against the tracker before it is saved, stored
encrypted, and never returned by the API.
"""

from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import auth, connections, database, models, providers, secretbox, tasks

router = APIRouter(prefix="/tasks/connections", tags=["tasks"])

ProviderName = Literal["jira", "shortcut", "huly"]


class ConnectionOut(connections.ConnectionInfo):
    """A connection as the UI sees it: everything but the token
    (see ``ConnectionInfo``), plus:

    Attributes:
        filters: Which tasks it shows.
        mapping: Board column per status name, as the user set it.
        task_count: How many tasks the last read found.
    """

    filters: Dict[str, Any]
    mapping: Dict[str, str]
    task_count: int = 0


class ConnectionCreate(connections.NewConnection):
    """A new connection."""

    provider: ProviderName


class ConnectionChange(connections.ConnectionEdit):
    """Changes to a connection (see ``ConnectionEdit``), plus its
    filters and status mapping."""

    filters: Optional[Dict[str, Any]] = None
    mapping: Optional[Dict[str, str]] = None


def _out(row: models.TaskConnection) -> ConnectionOut:
    return ConnectionOut(
        **connections.info(row),
        filters=row.filters_json or {},
        mapping=row.mapping_json or {},
        task_count=len(row.cache.items_json or []) if row.cache else 0,
    )


def _clean_mapping(mapping: Dict[str, str]) -> Dict[str, str]:
    """Keeps only entries that name a board column.

    Raises:
        HTTPException: 422 for an unknown column or too many entries.
    """
    if len(mapping) > 500:
        raise HTTPException(status_code=422, detail="Too many status mappings")
    for status, column in mapping.items():
        if column not in tasks.COLUMNS or len(status) > 200:
            raise HTTPException(status_code=422, detail="Unknown column")
    return dict(mapping)


def _same_place_or_refuse(row: models.TaskConnection, config: Dict[str, Any]):
    """Refuses new settings that would send the saved token
    somewhere else (another site, account or workspace) unless
    the token is entered again.

    Raises:
        HTTPException: 422 when the settings point elsewhere.
    """
    try:
        cleaned = tasks.provider_of(row).normalize_config(config)
    except providers.ProviderError as e:
        raise tasks.http_error(e) from e
    except tasks.UNEXPECTED as e:
        raise tasks.unexpected_answer(e) from e
    saved = {k: v for k, v in (row.config_json or {}).items() if k != "account"}
    if cleaned != saved:
        raise HTTPException(
            status_code=422,
            detail="Enter the token again when changing these settings",
        )


async def _verify(provider: str, config: Dict[str, Any], secret: str) -> Dict[str, Any]:
    """Validates settings and token against the tracker.

    Returns:
        The cleaned settings, with ``account`` added.

    Raises:
        HTTPException: 422 for bad settings, 400 when the tracker
            rejects the token, or the tracker's error.
    """
    module = tasks.PROVIDERS.get(provider)
    if module is None:
        raise HTTPException(status_code=422, detail=f"{provider} is not supported yet")
    cleaned, account = await connections.verify(module, provider, config, secret)
    return {**cleaned, "account": account}


@router.get("", response_model=List[ConnectionOut])
def list_connections(
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Lists the user's connections, oldest first."""
    return [_out(row) for row in tasks.user_connections(db, email)]


@router.post("", response_model=ConnectionOut)
async def create_connection(
    body: ConnectionCreate,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Adds a connection after checking its token, then reads its
    tasks once so they show up right away.

    Raises:
        HTTPException: 422 for a blank name or bad settings, 400
            when the tracker rejects the token.
    """
    connections.clean_name(body.name)
    config = await _verify(body.provider, body.config, body.secret)
    row = await connections.create(
        db,
        models.TaskConnection,
        email,
        body,
        config,
        tasks.sync_connection,
        filters_json={},
        mapping_json={},
    )
    return _out(row)


@router.patch("/{connection_id}", response_model=ConnectionOut)
async def update_connection(
    connection_id: int,
    body: ConnectionChange,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Changes a connection. New settings or a new token are
    checked against the tracker before they are saved; changed
    settings or filters read the tasks again.

    Raises:
        HTTPException: 404 if not the user's; as for creating.
    """
    row = tasks.own_connection(db, email, connection_id)
    given = body.model_fields_set
    resync = False
    if "name" in given:
        row.name = connections.clean_name(body.name)
    new_secret = (body.secret or "").strip()
    if ("config" in given and body.config is not None) or new_secret:
        config = body.config if body.config is not None else row.config_json
        if new_secret:
            secret = new_secret
        else:
            _same_place_or_refuse(row, config)
            try:
                secret = tasks.open_conn(row).secret
            except providers.ProviderError as e:
                raise tasks.http_error(e) from e
            except tasks.UNEXPECTED as e:
                raise tasks.unexpected_answer(e) from e
        row.config_json = await _verify(row.provider, config, secret)
        if new_secret:
            row.secret_enc = secretbox.encrypt(new_secret)
        resync = True
    if "filters" in given and body.filters is not None:
        try:
            row.filters_json = tasks.provider_of(row).normalize_filters(body.filters)
        except providers.ProviderError as e:
            raise tasks.http_error(e) from e
        except tasks.UNEXPECTED as e:
            raise tasks.unexpected_answer(e) from e
        resync = True
    if "mapping" in given and body.mapping is not None:
        row.mapping_json = _clean_mapping(body.mapping)
    db.commit()
    if resync:
        await tasks.sync_connection(db, row)
    db.refresh(row)
    return _out(row)


@router.delete("/{connection_id}")
def delete_connection(
    connection_id: int,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Removes a connection, its token and its cached tasks.
    Nothing changes in the tracker.

    Raises:
        HTTPException: 404 if not the user's.
    """
    db.delete(tasks.own_connection(db, email, connection_id))
    db.commit()
    return {"ok": True}


class StatusColumn(BaseModel):
    """Where a status of a connection goes on the board.

    Attributes:
        name: The tracker's status name.
        category: The tracker's own kind: todo, in_progress, done.
        auto_column: The column it gets unless the user chooses.
        column: The column it goes in now.
    """

    name: str
    category: str
    auto_column: str
    column: str


@router.get("/{connection_id}/statuses", response_model=List[StatusColumn])
def list_status_columns(
    connection_id: int,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """The statuses known for a connection and their columns.

    Known statuses are those of the tasks last read, plus any the
    user mapped before; a status the tracker adds later shows up
    after the next read, in its automatic column.

    Raises:
        HTTPException: 404 if not the user's.
    """
    row = tasks.own_connection(db, email, connection_id)
    mapping = row.mapping_json or {}
    seen: Dict[str, str] = {}
    for item in (row.cache.items_json if row.cache else None) or []:
        seen.setdefault(item.get("status") or "", item.get("category") or "todo")
    for status in mapping:
        seen.setdefault(status, "todo")
    seen.pop("", None)
    return [
        StatusColumn(
            name=name,
            category=category,
            auto_column=tasks.auto_column(category, name),
            column=tasks.column_for(mapping, category, name),
        )
        for name, category in sorted(seen.items(), key=lambda kv: kv[0].lower())
    ]


async def _connection_call(db: Session, email: str, connection_id: int, action):
    """Runs ``action(module, conn, http)`` against a connection.

    Returns:
        The connection row and the action's result.

    Raises:
        HTTPException: 404 if not the user's; the tracker's error.
    """
    row = tasks.own_connection(db, email, connection_id)
    try:
        conn = tasks.open_conn(row)
        async with providers.http_client() as http:
            return row, await action(tasks.provider_of(row), conn, http)
    except providers.ProviderError as e:
        raise tasks.http_error(e) from e
    except tasks.UNEXPECTED as e:
        raise tasks.unexpected_answer(e) from e


@router.get("/{connection_id}/create-options", response_model=providers.CreateOptions)
async def create_options(
    connection_id: int,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Projects and priorities for a new task in a tracker."""
    _, options = await _connection_call(
        db, email, connection_id, lambda m, c, h: m.create_options(c, h)
    )
    return options


@router.get("/{connection_id}/types", response_model=List[providers.Choice])
async def task_types(
    connection_id: int,
    project: str,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """The kinds of task a project allows (Jira issue types)."""
    _, found = await _connection_call(
        db, email, connection_id, lambda m, c, h: m.types(c, h, project[:200])
    )
    return found


@router.post("/{connection_id}/tasks", response_model=tasks.TaskItem)
async def create_task(
    connection_id: int,
    body: providers.NewTask,
    db: Session = Depends(database.get_db),
    email: str = Depends(auth.current_email),
):
    """Creates a task in a tracker, assigned to the connection's
    account, and puts it on the board right away.

    Raises:
        HTTPException: 422 for a blank title or when the tracker
            asks for more fields; the tracker's other errors.
    """
    if not body.title.strip():
        raise HTTPException(status_code=422, detail="Title is required")
    clean = body.model_copy(update={"title": body.title.strip()})
    row, created = await _connection_call(
        db, email, connection_id, lambda m, c, h: m.create(c, h, clean)
    )
    tasks.store_in_cache(row, created)
    db.commit()
    return tasks.external_item(row, created)
