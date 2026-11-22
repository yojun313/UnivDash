"""Web push notifications: when an agent finishes its work or needs an answer, subscribed devices (Mac · Windows · Android · iOS home screen app) are notified.

A notification only arrives while the browser tab is in the background or closed (including a locked phone) if the
server sends it itself, so this uses standard Web Push (RFC 8030) + VAPID (RFC 8292) + aes128gcm encryption (RFC 8291).

- The VAPID private key and the subscription list are kept in the data folder with mode 0600.
- Only known push service hosts (HTTPS) are accepted as subscription addresses → the server never sends requests to
  arbitrary addresses (SSRF protection).
- The notification content is encrypted with a per-device key, so even the push service cannot read it.
- Nothing is sent to a device that is looking at the dashboard right now (focused) — the in-page notice is enough.
"""

import asyncio
import base64
import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import suppress
from pathlib import Path
from urllib.parse import quote, urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.i18n import _
from app.paths import data_dir

logger = logging.getLogger(__name__)

MAX_SUBSCRIPTIONS = 30
WATCH_INTERVAL = 2.0
DEDUPE_SECONDS = 10
# A 'work finished' notice waits this long, is checked again and then sent: the session log is written a few seconds
# late, so it is not known at once whether only a conversation compaction just ended, and right after an automatic
# compaction the agent pauses briefly and then carries on working.
DONE_SETTLE = 5.0
# when the device is off, the push service keeps the message this long before delivering it
PUSH_TTL = 6 * 3600
SEND_TIMEOUT = 10
DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# Push services of the major browsers: Chrome · Edge (new) · Android = FCM, Firefox = Mozilla, Safari · iOS = Apple, Edge (old) = WNS
PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
)

_lock = threading.Lock()
# WebSocket channel → (device ID, keys of the windows visible on that device's screen now, whether the dashboard is in use on that device now)
_focus: dict[int, tuple[str, frozenset[str], bool]] = {}
_focus_lock = threading.Lock()


# ── Storage ───────────────────────────────────────────────────────────
def _dir() -> Path:
    path = data_dir() / "push"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _write_private(path: Path, data: bytes) -> None:
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        with suppress(OSError):
            os.unlink(temp)
        raise


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


_vapid: ec.EllipticCurvePrivateKey | None = None


def _vapid_key() -> ec.EllipticCurvePrivateKey:
    global _vapid
    with _lock:
        if _vapid is None:
            path = _dir() / "vapid_private.pem"
            try:
                key = serialization.load_pem_private_key(
                    path.read_bytes(), password=None
                )
            except (OSError, ValueError):
                key = None
            if not isinstance(key, ec.EllipticCurvePrivateKey):
                key = ec.generate_private_key(ec.SECP256R1())
                _write_private(
                    path,
                    key.private_bytes(
                        serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption(),
                    ),
                )
                logger.info("created a new web push VAPID key.")
            _vapid = key
        return _vapid


def public_key() -> str:
    point = (
        _vapid_key()
        .public_key()
        .public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    return _b64(point)


def _subs_path() -> Path:
    return _dir() / "subscriptions.json"


def _load() -> list[dict]:
    try:
        data = json.loads(_subs_path().read_text(encoding="utf-8"))
        return (
            [s for s in data if isinstance(s, dict)] if isinstance(data, list) else []
        )
    except (OSError, ValueError):
        return []


def _save(subs: list[dict]) -> None:
    _write_private(_subs_path(), json.dumps(subs, ensure_ascii=False).encode())


def has_subscriptions() -> bool:
    with _lock:
        return bool(_load())


def valid_endpoint(endpoint: str) -> bool:
    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return (
        parts.scheme == "https"
        and len(endpoint) <= 1024
        and parts.port in (None, 443)
        and not parts.username
        and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)
    )


def subscribe(
    device: str, endpoint: str, p256dh: str, auth: str, origin: str, label: str
) -> None:
    if not DEVICE_RE.match(device):
        raise ValueError(_("잘못된 기기 ID 입니다."))
    if not valid_endpoint(endpoint):
        raise ValueError(_("지원하지 않는 푸시 서비스입니다."))
    try:
        point, secret = _unb64(p256dh), _unb64(auth)
    except ValueError:
        raise ValueError(_("잘못된 구독 키입니다.")) from None
    if len(point) != 65 or point[0] != 4 or len(secret) != 16:
        raise ValueError(_("잘못된 구독 키입니다."))
    ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), point
    )  # checks that the point is on the curve
    entry = {
        "device": device,
        "endpoint": endpoint,
        "p256dh": p256dh,
        "auth": auth,
        "origin": origin,
        "label": label[:80],
        "created": int(time.time()),
    }
    with _lock:
        subs = [
            s
            for s in _load()
            if s.get("device") != device and s.get("endpoint") != endpoint
        ]
        subs.append(entry)
        _save(subs[-MAX_SUBSCRIPTIONS:])


def unsubscribe(device: str) -> None:
    with _lock:
        subs = _load()
        kept = [s for s in subs if s.get("device") != device]
        if len(kept) != len(subs):
            _save(kept)


def _drop_endpoint(endpoint: str) -> None:
    with _lock:
        subs = _load()
        kept = [s for s in subs if s.get("endpoint") != endpoint]
        if len(kept) != len(subs):
            _save(kept)


def is_subscribed(device: str) -> bool:
    with _lock:
        return any(s.get("device") == device for s in _load())


# ── Focus (devices looking right now) ──────────────────────────────────
def set_focus(channel: int, device: str | None, keys=(), present: bool = False) -> None:
    """Device state of this channel (tab): the window keys visible on screen, and whether the dashboard is in use on that device now (present).

    When device is None (the connection dropped) the entry is removed.
    """
    with _focus_lock:
        if device and DEVICE_RE.match(device):
            _focus[channel] = (device, frozenset(keys), bool(present))
        else:
            _focus.pop(channel, None)


def watching_devices(key: str | None) -> set[str]:
    """Devices that have that window open on screen now (they get only the in-page notice, no push)."""
    with _focus_lock:
        return {d for d, keys, _present in _focus.values() if key and key in keys}


def present_devices() -> set[str]:
    """Devices using the dashboard right now — if there is even one, notifications go only to those devices."""
    with _focus_lock:
        return {d for d, _keys, present in _focus.values() if present}


# ── Encryption (RFC 8291) · VAPID (RFC 8292) ───────────────────────────
def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(
        ikm
    )


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    ua_public = _unb64(p256dh)
    auth_secret = _unb64(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_public = as_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    shared = as_key.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + (4096).to_bytes(4, "big") + bytes([len(as_public)]) + as_public + body


def _vapid_header(endpoint: str, subject: str) -> str:
    parts = urlsplit(endpoint)
    header = _b64(
        json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode()
    )
    claims = _b64(
        json.dumps(
            {
                "aud": f"{parts.scheme}://{parts.netloc}",
                "exp": int(time.time()) + 12 * 3600,
                "sub": subject,
            },
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    r, s = decode_dss_signature(
        _vapid_key().sign(signing_input, ec.ECDSA(hashes.SHA256()))
    )
    token = f"{header}.{claims}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={token}, k={public_key()}"


def _subject(origin: str) -> str:
    # the address the push service contacts in case of trouble. Apple requires https: or mailto:.
    try:
        parts = urlsplit(origin)
        if parts.scheme == "https" and parts.hostname:
            return f"https://{parts.hostname}"
    except ValueError:
        pass
    return "mailto:univdash@localhost"


def _send_one(sub: dict, data: dict, urgency: str = "high") -> int:
    endpoint = sub["endpoint"]
    if not valid_endpoint(endpoint):
        return 0
    body = encrypt(
        json.dumps(data, ensure_ascii=False).encode(), sub["p256dh"], sub["auth"]
    )
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": _vapid_header(endpoint, _subject(sub.get("origin", ""))),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(PUSH_TTL),
            "Urgency": urgency,
        },
    )
    # redirects are not followed (so nothing leaks to an address outside the allow list)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=SEND_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as error:
        if error.code in (404, 410):  # the subscription expired · was cancelled
            _drop_endpoint(endpoint)
        else:
            logger.warning(
                "web push failed (%s): %s", error.code, urlsplit(endpoint).hostname
            )
        return error.code
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        logger.warning("web push send error: %s", error)
        return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


async def send(
    data: dict, devices: set[str] | None = None, skip_focused: bool = True
) -> list[int]:
    """Sends a notification to the subscribed devices. With devices, only to those.

    With skip_focused: when some device is using the dashboard, send only to it (other devices stay quiet),
    and leave out devices that have that window open on screen (in-page notice only).
    """
    with _lock:
        subs = _load()
    busy = watching_devices(data.get("key")) if skip_focused else set()
    using = present_devices() if skip_focused else set()
    if using:
        devices = using if devices is None else devices & using
    targets = [
        s
        for s in subs
        if (devices is None or s.get("device") in devices)
        and s.get("device") not in busy
    ]
    if not targets:
        if using:
            logger.info(
                "web push %s · a device is in use, so not sent to other devices",
                data.get("title", ""),
            )
        return []
    if not targets:
        return []
    results = list(
        await asyncio.gather(*(asyncio.to_thread(_send_one, s, data) for s in targets))
    )
    logger.info(
        "web push %s · %s",
        data.get("title", ""),
        ", ".join(
            f"{s.get('label') or 'device'}={code}" for s, code in zip(targets, results)
        )
        + (f" · left out {len(busy)} watching" if busy else "")
        + (" · only to devices in use" if using else ""),
    )
    return results


# ── Watching agent status ──────────────────────────────────────────────
def _display_name(window, windows, aliases: dict[str, str]) -> str:
    alias = aliases.get(window.key)
    if alias:
        return alias
    alone = not any(
        o.session == window.session and o.key != window.key for o in windows
    )
    return (
        window.session
        if window.index == 0 and alone
        else f"{window.session}:{window.index} {window.name}"
    )


AGENT_LABELS = {"claude": "Claude", "codex": "Codex", "gemini": "Gemini"}


def _events(previous: dict[str, str], windows, prefs) -> list[dict]:
    events = []
    for window in windows:
        before = previous.get(window.key)
        if (
            not before
            or before == window.status
            or window.key in prefs.hidden
            or window.starting
        ):
            continue
        if window.status == "waiting":
            done = False
        elif before == "busy" and window.status == "idle":
            if getattr(window, "compacted", False):
                continue  # a finished conversation compaction alone is not finished work
            done = True
        else:
            continue
        name = _display_name(window, windows, prefs.aliases)
        title = (
            _("{name} · 작업 완료", name=name)
            if done
            else _("{name} · 응답이 필요합니다", name=name)
        )
        agent = AGENT_LABELS.get(window.agent or "", window.agent or "")
        note = getattr(prefs, "notes", {}).get(window.key) or window.title
        detail = " · ".join(x for x in (agent, note, window.path) if x)
        events.append(
            {
                "title": title,
                "body": detail[:200],
                "tag": f"univdash-{window.key}",
                "url": "/#" + quote(window.key, safe=""),
                "key": window.key,
                "status": window.status,
            }
        )
    return events


async def watch_loop() -> None:
    """Checks window status only while there are subscriptions and notifies about changes (works without any WebSocket connection)."""
    from app.services.agents import tmux_service
    from app.services.agents.preferences import PreferencesStore

    previous: dict[str, str] = {}
    sent: dict[tuple[str, str], float] = {}
    # window key → (time to send, 'work finished' notice)
    held: dict[str, tuple[float, dict]] = {}
    while True:
        await asyncio.sleep(WATCH_INTERVAL)
        try:
            if not await asyncio.to_thread(has_subscriptions):
                previous = {}
                continue
            windows = await asyncio.to_thread(tmux_service.cached_windows)
            prefs = await asyncio.to_thread(PreferencesStore.load)
            events = _events(previous, windows, prefs) if previous else []
            previous = {w.key: w.status for w in windows}
            now = time.monotonic()
            sent = {k: t for k, t in sent.items() if now - t < DEDUPE_SECONDS}
            ready = []
            for event in events:
                if event["status"] == "idle":
                    held[event["key"]] = (now + DONE_SETTLE, event)
                else:
                    held.pop(event["key"], None)
                    ready.append(event)
            by_key = {w.key: w for w in windows}
            for key, (due, event) in list(held.items()):
                window = by_key.get(key)
                if (
                    window is None
                    or window.status != "idle"
                    or window.compacted
                    or window.starting
                ):
                    # working again · window gone · only a compaction ended · restarting → no notice
                    del held[key]
                elif now >= due:
                    del held[key]
                    ready.append(event)
            for event in ready:
                mark = (event["key"], event["status"])
                if mark in sent:
                    continue
                sent[mark] = now
                await send(event)
        except asyncio.CancelledError:
            raise
        except Exception:  # so the watcher never stops
            logger.exception("web push watcher error")
