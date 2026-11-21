"""공유 링크의 접근 코드: 링크와 따로 전달하는 비밀 코드. 둘 다 있어야 열린다.

- 코드는 만들 때 한 번만 보여 준다 (주인이 볼 사람에게 직접 전달). 서버에는 솔트를 붙인 해시만 둔다.
- 32자 알파벳(헷갈리는 0 O 1 I 뺌) 12자리 = 60비트. XXXX-XXXX-XXXX 로 보여 주고, 대소문자 · 띄어쓰기 · '-' 는 무시한다.
- 틀린 코드는 공유마다 세어 10번 틀리면 15분 동안 그 공유의 코드 확인을 막는다 (맞는 코드도 막음 — 맞혀 보기 차단).
"""

import hashlib
import hmac
import secrets
import threading
import time
from collections import deque

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
LENGTH = 12
MAX_FAILURES = 10
WINDOW = 600.0
LOCKOUT = 900.0

_lock = threading.Lock()
_failures: dict[str, deque[float]] = {}
_locked: dict[str, float] = {}
_verified: dict[bytes, float] = {}
VERIFIED_TTL = 60.0


def generate() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
    return "-".join(raw[i : i + 4] for i in range(0, LENGTH, 4))


def normalize(code) -> str:
    if not isinstance(code, str):
        return ""
    return "".join(ch for ch in code[:64].upper() if ch.isalnum())


def digest(code: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", normalize(code).encode(), bytes.fromhex(salt), 50_000
    ).hex()


def make() -> tuple[str, dict]:
    """(보여 줄 코드, 저장할 값)"""
    code = generate()
    salt = secrets.token_hex(16)
    return code, {"code_salt": salt, "code_hash": digest(code, salt)}


def locked(share_id: str) -> int:
    """막혀 있으면 남은 초."""
    with _lock:
        until = _locked.get(share_id, 0) - time.monotonic()
        if until <= 0:
            _locked.pop(share_id, None)
            return 0
        return int(until) + 1


def check(share: dict, code) -> bool | None:
    """True: 맞음 · False: 틀림 · None: 틀린 횟수가 많아 잠시 막힘. 코드가 필요 없는 공유면 True."""
    if not share.get("code_hash"):
        return True
    share_id = share["id"]
    if locked(share_id):
        return None
    value = normalize(code)
    # 화면은 1초마다 묻는다 → 맞힌 코드는 잠깐 기억해 매번 느린 해시를 하지 않는다 (메모리에만, 해시로)
    memo = hashlib.sha256(f"{share_id}:{share['code_hash']}:{value}".encode()).digest()
    now = time.monotonic()
    with _lock:
        if _verified.get(memo, 0) > now:
            return True
    ok = len(value) == LENGTH and hmac.compare_digest(
        digest(value, share["code_salt"]), share["code_hash"]
    )
    if ok:
        with _lock:
            if len(_verified) > 1000:
                for key in [k for k, t in _verified.items() if t <= now]:
                    _verified.pop(key)
            _verified[memo] = now + VERIFIED_TTL
        return True
    with _lock:
        failures = _failures.setdefault(share_id, deque())
        failures.append(now)
        while failures and now - failures[0] > WINDOW:
            failures.popleft()
        if len(failures) >= MAX_FAILURES:
            _locked[share_id] = now + LOCKOUT
            failures.clear()
            return None
    return False


_lock_noted: dict[str, float] = {}


def should_notify(share_id: str) -> bool:
    """코드가 잠겼음을 주인에게 알릴지 (공유마다 잠금 시간에 한 번)."""
    now = time.monotonic()
    with _lock:
        if now - _lock_noted.get(share_id, -1e9) < LOCKOUT:
            return False
        _lock_noted[share_id] = now
    return True


def forget(share_id: str) -> None:
    with _lock:
        _failures.pop(share_id, None)
        _locked.pop(share_id, None)
        _lock_noted.pop(share_id, None)
