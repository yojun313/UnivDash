import asyncio
import json
import logging
import os

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services import tmux_service, transcript_service, upload_service
from app.services.auth_service import AuthService
from app.services.preferences import Preferences, PreferencesStore, rename_session_keys
from app.services.tmux_service import TmuxError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

@router.get("/")
async def workspace_page(request: Request):
    return render_page(request, "workspace")


@router.get("/organize")
async def organize_page(request: Request):
    return render_page(request, "organize")


def _raise_for(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(status_code=404, detail=str(error.args[0] if error.args else "없음")) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    logger.warning("tmux 명령 실패: %s", error)
    raise HTTPException(status_code=502, detail="tmux 명령을 실행하지 못했습니다.") from error


async def _state() -> dict:
    windows = await asyncio.to_thread(tmux_service.cached_windows)
    return {
        "windows": [w.to_dict() for w in windows],
        "preferences": PreferencesStore.load().model_dump(),
    }


@router.get("/api/state", dependencies=api_auth)
async def api_state():
    try:
        return await _state()
    except TmuxError as error:
        _raise_for(error)


@router.put("/api/preferences", dependencies=api_auth)
async def api_save_preferences(preferences: Preferences):
    saved = await asyncio.to_thread(PreferencesStore.save, preferences)
    return saved.model_dump()


class CreateSessionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    path: str = Field(default="~", max_length=1024)
    command: str = Field(default="", max_length=500)


@router.post("/api/sessions", dependencies=api_auth)
async def api_create_session(body: CreateSessionRequest):
    try:
        pane = await asyncio.to_thread(tmux_service.create_session, body.name, body.path, body.command)
    except (TmuxError, ValueError) as error:
        _raise_for(error)
    logger.info("세션 생성 · %s", body.name)
    return {"pane": pane}


@router.get("/api/transcript", dependencies=api_auth)
async def api_transcript(pane: str, start: int | None = None, limit: int = 80):
    """에이전트 대화 기록. Claude Code 는 tmux 스크롤백이 없어서 세션 로그로 전체 대화를 보여준다."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        windows = await asyncio.to_thread(tmux_service.cached_windows)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    target = next(((w, p) for w in windows for p in w.panes if p.id == pane), None)
    if target is None:
        raise HTTPException(status_code=404, detail="존재하지 않는 pane 입니다.")
    window, pane_info = target
    agent = pane_info.command if pane_info.command in tmux_service.AGENTS else window.agent
    cwd = os.path.expanduser(pane_info.path)
    path = await asyncio.to_thread(transcript_service.find_log, pane_info.pid, agent, cwd)
    if path is None:
        return {"available": False, "agent": agent, "total": 0, "start": 0, "items": []}
    data = await asyncio.to_thread(transcript_service.read, path, agent, start, limit)
    return {"available": True, "agent": agent, **data}


class RenameSessionRequest(BaseModel):
    session: str = Field(min_length=2, max_length=10)
    name: str = Field(min_length=1, max_length=50)


@router.post("/api/sessions/rename", dependencies=api_auth)
async def api_rename_session(body: RenameSessionRequest):
    """tmux 세션 이름 변경 + 정리 설정의 키도 새 이름으로 옮긴다."""
    try:
        old, new = await asyncio.to_thread(tmux_service.rename_session, body.session, body.name)
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    prefs = PreferencesStore.load()
    if old != new:
        prefs = await asyncio.to_thread(PreferencesStore.save, rename_session_keys(prefs, old, new))
        logger.info("세션 이름 변경 · %s → %s", old, new)
    return {"old": old, "name": new, "preferences": prefs.model_dump()}


class WindowRequest(BaseModel):
    window: str = Field(min_length=2, max_length=10)


@router.post("/api/windows/kill", dependencies=api_auth)
async def api_kill_window(body: WindowRequest):
    try:
        window = await asyncio.to_thread(tmux_service.require_window, body.window)
        await asyncio.to_thread(tmux_service.kill_window, window)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    logger.info("창 종료 · %s", body.window)
    return {"ok": True}


# ── 실시간 채널 ───────────────────────────────────────────────────────────────
# client → server
#   {"t":"sub", "pane":"%3", "history":300}   화면 구독 (하나만)
#   {"t":"unsub"}
#   {"t":"prompt", "pane", "text", "submit":true, "attachments":[업로드 ID]}  프롬프트 입력(+Enter)
#   {"t":"text", "pane", "text"}                직접 입력 모드의 문자
#   {"t":"keys", "pane", "keys":["Escape"]}     특수 키
#   {"t":"select", "pane"}                      tmux 에서 해당 pane 활성화
# server → client
#   {"t":"windows", "windows":[...]} / {"t":"screen", ...} / {"t":"ack","id"} / {"t":"error","message","id"}

MAX_MESSAGE = 64 * 1024
MAX_ATTACHMENTS = 20
SCREEN_INTERVAL = 0.4
WINDOWS_INTERVAL = 1.5
AUTH_RECHECK = 10


class _Channel:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.pane: str | None = None
        self.history = 300
        self.last_screen: str | None = None
        self.last_windows: str | None = None
        self.wake = asyncio.Event()
        self.send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False))

    async def push_screen(self, force: bool = False) -> None:
        pane = self.pane
        if not pane:
            return
        try:
            screen = await asyncio.to_thread(tmux_service.capture, pane, self.history)
        except TmuxError:
            self.pane = None
            await self.send({"t": "gone", "pane": pane})
            return
        encoded = json.dumps(screen, ensure_ascii=False)
        if force or encoded != self.last_screen:
            self.last_screen = encoded
            await self.send({"t": "screen", **screen})

    async def push_windows(self) -> None:
        windows = await asyncio.to_thread(tmux_service.cached_windows)
        encoded = json.dumps([w.to_dict() for w in windows], ensure_ascii=False)
        if encoded != self.last_windows:
            self.last_windows = encoded
            await self.send({"t": "windows", "windows": json.loads(encoded)})


async def _pump(channel: _Channel) -> None:
    loop = asyncio.get_running_loop()
    next_windows = 0.0
    next_auth = loop.time() + AUTH_RECHECK
    while True:
        now = loop.time()
        # 입력이 없어도 화면은 계속 나가므로, 로그아웃 · 만료된 세션은 여기서 끊는다.
        if now >= next_auth:
            if not AuthService.current_user(channel.ws):
                await channel.ws.close(code=1008)
                return
            next_auth = now + AUTH_RECHECK
        if now >= next_windows:
            try:
                await channel.push_windows()
            except TmuxError:
                pass
            next_windows = now + WINDOWS_INTERVAL
        await channel.push_screen()
        try:
            await asyncio.wait_for(channel.wake.wait(), timeout=SCREEN_INTERVAL)
        except TimeoutError:
            pass
        channel.wake.clear()


async def _handle(channel: _Channel, message: dict) -> None:
    kind = message.get("t")
    if kind == "unsub":
        channel.pane = None
        return
    if kind == "ping":
        await channel.send({"t": "pong"})
        return

    pane = await asyncio.to_thread(tmux_service.require_pane, message.get("pane"))
    if kind == "sub":
        history = message.get("history", 300)
        channel.history = history if isinstance(history, int) else 300
        channel.pane = pane
        channel.last_screen = None
    elif kind == "prompt":
        text = message.get("text", "")
        if not isinstance(text, str):
            raise ValueError("잘못된 입력입니다.")
        attachments = message.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS:
            raise ValueError(f"첨부 파일은 한 번에 {MAX_ATTACHMENTS}개까지 보낼 수 있습니다.")
        # 클라이언트가 준 경로가 아니라 업로드 ID 를 받아 서버가 경로를 정한다.
        paths = [str(await asyncio.to_thread(upload_service.resolve, item)) for item in attachments]
        await asyncio.to_thread(tmux_service.send_prompt, pane, text, bool(message.get("submit", True)), paths)
    elif kind == "text":
        text = message.get("text", "")
        if not isinstance(text, str):
            raise ValueError("잘못된 입력입니다.")
        await asyncio.to_thread(tmux_service.send_literal, pane, text)
    elif kind == "keys":
        keys = message.get("keys", [])
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
            raise ValueError("잘못된 키 입력입니다.")
        await asyncio.to_thread(tmux_service.send_keys, pane, keys)
    elif kind == "select":
        await asyncio.to_thread(tmux_service.select_pane, pane)
        tmux_service.invalidate_cache()
    else:
        raise ValueError("알 수 없는 요청입니다.")

    if kind != "sub":
        # 입력 직후 화면을 빨리 보여주기 위해 잠깐 뒤 다시 캡처한다.
        await asyncio.sleep(0.08)
    channel.wake.set()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Origin 검사는 SecurityMiddleware 가, 로그인 검사는 여기서 한다.
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    channel = _Channel(websocket)
    pump = asyncio.create_task(_pump(channel))
    try:
        while True:
            raw = await websocket.receive_text()
            # 터미널 입력은 셸 권한이므로 메시지마다 세션을 확인한다.
            if not AuthService.current_user(websocket):
                await websocket.close(code=1008)
                return
            if len(raw) > MAX_MESSAGE:
                await channel.send({"t": "error", "message": "요청이 너무 큽니다."})
                continue
            message = None
            try:
                try:
                    message = json.loads(raw)
                except ValueError:
                    raise ValueError("잘못된 요청입니다.") from None
                if not isinstance(message, dict):
                    message = None
                    raise ValueError("잘못된 요청입니다.")
                await _handle(channel, message)
                if "id" in message:
                    await channel.send({"t": "ack", "id": message["id"]})
            except (KeyError, ValueError, TmuxError) as error:
                detail = error.args[0] if error.args and isinstance(error.args[0], str) else "요청을 처리하지 못했습니다."
                if isinstance(error, TmuxError):
                    logger.warning("tmux 입력 실패: %s", error)
                    detail = "tmux 명령을 실행하지 못했습니다."
                await channel.send({"t": "error", "message": detail, "id": message.get("id") if isinstance(message, dict) else None})
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
