"""FastAPI application and REST API endpoints for Agent Dashboard.

Defines Pydantic schemas, authentication endpoints, and CRUD
operations for hosts, agents, and telemetry.
"""

import asyncio
import os
import re
import secrets as secrets_module
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
import socketio
from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, inspect, text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from . import models, database, auth, socket, tasks, secretbox, task_connections

# Initialize the database
models.Base.metadata.create_all(bind=database.engine)


def _add_missing_columns() -> None:
    """Adds columns that are newer than an existing database.

    ``create_all`` only creates missing tables, so columns
    added to a table later are added here. Every such column is
    nullable, so old rows stay valid.
    """
    # ponytail: hand-rolled ALTER; move to Alembic once
    # migrations need more than added nullable columns.
    added = {"host_tool_settings": ["command_new", "command_resume"]}
    try:
        inspector = inspect(database.engine)
        with database.engine.begin() as conn:
            for table, columns in added.items():
                have = {c["name"] for c in inspector.get_columns(table)}
                for column in columns:
                    if column not in have:
                        conn.execute(
                            text(f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR")
                        )
    except Exception as e:  # pylint: disable=broad-exception-caught
        print(f"Could not add new database columns: {e}")


_add_missing_columns()

# --- Version tracking ---
# Read embedded version from /app/VERSION (written at build
# time). Falls back to "dev" if the file doesn't exist.
_CURRENT_VERSION = "dev"
try:
    with open("/app/VERSION", "r", encoding="utf-8") as _vf:
        _CURRENT_VERSION = _vf.read().strip() or "dev"
except FileNotFoundError:
    pass

# Regex to detect clean semver tags (e.g. v0.4.0) vs
# development builds (e.g. v0.4.0-3-g20799ff or just a hash)
_SEMVER_TAG = re.compile(r"^v?\d+\.\d+\.\d+$")

# Cached latest release info from GitHub
_latest_release: Dict[str, Optional[str]] = {
    "tag": None,
    "url": None,
}

# GitHub repo for release checks
_GITHUB_REPO = os.getenv(
    "GITHUB_REPO",
    "dustinblack/agent-dashboard",
)
# Interval between GitHub release checks (seconds)
_VERSION_CHECK_INTERVAL = 1800  # 30 minutes


def _parse_semver(version: str) -> Optional[tuple]:
    """Parses a version string into a (major, minor, patch)
    tuple. Returns None if the version is not a clean semver
    tag.
    """
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", version)
    if match:
        return tuple(int(x) for x in match.groups())
    return None


def _is_dev_build(version: str) -> bool:
    """Returns True if the version is a development build
    (not a clean semver tag).
    """
    return not _SEMVER_TAG.match(version)


fastapi_app = FastAPI(title="AI Coding Agent Dashboard API")

# Add Session Middleware for OIDC.
# SECRET_KEY is required when authentication is enabled.
# In BYPASS_AUTH mode a placeholder is acceptable since
# sessions are not used for access control.
_bypass_auth = os.getenv("BYPASS_AUTH", "false").lower() == "true"
_secret_key = os.getenv("SECRET_KEY", "")
if not _secret_key and not _bypass_auth:
    _secret_key = secrets_module.token_hex(32)
    print(
        "WARNING: SECRET_KEY not set — generated an ephemeral key. "
        "Sessions will not survive restarts. Set SECRET_KEY in the "
        "environment for production use."
    )
elif not _secret_key:
    _secret_key = "bypass-auth-placeholder"

fastapi_app.add_middleware(SessionMiddleware, secret_key=_secret_key)
# Third-party tokens of the Tasks tab are encrypted with a key
# derived from the same secret.
# Without a SECRET_KEY of its own (BYPASS_AUTH), the placeholder
# above is public, so a random key is used: tokens are then lost
# at every restart, as documented.
secretbox.configure(
    _secret_key if os.getenv("SECRET_KEY") else secrets_module.token_hex(32)
)

# Add CORS Middleware
# In lab environments (BYPASS_AUTH=true), we allow any HTTP/HTTPS origin.
# In production, specify comma-separated origins via the ALLOWED_ORIGINS env var.
allowed_origins_env = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:8080,http://127.0.0.1:8080"
)
allowed_origins = [
    origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()
]

if _bypass_auth:
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_origin_regex="https?://.*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# Mount Socket.IO
@fastapi_app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    """Answers invalid requests like FastAPI does, but without
    echoing the values sent: they may hold a tracker token."""
    errors = [
        {k: v for k, v in error.items() if k not in ("input", "ctx")}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


fastapi_app.include_router(task_connections.router)
fastapi_app.include_router(tasks.router)

app = socketio.ASGIApp(socket.sio, fastapi_app)


# Pydantic Schemas
class HostBase(BaseModel):
    """Base schema for host data."""

    name: str


class HostCreate(HostBase):
    """Schema for creating a new host registration."""

    host_token: str


class ToolSetting(BaseModel):
    """What the user chose for one AI tool on one host.

    Attributes:
        tool: Profile name the daemon reports for the tool.
        enabled: Whether the tool is offered on the host.
        label: Name shown on its spawn button, or None for the
            name the tool's profile gives it.
        command_new: Command line that starts a new session,
            or None for the profile's.
        command_resume: Command line that resumes the last
            session, or None for the profile's.
    """

    model_config = ConfigDict(from_attributes=True)

    tool: str
    enabled: bool = True
    label: Optional[str] = None
    command_new: Optional[str] = None
    command_resume: Optional[str] = None


class ToolSettingUpdate(BaseModel):
    """Changes to a tool's settings on a host. Fields left
    out keep their value.

    Attributes:
        enabled: Offer the tool on the host, or hide it and
            refuse to start it.
        label: New name for the spawn button. Blank restores
            the default.
        command_new: Command line for new sessions, quoted as
            in a shell. Blank restores the profile's.
        command_resume: Command line for resumed sessions.
            Blank restores the profile's.
    """

    enabled: Optional[bool] = None
    label: Optional[str] = Field(None, max_length=40)
    command_new: Optional[str] = Field(None, max_length=2000)
    command_resume: Optional[str] = Field(None, max_length=2000)


class HostSchema(HostBase):
    """Schema for host responses including status and metadata."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: str
    projects: Optional[dict] = None
    created_at: datetime
    # Only tools the user changed; the rest are enabled and
    # carry their default name.
    tool_settings: List[ToolSetting] = []


class AgentBase(BaseModel):
    """Base schema for agent session data."""

    agent_id: str
    tool_name: Optional[str] = None
    pid: Optional[int] = None
    telemetry: dict = {}


class AgentCreate(AgentBase):
    """Schema for creating a new agent session."""

    host_id: int


class AgentSchema(AgentBase):
    """Schema for agent responses with status and timestamps."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    host_id: int
    status: str
    tool_name: Optional[str] = None
    started_at: datetime
    ended_at: Optional[datetime] = None


class AgentDetailSchema(AgentSchema):
    """Extended agent schema with host name and tools."""

    host_name: str
    available_tools: Optional[list] = None


class SpawnRequest(BaseModel):
    """Schema for requesting an agent spawn on a host."""

    host_id: int
    tool_name: str
    project_dir: Optional[str] = None
    task_description: Optional[str] = None
    # User-chosen name shown on the session's tab.
    session_name: Optional[str] = Field(None, max_length=60)
    session_mode: Optional[str] = "resume"
    use_worktree: Optional[bool] = False
    cols: Optional[int] = 120
    rows: Optional[int] = 40
    # Model name for tools with a model picker. Validated by
    # the host daemon against the names it offered.
    model: Optional[str] = None


class CreateProjectRequest(BaseModel):
    """Schema for creating a project folder on a host."""

    name: str
    git_init: bool = False


# Authentication Endpoints
@fastapi_app.get("/login")
async def login(request: Request):
    """Redirects the user to the OIDC provider for login."""
    redirect_uri = request.url_for("auth_route")
    return await auth.oauth.oidc.authorize_redirect(request, redirect_uri)


@fastapi_app.get("/auth", name="auth_route")
async def auth_route(request: Request):
    """Handles the OIDC callback, validating the token and setting the user session."""
    try:
        token = await auth.oauth.oidc.authorize_access_token(request)
        user = token.get("userinfo")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Authentication failed: {str(e)}")
    if user and not auth.is_allowed(user):
        raise HTTPException(
            status_code=403, detail="This account is not allowed to sign in."
        )
    if user:
        request.session["user"] = dict(user)
    return RedirectResponse(url="/")


@fastapi_app.get("/logout")
async def logout(request: Request):
    """Clears the current user's session."""
    request.session.pop("user", None)
    return RedirectResponse(url="/")


@fastapi_app.get("/me")
async def me(user: dict = Depends(auth.get_current_user)):
    """Returns the currently logged-in user's profile information."""
    return user


class OpenTabs(BaseModel):
    """The session tabs a user has open, in display order.

    Attributes:
        tabs: Agent IDs, first tab first. ``None`` in a response
            means the user has never saved any, which is not the
            same as having closed them all.
    """

    tabs: Optional[List[str]] = Field(None, max_length=200)


# Kept as a name of its own: many endpoints below use it.
_user_key = auth.user_email


@fastapi_app.get("/me/tabs", response_model=OpenTabs)
def read_open_tabs(
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Returns the logged-in user's open session tabs, in order.

    Args:
        db: Database session.
        user: The logged-in user. Requires UI login.

    Returns:
        The saved agent IDs, or ``tabs: null`` when the user has
        never saved any.
    """
    row = db.get(models.UserTabs, _user_key(user))
    return OpenTabs(tabs=None if row is None else row.tabs_json)


@fastapi_app.put("/me/tabs", response_model=OpenTabs)
def write_open_tabs(
    body: OpenTabs,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Replaces the logged-in user's open session tabs.

    The whole list is replaced: the last device to write wins.

    Args:
        body: The agent IDs of the open tabs, first tab first.
        db: Database session.
        user: The logged-in user. Requires UI login.

    Returns:
        The list as saved, without duplicates.

    Raises:
        HTTPException: 422 if an ID is longer than 200 characters.
    """
    tabs = list(dict.fromkeys(body.tabs or []))
    if any(len(tab) > 200 for tab in tabs):
        raise HTTPException(status_code=422, detail="Tab ID too long")
    email = _user_key(user)
    row = db.get(models.UserTabs, email)
    if row is None:
        row = models.UserTabs(email=email)
        db.add(row)
    row.tabs_json = tabs
    db.commit()
    return OpenTabs(tabs=tabs)


LANGUAGES = ("pt-BR", "en")


class Preferences(BaseModel):
    """Preferences that follow the user across devices.

    Attributes:
        language: Interface language, ``pt-BR`` or ``en``; None
            until the user picks one.
    """

    language: Optional[str] = None


@fastapi_app.get("/me/preferences", response_model=Preferences)
def read_preferences(
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Returns the logged-in user's preferences.

    Args:
        db: Database session.
        user: The logged-in user. Requires UI login.
    """
    row = db.get(models.UserPrefs, _user_key(user))
    return Preferences(language=row.language if row else None)


@fastapi_app.put("/me/preferences", response_model=Preferences)
def write_preferences(
    body: Preferences,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Saves the logged-in user's preferences.

    Raises:
        HTTPException: 422 for a language the UI does not have.
    """
    if body.language is not None and body.language not in LANGUAGES:
        raise HTTPException(status_code=422, detail="Unknown language")
    email = _user_key(user)
    row = db.get(models.UserPrefs, email)
    if row is None:
        row = models.UserPrefs(email=email)
        db.add(row)
    row.language = body.language
    db.commit()
    return Preferences(language=row.language)


# Protected API Endpoints
@fastapi_app.get("/hosts", response_model=List[HostSchema])
def read_hosts(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    List all registered hosts. Requires UI login.
    """
    hosts = db.query(models.Host).offset(skip).limit(limit).all()
    return hosts


@fastapi_app.post("/hosts", response_model=HostSchema)
def create_host(
    host: HostCreate,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Register a new host. Requires UI login.
    """
    db_host = models.Host(name=host.name, host_token=host.host_token)
    db.add(db_host)
    try:
        db.commit()
        db.refresh(db_host)
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Host registration failed." " Name or token might already exist.",
        )
    return db_host


@fastapi_app.post("/hosts/{host_id}/projects")
async def create_project(
    host_id: int,
    request: CreateProjectRequest,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Asks a host daemon to create an empty project folder.

    The daemon owns the filesystem, so it validates the name
    and creates the folder; this endpoint only relays the
    request and turns the daemon's answer into an HTTP
    response.

    Args:
        host_id: ID of the host to create the folder on.
        request: Folder name and whether to run ``git init``.

    Returns:
        Dict with the absolute ``path`` of the new folder.

    Raises:
        HTTPException: 400 if the host is offline or the daemon
            rejects the request, 504 if the daemon does not
            answer in time.
    """
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    sid = socket.host_sids.get(host_id)
    if not host or host.status != "online" or not sid:
        raise HTTPException(
            status_code=400,
            detail="Cannot create folder: Host is offline or does not exist.",
        )
    try:
        result = await socket.sio.call(
            "create_project",
            {"name": request.name, "git_init": request.git_init},
            to=sid,
            namespace="/terminal",
            timeout=20,
        )
    except socketio.exceptions.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="The host did not answer the folder request.",
        ) from exc
    if not isinstance(result, dict) or not result.get("ok"):
        detail = (result or {}).get("error") if isinstance(result, dict) else None
        raise HTTPException(
            status_code=400, detail=detail or "Could not create the folder."
        )
    return {"path": result["path"]}


@fastapi_app.get("/hosts/{host_id}/tools/{tool_name}/models")
async def list_tool_models(
    host_id: int,
    tool_name: str,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Asks a host daemon for a tool's current model list.

    Used by the spawn dialog when it opens, so the model
    choices reflect what the tool's model endpoint offers at
    that moment.

    Args:
        host_id: ID of the host running the tool.
        tool_name: Profile name of the tool.

    Returns:
        Dict with ``models`` (list of names), ``default_model``
        and ``error`` (why the live list is incomplete, or None).

    Raises:
        HTTPException: 400 if the host is offline or the tool
            has no model list, 504 if the daemon does not
            answer in time.
    """
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    sid = socket.host_sids.get(host_id)
    if not host or host.status != "online" or not sid:
        raise HTTPException(
            status_code=400,
            detail="Cannot list models: Host is offline or does not exist.",
        )
    try:
        result = await socket.sio.call(
            "list_models",
            {"tool": tool_name},
            to=sid,
            namespace="/terminal",
            timeout=15,
        )
    except socketio.exceptions.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="The host did not answer the model list request.",
        ) from exc
    if not isinstance(result, dict) or not result.get("ok"):
        detail = result.get("error") if isinstance(result, dict) else None
        raise HTTPException(status_code=400, detail=detail or "Could not list models.")
    return {
        "models": result.get("models", []),
        "default_model": result.get("default_model"),
        "error": result.get("error"),
    }


@fastapi_app.put(
    "/hosts/{host_id}/tools/{tool_name}/settings",
    response_model=List[ToolSetting],
)
async def update_tool_setting(
    host_id: int,
    tool_name: str,
    body: ToolSettingUpdate,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Enables, disables, renames or sets the command lines of an
    AI tool on a host.

    A disabled tool is hidden from the host's spawn buttons and
    ``POST /agents/spawn`` refuses it. Sessions already running
    are not touched. Every connected UI is told about the
    change. Requires UI login.

    Args:
        host_id: ID of the host the setting applies to.
        tool_name: Profile name of the tool, as the daemon
            reports it. It need not be detected right now.
        body: The fields to change.
        db: Database session.
        user: The logged-in user.

    Returns:
        All the tool settings saved for the host.

    Raises:
        HTTPException: 404 if the host does not exist, 422 if
            the tool name is not a plausible profile name.
    """
    host = db.query(models.Host).filter(models.Host.id == host_id).first()
    if not host:
        raise HTTPException(status_code=404, detail="Host not found.")
    if not re.fullmatch(r"[\w.@-]{1,100}", tool_name):
        raise HTTPException(status_code=422, detail="Invalid tool name.")
    try:
        row = next((s for s in host.tool_settings if s.tool == tool_name), None)
        if row is None:
            row = models.HostToolSetting(tool=tool_name, enabled=True)
            host.tool_settings.append(row)
        if body.enabled is not None:
            row.enabled = body.enabled
        if body.label is not None:
            row.label = body.label.strip() or None
        if body.command_new is not None:
            row.command_new = body.command_new.strip() or None
        if body.command_resume is not None:
            row.command_resume = body.command_resume.strip() or None
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=500, detail=f"Failed to save tool settings: {e}"
        ) from e
    settings = [ToolSetting.model_validate(s).model_dump() for s in host.tool_settings]
    await socket.sio.emit(
        "host_settings_update",
        {"host_id": host_id, "tool_settings": settings},
        namespace="/terminal",
    )
    return settings


@fastapi_app.post("/hosts/{host_id}/restart")
async def restart_host_daemon(
    host_id: int,
    user: dict = Depends(auth.get_current_user),
):
    """Asks a host daemon to restart itself.

    The daemon shuts down and its supervisor (the launchd
    KeepAlive job, or the container restart policy) starts a
    fresh one. Every session on the host ends: the daemon
    closes their tmux sessions as it stops.

    Args:
        host_id: ID of the host whose daemon to restart.

    Returns:
        Dict with a ``detail`` message.

    Raises:
        HTTPException: 400 if no daemon of that host is
            connected.
    """
    sid = socket.host_sids.get(host_id)
    if not sid:
        raise HTTPException(
            status_code=400,
            detail="Cannot restart: Host is offline or does not exist.",
        )
    # Fire and forget: the daemon disconnects right away.
    await socket.sio.emit("restart_daemon", {}, to=sid, namespace="/terminal")
    return {"detail": "Restart requested."}


@fastapi_app.delete("/hosts/{host_id}")
def delete_host(
    host_id: int,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Deletes a registered host and cascades to all its
    agents and logs. Requires UI login.
    """
    db_host = db.query(models.Host).filter(models.Host.id == host_id).first()
    if not db_host:
        raise HTTPException(status_code=404, detail="Host not found.")

    try:
        db.delete(db_host)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete host: {e}")
    return {"detail": "Host deleted successfully."}


@fastapi_app.get("/agents", response_model=List[AgentSchema])
def read_agents(
    skip: int = 0,
    limit: int = 100,
    status: Optional[str] = None,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    List agent sessions, optionally filtered by status. Requires UI login.
    """
    query = db.query(models.Agent)
    if status:
        query = query.filter(models.Agent.status == status)
    agents = query.offset(skip).limit(limit).all()
    return agents


@fastapi_app.get(
    "/agents/{agent_id}/details",
    response_model=AgentDetailSchema,
)
def get_agent_details(
    agent_id: str,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Returns a single agent's data along with the host name.
    Requires UI login.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")

    host = db.query(models.Host).filter(models.Host.id == db_agent.host_id).first()
    host_name = host.name if host else "unknown"
    available_tools = (
        host.last_projects_json.get("available_tools")
        if host and host.last_projects_json
        else None
    )

    return AgentDetailSchema(
        id=db_agent.id,
        host_id=db_agent.host_id,
        agent_id=db_agent.agent_id,
        tool_name=db_agent.tool_name,
        pid=db_agent.pid,
        status=db_agent.status,
        telemetry=db_agent.telemetry,
        started_at=db_agent.started_at,
        ended_at=db_agent.ended_at,
        host_name=host_name,
        available_tools=available_tools,
    )


@fastapi_app.get(
    "/agents/{agent_id}/companions",
    response_model=List[AgentSchema],
)
def get_agent_companions(
    agent_id: str,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Returns active companion agents on the same host sharing
    the same effective working directory. Companions are matched
    by worktree_path when present (agents sharing the same
    worktree), or by project_dir when neither agent has a
    worktree (agents sharing the original repo). This prevents
    worktree-isolated agents from being matched as companions
    to non-worktree agents on the same project.
    Requires UI login.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")

    tel = db_agent.telemetry_json or {}
    worktree_path = tel.get("worktree_path")
    project_dir = tel.get("project_dir")
    if not project_dir:
        return []

    # Match companions by effective working directory:
    # if this agent is in a worktree, find others in the
    # same worktree. If not, find others also without a
    # worktree on the same project.
    base_filter = [
        models.Agent.host_id == db_agent.host_id,
        models.Agent.status == "active",
        models.Agent.agent_id != agent_id,
    ]
    if worktree_path:
        base_filter.append(
            func.json_extract(models.Agent.telemetry_json, "$.worktree_path")
            == worktree_path
        )
    else:
        base_filter.append(
            func.json_extract(models.Agent.telemetry_json, "$.project_dir")
            == project_dir
        )
        # Exclude agents that have a worktree_path set
        base_filter.append(
            func.json_extract(models.Agent.telemetry_json, "$.worktree_path").is_(None)
        )

    companions = db.query(models.Agent).filter(*base_filter).all()
    return companions


@fastapi_app.post("/agents/spawn", response_model=AgentSchema)
async def spawn_agent(
    request: SpawnRequest,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Commands a remote host to spawn a new AI agent session.
    """
    # 0. Check if host is online
    host = db.query(models.Host).filter(models.Host.id == request.host_id).first()
    if not host or host.status != "online":
        raise HTTPException(
            status_code=400,
            detail="Cannot spawn agent: Host is offline or does not exist.",
        )
    # Hiding the button is not enough: a tool the user turned
    # off for this host must not start from any client.
    setting = next((s for s in host.tool_settings if s.tool == request.tool_name), None)
    if setting and not setting.enabled:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Cannot spawn agent: {request.tool_name} is disabled on "
                f"{host.name}. Enable it in the host's Settings."
            ),
        )

    import uuid

    agent_uuid = str(uuid.uuid4())

    # 1. Create database record
    db_agent = models.Agent(
        host_id=request.host_id,
        agent_id=agent_uuid,
        tool_name=request.tool_name,
        status="active",
        telemetry_json={
            "project_dir": request.project_dir,
            "task_description": request.task_description,
            "session_name": (request.session_name or "").strip() or None,
            "use_worktree": request.use_worktree or False,
        },
    )
    db.add(db_agent)
    db.commit()
    db.refresh(db_agent)

    # 2. Relay command to the specific host daemon via Socket.IO
    # The host daemon should be in a room named "host_{id}"
    await socket.sio.emit(
        "spawn_agent",
        {
            "agent_id": agent_uuid,
            "tool": request.tool_name,
            "project_dir": request.project_dir,
            "task_description": request.task_description,
            "session_mode": request.session_mode or "resume",
            "use_worktree": request.use_worktree or False,
            "cols": request.cols or 120,
            "rows": request.rows or 40,
            "model": request.model,
            # Command lines set in the host's Settings.
            "commands": {
                "new": setting.command_new if setting else None,
                "resume": setting.command_resume if setting else None,
            },
        },
        room=f"host_{request.host_id}",
        namespace="/terminal",
    )

    return db_agent


@fastapi_app.post("/agents/{agent_id}/stop")
async def stop_agent(
    agent_id: str,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """
    Commands a remote host to stop an active AI agent session.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")

    if db_agent.status in ("closed", "stopped"):
        return {"status": "already stopped"}

    # 1. Update database with "stopped" status to distinguish
    # user-initiated stops from daemon-side disconnects
    # ("closed"). This prevents the terminal auto-reconnect
    # from respawning the agent.
    db_agent.status = "stopped"
    db_agent.ended_at = datetime.now(timezone.utc)
    db.commit()

    # 2. Relay command to the specific host daemon to kill the actual process
    await socket.sio.emit(
        "stop_agent",
        {"agent_id": agent_id},
        room=f"host_{db_agent.host_id}",
        namespace="/terminal",
    )

    # 3. Notify all UI clients via Socket.IO for real-time removal.
    # Use "stopped" so terminal windows know this was user-initiated
    # and should not auto-reconnect.
    await socket.sio.emit(
        "agent_status_update",
        {"agent_id": agent_id, "status": "stopped"},
        namespace="/terminal",
    )

    return {"status": "stop command issued"}


class TaskDescriptionUpdate(BaseModel):
    """Request body for updating an agent's task description."""

    task_description: str


@fastapi_app.patch(
    "/agents/{agent_id}/task-description",
)
async def update_task_description(
    agent_id: str,
    body: TaskDescriptionUpdate,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Updates the user-provided task description for an
    active agent. Persists to DB and syncs to the host
    daemon so its telemetry dict stays current.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")

    # Update telemetry_json in the database
    tel = dict(db_agent.telemetry_json or {})
    tel["task_description"] = body.task_description
    db_agent.telemetry_json = tel
    db.commit()

    # Relay to daemon so its local telemetry stays in sync
    await socket.sio.emit(
        "update_task_description",
        {
            "agent_id": agent_id,
            "task_description": body.task_description,
        },
        room=f"host_{db_agent.host_id}",
        namespace="/terminal",
    )

    # Broadcast updated telemetry to all UI clients
    await socket.sio.emit(
        "agent_telemetry_update",
        {"agent_id": agent_id, "telemetry": tel},
        namespace="/terminal",
    )

    return {"status": "updated"}


# Largest file the UI may send to a session. Keep in sync with
# MAX_UPLOAD_BYTES in agent/host_daemon.py and
# client_max_body_size in frontend/nginx.conf.
MAX_UPLOAD_BYTES = 90 * 1024 * 1024


@fastapi_app.post("/agents/{agent_id}/files")
async def upload_agent_file(
    agent_id: str,
    file: UploadFile,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Sends a file to the host a session runs on.

    The daemon owns the filesystem, so it picks the location
    and sanitises the name; this endpoint enforces the size
    limit, relays the bytes and turns the daemon's answer into
    an HTTP response. The UI then types the returned path into
    the session's terminal.

    Args:
        agent_id: ID of the session the file is for.
        file: The uploaded file.

    Returns:
        Dict with the absolute ``path`` of the file on the host.

    Raises:
        HTTPException: 404 if the session does not exist, 400 if
            its host is offline or the daemon rejects the file,
            413 if the file is too large, 504 if the daemon does
            not answer in time.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")
    sid = socket.host_sids.get(db_agent.host_id)
    if not sid:
        raise HTTPException(
            status_code=400, detail="Cannot send the file: Host is offline."
        )
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )
    try:
        result = await socket.sio.call(
            "upload_file",
            {"agent_id": agent_id, "name": file.filename, "data": data},
            to=sid,
            namespace="/terminal",
            timeout=120,
        )
    except socketio.exceptions.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="The host did not answer the file upload.",
        ) from exc
    if not isinstance(result, dict) or not result.get("ok"):
        detail = (result or {}).get("error") if isinstance(result, dict) else None
        raise HTTPException(
            status_code=400, detail=detail or "Could not save the file."
        )
    return {"path": result["path"]}


class SessionNameUpdate(BaseModel):
    """Request body for renaming an agent session."""

    # Empty or missing clears the name: the tab falls back to
    # tool and project.
    session_name: Optional[str] = Field(None, max_length=60)


@fastapi_app.patch("/agents/{agent_id}/session-name")
async def update_session_name(
    agent_id: str,
    body: SessionNameUpdate,
    db: Session = Depends(database.get_db),
    user: dict = Depends(auth.get_current_user),
):
    """Renames a session, the name shown on its tab.

    The name lives only in the backend's copy of the
    telemetry: daemon updates are merged into it and never
    carry the key, so no relay to the host is needed.

    Args:
        agent_id: The session to rename.
        body: The new name; blank clears it.
        db: Database session.
        user: The authenticated UI user.

    Returns:
        A status dict.

    Raises:
        HTTPException: 404 when the agent does not exist.
    """
    db_agent = db.query(models.Agent).filter(models.Agent.agent_id == agent_id).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found.")

    tel = dict(db_agent.telemetry_json or {})
    tel["session_name"] = (body.session_name or "").strip() or None
    db_agent.telemetry_json = tel
    db.commit()

    # Every open dashboard refreshes the tab label from this.
    await socket.sio.emit(
        "agent_telemetry_update",
        {"agent_id": agent_id, "telemetry": tel},
        namespace="/terminal",
    )

    return {"status": "updated"}


@fastapi_app.get("/health")
def health_check():
    """
    Simple public health check endpoint.
    """
    return {"status": "healthy"}


@fastapi_app.get("/version")
def get_version():
    """Returns current version and latest available release.

    The current version is embedded at build time. The latest
    release is fetched from GitHub periodically in the
    background. For tagged builds, update_available is true
    when a newer semver release exists. For development builds,
    update_available is always false but the latest release
    info is still returned for informational display.
    """
    current = _CURRENT_VERSION
    latest = _latest_release["tag"]
    latest_url = _latest_release["url"]
    is_dev = _is_dev_build(current)

    update_available = False
    if not is_dev and latest:
        current_ver = _parse_semver(current)
        latest_ver = _parse_semver(latest)
        if current_ver and latest_ver:
            update_available = latest_ver > current_ver

    return {
        "current": current,
        "is_dev": is_dev,
        "latest": latest,
        "latest_url": latest_url,
        "update_available": update_available,
    }


async def _check_latest_release():
    """Background task that periodically fetches the latest
    GitHub release and caches the result. Runs every 30 minutes.
    Errors are logged but do not affect application operation.
    """
    while True:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}" "/releases/latest",
                    headers={"Accept": "application/vnd.github.v3+json"},
                    timeout=10,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    _latest_release["tag"] = data.get("tag_name")
                    _latest_release["url"] = data.get("html_url")
                    print(
                        f"Version check: current={_CURRENT_VERSION}"
                        f" latest={_latest_release['tag']}"
                    )
                else:
                    print(f"Version check failed: " f"HTTP {resp.status_code}")
        except Exception as e:
            print(f"Version check error: {e}")
        await asyncio.sleep(_VERSION_CHECK_INTERVAL)


_background_tasks: set = set()


@fastapi_app.on_event("startup")
async def start_version_checker():
    """Launches the background GitHub release checker and the
    poller that keeps the Tasks tab's tracker tasks fresh."""
    asyncio.create_task(_check_latest_release())
    # Keep a reference: the event loop holds tasks only weakly.
    _background_tasks.add(
        asyncio.create_task(tasks.poll_forever(socket.notify_tasks_changed))
    )
