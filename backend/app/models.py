"""SQLAlchemy ORM models for Agent Dashboard.

Defines Host, Agent, and Log tables with their relationships.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    Integer,
    String,
    DateTime,
    ForeignKey,
    Text,
    JSON,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


class Host(Base):
    """
    Represents a developer workstation or server where the host daemon is running.
    """

    __tablename__ = "hosts"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    host_token = Column(String, unique=True, index=True, nullable=False)
    status = Column(String, default="offline")  # online, offline
    last_projects_json = Column(JSON, nullable=True)  # Cached project list
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    agents = relationship("Agent", back_populates="host", cascade="all, delete-orphan")
    tool_settings = relationship(
        "HostToolSetting", back_populates="host", cascade="all, delete-orphan"
    )

    @property
    def projects(self):
        """Returns the cached project list JSON."""
        return self.last_projects_json


class HostToolSetting(Base):
    """
    What the user chose for one AI tool on one host: whether it
    is offered there, and under which name.

    A row exists only for tools the user touched. A tool with
    no row is enabled and uses the name its profile gives it.
    Rows outlive the tool being detected, so the choice comes
    back if the tool is reinstalled.
    """

    __tablename__ = "host_tool_settings"
    __table_args__ = (UniqueConstraint("host_id", "tool"),)

    id = Column(Integer, primary_key=True, index=True)
    host_id = Column(Integer, ForeignKey("hosts.id"), nullable=False, index=True)
    # Profile name the daemon reports, e.g. "claude-work".
    tool = Column(String, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    # Name shown on the spawn button; None for the default.
    label = Column(String, nullable=True)
    # Command lines that start the tool, replacing its
    # profile's; None for the profile's own.
    command_new = Column(String, nullable=True)
    command_resume = Column(String, nullable=True)

    host = relationship("Host", back_populates="tool_settings")


class UserTabs(Base):
    """
    The session tabs one UI user has open, in display order.

    Kept on the server so the same tabs, in the same order, show
    up on every device the user signs in from. There is no users
    table: the row is keyed by the email of the OIDC login.
    """

    __tablename__ = "user_tabs"

    email = Column(String, primary_key=True)
    # Ordered list of agent_id strings.
    tabs_json = Column(JSON, nullable=False, default=list)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class Agent(Base):
    """
    Represents an active or historical AI agent session (e.g. Gemini, Claude).
    """

    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, index=True)
    host_id = Column(Integer, ForeignKey("hosts.id"), nullable=False)
    agent_id = Column(String, unique=True, index=True, nullable=False)
    tool_name = Column(String, nullable=True)  # gemini, claude, etc.
    pid = Column(Integer, nullable=True)  # Process ID on the host
    status = Column(String, default="active")  # active, closed
    telemetry_json = Column(JSON, default=dict)  # Rich telemetry context
    started_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    ended_at = Column(DateTime, nullable=True)

    host = relationship("Host", back_populates="agents")
    logs = relationship("Log", back_populates="agent", cascade="all, delete-orphan")

    @property
    def telemetry(self):
        """Returns the agent's telemetry dict, defaulting to empty."""
        return self.telemetry_json or {}


class Log(Base):
    """
    Stores terminal logs or metadata for a given agent session.
    """

    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    agent = relationship("Agent", back_populates="logs")


class LocalTask(Base):
    """
    A task kept in the dashboard itself, as opposed to one read
    from Jira, Shortcut or Huly.

    Each task belongs to one UI user, keyed by the email of the
    OIDC login like ``UserTabs``; nobody else sees it.
    """

    __tablename__ = "local_tasks"

    id = Column(Integer, primary_key=True, index=True)
    owner_email = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    # Board column: todo, in_progress, review or done.
    column = Column(String, nullable=False, default="todo")
    # low, medium, high or urgent; None when not set.
    priority = Column(String, nullable=True)
    # ISO date (YYYY-MM-DD); None when there is no deadline.
    due_date = Column(String, nullable=True)
    tags_json = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class TaskConnection(Base):
    """
    One account of an external tracker (Jira, Shortcut, Huly)
    that a UI user connected to the Tasks tab.

    A user can have several, each with a name of their own
    (e.g. "Jira work" and "Jira side project"). The token is
    stored encrypted (see ``secretbox``) and never sent back to
    the browser.
    """

    __tablename__ = "task_connections"

    id = Column(Integer, primary_key=True, index=True)
    owner_email = Column(String, nullable=False, index=True)
    # jira, shortcut or huly.
    provider = Column(String, nullable=False)
    name = Column(String, nullable=False)
    # Settings that are not secret, e.g. the site URL and email.
    config_json = Column(JSON, nullable=False, default=dict)
    # The token, encrypted with secretbox.
    secret_enc = Column(Text, nullable=False)
    # Which tasks to show (see the Tasks docs, "Filters").
    filters_json = Column(JSON, nullable=False, default=dict)
    # Board column chosen by the user per status name.
    mapping_json = Column(JSON, nullable=False, default=dict)
    last_sync_at = Column(DateTime, nullable=True)
    # Why the last sync failed; None when it worked.
    last_error = Column(String, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    cache = relationship(
        "TaskCache",
        back_populates="connection",
        cascade="all, delete-orphan",
        uselist=False,
    )


class TaskCache(Base):
    """
    The tasks last read from a connection, so the board shows
    them at once instead of waiting for every tracker.
    """

    __tablename__ = "task_cache"

    connection_id = Column(Integer, ForeignKey("task_connections.id"), primary_key=True)
    # List of TaskItem dicts, as the board shows them.
    items_json = Column(JSON, nullable=False, default=list)
    synced_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    connection = relationship("TaskConnection", back_populates="cache")


class UserPrefs(Base):
    """
    Preferences of one UI user that follow them across devices,
    keyed by the email of the OIDC login like ``UserTabs``.
    """

    __tablename__ = "user_prefs"

    email = Column(String, primary_key=True)
    # Interface language: "pt-BR" or "en".
    language = Column(String, nullable=True)
