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
