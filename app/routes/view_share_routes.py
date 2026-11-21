"""tmux 화면 공유 (읽기 전용).

- 관리(로그인 필요): 만들기 · 목록 · 끊기 · 모두 끊기.
- 보기(로그인 없음): GET /v 는 토큰 없는 빈 페이지, 토큰은 주소의 # 뒤에만 있다 (서버 · 로그로 가지 않음).
  페이지 스크립트가 X-View-Token 헤더로 GET /api/view/info · /api/view/screen 을 부른다.
  공개 경로에는 화면 읽기만 있고, 입력 · 키 · 크기 바꾸기는 어디에도 없다.
"""

import asyncio
import logging
import threading
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app.routes.pages import templates
from app.security import LoginRateLimiter, client_key
from app.services import access_code, push_service, tmux_service, view_share_service
from app.services.auth_service import AuthService
from app.services.tmux_service import TmuxError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

# 틀린 토큰을 계속 넣어 보는 것을 늦춘다
_misses = LoginRateLimiter(
    max_attempts=20,
    window_seconds=600,
    lockout_seconds=900,
    global_max_attempts=300,
    global_window_seconds=600,
    global_lockout_seconds=300,
)
PUBLIC_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
}
# 화면 요청: 보는 곳마다 초당 이 정도까지 (페이지는 1초에 한 번 묻는다)
RATE_PER_SEC = 3.0
RATE_BURST = 6.0
_buckets: dict[str, tuple[float, float]] = {}
_buckets_lock = threading.Lock()
_tasks: set[asyncio.Task] = set()


# ── 관리 ──────────────────────────────────────────────────────────────────
class ViewShareRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    minutes: int = Field(
        default=view_share_service.MINUTES_DEFAULT,
        ge=view_share_service.MINUTES_MIN,
        le=view_share_service.MINUTES_MAX,
    )
    history: int = Field(default=0, ge=0, le=2000)
    title: str = Field(default="", max_length=200)
    chat: bool = True  # 에이전트 창이면 대화 기록(채팅)도 보여 준다


@router.post("/api/view-shares", dependencies=api_auth)
async def create_view_share(body: ViewShareRequest):
    try:
        token, code, share = await asyncio.to_thread(
            view_share_service.create,
            body.pane,
            body.minutes,
            body.history,
            body.title,
            body.chat,
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="창을 찾을 수 없어요.") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except TmuxError as error:
        raise HTTPException(
            status_code=502, detail="tmux 명령을 실행하지 못했습니다."
        ) from error
    return {"url": f"/v#{token}", "code": code, "share": share}


@router.get("/api/view-shares", dependencies=api_auth)
async def list_view_shares():
    shares = await asyncio.to_thread(view_share_service.active)
    try:
        panes = await asyncio.to_thread(tmux_service._pane_ids)
    except TmuxError:
        panes = set()
    for share in shares:
        share["pane_alive"] = share["pane"] in panes
    return {"shares": shares}


@router.delete("/api/view-shares/{share_id}", dependencies=api_auth)
async def revoke_view_share(share_id: str):
    if not await asyncio.to_thread(view_share_service.revoke, share_id[:64]):
        raise HTTPException(status_code=404, detail="이미 끊긴 공유예요.")
    return {"ok": True}


@router.delete("/api/view-shares", dependencies=api_auth)
async def revoke_all_view_shares():
    return {"revoked": await asyncio.to_thread(view_share_service.revoke_all)}


# ── 보기 (로그인 없음) ──────────────────────────────────────────────────────
@router.get("/v")
async def view_page(request: Request):
    response = templates.TemplateResponse(request=request, name="view.html")
    response.headers.update(PUBLIC_HEADERS)
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _json(status: int, content: dict, **headers) -> JSONResponse:
    return JSONResponse(
        status_code=status, content=content, headers={**PUBLIC_HEADERS, **headers}
    )


def _allow(who: str) -> bool:
    now = time.monotonic()
    with _buckets_lock:
        if len(_buckets) > 5000:
            for key in [k for k, (_, t) in _buckets.items() if now - t > 60]:
                _buckets.pop(key)
        tokens, last = _buckets.get(who, (RATE_BURST, now))
        tokens = min(RATE_BURST, tokens + (now - last) * RATE_PER_SEC)
        if tokens < 1:
            _buckets[who] = (tokens, now)
            return False
        _buckets[who] = (tokens - 1, now)
        return True


def _lookup(request: Request, token: str):
    """(공유, 오류 응답) — 맞는 토큰은 잠금과 상관없이 연다 (256비트라 맞혀 볼 수 없다)."""
    share = view_share_service.find(token)
    if share is not None:
        return share, None
    key = client_key(request)
    wait = _misses.retry_after(key)
    if wait:
        return None, _json(429, {"state": "locked"}, **{"Retry-After": str(wait)})
    _misses.record_failure(key)
    logger.warning("없거나 만료된 화면 공유 · client=%s", key)
    return None, _json(404, {"state": "gone"})


def _token(request: Request) -> str:
    return (request.headers.get("x-view-token") or "")[:64]


async def _code_error(request: Request, share: dict) -> JSONResponse | None:
    """접근 코드가 맞으면 None, 아니면 보낼 응답."""
    result = await asyncio.to_thread(
        access_code.check, share, request.headers.get("x-view-code")
    )
    if result:
        return None
    who = client_key(request)
    if result is None:
        wait = access_code.locked(share["id"]) or 60
        logger.warning("화면 공유 접근 코드 잠김 · %s · client=%s", share["id"], who)
        if access_code.should_notify(share["id"]):
            task = asyncio.create_task(_notify_lock(share))
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
        return _json(
            429, {"state": "code_locked", "wait": wait}, **{"Retry-After": str(wait)}
        )
    logger.warning("화면 공유 접근 코드 틀림 · %s · client=%s", share["id"], who)
    return _json(403, {"state": "code"})


@router.get("/api/view/info")
async def view_info(request: Request):
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    token = _token(request)
    share, error = await asyncio.to_thread(_lookup, request, token)
    if error:
        return error
    if not request.headers.get("x-view-code"):
        return _json(
            401, {"state": "need_code"}
        )  # 코드 입력 화면 — 아직 아무것도 보여 주지 않는다
    if denied := await _code_error(request, share):
        return denied
    opened = await asyncio.to_thread(view_share_service.note_open, token)
    if opened is None:
        return _json(404, {"state": "gone"})
    logger.info(
        "화면 공유 열림 · %s · pane=%s · client=%s · %d번째",
        share["id"],
        share["pane"],
        who,
        opened["opens"],
    )
    if view_share_service.note_viewer(share["id"], who):
        task = asyncio.create_task(_notify(opened))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    return _json(
        200,
        {
            "state": "ok",
            "title": share["title"],
            "expires": share["expires"],
            "chat": await asyncio.to_thread(view_share_service.chat_available, share),
            "until": datetime.fromtimestamp(share["expires"])
            .strftime("%m월 %d일 %H:%M")
            .lstrip("0"),
        },
    )


@router.get("/api/view/chat")
async def view_chat(request: Request, start: int | None = None, limit: int = 100):
    """공유한 창의 에이전트 대화 기록 (읽기만). start 가 없으면 마지막 limit 개."""
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    share, error = await asyncio.to_thread(_lookup, request, _token(request))
    if error:
        return error
    if denied := await _code_error(request, share):
        return denied
    view_share_service.note_viewer(share["id"], who)
    if start is not None and not 0 <= start <= 10_000_000:
        start = None
    try:
        data = await asyncio.to_thread(view_share_service.chat, share, start, limit)
    except Exception:
        logger.exception("화면 공유 채팅 읽기 실패 · %s", share["id"])
        return _json(200, {"state": "ok", "available": False})
    if data is None:
        return _json(410, {"state": "closed"})
    if data.get("hash") and request.query_params.get("h") == data["hash"]:
        return Response(status_code=204, headers=PUBLIC_HEADERS)
    return _json(200, {"state": "ok", "expires": share["expires"], **data})


@router.get("/api/view/screen")
async def view_screen(request: Request):
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    share, error = await asyncio.to_thread(_lookup, request, _token(request))
    if error:
        return error
    if denied := await _code_error(request, share):
        return denied
    view_share_service.note_viewer(share["id"], who)
    data = await asyncio.to_thread(view_share_service.screen, share)
    if data is None:
        return _json(410, {"state": "closed"})
    if request.query_params.get("h") == data["hash"]:
        return Response(status_code=204, headers=PUBLIC_HEADERS)
    return _json(200, {"state": "ok", "expires": share["expires"], **data})


async def _notify(share: dict) -> None:
    try:
        await push_service.send(
            {
                "title": "공유한 화면을 누가 보고 있어요",
                "body": f"{share['title']} · {share.get('opens', 0)}번째 열림",
                "tag": f"univdash-view-{share['id']}",
                "url": "/",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("화면 공유 알림 실패")


async def _notify_lock(share: dict) -> None:
    try:
        await push_service.send(
            {
                "title": "화면 공유 접근 코드가 여러 번 틀렸어요",
                "body": f"{share['title']} · 15분 동안 막았어요. 모르는 사람이면 공유를 끊으세요.",
                "tag": f"univdash-view-lock-{share['id']}",
                "url": "/",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("화면 공유 알림 실패")
