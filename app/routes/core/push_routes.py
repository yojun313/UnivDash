"""Web push subscription API (sign-in required; the security middleware blocks cross-origin requests) + the service worker script."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.i18n import _
from app.services.core import push_service
from app.services.core.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
SW_PATH = Path(__file__).resolve().parents[2] / "static" / "sw.js"


class PushKeys(BaseModel):
    model_config = ConfigDict(extra="ignore")
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class Subscribe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device: str = Field(min_length=8, max_length=64)
    endpoint: str = Field(max_length=1024)
    keys: PushKeys
    label: str = Field(default="", max_length=80)


class Device(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device: str = Field(min_length=8, max_length=64)


@router.get("/sw.js", include_in_schema=False)
async def service_worker():
    # the service worker is served from the root because of its scope (/). It is a static script with no secrets.
    return FileResponse(
        SW_PATH,
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


@router.get("/api/push/key", dependencies=api_auth)
async def push_key():
    return {"key": await asyncio.to_thread(push_service.public_key)}


@router.get("/api/push/status", dependencies=api_auth)
async def push_status(device: str):
    if not push_service.DEVICE_RE.match(device):
        raise HTTPException(status_code=400, detail=_("잘못된 기기 ID 입니다."))
    return {"subscribed": await asyncio.to_thread(push_service.is_subscribed, device)}


@router.post("/api/push/subscribe", dependencies=api_auth)
async def push_subscribe(body: Subscribe, request: Request):
    origin = request.headers.get("origin", "")
    try:
        await asyncio.to_thread(
            push_service.subscribe,
            body.device,
            body.endpoint,
            body.keys.p256dh,
            body.keys.auth,
            origin,
            body.label,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    return {"ok": True}


@router.post("/api/push/unsubscribe", dependencies=api_auth)
async def push_unsubscribe(body: Device):
    if not push_service.DEVICE_RE.match(body.device):
        raise HTTPException(status_code=400, detail=_("잘못된 기기 ID 입니다."))
    await asyncio.to_thread(push_service.unsubscribe, body.device)
    return {"ok": True}


@router.post("/api/push/test", dependencies=api_auth)
async def push_test(body: Device):
    if not push_service.DEVICE_RE.match(body.device):
        raise HTTPException(status_code=400, detail=_("잘못된 기기 ID 입니다."))
    results = await push_service.send(
        {
            "title": _("UnivDash 테스트 알림"),
            "body": _("에이전트 작업이 끝나면 이렇게 알려 드립니다."),
            "tag": "univdash-test",
            "url": "/",
        },
        devices={body.device},
        skip_focused=False,
    )
    if not results:
        raise HTTPException(
            status_code=404, detail=_("이 기기는 아직 구독되지 않았습니다.")
        )
    if not any(200 <= code < 300 for code in results):
        raise HTTPException(
            status_code=502,
            detail=_("푸시 서비스가 거절했습니다 ({code}).", code=results[0])
            if results[0]
            else _("푸시 서비스가 거절했습니다 (연결 실패)."),
        )
    return {"ok": True}
