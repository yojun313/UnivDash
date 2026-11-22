"""Passkey (WebAuthn) sign-in.

A passkey lives on the user's device (phone, laptop, security key) and proves itself with the device's own
unlock (Face ID, fingerprint, PIN). Signing in with one therefore needs neither the password nor a
two-factor code. A passkey on a phone can also sign in a desktop browser: the browser shows a QR code,
the phone scans it. That part is done by the browser and the OS; nothing here is specific to it.

The server keeps only public keys (data folder, file mode 600). Challenges live in the server-side
pre-sign-in session and are single-use. The relying-party ID is the host the browser is on, so a passkey
made on dash.example.com cannot be used anywhere else.
"""

import base64
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.i18n import _
from app.paths import data_dir

logger = logging.getLogger(__name__)

MAX_PASSKEYS = 20
CHALLENGE_SECONDS = 5 * 60
NAME_MAX = 40
_lock = threading.Lock()


class PasskeyError(ValueError):
    """A message that can be shown to the user as it is."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _file() -> Path:
    return data_dir() / "passkeys.json"


def _load() -> list[dict]:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return (
        [item for item in data if isinstance(item, dict)]
        if isinstance(data, list)
        else []
    )


def _save(items: list[dict]) -> None:
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(items, handle)
    os.replace(tmp, path)


def site(origin: str | None, host: str | None) -> tuple[str, str]:
    """(relying-party ID, expected origin) for this request.

    The Origin header is what the browser signs into the passkey response, and SecurityMiddleware has
    already checked that it is this site. The RP ID is its host name without the port.
    """
    parts = urlsplit(origin or "")
    if parts.scheme not in {"https", "http"} or not parts.hostname:
        raise PasskeyError(_("이 주소에서는 패스키를 사용할 수 없습니다."))
    if (host or "").split(":")[0].strip("[]").lower() != parts.hostname.lower():
        raise PasskeyError(_("이 주소에서는 패스키를 사용할 수 없습니다."))
    rp_id = parts.hostname.lower()
    # Browsers allow passkeys only on https, or on plain http for localhost. An IP address is never a valid ID.
    if parts.scheme == "http" and rp_id != "localhost":
        raise PasskeyError(
            _("패스키는 HTTPS 주소(또는 localhost)에서만 사용할 수 있습니다.")
        )
    return rp_id, f"{parts.scheme}://{parts.netloc}"


def public_list(rp_id: str | None = None) -> list[dict]:
    """What Settings shows: name, dates and whether it belongs to this address (never the key)."""
    return [
        {
            "id": item["id"][:16],
            "name": item.get("name") or "",
            "created": item.get("created"),
            "last_used": item.get("last_used"),
            "here": rp_id is None or item.get("rp_id") == rp_id,
            "synced": bool(item.get("backed_up")),
        }
        for item in _load()
    ]


def available(rp_id: str) -> bool:
    return any(item.get("rp_id") == rp_id for item in _load())


def any_registered() -> bool:
    return bool(_load())


# Challenges are kept on the server; the (signed) session cookie only carries a random ticket for one.
# A cookie can be replayed, so the challenge itself must not live in it: taking a challenge deletes it here.
_pending: dict[str, tuple[bytes, float]] = {}


def _challenge(session: dict, key: str, challenge: bytes) -> None:
    ticket = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        for old in [
            t for t, (_c, at) in _pending.items() if now - at > CHALLENGE_SECONDS
        ]:
            del _pending[old]
        if len(_pending) > 2000:  # many sign-in pages opened and abandoned
            _pending.clear()
        _pending[ticket] = (challenge, now)
    session[key] = ticket


def _take_challenge(session: dict, key: str) -> bytes:
    """Challenges are single-use: reading one removes it."""
    ticket = session.pop(key, None)
    with _lock:
        saved = _pending.pop(ticket, None) if isinstance(ticket, str) else None
    if saved is None or time.time() - saved[1] > CHALLENGE_SECONDS:
        raise PasskeyError(_("시간이 지났습니다. 다시 시도해 주십시오."))
    return saved[0]


# ── registering a passkey (signed in, from Settings) ──────────────────────────


def register_options(session: dict, rp_id: str, username: str) -> dict:
    items = _load()
    if len(items) >= MAX_PASSKEYS:
        raise PasskeyError(
            _("패스키를 더 등록할 수 없습니다. 쓰지 않는 패스키를 삭제해 주십시오.")
        )
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name="UnivDash",
        user_name=username,
        user_id=f"univdash:{username}".encode(),
        user_display_name=username,
        authenticator_selection=AuthenticatorSelectionCriteria(
            # a discoverable passkey: sign-in needs no user name typed first
            resident_key=ResidentKeyRequirement.REQUIRED,
            # the device must check the person (biometrics or PIN): this is what replaces the second factor
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=_unb64(item["id"]))
            for item in items
            if item.get("rp_id") == rp_id
        ],
    )
    _challenge(session, "pk_register", options.challenge)
    return json.loads(options_to_json(options))


def register_verify(
    session: dict, rp_id: str, origin: str, credential: dict, name: str
) -> dict:
    challenge = _take_challenge(session, "pk_register")
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
    except (WebAuthnException, ValueError, KeyError, TypeError) as error:
        logger.warning("passkey registration rejected: %s", type(error).__name__)
        raise PasskeyError(
            _("패스키를 등록하지 못했습니다. 다시 시도해 주십시오.")
        ) from error
    record = {
        "id": _b64(verified.credential_id),
        "public_key": _b64(verified.credential_public_key),
        "sign_count": verified.sign_count,
        "rp_id": rp_id,
        "name": (name or "").strip()[:NAME_MAX] or _("패스키"),
        "created": time.time(),
        "last_used": None,
        "backed_up": bool(getattr(verified, "credential_backed_up", False)),
    }
    with _lock:
        items = _load()
        if any(item["id"] == record["id"] for item in items):
            raise PasskeyError(_("이미 등록된 패스키입니다."))
        _save([*items, record])
    return public_list(rp_id)[-1]


def rename(short_id: str, name: str) -> None:
    with _lock:
        items = _load()
        for item in items:
            if item["id"][:16] == short_id:
                item["name"] = (
                    (name or "").strip()[:NAME_MAX] or item.get("name") or _("패스키")
                )
                _save(items)
                return
    raise KeyError(_("없는 패스키입니다."))


def remove(short_id: str) -> None:
    with _lock:
        items = _load()
        kept = [item for item in items if item["id"][:16] != short_id]
        if len(kept) == len(items):
            raise KeyError(_("없는 패스키입니다."))
        _save(kept)


# ── signing in with a passkey (not signed in yet) ─────────────────────────────


def login_options(session: dict, rp_id: str) -> dict:
    options = generate_authentication_options(
        rp_id=rp_id,
        # no allow-list: the browser offers every passkey it has for this site, including one on a nearby
        # phone (QR code). The user never types a name.
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _challenge(session, "pk_login", options.challenge)
    return json.loads(options_to_json(options))


def login_verify(session: dict, rp_id: str, origin: str, credential: dict) -> str:
    """Returns the name of the passkey that signed in. Raises PasskeyError when it is not accepted."""
    challenge = _take_challenge(session, "pk_login")
    refused = PasskeyError(_("이 패스키로는 로그인할 수 없습니다."))
    credential_id = str((credential or {}).get("id") or "")
    with _lock:
        items = _load()
        record = next(
            (i for i in items if i["id"] == credential_id and i.get("rp_id") == rp_id),
            None,
        )
        if record is None:
            raise refused
        try:
            verified = verify_authentication_response(
                credential=credential,
                expected_challenge=challenge,
                expected_rp_id=rp_id,
                expected_origin=origin,
                credential_public_key=_unb64(record["public_key"]),
                credential_current_sign_count=int(record.get("sign_count") or 0),
                require_user_verification=True,
            )
        except (WebAuthnException, ValueError, KeyError, TypeError) as error:
            logger.warning("passkey sign-in rejected: %s", type(error).__name__)
            raise refused from error
        record["sign_count"] = verified.new_sign_count
        record["last_used"] = time.time()
        _save(items)
        return str(record.get("name") or "")
