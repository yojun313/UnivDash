"""웹 푸시 알림: 에이전트 작업이 끝나거나 응답이 필요하면 구독한 기기(맥 · 윈도우 · 안드로이드 · iOS 홈 화면 앱)에 알린다.

브라우저 탭이 백그라운드이거나 닫혀 있어도(휴대폰 잠금 포함) 서버가 직접 보내야 오므로
표준 Web Push(RFC 8030) + VAPID(RFC 8292) + aes128gcm 암호화(RFC 8291)를 쓴다.

- VAPID 개인 키와 구독 목록은 데이터 폴더에 0600 으로 둔다.
- 구독 주소는 알려진 푸시 서비스 호스트(HTTPS)만 받는다 → 서버가 임의 주소로 요청을 보내지 않는다(SSRF 차단).
- 알림 내용은 기기별 키로 암호화되어 푸시 서비스도 읽을 수 없다.
- 그 기기에서 대시보드를 지금 보고 있으면(포커스) 보내지 않는다 — 화면 안 알림으로 충분하다.
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

from app.paths import data_dir

logger = logging.getLogger(__name__)

MAX_SUBSCRIPTIONS = 30
WATCH_INTERVAL = 2.0
DEDUPE_SECONDS = 10
PUSH_TTL = 6 * 3600  # 기기가 꺼져 있으면 푸시 서비스가 이 시간까지 보관했다가 전달
SEND_TIMEOUT = 10
DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# 주요 브라우저 푸시 서비스: Chrome · Edge(신) · 안드로이드 = FCM, Firefox = Mozilla, Safari · iOS = Apple, Edge(구) = WNS
PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
)

_lock = threading.Lock()
# WebSocket 채널 → (기기 ID, 그 기기 화면에 지금 보이는 창 key 들, 지금 그 기기에서 대시보드를 쓰고 있는지)
_focus: dict[int, tuple[str, frozenset[str], bool]] = {}
_focus_lock = threading.Lock()


# ── 저장소 ────────────────────────────────────────────────────────────
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
                logger.info("웹 푸시 VAPID 키를 새로 만들었습니다.")
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
        raise ValueError("잘못된 기기 ID 입니다.")
    if not valid_endpoint(endpoint):
        raise ValueError("지원하지 않는 푸시 서비스입니다.")
    try:
        point, secret = _unb64(p256dh), _unb64(auth)
    except ValueError:
        raise ValueError("잘못된 구독 키입니다.") from None
    if len(point) != 65 or point[0] != 4 or len(secret) != 16:
        raise ValueError("잘못된 구독 키입니다.")
    ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), point
    )  # 곡선 위의 점인지 확인
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


# ── 포커스(지금 보고 있는 기기) ─────────────────────────────────────────
def set_focus(channel: int, device: str | None, keys=(), present: bool = False) -> None:
    """이 채널(탭)의 기기 상태: 화면에 보이는 창 keys, 지금 그 기기에서 대시보드를 쓰고 있는지(present).

    device 가 None 이면 (연결이 끊김) 지운다.
    """
    with _focus_lock:
        if device and DEVICE_RE.match(device):
            _focus[channel] = (device, frozenset(keys), bool(present))
        else:
            _focus.pop(channel, None)


def watching_devices(key: str | None) -> set[str]:
    """지금 그 창을 화면에 띄워 보고 있는 기기 (그 기기에는 푸시 대신 화면 안 알림만)."""
    with _focus_lock:
        return {d for d, keys, _ in _focus.values() if key and key in keys}


def present_devices() -> set[str]:
    """지금 대시보드를 쓰고 있는 기기 — 하나라도 있으면 알림은 그 기기로만 간다."""
    with _focus_lock:
        return {d for d, _, present in _focus.values() if present}


# ── 암호화 (RFC 8291) · VAPID (RFC 8292) ───────────────────────────────
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
    # 푸시 서비스가 문제 시 연락할 주소. Apple 은 https: 또는 mailto: 를 요구한다.
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
    # 리다이렉트를 따라가지 않는다 (허용 목록 밖 주소로 새지 않게)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=SEND_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as error:
        if error.code in (404, 410):  # 구독이 만료 · 해지됨
            _drop_endpoint(endpoint)
        else:
            logger.warning(
                "웹 푸시 실패 (%s): %s", error.code, urlsplit(endpoint).hostname
            )
        return error.code
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        logger.warning("웹 푸시 전송 오류: %s", error)
        return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


async def send(
    data: dict, devices: set[str] | None = None, skip_focused: bool = True
) -> list[int]:
    """구독한 기기들에 알림을 보낸다. devices 를 주면 그 기기만.

    skip_focused 면: 대시보드를 쓰고 있는 기기가 있으면 그 기기로만 보내고(다른 기기는 조용히),
    그 창을 화면에 띄워 보고 있는 기기는 뺀다 (화면 안 알림만).
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
                "웹 푸시 %s · 쓰고 있는 기기가 있어 다른 기기로는 보내지 않음",
                data.get("title", ""),
            )
        return []
    if not targets:
        return []
    results = list(
        await asyncio.gather(*(asyncio.to_thread(_send_one, s, data) for s in targets))
    )
    logger.info(
        "웹 푸시 %s · %s",
        data.get("title", ""),
        ", ".join(
            f"{s.get('label') or '기기'}={code}" for s, code in zip(targets, results)
        )
        + (f" · 보고 있어서 뺌 {len(busy)}대" if busy else "")
        + (" · 쓰고 있는 기기로만" if using else ""),
    )
    return results


# ── 에이전트 상태 감시 ─────────────────────────────────────────────────
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


AGENT_LABELS = {"claude": "Claude", "codex": "Codex"}


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
            what = "응답이 필요해요"
        elif before == "busy" and window.status == "idle":
            what = "작업 완료"
        else:
            continue
        name = _display_name(window, windows, prefs.aliases)
        agent = AGENT_LABELS.get(window.agent or "", window.agent or "")
        detail = " · ".join(x for x in (agent, window.title, window.path) if x)
        events.append(
            {
                "title": f"{name} · {what}",
                "body": detail[:200],
                "tag": f"univdash-{window.key}",
                "url": "/#" + quote(window.key, safe=""),
                "key": window.key,
                "status": window.status,
            }
        )
    return events


async def watch_loop() -> None:
    """구독이 있을 때만 창 상태를 확인해 바뀐 것을 알린다 (WebSocket 연결이 없어도 동작)."""
    from app.services import tmux_service
    from app.services.preferences import PreferencesStore

    previous: dict[str, str] = {}
    sent: dict[tuple[str, str], float] = {}
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
            for event in events:
                mark = (event["key"], event["status"])
                if mark in sent:
                    continue
                sent[mark] = now
                await send(event)
        except asyncio.CancelledError:
            raise
        except Exception:  # 감시가 멈추지 않도록
            logger.exception("웹 푸시 감시 오류")
