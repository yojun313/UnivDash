"""Agent account management API (Codex · Claude Code · Gemini): list · switch · delete · add by signing in.

Tokens never leave the server — responses carry only the email, plan and state.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.i18n import _
from app.services.accounts import (
    claude_accounts,
    claude_login,
    codex_accounts,
    codex_auto_switch,
    gemini_accounts,
)
from app.services.accounts.ai_usage_service import AIUsageService
from app.services.core.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


def _raise(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else _("없음"))
        ) from error
    if isinstance(
        error,
        (
            codex_accounts.AccountError,
            claude_accounts.AccountError,
            gemini_accounts.AccountError,
        ),
    ):
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning("Account operation failed: %s", error)
    raise HTTPException(
        status_code=500, detail=_("계정 정보를 처리하지 못했습니다.")
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
    logger.info("Codex auto-switch setting · %s", body.enabled)
    return await asyncio.to_thread(codex_auto_switch.set_enabled, body.enabled)


@router.post("/api/accounts/codex/switch", dependencies=api_auth)
async def codex_switch(body: SwitchRequest):
    try:
        result = await asyncio.to_thread(codex_accounts.switch, body.id)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex account switched · changed=%s", result["changed"])
    result["limits"] = await asyncio.to_thread(AIUsageService.limits)
    return result


@router.post("/api/accounts/codex/apply", dependencies=api_auth)
async def codex_apply():
    """Apply the current login to every Codex window: stop the windows → codex update → restart the daemon → restart on the same conversation.

    If any Codex window is working, it runs automatically after they all finish (in the background). Progress is read with GET.
    """
    try:
        result = await asyncio.to_thread(codex_accounts.apply_to_sessions)
    except (KeyError, OSError, codex_accounts.AccountError) as error:
        _raise(error)
    logger.info("Codex account apply scheduled · state %s", result["state"])
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
    logger.info("Codex add-account login started")
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


# ── Claude Code: sign in again ──


class ClaudeCodeRequest(BaseModel):
    code: str = Field(pattern=claude_login.CODE_PATTERN)


def _claude_error(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=_("로그인 요청을 찾지 못했습니다.")
        ) from error
    if isinstance(error, claude_login.LoginError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    logger.warning("Claude login failed: %s", type(error).__name__)
    raise HTTPException(
        status_code=500, detail=_("로그인을 진행하지 못했습니다.")
    ) from error


@router.post("/api/accounts/claude/login", dependencies=api_auth)
async def claude_login_start():
    try:
        result = await asyncio.to_thread(claude_login.start_login)
    except (OSError, claude_login.LoginError) as error:
        _claude_error(error)
    logger.info("Claude re-login started")
    return result


# ── Claude Code: multiple accounts ──


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
    logger.info("Claude add-account login started")
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


# ── Gemini (Antigravity CLI): multiple accounts ──


@router.get("/api/accounts/gemini", dependencies=api_auth)
async def gemini_list():
    try:
        return await asyncio.to_thread(gemini_accounts.list_accounts)
    except (OSError, ValueError) as error:
        _raise(error)


@router.post("/api/accounts/gemini/switch", dependencies=api_auth)
async def gemini_switch(body: SwitchRequest):
    try:
        result = await asyncio.to_thread(gemini_accounts.switch, body.id)
    except (KeyError, OSError, ValueError, gemini_accounts.AccountError) as error:
        _raise(error)
    logger.info("Gemini account switched · changed=%s", result.get("changed"))
    return result


@router.delete("/api/accounts/gemini/{account_id}", dependencies=api_auth)
async def gemini_remove(account_id: str):
    try:
        await asyncio.to_thread(gemini_accounts.remove, account_id)
    except (KeyError, OSError, gemini_accounts.AccountError) as error:
        _raise(error)
    return {"ok": True}


@router.post("/api/accounts/gemini/add", dependencies=api_auth)
async def gemini_add_start():
    try:
        result = await asyncio.to_thread(gemini_accounts.start_login)
    except (OSError, gemini_accounts.AccountError) as error:
        _raise(error)
    logger.info("Gemini add-account login started")
    return result


@router.get("/api/accounts/gemini/login/{login_id}", dependencies=api_auth)
async def gemini_login_status(login_id: str):
    try:
        return gemini_accounts.login_status(login_id)
    except KeyError as error:
        _raise(error)


@router.post("/api/accounts/gemini/login/{login_id}/code", dependencies=api_auth)
async def gemini_login_code(login_id: str, body: ClaudeCodeRequest):
    try:
        return await asyncio.to_thread(gemini_accounts.submit_code, login_id, body.code)
    except (KeyError, OSError, gemini_accounts.AccountError) as error:
        _raise(error)


@router.delete("/api/accounts/gemini/login/{login_id}", dependencies=api_auth)
async def gemini_login_cancel(login_id: str):
    gemini_accounts.cancel_login(login_id)
    return {"ok": True}


# ── Sign out: removes the current login and the saved data of that account ──


@router.post("/api/accounts/{provider}/logout", dependencies=api_auth)
async def account_logout(provider: str):
    module = {
        "claude": claude_accounts,
        "codex": codex_accounts,
        "gemini": gemini_accounts,
    }.get(provider)
    if module is None:
        raise HTTPException(status_code=404, detail=_("없는 제공자입니다."))
    try:
        result = await asyncio.to_thread(module.logout)
    except (KeyError, OSError, ValueError, module.AccountError) as error:
        _raise(error)
    logger.info("%s account signed out · saved data deleted", provider)
    return {"ok": True, **result}
