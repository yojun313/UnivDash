"""웹 푸시 구독 API (로그인 필요, 교차 출처 요청은 보안 미들웨어가 막는다) + 서비스 워커 스크립트."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.services import push_service
from app.services.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
SW_PATH = Path(__file__).resolve().parents[1] / "static" / "sw.js"


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
    # 서비스 워커는 범위(/) 때문에 루트에서 내려준다. 비밀 정보가 없는 정적 스크립트다.
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
        raise HTTPException(status_code=400, detail="잘못된 기기 ID 입니다.")
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
        raise HTTPException(status_code=400, detail="잘못된 기기 ID 입니다.")
    await asyncio.to_thread(push_service.unsubscribe, body.device)
    return {"ok": True}


@router.post("/api/push/test", dependencies=api_auth)
async def push_test(body: Device):
    if not push_service.DEVICE_RE.match(body.device):
        raise HTTPException(status_code=400, detail="잘못된 기기 ID 입니다.")
    results = await push_service.send(
        {
            "title": "UnivDash 테스트 알림",
            "body": "에이전트 작업이 끝나면 이렇게 알려 드려요.",
            "tag": "univdash-test",
            "url": "/",
        },
        devices={body.device},
        skip_focused=False,
    )
    if not results:
        raise HTTPException(status_code=404, detail="이 기기는 아직 구독되지 않았어요.")
    if not any(200 <= code < 300 for code in results):
        raise HTTPException(
            status_code=502,
            detail=f"푸시 서비스가 거절했어요 ({results[0] or '연결 실패'}).",
        )
    return {"ok": True}
