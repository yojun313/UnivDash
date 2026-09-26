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
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services import tmux_service, transcript_service, upload_service
from app.services.auth_service import AuthService
from app.services import seen_service
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
    # 창 정리는 Workspace 안의 패널로 합쳤다 (예전 주소 호환)
    return RedirectResponse(url="/", status_code=303)


def _raise_for(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else "없음")
        ) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    logger.warning("tmux 명령 실패: %s", error)
    raise HTTPException(
        status_code=502, detail="tmux 명령을 실행하지 못했습니다."
    ) from error


async def _state() -> dict:
    windows = await asyncio.to_thread(tmux_service.cached_windows)
    return {
        "windows": [w.to_dict() for w in windows],
        "preferences": PreferencesStore.load().model_dump(),
        "seen": seen_service.snapshot(),
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
        pane = await asyncio.to_thread(
            tmux_service.create_session, body.name, body.path, body.command
        )
    except (TmuxError, ValueError) as error:
        _raise_for(error)
    logger.info("세션 생성 · %s", body.name)
    if body.command.strip().split(" ")[0] in tmux_service.AGENTS:
        from app.services import agent_restart

        # 신뢰 · 권한 질문에 자동으로 "예"
        agent_restart.watch_startup(pane, agent=body.command.strip().split(" ")[0])
    return {"pane": pane}


async def _resolve_log(pane: str):
    """pane 에서 실행 중인 에이전트의 세션 로그 파일 (없으면 None) 과 에이전트 종류."""
    windows = await asyncio.to_thread(tmux_service.cached_windows)
    target = next(((w, p) for w in windows for p in w.panes if p.id == pane), None)
    if target is None:
        raise KeyError("존재하지 않는 pane 입니다.")
    window, pane_info = target
    agent = (
        pane_info.command if pane_info.command in tmux_service.AGENTS else window.agent
    )
    cwd = os.path.expanduser(pane_info.path)
    path = await asyncio.to_thread(
        transcript_service.find_log, pane_info.pid, agent, cwd
    )
    return path, agent


@router.get("/api/agent/model", dependencies=api_auth)
async def api_agent_model(pane: str):
    """pane 에서 도는 에이전트가 지금 쓰는 모델 (세션 로그 기준)."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, agent = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    status = (
        await asyncio.to_thread(transcript_service.model_status, path, agent)
        if path
        else {"model": None, "error": None, "error_at": None}
    )
    # Codex 는 화면 아래에 지금 모델을 늘 보여 준다 ("GPT-6-Luna low · ~") — 세션만 바꾼 모델까지 가장 정확하다.
    # Claude 는 답변이 아직 없으면 기록에 모델이 없으므로 기본 설정(settings.json)의 모델을 보여 준다.
    if agent == "codex":
        shown = await asyncio.to_thread(tmux_service.codex_footer_model, pane)
        if shown:
            status["model"] = shown
    elif agent == "claude" and not status.get("model"):
        status["model"] = await asyncio.to_thread(
            transcript_service.claude_default_model
        )
    return {"agent": agent, **status}


class AgentRestartRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    update: bool = True


@router.post("/api/agent/restart", dependencies=api_auth)
async def api_agent_restart(body: AgentRestartRequest):
    """에이전트를 (업데이트하고) 같은 대화로 다시 켠다. 작업 중이면 거절."""
    from app.services import agent_restart

    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, body.pane)
        result = await asyncio.to_thread(agent_restart.restart, pane, body.update)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    logger.info(
        "에이전트 다시 켜기 · pane=%s · %s · update=%s",
        pane,
        result["agent"],
        body.update,
    )
    return result


class AgentSwitchRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    to: str = Field(pattern=r"^(claude|codex)$")


@router.post("/api/agent/switch", dependencies=api_auth)
async def api_agent_switch(body: AgentSwitchRequest):
    """에이전트 바꾸기 (Claude ↔ Codex, 셸만 있는 창에서 켜기). 대화는 옮겨지지 않고 새로 시작한다."""
    from app.services import agent_restart

    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, body.pane)
        result = await asyncio.to_thread(agent_restart.switch_agent, pane, body.to)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    logger.info(
        "에이전트 바꾸기 · pane=%s · %s → %s", pane, result["from"], result["to"]
    )
    return result


@router.get("/api/ai-limits", dependencies=api_auth)
async def api_ai_limits():
    from app.services.ai_usage_service import AIUsageService

    return await asyncio.to_thread(AIUsageService.limits)


@router.get("/api/transcript", dependencies=api_auth)
async def api_transcript(pane: str, start: int | None = None, limit: int = 80):
    """에이전트 대화 기록. Claude Code 는 tmux 스크롤백이 없어서 세션 로그로 전체 대화를 보여준다."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, agent = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
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
        old, new = await asyncio.to_thread(
            tmux_service.rename_session, body.session, body.name
        )
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    prefs = PreferencesStore.load()
    if old != new:
        prefs = await asyncio.to_thread(
            PreferencesStore.save, rename_session_keys(prefs, old, new)
        )
        seen_service.rename_session(old, new)
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
#   {"t":"logsub", "pane", "since":N} / {"t":"logunsub"}  채팅(세션 로그) 실시간 구독
#   {"t":"seen", "items":{창 키: 활동 시각}}     읽음 처리 (모든 기기 동기화)
# server → client
#   {"t":"seen", "seen":{...}} / {"t":"windows", "windows":[...]} / {"t":"screen", ...} / {"t":"log", "pane", "items", "total", "start"} / {"t":"ack","id"} / {"t":"error","message","id"}

MAX_MESSAGE = 64 * 1024
MAX_ATTACHMENTS = 20
SCREEN_INTERVAL = 0.15  # 화면 · 세션 로그 확인 주기 (터미널 글이 채팅에 바로 뜨게)
WINDOWS_INTERVAL = 1.5
AUTH_RECHECK = 10


class _Channel:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.pane: str | None = None
        self.history = 300
        self.last_screen: str | None = None
        self.last_windows: str | None = None
        self.seen_version = -1
        self.wake = asyncio.Event()
        self.send_lock = asyncio.Lock()
        # 채팅(에이전트 세션 로그) 실시간 구독
        self.log_pane: str | None = None
        self.log_path = None
        self.log_agent: str | None = None
        self.log_since = 0
        self.log_size = -1
        self.log_resolved_at = 0.0

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

    async def push_seen(self) -> None:
        """다른 기기에서 창을 읽으면 여기서도 안 읽음 점이 바로 사라지게 한다."""
        current = seen_service.version()
        if current != self.seen_version:
            self.seen_version = current
            await self.send({"t": "seen", "seen": seen_service.snapshot()})

    async def push_windows(self) -> None:
        windows = await asyncio.to_thread(tmux_service.cached_windows)
        encoded = json.dumps([w.to_dict() for w in windows], ensure_ascii=False)
        if encoded != self.last_windows:
            self.last_windows = encoded
            await self.send({"t": "windows", "windows": json.loads(encoded)})


LOG_RESOLVE_INTERVAL = 5  # /clear 등으로 세션 로그 파일이 바뀌는 것을 따라가는 주기(초)


async def push_log(channel: _Channel, loop) -> None:
    """구독 중인 세션 로그가 커졌으면 새 항목(과 끝부분 몇 개: 나중에 채워지는 도구 결과)을 바로 보낸다."""
    pane = channel.log_pane
    if not pane:
        return
    now = loop.time()
    if channel.log_path is None or now - channel.log_resolved_at > LOG_RESOLVE_INTERVAL:
        try:
            path, agent = await _resolve_log(pane)
        except (TmuxError, KeyError):
            return
        channel.log_resolved_at = now
        if path != channel.log_path:
            channel.log_path, channel.log_agent, channel.log_size = path, agent, -1
    if channel.log_path is None:
        return
    try:
        size = channel.log_path.stat().st_size
    except OSError:
        channel.log_path = None
        return
    if size == channel.log_size:
        return
    channel.log_size = size
    data = await asyncio.to_thread(
        transcript_service.read,
        channel.log_path,
        channel.log_agent,
        max(0, channel.log_since - 12),
        300,
    )
    channel.log_since = data["total"]
    await channel.send({"t": "log", "pane": pane, **data})


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
        await channel.push_seen()
        if seen_service.dirty():
            await asyncio.to_thread(seen_service.flush)
        await channel.push_screen()
        await push_log(channel, loop)
        try:
            await asyncio.wait_for(channel.wake.wait(), timeout=SCREEN_INTERVAL)
        except TimeoutError:
            pass
        channel.wake.clear()


async def _handle(channel: _Channel, message: dict) -> None:
    kind = message.get("t")
    if kind == "seen":
        items = message.get("items")
        if isinstance(items, dict):
            seen_service.mark(items)
        return
    if kind == "unsub":
        channel.pane = None
        return
    if kind == "logunsub":
        channel.log_pane = None
        return
    if kind == "ping":
        await channel.send({"t": "pong"})
        return

    pane = await asyncio.to_thread(tmux_service.require_pane, message.get("pane"))
    if kind == "logsub":
        since = message.get("since", 0)
        channel.log_pane = pane
        channel.log_path = None
        channel.log_since = since if isinstance(since, int) and since >= 0 else 0
        channel.log_size = -1
        channel.wake.set()
        return
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
            raise ValueError(
                f"첨부 파일은 한 번에 {MAX_ATTACHMENTS}개까지 보낼 수 있습니다."
            )
        # 클라이언트가 준 경로가 아니라 업로드 ID 를 받아 서버가 경로를 정한다.
        paths = [
            str(await asyncio.to_thread(upload_service.resolve, item))
            for item in attachments
        ]
        await asyncio.to_thread(
            tmux_service.send_prompt,
            pane,
            text,
            bool(message.get("submit", True)),
            paths,
        )
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
                detail = (
                    error.args[0]
                    if error.args and isinstance(error.args[0], str)
                    else "요청을 처리하지 못했습니다."
                )
                if isinstance(error, TmuxError):
                    logger.warning("tmux 입력 실패: %s", error)
                    detail = "tmux 명령을 실행하지 못했습니다."
                await channel.send(
                    {
                        "t": "error",
                        "message": detail,
                        "id": message.get("id") if isinstance(message, dict) else None,
                    }
                )
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
