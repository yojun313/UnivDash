"""Access code of a share link: a secret code delivered separately from the link. Both are needed to open it.

- The code is shown only once, at creation (the owner hands it to the viewer directly). The server keeps only a salted hash.
- 12 characters of a 32-letter alphabet (without the confusable 0 O 1 I) = 60 bits. Shown as XXXX-XXXX-XXXX; case, spaces and '-' are ignored.
- Wrong codes are counted per share; after 10 failures code checks for that share are blocked for 15 minutes (correct codes too — stops guessing).
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
    """(code to show, values to store)"""
    code = generate()
    salt = secrets.token_hex(16)
    return code, {"code_salt": salt, "code_hash": digest(code, salt)}


def locked(share_id: str) -> int:
    """Seconds left while blocked."""
    with _lock:
        until = _locked.get(share_id, 0) - time.monotonic()
        if until <= 0:
            _locked.pop(share_id, None)
            return 0
        return int(until) + 1


def check(share: dict, code) -> bool | None:
    """True: correct · False: wrong · None: temporarily blocked after too many failures. True for a share that needs no code."""
    if not share.get("code_hash"):
        return True
    share_id = share["id"]
    if locked(share_id):
        return None
    value = normalize(code)
    # The page asks every second → remember a correct code briefly to skip the slow hash each time (memory only, as a hash)
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
    """Whether to tell the owner that the code got locked (once per lockout period per share)."""
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
