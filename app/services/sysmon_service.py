"""사이드바 서버 상태: CPU · 메모리 · GPU(nvidia-smi) · 디스크 사용량을 한 번에 모은다.

- 여러 화면이 동시에 물어봐도 0.8초 안의 요청은 마지막 결과를 그대로 준다 (nvidia-smi 를 매번 띄우지 않게).
- GPU 가 없거나 nvidia-smi 가 없으면 gpus 는 빈 목록. 디스크는 실제 장치에 붙은 곳만 (snap · boot 등 제외).
"""

import asyncio
import shutil
import time

import psutil

CACHE_SECONDS = 0.8
NVIDIA_TIMEOUT = 4
MAX_DISKS = 4
SKIP_MOUNTS = ("/snap", "/boot", "/var/lib/docker", "/run", "/dev", "/sys", "/proc")
GPU_FIELDS = (
    "index",
    "name",
    "utilization.gpu",
    "memory.total",
    "memory.used",
    "temperature.gpu",
    "power.draw",
    "power.limit",
)

_lock = asyncio.Lock()
_cache: tuple[float, dict] | None = None
_nvidia = shutil.which("nvidia-smi")
_nvidia_broken_until = 0.0  # 실패하면 잠깐 쉬었다가 다시 시도
_net_last: tuple[float, int, int] | None = None

psutil.cpu_percent()  # 첫 호출은 기준점만 잡으므로 미리 한 번


def _num(value: str):
    value = value.strip()
    if not value or value.startswith("[") or value.lower() in ("n/a", "na"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


async def _gpus() -> list[dict]:
    global _nvidia_broken_until
    if not _nvidia or time.monotonic() < _nvidia_broken_until:
        return []
    try:
        proc = await asyncio.create_subprocess_exec(
            _nvidia,
            f"--query-gpu={','.join(GPU_FIELDS)}",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), NVIDIA_TIMEOUT)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
        if proc.returncode != 0:
            raise RuntimeError("nvidia-smi failed")
    except (TimeoutError, OSError, RuntimeError):
        _nvidia_broken_until = time.monotonic() + 30
        return []
    gpus = []
    for line in out.decode(errors="replace").strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < len(GPU_FIELDS):
            continue
        index, name = parts[0], ",".join(parts[1 : len(parts) - 6]).strip()
        util, total, used, temp, power, limit = (_num(p) for p in parts[-6:])
        gpus.append(
            {
                "index": int(_num(index) or 0),
                "name": name,
                "util": util,  # %
                "mem_total": total * 1024 * 1024
                if total is not None
                else None,  # MiB → B
                "mem_used": used * 1024 * 1024 if used is not None else None,
                "temp": temp,
                "power": power,
                "power_limit": limit,
            }
        )
    return gpus


def _disks() -> list[dict]:
    seen, disks = set(), []
    try:
        parts = psutil.disk_partitions(all=False)
    except OSError:
        parts = []
    for part in parts:
        mount = part.mountpoint
        if part.device in seen or (mount != "/" and mount.startswith(SKIP_MOUNTS)):
            continue
        if part.device.startswith("/dev/loop") or "squashfs" in part.fstype:
            continue
        try:
            usage = psutil.disk_usage(mount)
        except OSError:
            continue
        seen.add(part.device)
        disks.append(
            {
                "mount": mount,
                "total": usage.total,
                "used": usage.used,
                "percent": usage.percent,
            }
        )
    disks.sort(key=lambda d: (d["mount"] != "/", -d["total"]))
    return disks[:MAX_DISKS]


def _host(cpu_temp) -> dict:
    global _net_last
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    try:
        load = [round(x, 2) for x in psutil.getloadavg()]
    except (AttributeError, OSError):
        load = None
    net = psutil.net_io_counters()
    now = time.monotonic()
    rates = None
    if _net_last and now > _net_last[0]:
        span = now - _net_last[0]
        rates = {
            "rx": max(0, (net.bytes_recv - _net_last[1]) / span),
            "tx": max(0, (net.bytes_sent - _net_last[2]) / span),
        }
    _net_last = (now, net.bytes_recv, net.bytes_sent)
    return {
        "cpu": {
            "percent": psutil.cpu_percent(),
            "cores": psutil.cpu_count() or 0,
            "load": load,
            "temp": (cpu_temp() or {}).get("current") if cpu_temp else None,
        },
        "memory": {
            "total": vm.total,
            "used": vm.total - vm.available,
            "percent": vm.percent,
            "swap_total": sw.total,
            "swap_used": sw.used,
        },
        "disks": _disks(),
        "net": rates,
    }


async def snapshot(cpu_temp=None) -> dict:
    global _cache
    async with _lock:
        now = time.monotonic()
        if _cache and now - _cache[0] < CACHE_SECONDS:
            return _cache[1]
        host, gpus = await asyncio.gather(asyncio.to_thread(_host, cpu_temp), _gpus())
        data = {**host, "gpus": gpus, "time": time.time()}
        _cache = (time.monotonic(), data)
        return data
