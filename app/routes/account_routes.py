"""에이전트 계정 관리 API (Codex · Claude Code): 목록 · 전환 · 삭제 · 로그인으로 추가.

토큰은 서버 밖으로 내보내지 않는다 — 응답에는 메일 · 요금제 · 상태만.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import (
    claude_accounts,
    claude_login,
    codex_accounts,
    codex_auto_switch,
)
from app.services.ai_usage_service import AIUsageService
from app.services.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


def _raise(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else "없음")
        ) from error
    if isinstance(error, (codex_accounts.AccountError, claude_accounts.AccountError)):
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning("계정 처리 실패: %s", error)
    raise HTTPException(
        status_code=500, detail="계정 정보를 처리하지 못했습니다."
    ) from error


class AutoSwitchRequest(BaseModel):
    enabled: bool


class SwitchRequest(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{12}$")


@router.get("/api/accounts/codex", dependencies=api_auth)
async def codex_list():
    try:
        return await asyncio.to_thread(codex_accounts.list_accounts)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)


@router.get("/api/accounts/codex/auto-switch", dependencies=api_auth)
async def codex_auto_switch_status():
    return await asyncio.to_thread(codex_auto_switch.status)


@router.put("/api/accounts/codex/auto-switch", dependencies=api_auth)
async def codex_auto_switch_save(body: AutoSwitchRequest):
    logger.info("Codex 자동 전환 설정 · %s", body.enabled)
    return await asyncio.to_thread(codex_auto_switch.set_enabled, body.enabled)


@router.post("/api/accounts/codex/switch", dependencies=api_auth)
async def codex_switch(body: SwitchRequest):
    try:
        result = await asyncio.to_thread(codex_accounts.switch, body.id)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex 계정 전환 · changed=%s", result["changed"])
    result["limits"] = await asyncio.to_thread(AIUsageService.limits)
    return result


@router.post("/api/accounts/codex/apply", dependencies=api_auth)
async def codex_apply():
    """지금 로그인을 모든 Codex 창에 적용: 창 끄기 → codex update → 데몬 재시작 → 같은 대화로 다시 켜기.

    작업 중인 Codex 창이 있으면 모두 끝난 뒤 자동으로 한다 (백그라운드). 진행은 GET 으로 확인한다.
    """
    try:
        result = await asyncio.to_thread(codex_accounts.apply_to_sessions)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex 계정 적용 예약 · 상태 %s", result["state"])
    return result


@router.get("/api/accounts/codex/apply", dependencies=api_auth)
async def codex_apply_status():
    return codex_accounts.apply_status()


@router.delete("/api/accounts/codex/{account_id}", dependencies=api_auth)
async def codex_remove(account_id: str):
    try:
        await asyncio.to_thread(codex_accounts.remove, account_id)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    return {"ok": True}


@router.post("/api/accounts/codex/login", dependencies=api_auth)
async def codex_login_start():
    try:
        result = await asyncio.to_thread(codex_accounts.start_login)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex 계정 추가 로그인 시작")
    return result


@router.get("/api/accounts/codex/login/{login_id}", dependencies=api_auth)
async def codex_login_status(login_id: str):
    try:
        return codex_accounts.login_status(login_id)
    except KeyError as error:
        _raise(error)


@router.delete("/api/accounts/codex/login/{login_id}", dependencies=api_auth)
async def codex_login_cancel(login_id: str):
    codex_accounts.cancel_login(login_id)
    return {"ok": True}


# ── Claude Code 다시 로그인 ──


class ClaudeCodeRequest(BaseModel):
    code: str = Field(pattern=claude_login.CODE_PATTERN)


def _claude_error(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail="로그인 요청을 찾지 못했어요."
        ) from error
    if isinstance(error, claude_login.LoginError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning("Claude 로그인 처리 실패: %s", type(error).__name__)
    raise HTTPException(
        status_code=500, detail="로그인을 진행하지 못했어요."
    ) from error


@router.post("/api/accounts/claude/login", dependencies=api_auth)
async def claude_login_start():
    try:
        result = await asyncio.to_thread(claude_login.start_login)
    except (OSError, claude_login.LoginError) as error:
        _claude_error(error)
    logger.info("Claude 다시 로그인 시작")
    return result


# ── Claude Code 계정 여러 개 ──


@router.get("/api/accounts/claude", dependencies=api_auth)
async def claude_list():
    try:
        return await asyncio.to_thread(claude_accounts.list_accounts)
    except (OSError, ValueError) as error:
        _raise(error)


@router.post("/api/accounts/claude/switch", dependencies=api_auth)
async def claude_switch(body: SwitchRequest):
    try:
        result = await asyncio.to_thread(claude_accounts.switch, body.id)
    except (KeyError, OSError, ValueError, claude_accounts.AccountError) as error:
        _raise(error)
    return result


@router.delete("/api/accounts/claude/{account_id}", dependencies=api_auth)
async def claude_remove(account_id: str):
    try:
        await asyncio.to_thread(claude_accounts.remove, account_id)
    except (KeyError, OSError, claude_accounts.AccountError) as error:
        _raise(error)
    return {"ok": True}


@router.post("/api/accounts/claude/add", dependencies=api_auth)
async def claude_add_start():
    try:
        result = await asyncio.to_thread(claude_login.start_login, True)
    except (OSError, claude_login.LoginError) as error:
        _claude_error(error)
    logger.info("Claude 계정 추가 로그인 시작")
    return result


@router.get("/api/accounts/claude/login/{login_id}", dependencies=api_auth)
async def claude_login_status(login_id: str):
    try:
        return claude_login.status(login_id)
    except KeyError as error:
        _claude_error(error)


@router.post("/api/accounts/claude/login/{login_id}/code", dependencies=api_auth)
async def claude_login_code(login_id: str, body: ClaudeCodeRequest):
    try:
        return await asyncio.to_thread(claude_login.submit_code, login_id, body.code)
    except (KeyError, OSError, claude_login.LoginError) as error:
        _claude_error(error)


@router.delete("/api/accounts/claude/login/{login_id}", dependencies=api_auth)
async def claude_login_cancel(login_id: str):
    claude_login.cancel(login_id)
    return {"ok": True}
