"""서버 & 프로세스 (PM2Dash 에서 옮겨 온 기능): 서버 자원, PM2 프로세스 제어 · 로그, AI 사용량."""

import asyncio
import logging

import psutil
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services import ecosystem_service
from app.services.ai_usage_service import AIUsageService
from app.services.auth_service import AuthService
from app.services.ecosystem_service import EcosystemError
from app.services.pm2_service import PM2Service

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


@router.get("/server")
async def server_resources_page(request: Request):
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    processes = await asyncio.to_thread(PM2Service.get_process_summaries)
    return render_page(request, "server", processes=processes)


@router.get("/ai-usage")
async def ai_usage_page(request: Request):
    return render_page(request, "ai_usage")


@router.get("/processes")
async def pm2_manager_page(request: Request):
    # PM2Dash 시절 주소 호환
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    return RedirectResponse(url="/server", status_code=303)


async def ensure_process(name: str) -> None:
    """URL 로 받은 이름이 실제 PM2 프로세스인지 확인한다 (옵션 주입/임의 대상 차단)."""
    if not name or name.startswith("-") or len(name) > 200:
        raise HTTPException(status_code=400, detail="Invalid process name")
    if not await asyncio.to_thread(PM2Service.process_exists, name):
        raise HTTPException(status_code=404, detail="Process not found")


@router.post("/control/{action}/{name}", dependencies=api_auth)
async def control_process(action: str, name: str):
    if action not in ["restart", "stop", "start", "delete"]:
        raise HTTPException(status_code=400, detail="Invalid action")
    await ensure_process(name)

    success = await asyncio.to_thread(PM2Service.run_command, action, name)
    if not success:
        raise HTTPException(status_code=500, detail="Command failed")

    return {"status": "success"}


@router.get("/status", dependencies=api_auth)
async def get_pm2_status_api():
    return await asyncio.to_thread(PM2Service.get_process_summaries)


@router.get("/server-stats", dependencies=api_auth)
async def get_server_stats():
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    du = psutil.disk_usage("/")
    net = psutil.net_io_counters()

    return {
        "cpu_percent": psutil.cpu_percent(),
        "cpu_cores": psutil.cpu_percent(percpu=True),
        "cpu_count_logical": psutil.cpu_count(),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "memory_total": vm.total,
        "memory_available": vm.available,
        "memory_used": vm.used,
        "memory_percent": vm.percent,
        "swap_total": sw.total,
        "swap_used": sw.used,
        "swap_percent": sw.percent,
        "disk_total": du.total,
        "disk_used": du.used,
        "disk_free": du.free,
        "disk_percent": du.percent,
        "net_bytes_sent": net.bytes_sent,
        "net_bytes_recv": net.bytes_recv,
    }


@router.get("/api/ai-usage", dependencies=api_auth)
async def get_ai_usage(days: int = 7):
    return await asyncio.to_thread(AIUsageService.get_usage, days)


@router.websocket("/ws/logs/{name}")
async def process_logs_websocket(websocket: WebSocket, name: str):
    # Origin 검사는 SecurityMiddleware 가, 로그인 검사는 여기서 한다.
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    if name.startswith("-") or not await asyncio.to_thread(
        PM2Service.process_exists, name
    ):
        await websocket.send_text("Error: Process not found.")
        await websocket.close(code=1008)
        return

    process = await asyncio.create_subprocess_exec(
        "pm2",
        "logs",
        name,
        "--lines",
        "50",
        "--raw",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=ecosystem_service.child_env(),
    )

    loop = asyncio.get_running_loop()
    next_auth = loop.time() + 10
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            if loop.time() >= next_auth:
                if not AuthService.current_user(websocket):
                    await websocket.close(code=1008)
                    break
                next_auth = loop.time() + 10

            await websocket.send_text(line.decode().strip())

    except WebSocketDisconnect:
        if process.returncode is None:
            process.terminate()
    except Exception as e:
        logger.exception("프로세스 로그 스트리밍 오류 · process=%s · error=%s", name, e)
    finally:
        if process.returncode is None:
            process.terminate()
            await process.wait()


@router.post("/toggle-watch/{name}", dependencies=api_auth)
async def toggle_watch(name: str):
    if not name or name.startswith("-"):
        raise HTTPException(status_code=400, detail="Invalid process name")

    processes = await asyncio.to_thread(PM2Service.get_processes)
    target_proc = next((p for p in processes if p["name"] == name), None)

    if not target_proc:
        raise HTTPException(status_code=404, detail="Process not found")

    current_watch = target_proc.get("pm2_env", {}).get("watch", False)

    new_flag = ["--watch", "false"] if current_watch else ["--watch"]

    new_flag.append("--update-env")

    success = await asyncio.to_thread(PM2Service.run_command, "restart", name, new_flag)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to toggle watch mode")

    return {"status": "success", "watch": not current_watch}


@router.get("/startup-status", dependencies=api_auth)
async def get_startup_status():
    status = await asyncio.to_thread(PM2Service.get_startup_status)
    return {"is_registered": status}


@router.post("/save", dependencies=api_auth)
async def save_pm2_list():
    success = await asyncio.to_thread(PM2Service.save_processes)
    if not success:
        raise HTTPException(status_code=500, detail="Save failed")
    return {"status": "success"}


# ── ecosystem.config.js ─────────────────────────────────────────────────────


class EcosystemAppRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    cwd: str = Field(min_length=1, max_length=1024)
    script: str = Field(min_length=1, max_length=500)
    interpreter: str = Field(default="", max_length=500)
    args: str = Field(default="", max_length=500)
    watch: bool = False
    time: bool = True
    env: str = Field(default="", max_length=20000)
    start: bool = True


def _ecosystem_error(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(status_code=404, detail=str(error.args[0] if error.args else error)) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/api/ecosystem", dependencies=api_auth)
async def get_ecosystem():
    path = ecosystem_service.ecosystem_path()
    try:
        apps = await asyncio.to_thread(ecosystem_service.load_apps, path)
    except EcosystemError as error:
        return {"path": str(path), "exists": path.exists(), "error": str(error), "apps": []}
    running = {proc["name"]: proc["pm2_env"]["status"] for proc in await asyncio.to_thread(PM2Service.get_process_summaries)}
    for app in apps:
        app["status"] = running.get(app.get("name"))
    return {"path": str(path), "exists": path.exists(), "apps": apps}


@router.get("/api/ecosystem/inspect", dependencies=api_auth)
async def inspect_ecosystem_directory(cwd: str = Query(..., max_length=1024)):
    return await asyncio.to_thread(ecosystem_service.inspect_directory, cwd)


@router.post("/api/ecosystem/apps", dependencies=api_auth)
async def add_ecosystem_app(body: EcosystemAppRequest):
    try:
        result = await asyncio.to_thread(ecosystem_service.add_app, body.model_dump())
    except (ValueError, KeyError, EcosystemError, OSError) as error:
        _ecosystem_error(error)
    logger.info("ecosystem 앱 추가 · %s", body.name)
    result["started"] = None
    if body.start:
        try:
            ok, output = await asyncio.to_thread(ecosystem_service.start_app, body.name)
        except (ValueError, KeyError, EcosystemError) as error:
            ok, output = False, str(error)
        result.update(started=ok, output=output)
    return result


@router.post("/api/ecosystem/apps/{name}/start", dependencies=api_auth)
async def start_ecosystem_app(name: str):
    try:
        ok, output = await asyncio.to_thread(ecosystem_service.start_app, name)
    except (ValueError, KeyError, EcosystemError) as error:
        _ecosystem_error(error)
    if not ok:
        raise HTTPException(status_code=500, detail=output or "pm2 start 가 실패했습니다.")
    return {"started": True, "output": output}
