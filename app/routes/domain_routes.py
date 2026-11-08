"""Domains 페이지 (nginx 프록시 · SSL 인증서 관리). 로그인한 사용자만 쓸 수 있다."""

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.websockets import WebSocketDisconnect
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services import domain_service
from app.services.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)
MAX_CONSOLE_MESSAGE = 4096
FIRST_MESSAGE_TIMEOUT = 15


class PathRequest(BaseModel):
    domain: str = Field(max_length=253)
    path: str = Field(max_length=200)
    port: str = Field(max_length=5)
    passphrase: str = Field(max_length=1024)


class PathDeleteRequest(BaseModel):
    domain: str = Field(max_length=253)
    path: str = Field(max_length=200)
    passphrase: str = Field(max_length=1024)


class PassphraseChangeRequest(BaseModel):
    current: str = Field(max_length=1024)
    new: str = Field(max_length=1024)


class RenameCheckRequest(BaseModel):
    old_domain: str = Field(max_length=253)
    new_domain: str = Field(max_length=253)


class FolderNameRequest(BaseModel):
    name: str = Field(max_length=200)


class FolderAssignRequest(BaseModel):
    domain: str = Field(max_length=253)
    folder_id: str | None = Field(default=None, max_length=32)


def _bad_request(error: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@router.get("/domains")
async def domains_page(request: Request):
    return render_page(request, "domains")


@router.get("/api/domains", dependencies=api_auth)
async def get_domains():
    return await asyncio.to_thread(domain_service.overview)


@router.post("/api/domains/folders", dependencies=api_auth)
async def create_folder(body: FolderNameRequest):
    try:
        return await asyncio.to_thread(domain_service.create_folder, body.name)
    except ValueError as error:
        raise _bad_request(error) from error


@router.post("/api/domains/folders/assign", dependencies=api_auth)
async def assign_folder(body: FolderAssignRequest):
    try:
        await asyncio.to_thread(
            domain_service.assign_domain, body.domain, body.folder_id
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.put("/api/domains/folders/{folder_id}", dependencies=api_auth)
async def rename_folder(folder_id: str, body: FolderNameRequest):
    try:
        await asyncio.to_thread(domain_service.rename_folder, folder_id, body.name)
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.delete("/api/domains/folders/{folder_id}", dependencies=api_auth)
async def delete_folder(folder_id: str):
    try:
        await asyncio.to_thread(domain_service.delete_folder, folder_id)
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.post("/api/domains/passphrase", dependencies=api_auth)
async def change_passphrase(body: PassphraseChangeRequest):
    logger.info("도메인 변경 비밀번호 변경 요청")
    try:
        await asyncio.to_thread(
            domain_service.change_passphrase, body.current, body.new
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.post("/api/domains/paths", dependencies=api_auth)
async def add_path(body: PathRequest):
    logger.info("도메인 경로 추가 · %s%s -> :%s", body.domain, body.path, body.port)
    try:
        await asyncio.to_thread(
            domain_service.add_path, body.domain, body.path, body.port, body.passphrase
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.put("/api/domains/paths", dependencies=api_auth)
async def edit_path(body: PathRequest):
    logger.info("도메인 경로 수정 · %s%s -> :%s", body.domain, body.path, body.port)
    try:
        await asyncio.to_thread(
            domain_service.edit_path,
            body.domain,
            body.path,
            body.port,
            body.passphrase,
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.post("/api/domains/paths/delete", dependencies=api_auth)
async def delete_path(body: PathDeleteRequest):
    logger.info("도메인 경로 삭제 · %s%s", body.domain, body.path)
    try:
        last = await asyncio.to_thread(
            domain_service.delete_path, body.domain, body.path, body.passphrase
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": not last, "requires_full_delete": last}


@router.post("/api/domains/rename/check", dependencies=api_auth)
async def check_rename(body: RenameCheckRequest):
    try:
        await asyncio.to_thread(
            domain_service.check_rename, body.old_domain, body.new_domain
        )
    except ValueError as error:
        raise _bad_request(error) from error
    return {"ok": True}


@router.websocket("/ws/domains/console")
async def domain_console(websocket: WebSocket):
    # Origin 검사는 SecurityMiddleware 가, 로그인은 여기서
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()

    connected = True

    async def send(payload: dict) -> None:
        nonlocal connected
        if not connected:
            return
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        except (WebSocketDisconnect, RuntimeError):
            connected = False

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), FIRST_MESSAGE_TIMEOUT)
        if len(raw) > MAX_CONSOLE_MESSAGE:
            raise ValueError("요청이 너무 깁니다.")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("잘못된 요청입니다.")
        arguments = domain_service.console_arguments(data)
        passphrase = domain_service.clean_passphrase(data.pop("passphrase", None))
        if not (await asyncio.to_thread(domain_service.helper_status))["ready"]:
            raise ValueError("먼저 Nginx 헬퍼를 설치해 주세요.")
    except (ValueError, TimeoutError, WebSocketDisconnect, RuntimeError) as error:
        message = str(error) if isinstance(error, ValueError) else "잘못된 요청입니다."
        await send({"line": f"실패: {message}"})
        await send({"done": True, "ok": False})
        if connected:
            await websocket.close()
        return

    logger.info("도메인 작업 시작 · %s", " ".join(arguments[:2]))
    process = await asyncio.create_subprocess_exec(
        *domain_service.helper_command(*arguments),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        limit=1024 * 1024,
    )
    process.stdin.write(passphrase.encode() + b"\n")
    await process.stdin.drain()
    process.stdin.close()
    del passphrase
    # 브라우저가 끊겨도 헬퍼는 끝까지 돌리고(인증서 발급 · 되돌리기가 중간에 멈추면 안 된다) 결과를 반영한다
    while line := await process.stdout.readline():
        await send({"line": line.decode("utf-8", "replace").rstrip()})
    code = await process.wait()
    logger.info("도메인 작업 끝 · %s · 종료 코드 %s", " ".join(arguments[:2]), code)
    if code == 0:
        note = await asyncio.to_thread(
            domain_service.after_console_success, arguments, data
        )
        if note:
            await send({"line": note})
    await send({"done": True, "ok": code == 0})
    if connected:
        await websocket.close()
