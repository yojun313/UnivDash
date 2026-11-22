"""tmux 화면 공유: pane 하나의 화면을 정해진 시간 동안 로그인 없이 '보기만' 하게 한다.

보안
- 보는 쪽에 열린 것은 화면 읽기 하나뿐이다. 입력 · 키 · 크기 바꾸기 · 선택 같은 기능은 공개 경로에 아예 없다
  (WebSocket 도 쓰지 않는다). 그래서 링크로는 터미널에 아무것도 보낼 수 없다.
- 링크는 /v#<토큰> 모양이다. # 뒤는 브라우저가 서버로 보내지 않으므로 접속 로그 · nginx 로그 · Referer 에 남지 않는다.
  화면은 X-View-Token 헤더로 토큰을 실어 받는다.
- 링크만으로는 열리지 않는다: 만들 때 함께 나오는 접근 코드(60비트)를 넣어야 화면이 나간다. 코드는 주인이 볼 사람에게
  직접 전달하고, 서버에는 솔트 해시만 둔다. 공유마다 10번 틀리면 15분 동안 막는다 (app/services/access_code.py).
- 토큰은 256비트 임의 값이고, 서버에는 SHA-256 해시만 저장한다 (data/view_shares.json, 0600). 링크는 만들 때 한 번만 보여 준다.
- 공유는 만들 때의 pane 하나에 묶인다 (pane id + 그 pane 이 속한 tmux 서버 pid). tmux 서버가 다시 떠서 같은 번호의
  다른 pane 이 생겨도 그 화면은 나가지 않는다. 창을 닫으면 공유도 끝난다.
- 스크롤백은 고른 만큼만 (기본: 지금 화면만). 흔한 비밀 값(API 키 · 토큰 · 개인 키)은 보내기 전에 가린다 (최선의 노력).
- 만료 · 취소 · 창이 사라진 공유는 없는 링크와 똑같이 응답한다.
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

from app.paths import data_dir
from app.services import access_code, tmux_service
from app.services.tmux_service import TmuxError

logger = logging.getLogger(__name__)

MINUTES_MIN = 5
MINUTES_MAX = 7 * 24 * 60
MINUTES_DEFAULT = 60
HISTORY_CHOICES = (0, 300, 2000)
MAX_ACTIVE = 20
TITLE_MAX = 60
TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32)
CAPTURE_TTL = 0.7  # 여러 사람이 봐도 tmux 캡처는 이 간격에 한 번
VIEWER_WINDOW = 30.0  # 이 시간 안에 화면을 받아 간 곳을 '지금 보는 중'으로 센다

# 화면에 찍힌 흔한 비밀 값 — 보는 쪽에 보내기 전에 가린다
_SECRETS = [
    re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)",
        re.DOTALL,
    ),
    # 앞 글자와 붙어 있어도 가린다 (예: 따옴표 안 '\nghp_…', 'KEY=sk-…'). 접두사가 독특해 잘못 가릴 일이 드물다.
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
_viewers: dict[str, dict[str, float]] = {}  # 공유 id → {보는 곳: 마지막 시각}


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
    """pane 이 속한 tmux 서버의 pid (없으면 KeyError)."""
    tmux_service.require_pane(pane_id)
    server = tmux_service._run(["display-message", "-p", "-t", pane_id, "#{pid}"])
    server = server.strip()
    if not server.isdigit():
        raise KeyError("존재하지 않는 pane 입니다.")
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
    # 제어 문자 · 보이지 않는 글자 · 방향 바꾸기 글자 (제목을 다른 글처럼 보이게 하는 것 방지)
    title = re.sub(
        "[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
        "",
        title,
    )
    title = title.strip()
    return title[:TITLE_MAX] or "터미널 화면"


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
    """공유를 만든다. (링크 토큰, 접근 코드, 공개 정보) — 토큰 · 코드는 이때만 알 수 있다.

    화면 공유는 항상 접근 코드가 있어야 볼 수 있다 (링크만으로는 열리지 않음).
    chat 이면 그 창의 에이전트(Claude · Codex) 대화 기록 전체도 채팅으로 보여 준다.
    """
    if history not in HISTORY_CHOICES:
        raise ValueError("스크롤백 범위가 올바르지 않습니다.")
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
                f"화면 공유가 너무 많습니다 (최대 {MAX_ACTIVE}개). 안 쓰는 공유를 끊어 주십시오."
            )
        alive[_hash(token)] = share
        _save(alive)
    logger.info(
        "화면 공유 만듦 · %s · pane=%s · %d분 · 스크롤백 %d줄 · 접근 코드 필요",
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
                logger.info("화면 공유 끊음 · %s · pane=%s", share_id, share["pane"])
                return True
    return False


def revoke_all() -> int:
    with _lock:
        shares = _load()
        if shares:
            _save({})
        _viewers.clear()
    if shares:
        logger.info("화면 공유 모두 끊음 · %d개", len(shares))
    return len(shares)


def find(token: str) -> dict | None:
    """살아 있는 공유 (토큰 모양이 틀리거나 없거나 만료면 None)."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    with _lock:
        share = _load().get(_hash(token))
    return share if share and _alive(share, time.time()) else None


def note_open(token: str) -> dict | None:
    """페이지를 연 횟수를 센다."""
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
    """보는 곳을 기록한다. 처음 보는 곳이면 True."""
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
    """공유한 pane 의 화면 (가린 뒤). pane 이 사라졌거나 다른 pane 이면 None."""
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
            # -J: 화면 너비 때문에 접힌 줄을 이어 붙인다 → 줄 끝에서 잘린 비밀 값도 한 덩어리로 가릴 수 있다
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
        for key in [k for k, (t, _) in _captures.items() if now - t > 60]:
            _captures.pop(key)
        _captures[share["id"]] = (now, result)
        return result


# ── 채팅: 공유한 pane 에서 돌고 있는 에이전트의 대화 기록 (읽기만) ──
CHAT_PAGE = 100
CHAT_PAGE_MAX = 200
_ITEM_TEXT = ("kind", "text", "ts", "name", "summary", "status")
_HOME = str(Path.home())


def _safe_text(value) -> str:
    """보는 쪽에 보낼 글: 비밀 값은 가리고, 홈 폴더 경로(계정 이름)는 ~ 로 줄인다."""
    text = redact(str(value))
    return text.replace(_HOME + "/", "~/").replace(_HOME, "~")


def _safe_item(item: dict) -> dict:
    """대화 항목에서 보여 줄 값만 골라 담는다 (내부 식별자 · 서브에이전트 로그 경로 · 그림 파일은 뺀다)."""
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
        out["images"] = len(images)  # 그림 자체는 보내지 않는다
    return out


def _agent_log(pane_id: str) -> tuple[Path | None, str | None]:
    """pane 에서 돌고 있는 에이전트의 세션 로그와 에이전트 종류."""
    from app.services import transcript_service

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
    """대화 기록 한 쪽 (가린 뒤). 채팅을 공유하지 않았거나 기록이 없으면 available=False, pane 이 사라졌으면 None."""
    from app.services import transcript_service

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
            logger.exception("화면 공유 정리 실패")
        await asyncio.sleep(60)
