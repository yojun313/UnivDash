"""tmux screen sharing: lets the screen of one pane be 'viewed only' without signing in for a set time.

Security
- The only thing open to the viewer is reading the screen. Input, keys, resizing and selection do not exist on the
  public routes at all (no WebSocket either). So nothing can be sent to the terminal through the link.
- The link looks like /v#<token>. The browser does not send the part after # to the server, so it stays out of
  access logs, nginx logs and the Referer. The screen is fetched with the token in the X-View-Token header.
- The link alone does not open it: the access code (60 bits) issued at creation must be entered before the screen
  is served. The owner hands the code to the viewer directly and the server keeps only a salted hash. After 10
  failures per share it is blocked for 15 minutes (app/services/sharing/access_code.py).
- The token is a 256-bit random value and the server stores only its SHA-256 hash (data/view_shares.json, 0600).
  The link is shown only once, at creation.
- A share is bound to the one pane it was created for (pane id + pid of the tmux server that pane belongs to).
  If the tmux server restarts and a different pane gets the same number, that screen is not served. Closing the
  window ends the share.
- Scrollback only as much as chosen (default: the current screen only). Common secret values (API keys, tokens,
  private keys) are masked before sending (best effort).
- Expired and revoked shares, and shares whose window is gone, answer exactly like links that never existed.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir
from app.services.agents import tmux_service
from app.services.agents.tmux_service import TmuxError
from app.services.sharing import access_code

logger = logging.getLogger(__name__)

MINUTES_MIN = 5
MINUTES_MAX = 7 * 24 * 60
MINUTES_DEFAULT = 60
HISTORY_CHOICES = (0, 300, 2000)
MAX_ACTIVE = 20
TITLE_MAX = 60
TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32)
CAPTURE_TTL = 0.7  # one tmux capture per this interval, however many are watching
VIEWER_WINDOW = (
    30.0  # a viewer that fetched the screen within this time counts as 'watching now'
)

# Common secret values printed on the screen — masked before sending to the viewer
_SECRETS = [
    re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)",
        re.DOTALL,
    ),
    # Masked even when glued to the preceding character (e.g. '\nghp_…' inside quotes, 'KEY=sk-…'). The prefixes are distinctive, so false matches are rare.
    re.compile(r"sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{20,}"),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"glpat-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"xox[abposr]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"hf_[A-Za-z0-9]{20,}"),
    re.compile(r"npm_[A-Za-z0-9]{30,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(?:bearer)\s+[A-Za-z0-9._~+/\-]{20,}=*"),
    re.compile(
        r"(?i)((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|client[_-]?secret)\w*\s*[=:]\s*[\"']?)(?=[^\s\"'\x1b]*\d)[^\s\"'\x1b]{8,}"
    ),
]
MASK = "••••••"

_lock = threading.Lock()
_capture_lock = threading.Lock()
_captures: dict[str, tuple[float, dict]] = {}
_viewers: dict[str, dict[str, float]] = {}  # share id → {viewer: last seen}


def _path() -> Path:
    return data_dir() / "view_shares.json"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _load() -> dict[str, dict]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(shares: dict[str, dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".view_shares.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(shares, handle)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _alive(share: dict, now: float) -> bool:
    return now < share.get("expires", 0)


def _pane_server(pane_id: str) -> str:
    """pid of the tmux server the pane belongs to (KeyError if missing)."""
    tmux_service.require_pane(pane_id)
    server = tmux_service._run(["display-message", "-p", "-t", pane_id, "#{pid}"])
    server = server.strip()
    if not server.isdigit():
        raise KeyError(_("존재하지 않는 pane 입니다."))
    return server


def redact(text: str) -> str:
    for pattern in _SECRETS:
        if pattern.groups:
            text = pattern.sub(lambda m: m.group(1) + MASK, text)
        else:
            text = pattern.sub(MASK, text)
    return text


def clean_title(title: str) -> str:
    title = re.sub(r"\x1b\[[0-9;:?]*[ -/]*[@-~]", "", title or "")
    # Control, invisible and direction-changing characters (keeps a title from posing as other text)
    title = re.sub(
        "[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
        "",
        title,
    )
    title = title.strip()
    return title[:TITLE_MAX] or _("터미널 화면")


def public(share: dict, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    seen = _viewers.get(share["id"], {})
    return {
        "id": share["id"],
        "pane": share["pane"],
        "title": share["title"],
        "history": share["history"],
        "chat": bool(share.get("chat")),
        "created": share["created"],
        "expires": share["expires"],
        "opens": share.get("opens", 0),
        "watching": sum(1 for t in seen.values() if now - t < VIEWER_WINDOW),
    }


def create(
    pane_id: str, minutes: int, history: int, title: str, chat: bool = True
) -> tuple[str, str, dict]:
    """Creates a share. (link token, access code, public info) — the token and code are only known here.

    A screen share always needs the access code to be viewed (the link alone does not open it).
    With chat, the whole conversation of that window's agent (Claude · Codex) is shown as a chat as well.
    """
    if history not in HISTORY_CHOICES:
        raise ValueError(_("스크롤백 범위가 올바르지 않습니다."))
    minutes = max(MINUTES_MIN, min(MINUTES_MAX, int(minutes)))
    server = _pane_server(pane_id)
    now = time.time()
    token = secrets.token_urlsafe(32)
    code, stored = access_code.make()
    share = {
        "id": secrets.token_hex(8),
        "pane": pane_id,
        "server": server,
        "title": clean_title(title),
        "history": history,
        "chat": bool(chat),
        "created": now,
        "expires": now + minutes * 60,
        "opens": 0,
        **stored,
    }
    with _lock:
        alive = {h: s for h, s in _load().items() if _alive(s, now)}
        if len(alive) >= MAX_ACTIVE:
            raise ValueError(
                _(
                    "화면 공유가 너무 많습니다 (최대 {count}개). 안 쓰는 공유를 끊어 주십시오.",
                    count=MAX_ACTIVE,
                )
            )
        alive[_hash(token)] = share
        _save(alive)
    logger.info(
        "screen share created · %s · pane=%s · %d min · scrollback %d lines · access code required",
        share["id"],
        pane_id,
        minutes,
        history,
    )
    return token, code, public(share, now)


def active() -> list[dict]:
    now = time.time()
    with _lock:
        shares = _load()
    items = [public(s, now) for s in shares.values() if _alive(s, now)]
    return sorted(items, key=lambda s: s["created"], reverse=True)


def revoke(share_id: str) -> bool:
    with _lock:
        shares = _load()
        for key, share in list(shares.items()):
            if share.get("id") == share_id:
                shares.pop(key)
                _save(shares)
                _viewers.pop(share_id, None)
                access_code.forget(share_id)
                logger.info(
                    "screen share stopped · %s · pane=%s", share_id, share["pane"]
                )
                return True
    return False


def revoke_all() -> int:
    with _lock:
        shares = _load()
        if shares:
            _save({})
        _viewers.clear()
    if shares:
        logger.info("all screen shares stopped · %d", len(shares))
    return len(shares)


def find(token: str) -> dict | None:
    """A live share (None when the token is malformed, unknown or expired)."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    with _lock:
        share = _load().get(_hash(token))
    return share if share and _alive(share, time.time()) else None


def note_open(token: str) -> dict | None:
    """Counts how many times the page was opened."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    key = _hash(token)
    with _lock:
        shares = _load()
        share = shares.get(key)
        if not share or not _alive(share, time.time()):
            return None
        share["opens"] = share.get("opens", 0) + 1
        _save(shares)
    return dict(share)


def note_viewer(share_id: str, who: str) -> bool:
    """Records a viewer. True when it is a new viewer."""
    now = time.time()
    with _lock:
        seen = _viewers.setdefault(share_id, {})
        for key in [k for k, t in seen.items() if now - t > 3600]:
            seen.pop(key)
        first = who not in seen
        if first and len(seen) >= 200:
            return False
        seen[who] = now
    return first


def screen(share: dict) -> dict | None:
    """Screen of the shared pane (after masking). None when the pane is gone or is a different pane."""
    now = time.monotonic()
    with _capture_lock:
        cached = _captures.get(share["id"])
        if cached and now - cached[0] < CAPTURE_TTL:
            return cached[1]
        pane = share["pane"]
        try:
            if _pane_server(pane) != share["server"]:
                return None
            info = tmux_service._run(
                ["display-message", "-p", "-t", pane, "#{pane_dead} #{pane_width}"]
            ).split()
            # -J: joins lines wrapped by the screen width → a secret cut at the end of a line can be masked as one piece
            content = tmux_service._run(
                [
                    "capture-pane",
                    "-p",
                    "-e",
                    "-J",
                    "-t",
                    pane,
                    "-S",
                    f"-{share['history']}",
                ]
            )
        except (KeyError, TmuxError, ValueError):
            return None
        if not info or info[0] == "1":
            return None
        width = int(info[1]) if len(info) > 1 and info[1].isdigit() else 80
        content = redact(content.removesuffix("\n"))
        result = {
            "content": content,
            "width": width,
            "hash": hashlib.sha256(f"{width}:{content}".encode()).hexdigest()[:24],
        }
        for key in [k for k, (t, _result) in _captures.items() if now - t > 60]:
            _captures.pop(key)
        _captures[share["id"]] = (now, result)
        return result


# ── Chat: conversation of the agent running in the shared pane (read-only) ──
CHAT_PAGE = 100
CHAT_PAGE_MAX = 200
_ITEM_TEXT = ("kind", "text", "ts", "name", "summary", "status")
_HOME = str(Path.home())


def _safe_text(value) -> str:
    """Text for the viewer: secret values are masked and the home folder path (account name) is shortened to ~."""
    text = redact(str(value))
    return text.replace(_HOME + "/", "~/").replace(_HOME, "~")


def _safe_item(item: dict) -> dict:
    """Keeps only the values to show from a conversation item (drops internal ids, subagent log paths and image files)."""
    out: dict = {"id": int(item.get("id", 0))}
    for key in _ITEM_TEXT:
        if isinstance(item.get(key), str):
            out[key] = _safe_text(item[key])
    if item.get("kind") == "tool":
        output = item.get("output")
        out["output"] = None if output is None else _safe_text(output)
        out["error"] = bool(item.get("error"))
        out["running"] = bool(item.get("running"))
        diffs = []
        for diff in item.get("diffs") or []:
            if not isinstance(diff, dict):
                continue
            diffs.append(
                {
                    "file": _safe_text(diff.get("file", "")),
                    "op": str(diff.get("op", "update"))[:10],
                    "add": int(diff.get("add") or 0),
                    "del": int(diff.get("del") or 0),
                    "cut": bool(diff.get("cut")),
                    "hunks": [
                        {
                            "o": h.get("o") if isinstance(h.get("o"), int) else None,
                            "n": h.get("n") if isinstance(h.get("n"), int) else None,
                            "lines": [_safe_text(line) for line in h.get("lines", [])],
                        }
                        for h in diff.get("hunks", [])
                        if isinstance(h, dict)
                    ],
                }
            )
        if diffs:
            out["diffs"] = diffs
    images = item.get("images")
    if isinstance(images, list) and images:
        out["images"] = len(images)  # the images themselves are not sent
    return out


def _agent_log(pane_id: str) -> tuple[Path | None, str | None]:
    """Session log and agent kind of the agent running in the pane."""
    from app.services.agents import transcript_service

    for max_age in (30, 1.5):
        windows = tmux_service.cached_windows(max_age)
        target = next(
            ((w, p) for w in windows for p in w.panes if p.id == pane_id), None
        )
        if target is not None:
            break
    else:
        return None, None
    window, pane = target
    agent = tmux_service.agent_of(pane.command) or window.agent
    if agent not in tmux_service.AGENTS:
        return None, None
    path = transcript_service.find_log(pane.pid, agent, os.path.expanduser(pane.path))
    return path, agent


def chat_available(share: dict) -> bool:
    if not share.get("chat"):
        return False
    try:
        if _pane_server(share["pane"]) != share["server"]:
            return False
        return _agent_log(share["pane"])[0] is not None
    except (KeyError, TmuxError, OSError):
        return False


def chat(share: dict, start: int | None, limit: int) -> dict | None:
    """One page of the conversation (after masking). available=False when chat is not shared or there is no log, None when the pane is gone."""
    from app.services.agents import transcript_service

    if not share.get("chat"):
        return {"available": False}
    try:
        if _pane_server(share["pane"]) != share["server"]:
            return None
        path, agent = _agent_log(share["pane"])
    except (KeyError, TmuxError):
        return None
    if path is None:
        return {"available": False}
    limit = max(1, min(int(limit), CHAT_PAGE_MAX))
    data = transcript_service.read(path, agent, start, limit)
    result = {
        "available": True,
        "agent": agent,
        "total": data["total"],
        "start": data["start"],
        "items": [_safe_item(item) for item in data["items"]],
        "related": [_safe_item(item) for item in data.get("related", [])],
    }
    result["hash"] = hashlib.sha256(
        json.dumps(result, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()[:24]
    return result


def cleanup() -> None:
    now = time.time()
    with _lock:
        shares = _load()
        alive = {h: s for h, s in shares.items() if _alive(s, now)}
        if len(alive) != len(shares):
            _save(alive)
        ids = {s["id"] for s in alive.values()}
        for key in [k for k in _viewers if k not in ids]:
            _viewers.pop(key)


async def cleanup_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(cleanup)
        except Exception:
            logger.exception("screen share cleanup failed")
        await asyncio.sleep(60)
