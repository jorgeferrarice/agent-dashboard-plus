"""Authentication module for the Agent Dashboard.

Provides host daemon authentication via API key headers and
OIDC-based authentication for the dashboard UI.
"""

import os

from authlib.integrations.starlette_client import OAuth
from fastapi import Security, HTTPException, status, Depends, Request
from fastapi.security import APIKeyHeader
from sqlalchemy.orm import Session
from starlette.config import Config

from . import models, database

# API Key Authentication for Host Daemons
API_KEY_NAME = "X-Host-Token"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)


def get_current_host(
    api_key_header: str = Security(  # pylint: disable=redefined-outer-name
        api_key_header
    ),
    db: Session = Depends(database.get_db),
) -> models.Host:
    """
    Validates the host token passed in the header and
    returns the corresponding Host model.
    """
    if not api_key_header:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing host token",
        )

    host = (
        db.query(models.Host).filter(models.Host.host_token == api_key_header).first()
    )
    if not host:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid host token",
        )

    return host


# OIDC Authentication for Dashboard UI
# Using dummy defaults for local development. In production,
# these should be set via environment variables.
config = Config(
    environ={
        "OIDC_CLIENT_ID": os.getenv("OIDC_CLIENT_ID", "dummy-client-id"),
        "OIDC_CLIENT_SECRET": os.getenv("OIDC_CLIENT_SECRET", "dummy-client-secret"),
        "OIDC_DISCOVERY_URL": os.getenv(
            "OIDC_DISCOVERY_URL",
            "https://dummy-oidc-provider/.well-known/openid-configuration",
        ),
    }
)
oauth = OAuth(config)

oauth.register(
    name="oidc",
    server_metadata_url=config.get("OIDC_DISCOVERY_URL"),
    client_id=config.get("OIDC_CLIENT_ID"),
    client_secret=config.get("OIDC_CLIENT_SECRET"),
    client_kwargs={"scope": "openid email profile"},
)


def is_allowed(user) -> bool:
    """Whether an OIDC user may use the dashboard.

    ALLOWED_EMAILS is a comma-separated list of e-mail addresses.
    When it is set, only those accounts get in: every session is
    a shell on a host, and a generic provider such as Google
    signs in anyone who has an account. Unset, any user the
    provider signs in is allowed, as before.

    Args:
        user: The session's user dict (OIDC userinfo), or None.

    Returns:
        True if the user is signed in and allowed.
    """
    if not user:
        return False
    allowed = {
        e.strip().lower()
        for e in os.getenv("ALLOWED_EMAILS", "").split(",")
        if e.strip()
    }
    if not allowed:
        return True
    return str(user.get("email", "")).lower() in allowed


def get_current_user(request: Request):
    """
    Dependency to check if a user is logged in via OIDC session.
    """
    if os.getenv("BYPASS_AUTH", "false").lower() == "true":
        return {"email": "dev@example.com", "name": "Developer"}

    user = request.session.get("user")
    if not is_allowed(user):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return user


def user_email(user: dict) -> str:
    """Returns the key per-user data is stored under.

    There is no users table: per-user rows are keyed by the
    email of the OIDC login.

    Args:
        user: The logged-in user, as ``get_current_user`` gives it.

    Returns:
        The user's email address, lowercased.

    Raises:
        HTTPException: 400 if the login carries no email, 403 if
            the identity provider did not verify it.
    """
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Login has no email address")
    # The email is who owns the data: an address the identity
    # provider says it did not verify must not claim it.
    if user.get("email_verified") is False:
        raise HTTPException(status_code=403, detail="Email address is not verified")
    return email


def current_email(user: dict = Depends(get_current_user)) -> str:
    """FastAPI dependency: the logged-in user's email.

    Args:
        user: The logged-in user. Requires UI login.

    Returns:
        The user's email address.
    """
    return user_email(user)
