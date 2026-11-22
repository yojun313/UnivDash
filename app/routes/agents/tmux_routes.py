import asyncio
import json
import logging
import os
import re
import time
from collections import OrderedDict
from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

from app.i18n import _
from app.routes.core.pages import render_page
from app.services.agents import (
    seen_service,
    session_restore,
    tmux_service,
    transcript_service,
)
from app.services.agents.preferences import (
    Preferences,
    PreferencesStore,
    rename_session_keys,
)
from app.services.agents.tmux_service import TmuxError
from app.services.core import push_service
from app.services.core.auth_service import AuthService
from app.services.files import upload_service

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


@router.get("/")
async def workspace_page(request: Request):
    return render_page(request, "workspace")


@router.get("/organize")
async def organize_page(request: Request):
    # Window organizing was merged into a panel inside Workspace (kept for the old address)
    return RedirectResponse(url="/", status_code=303)


def _raise_for(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else _("없음"))
        ) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    logger.warning("tmux command failed: %s", error)
    raise HTTPException(
        status_code=502, detail=_("tmux 명령을 실행하지 못했습니다.")
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
    fork_pane: str | None = Field(default=None, max_length=32)
    # Agent to start when continuing (if it differs from the original, the conversation is passed as a handoff file)
    fork_agent: Literal["claude", "codex", "gemini"] | None = None


class NavigationOrderRequest(BaseModel):
    order: list[str] = Field(max_length=20)


@router.put("/api/navigation-order", dependencies=api_auth)
async def api_save_navigation_order(body: NavigationOrderRequest):
    current = await asyncio.to_thread(PreferencesStore.load)
    payload = current.model_dump()
    payload["nav_order"] = body.order
    updated = Preferences.model_validate(payload)
    saved = await asyncio.to_thread(PreferencesStore.save, updated)
    return {"order": saved.nav_order}


@router.post("/api/sessions", dependencies=api_auth)
async def api_create_session(body: CreateSessionRequest):
    from app.services.agents import agent_restart

    command = body.command
    try:
        if body.fork_pane:
            # The server builds the start command from the original window (the command sent by the browser is not used)
            directory = await asyncio.to_thread(
                tmux_service.check_new_session, body.name, body.path
            )
            _agent, command = await asyncio.to_thread(
                agent_restart.fork_command, body.fork_pane, directory, body.fork_agent
            )
        pane = await asyncio.to_thread(
            tmux_service.create_session, body.name, body.path, command
        )
    except (TmuxError, ValueError, KeyError) as error:
        _raise_for(error)
    logger.info(
        "Session created · %s%s",
        body.name,
        " (continuing a conversation)" if body.fork_pane else "",
    )
    agent = tmux_service.agent_of(command.strip().split(" ")[0])
    if agent:
        # Answer "yes" to the trust / permission questions automatically. Continue in the current folder even if
        # the conversation was started in a different one
        agent_restart.watch_startup(pane, agent=agent, current_dir=bool(body.fork_pane))
    return {"pane": pane}


async def _resolve_log(pane: str):
    """Session log file of the agent running in the pane (None if there is none) and the agent kind."""
    # Use a slightly stale list so we do not wait for the status check (a pane's pid · folder rarely change).
    # Query again if the pane is not in it
    windows = await asyncio.to_thread(tmux_service.cached_windows, 30)
    target = next(((w, p) for w in windows for p in w.panes if p.id == pane), None)
    if target is None:
        windows = await asyncio.to_thread(tmux_service.cached_windows)
        target = next(((w, p) for w in windows for p in w.panes if p.id == pane), None)
    if target is None:
        raise KeyError(_("존재하지 않는 pane 입니다."))
    window, pane_info = target
    agent = tmux_service.agent_of(pane_info.command) or window.agent
    cwd = os.path.expanduser(pane_info.path)
    path = await asyncio.to_thread(
        transcript_service.find_log, pane_info.pid, agent, cwd
    )
    return path, agent


@router.get("/api/agent/model", dependencies=api_auth)
async def api_agent_model(pane: str):
    """Model the agent running in the pane is using now (from the session log)."""
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
    # Codex always shows the current model at the bottom of the screen ("GPT-6-Luna low · ~") — the most accurate
    # source, including a model changed for this session only.
    # Claude has no model in the log before the first answer, so show the model from the default settings (settings.json).
    # Gemini (Antigravity CLI) also shows it at the very bottom of the screen as "Gemini 3.8 Flash · low".
    if agent in {"codex", "gemini"}:
        footer = (
            tmux_service.codex_footer_model
            if agent == "codex"
            else tmux_service.gemini_footer_model
        )
        shown = await asyncio.to_thread(footer, pane)
        if shown:
            status["model"] = shown
    elif agent == "claude" and not status.get("model"):
        status["model"] = await asyncio.to_thread(
            transcript_service.claude_default_model
        )
    return {"agent": agent, **status}


@router.get("/api/agent/models", dependencies=api_auth)
async def api_agent_models(agent: str):
    """Model list for the model button. Gemini (Antigravity CLI) only: its picker has no numbers, so the user picks from a list."""
    if agent != "gemini":
        raise HTTPException(status_code=404, detail=_("모델 목록이 없습니다."))
    from app.services.accounts import gemini_service

    return {"agent": agent, "models": await asyncio.to_thread(gemini_service.models)}


class AgentRestartRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    update: bool = True


@router.post("/api/agent/restart", dependencies=api_auth)
async def api_agent_restart(body: AgentRestartRequest):
    """Restart the agent (after updating it) with the same conversation. Refused while it is working."""
    from app.services.agents import agent_restart

    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, body.pane)
        result = await asyncio.to_thread(agent_restart.restart, pane, body.update)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    logger.info(
        "Agent restart · pane=%s · %s · update=%s",
        pane,
        result["agent"],
        body.update,
    )
    return result


class AgentUpdateAllRequest(BaseModel):
    claude: bool = True
    codex: bool = True
    gemini: bool = True


@router.post("/api/agent/update-all", dependencies=api_auth)
async def api_agent_update_all(body: AgentUpdateAllRequest):
    """Update every agent window and restart it with the same conversation (in the background; working windows after they finish)."""
    from app.services.agents import agent_update_all

    if not (body.claude or body.codex or body.gemini):
        raise HTTPException(
            status_code=422, detail=_("업데이트할 에이전트를 선택하십시오.")
        )
    try:
        result = await asyncio.to_thread(
            agent_update_all.start, body.claude, body.codex, body.gemini
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.info(
        "Update of all agents started · claude=%s · codex=%s · gemini=%s",
        body.claude,
        body.codex,
        body.gemini,
    )
    return result


@router.get("/api/agent/update-all", dependencies=api_auth)
async def api_agent_update_all_status():
    from app.services.agents import agent_update_all

    return await asyncio.to_thread(agent_update_all.status)


class AgentSwitchRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    to: str = Field(pattern=r"^(claude|codex|gemini)$")
    carry: bool = False


@router.post("/api/agent/switch", dependencies=api_auth)
async def api_agent_switch(body: AgentSwitchRequest):
    """Switch agent (Claude ↔ Codex, or start one in a shell-only window). With carry, the current conversation is handed over to a new one."""
    from app.services.agents import agent_restart

    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, body.pane)
        result = await asyncio.to_thread(
            agent_restart.switch_agent, pane, body.to, body.carry
        )
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)
    logger.info("Agent switch · pane=%s · %s → %s", pane, result["from"], result["to"])
    return result


@router.get("/api/ai-limits", dependencies=api_auth)
async def api_ai_limits():
    from app.services.accounts.ai_usage_service import AIUsageService

    return await asyncio.to_thread(AIUsageService.limits)


@router.get("/api/transcript", dependencies=api_auth)
async def api_transcript(pane: str, start: int | None = None, limit: int = 80):
    """Agent conversation. Claude Code has no tmux scrollback, so the whole conversation is shown from the session log."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, agent = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    if path is None:
        return {"available": False, "agent": agent, "total": 0, "start": 0, "items": []}
    data = await asyncio.to_thread(transcript_service.read, path, agent, start, limit)
    return {"available": True, "agent": agent, **data}


@router.get("/api/transcript/search", dependencies=api_auth)
async def api_transcript_search(
    pane: str, q: str = Query(min_length=1, max_length=200), limit: int = 100
):
    """Chat search: over the whole conversation (including earlier history not loaded yet), my prompts · the agent's final answers only."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, agent = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    if path is None:
        return {
            "available": False,
            "total": 0,
            "items": [],
            "matches": 0,
            "truncated": False,
        }
    data = await asyncio.to_thread(transcript_service.search, path, agent, q, limit)
    return {"available": True, "agent": agent, **data}


@router.get("/api/transcript/usage", dependencies=api_auth)
async def api_transcript_usage(pane: str):
    """Skills · plugins · MCP servers · subagents · built-in tools used in this conversation (now / just now · by kind)."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, agent = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    if path is None:
        return {"available": False, "recent": [], "groups": [], "total": 0}
    data = await asyncio.to_thread(transcript_service.usage, path, agent)
    return {"available": True, "agent": agent, **data}


@router.get("/api/transcript/image/{name}", dependencies=api_auth)
async def api_transcript_image(name: str):
    """Image the user attached in chat (cache extracted from the conversation · named by content hash)."""
    path = transcript_service.image_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail=_("그림을 찾을 수 없습니다."))
    ext = name.rsplit(".", 1)[-1]
    media = {"jpg": "image/jpeg"}.get(ext, f"image/{ext}")
    return FileResponse(
        path,
        media_type=media,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.get("/api/transcript/sub", dependencies=api_auth)
async def api_transcript_sub(
    pane: str, agent: str = Query(max_length=600), limit: int = 60
):
    """Conversation of one subagent (when a subagent item is expanded in chat)."""
    try:
        pane = await asyncio.to_thread(tmux_service.require_pane, pane)
        path, kind = await _resolve_log(pane)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    sub = (
        await asyncio.to_thread(transcript_service.find_subagent_log, path, kind, agent)
        if path
        else None
    )
    if sub is None:
        return {"available": False, "total": 0, "start": 0, "items": []}
    data = await asyncio.to_thread(transcript_service.read, sub, kind, None, limit)
    return {"available": True, **data}


class RenameSessionRequest(BaseModel):
    session: str = Field(min_length=2, max_length=10)
    name: str = Field(min_length=1, max_length=50)


@router.post("/api/sessions/rename", dependencies=api_auth)
async def api_rename_session(body: RenameSessionRequest):
    """Rename a tmux session and move the keys of the organize settings to the new name."""
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
        await asyncio.to_thread(session_restore.note_closed, old)
        logger.info("Session renamed · %s → %s", old, new)
    return {"old": old, "name": new, "preferences": prefs.model_dump()}


class MoveSessionRequest(BaseModel):
    session: str = Field(min_length=2, max_length=10)
    path: str = Field(min_length=1, max_length=1024)


@router.post("/api/sessions/move", dependencies=api_auth)
async def api_move_session(body: MoveSessionRequest):
    """Change the session's working folder and restart the running agent in the new folder with the same conversation."""
    from app.services.agents import session_move

    try:
        return await asyncio.to_thread(session_move.move, body.session, body.path)
    except (TmuxError, KeyError, ValueError) as error:
        _raise_for(error)


class WindowRequest(BaseModel):
    window: str = Field(min_length=2, max_length=10)


@router.post("/api/windows/kill", dependencies=api_auth)
async def api_kill_window(body: WindowRequest):
    try:
        window = await asyncio.to_thread(tmux_service.require_window, body.window)
        session = await asyncio.to_thread(tmux_service.window_session, window)
        await asyncio.to_thread(tmux_service.kill_window, window)
    except (TmuxError, KeyError) as error:
        _raise_for(error)
    # If it was the last window and the session closed too, record it as 'closed on purpose' (left out of the restore notice)
    if session and session not in await asyncio.to_thread(
        session_restore._current_names
    ):
        await asyncio.to_thread(session_restore.note_closed, session)
    logger.info("Window closed · %s", body.window)
    return {"ok": True}


# ── Session restore (e.g. when tmux died as a whole) ────────────────────────


@router.get("/api/tmux/snapshots", dependencies=api_auth)
async def api_tmux_snapshots():
    return await asyncio.to_thread(session_restore.history)


class RestoreRequest(BaseModel):
    id: str = Field(pattern=r"^[0-9]{1,16}$")
    sessions: list[str] | None = Field(default=None, max_length=200)


@router.post("/api/tmux/snapshots/restore", dependencies=api_auth)
async def api_tmux_restore(body: RestoreRequest):
    try:
        names = await asyncio.to_thread(
            session_restore.restore_from_history, body.id, body.sessions
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0])) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning(
        "Session restore started · %d · %s", len(names), ", ".join(names)[:300]
    )
    return {"started": names}


# ── Live channel ──────────────────────────────────────────────────────────────
# client → server
#   {"t":"sub", "pane":"%3", "history":300}   subscribe to a screen (one only)
#   {"t":"unsub"}
#   {"t":"prompt", "pane", "text", "submit":true, "attachments":[upload IDs]}  type a prompt (+Enter)
#   {"t":"text", "pane", "text"}                characters in direct-input mode
#   {"t":"keys", "pane", "keys":["Escape"]}     special keys
#   {"t":"select", "pane"}                      activate that pane in tmux
#   {"t":"logsub", "pane", "since":N} / {"t":"logunsub"}  live chat (session log) subscription
#   {"t":"seen", "items":{window key: activity time}}     mark as read (synced to every device)
# server → client
#   {"t":"seen", "seen":{...}} / {"t":"windows", "windows":[...]} / {"t":"screen", ...} / {"t":"log", "pane", "items", "total", "start"} / {"t":"ack","id"} / {"t":"error","message","id"}

MAX_MESSAGE = 64 * 1024
MAX_ATTACHMENTS = 20
# How often the screen · session log are checked (so terminal text shows up in chat right away)
SCREEN_INTERVAL = 0.15
WINDOWS_INTERVAL = 1.5
AUTH_RECHECK = 10
SEND_TIMEOUT = 20


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
        # Live chat (agent session log) subscription
        self.log_pane: str | None = None
        self.log_path = None
        self.log_agent: str | None = None
        self.log_since = 0
        # Log size (+ the Codex input-history mark while waiting for a prompt)
        self.log_size: object = -1
        self.log_awaiting = False
        self.log_resolved_at = 0.0

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            # Keep a stalled receiver (a sleeping phone, etc.) from blocking all screen · chat sending
            await asyncio.wait_for(
                self.ws.send_text(json.dumps(payload, ensure_ascii=False)),
                timeout=SEND_TIMEOUT,
            )

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
        """When a window is read on another device, make the unread dot disappear here right away too."""
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


# Interval (seconds) for following a session log file that changes (/clear, etc.)
LOG_RESOLVE_INTERVAL = 5
# Interval (seconds) for looking again while the log is not found yet (new session · before the first prompt)
LOG_SEARCH_INTERVAL = 1


async def push_log(channel: _Channel, loop) -> None:
    """If the subscribed session log grew, send the new items (and a few at the end: tool results filled in later) right away."""
    pane = channel.log_pane
    if not pane:
        return
    now = loop.time()
    every = LOG_SEARCH_INTERVAL if channel.log_path is None else LOG_RESOLVE_INTERVAL
    if now - channel.log_resolved_at > every:
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
    signature = (
        (size, transcript_service.history_mark()) if channel.log_awaiting else size
    )
    if signature == channel.log_size:
        return
    channel.log_size = signature
    data = await asyncio.to_thread(
        transcript_service.read,
        channel.log_path,
        channel.log_agent,
        max(0, channel.log_since - 12),
        300,
    )
    if data["start"] + len(data["items"]) < data["total"]:
        # More piled up than fits in one send (reconnect, etc.) → send the latest batch and the screen reloads from scratch
        data = await asyncio.to_thread(
            transcript_service.read, channel.log_path, channel.log_agent, None, 300
        )
    channel.log_since = data["total"]
    if data.pop("awaiting", False) != channel.log_awaiting:
        channel.log_awaiting = not channel.log_awaiting
        channel.log_size = -1 if channel.log_awaiting else size
    await channel.send({"t": "log", "pane": pane, **data})


async def _push_windows(channel: _Channel) -> None:
    try:
        await channel.push_windows()
    except TmuxError:
        pass
    except Exception:  # e.g. a send that fails after the connection dropped
        logger.debug("Failed to send the window list", exc_info=True)


async def _pump(channel: _Channel) -> None:
    loop = asyncio.get_running_loop()
    next_windows = 0.0
    next_auth = loop.time() + AUTH_RECHECK
    # The window list (status check) runs separately — so the screen · chat still go out immediately while it waits
    windows_task: asyncio.Task | None = None
    try:
        while True:
            now = loop.time()
            # The screen keeps going out even without input, so signed-out · expired sessions are cut off here.
            if now >= next_auth:
                if not AuthService.current_user(channel.ws):
                    await channel.ws.close(code=1008)
                    return
                next_auth = now + AUTH_RECHECK
            if now >= next_windows and (windows_task is None or windows_task.done()):
                windows_task = asyncio.create_task(_push_windows(channel))
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
    except asyncio.CancelledError:
        raise
    except Exception:
        # If sending the screen · chat stops, nothing arrives even though the connection is alive → close it so
        # the client reconnects
        logger.warning("Live sending stopped → closing the connection", exc_info=True)
        try:
            await asyncio.wait_for(channel.ws.close(code=1011), timeout=5)
        except Exception:
            pass
    finally:
        if windows_task is not None:
            windows_task.cancel()


# Never type the same prompt twice: if a client that missed the ack sends it again, the same cid is typed only once
PROMPT_CID_TTL = 900.0
PROMPT_CID_MAX = 1000
_PROMPT_CID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_prompt_sent: "OrderedDict[str, tuple[float, asyncio.Future]]" = OrderedDict()


async def _send_prompt_once(key: str | None, send) -> bool:
    """Run send() only once per cid. False if it was already typed (or, if in progress, after waiting for it to finish)."""
    if key is None:
        await send()
        return True
    now = time.monotonic()
    while _prompt_sent and (
        len(_prompt_sent) > PROMPT_CID_MAX
        or now - next(iter(_prompt_sent.values()))[0] > PROMPT_CID_TTL
    ):
        _prompt_sent.popitem(last=False)
    entry = _prompt_sent.get(key)
    if entry is not None:
        await asyncio.shield(entry[1])
        return False
    done: asyncio.Future = asyncio.get_running_loop().create_future()
    _prompt_sent[key] = (now, done)
    try:
        await send()
    except asyncio.CancelledError:
        # Even when cancelled by a dropped connection, the tmux input may already have gone through → treat it
        # as typed and do not type it again
        done.set_result(None)
        raise
    except Exception as exc:
        _prompt_sent.pop(key, None)  # not typed → a resend will type it
        done.set_exception(exc)
        done.exception()  # so no warning is raised when nobody is waiting
        raise
    done.set_result(None)
    return True


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
    if kind == "focus":
        # Device state: the windows shown on screen (their notifications appear in-app instead of as a push),
        # and whether it is in use right now (then pushes go to that device only)
        device = message.get("device")
        keys = message.get("keys")
        keys = (
            [k for k in keys[:50] if isinstance(k, str) and len(k) <= 200]
            if isinstance(keys, list)
            else []
        )
        push_service.set_focus(
            id(channel),
            device if isinstance(device, str) else None,
            keys,
            message.get("present") is True,
        )
        return

    pane = await asyncio.to_thread(tmux_service.require_pane, message.get("pane"))
    if kind == "logsub":
        since = message.get("since", 0)
        channel.log_pane = pane
        channel.log_path = None
        channel.log_resolved_at = 0.0
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
            raise ValueError(_("잘못된 입력입니다."))
        attachments = message.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS:
            raise ValueError(
                _(
                    "첨부 파일은 한 번에 {count}개까지 보낼 수 있습니다.",
                    count=MAX_ATTACHMENTS,
                )
            )
        # The client sends upload IDs, not paths; the server decides the paths.
        paths = [
            str(await asyncio.to_thread(upload_service.resolve, item))
            for item in attachments
        ]
        cid = message.get("cid")
        key = (
            f"{pane}:{cid}" if isinstance(cid, str) and _PROMPT_CID.match(cid) else None
        )
        await _send_prompt_once(
            key,
            lambda: asyncio.to_thread(
                tmux_service.send_prompt,
                pane,
                text,
                bool(message.get("submit", True)),
                paths,
            ),
        )
    elif kind == "text":
        text = message.get("text", "")
        if not isinstance(text, str):
            raise ValueError(_("잘못된 입력입니다."))
        await asyncio.to_thread(tmux_service.send_literal, pane, text)
    elif kind == "keys":
        keys = message.get("keys", [])
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
            raise ValueError(_("잘못된 키 입력입니다."))
        await asyncio.to_thread(tmux_service.send_keys, pane, keys)
    elif kind == "size":
        cols, rows = message.get("cols"), message.get("rows")
        if not isinstance(cols, int) or not isinstance(rows, int):
            raise ValueError(_("잘못된 크기입니다."))
        if not await asyncio.to_thread(tmux_service.fit_window, pane, cols, rows):
            return
        tmux_service.invalidate_cache()
    elif kind == "select":
        await asyncio.to_thread(tmux_service.select_pane, pane)
        tmux_service.invalidate_cache()
    else:
        raise ValueError(_("알 수 없는 요청입니다."))

    if kind != "sub":
        # Capture again a moment later so the screen shows up quickly right after input.
        await asyncio.sleep(0.08)
    channel.wake.set()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # SecurityMiddleware checks the Origin; the login is checked here.
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    channel = _Channel(websocket)
    pump = asyncio.create_task(_pump(channel))
    try:
        while True:
            raw = await websocket.receive_text()
            # Terminal input is shell access, so the session is checked on every message.
            if not AuthService.current_user(websocket):
                await websocket.close(code=1008)
                return
            if len(raw) > MAX_MESSAGE:
                await channel.send({"t": "error", "message": _("요청이 너무 큽니다.")})
                continue
            message = None
            try:
                try:
                    message = json.loads(raw)
                except ValueError:
                    raise ValueError(_("잘못된 요청입니다.")) from None
                if not isinstance(message, dict):
                    message = None
                    raise ValueError(_("잘못된 요청입니다."))
                await _handle(channel, message)
                if "id" in message:
                    await channel.send({"t": "ack", "id": message["id"]})
            except (KeyError, ValueError, TmuxError) as error:
                detail = (
                    error.args[0]
                    if error.args and isinstance(error.args[0], str)
                    else _("요청을 처리하지 못했습니다.")
                )
                if isinstance(error, TmuxError):
                    logger.warning("tmux input failed: %s", error)
                    detail = _("tmux 명령을 실행하지 못했습니다.")
                await channel.send(
                    {
                        "t": "error",
                        "message": detail,
                        "id": message.get("id") if isinstance(message, dict) else None,
                    }
                )
    except WebSocketDisconnect:
        pass
    except TimeoutError:
        logger.info("Closing an unresponsive WebSocket connection")
    except RuntimeError:
        # The send loop closed the connection first (receive read a closed socket)
        logger.debug("WebSocket is already closed", exc_info=True)
    finally:
        push_service.set_focus(id(channel), None)
        pump.cancel()
