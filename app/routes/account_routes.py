"""에이전트 계정 관리 API (지금은 Codex): 목록 · 전환 · 삭제 · 기기 인증 로그인으로 추가.

토큰은 서버 밖으로 내보내지 않는다 — 응답에는 메일 · 요금제 · 상태만.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import codex_accounts
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
    if isinstance(error, codex_accounts.AccountError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning("계정 처리 실패: %s", error)
    raise HTTPException(
        status_code=500, detail="계정 정보를 처리하지 못했습니다."
    ) from error


class SwitchRequest(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{12}$")


@router.get("/api/accounts/codex", dependencies=api_auth)
async def codex_list():
    try:
        return await asyncio.to_thread(codex_accounts.list_accounts)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)


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
    """지금 로그인을 모든 Codex 창에 적용 (창 끄기 → 데몬 재시작 → 같은 대화로 다시 켜기)."""
    try:
        result = await asyncio.to_thread(codex_accounts.apply_to_sessions)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex 계정 적용 · 다시 켠 창 %d개", len(result["relaunched"]))
    return result


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
