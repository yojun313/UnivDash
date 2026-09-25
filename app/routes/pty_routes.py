"""Terminal (PTY) API · WebSocket."""

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.services import pty_service
from app.services.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)
AUTH_RECHECK = 10
MAX_MESSAGE = 64 * 1024


class NewTerminal(BaseModel):
    cwd: str = Field(default="", max_length=4096)
    cols: int = Field(default=100, ge=10, le=500)
    rows: int = Field(default=30, ge=3, le=300)


@router.get("/api/pty", dependencies=api_auth)
async def list_terminals():
    return {"terminals": pty_service.list_terminals()}


@router.post("/api/pty", dependencies=api_auth)
async def create_terminal(body: NewTerminal):
    try:
        terminal = pty_service.create(body.cwd or None, body.cols, body.rows)
    except (ValueError, OSError) as error:
        raise HTTPException(
            status_code=400,
            detail=str(error)
            if isinstance(error, ValueError)
            else "터미널을 열지 못했습니다.",
        ) from error
    logger.info("터미널 열기 · %s · %s", terminal.id, terminal.cwd)
    return terminal.info()


@router.delete("/api/pty/{terminal_id}", dependencies=api_auth)
async def close_terminal(terminal_id: str):
    pty_service.kill(terminal_id)
    return {"ok": True}


@router.websocket("/ws/pty/{terminal_id}")
async def terminal_socket(websocket: WebSocket, terminal_id: str):
    # Origin 검사는 SecurityMiddleware 가, 로그인은 여기서 (셸 권한이므로 주기적으로 다시 확인)
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    terminal = pty_service.get(terminal_id)
    if terminal is None:
        await websocket.send_text(json.dumps({"t": "gone"}))
        await websocket.close()
        return
    queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
    pty_service.attach_client(terminal, queue)
    await websocket.send_text(
        json.dumps(
            {"t": "out", "d": terminal.buffer, "replay": True}, ensure_ascii=False
        )
    )
    if not terminal.alive:
        await websocket.send_text(json.dumps({"t": "exit", "code": terminal.exit_code}))

    async def pump() -> None:
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=AUTH_RECHECK)
            except TimeoutError:
                message = None
            if not AuthService.current_user(websocket):
                await websocket.close(code=1008)
                return
            if message is not None:
                await websocket.send_text(json.dumps(message, ensure_ascii=False))

    sender = asyncio.create_task(pump())
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_MESSAGE:
                continue
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("t") == "in" and isinstance(message.get("d"), str):
                pty_service.write(terminal, message["d"])
            elif message.get("t") == "resize":
                try:
                    pty_service.resize(
                        terminal,
                        int(message.get("cols", 100)),
                        int(message.get("rows", 30)),
                    )
                except (TypeError, ValueError, OSError):
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        pty_service.detach_client(terminal, queue)
