"""Encryption of third-party credentials kept in the database.

Tokens for Jira, Shortcut and Huly are stored encrypted with
Fernet (AES-128-CBC plus HMAC-SHA256). The key is derived from
the dashboard's ``SECRET_KEY``, so a copy of the database alone
does not reveal them. Changing ``SECRET_KEY`` makes stored tokens
unreadable: each connection then asks for its token again.
"""

import base64
import hashlib
from typing import Dict, Optional

from cryptography.fernet import Fernet, InvalidToken

# Mixed into the key so it differs from the session-signing key
# even though both come from SECRET_KEY.
_CONTEXT = b"agent-dashboard/task-connections/v1:"
# The Fernet instance, once configured.
_state: Dict[str, Optional[Fernet]] = {"fernet": None}


class SecretUnreadable(Exception):
    """A stored secret cannot be decrypted with the current key."""


def configure(secret_key: str) -> None:
    """Sets the key secrets are encrypted with.

    Args:
        secret_key: The dashboard's SECRET_KEY.
    """
    digest = hashlib.sha256(_CONTEXT + secret_key.encode("utf-8")).digest()
    _state["fernet"] = Fernet(base64.urlsafe_b64encode(digest))


def _box() -> Fernet:
    """Returns the configured Fernet instance.

    Raises:
        RuntimeError: When ``configure`` was never called.
    """
    fernet = _state["fernet"]
    if fernet is None:
        raise RuntimeError("secretbox.configure() was not called")
    return fernet


def encrypt(plain: str) -> str:
    """Encrypts a secret for storage.

    Args:
        plain: The secret, e.g. an API token.

    Returns:
        The encrypted secret, as URL-safe text.
    """
    return _box().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    """Decrypts a stored secret.

    Args:
        token: What ``encrypt`` returned.

    Returns:
        The secret.

    Raises:
        SecretUnreadable: When the key changed or the value was
            tampered with.
    """
    try:
        return _box().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as e:
        raise SecretUnreadable() from e
