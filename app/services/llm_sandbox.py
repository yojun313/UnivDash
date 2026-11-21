"""LLM API 격리 실행: Claude · Codex CLI 를 요청마다 '나갈 수 없는' Docker 컨테이너 안에서만 돌린다.

컨테이너가 볼 수 있는 것
- 파일: 기본 이미지(ubuntu) + CLI 실행 파일 하나(읽기 전용) + 공개 CA 인증서(읽기 전용) + 빈 메모리 폴더(/work · /tmp).
  서버의 홈 폴더 · 프로젝트 · 대시보드 데이터 · SSH 키 · tmux/docker 소켓은 아예 붙이지 않는다 → 볼 수도 쓸 수도 없다.
- 프로세스: 자기 것만 (PID 네임스페이스). 서버의 tmux · 다른 프로세스에 신호를 보낼 수 없다.
- 네트워크: 없음 (--network none · 인터페이스는 loopback 뿐). 바깥으로 나가는 길은 대시보드가 여는 프록시 소켓 하나이고,
  이 프록시는 AI 서비스 주소(api.anthropic.com · chatgpt.com · api.openai.com)의 443 포트로 가는 연결만 이어 준다.
  서버의 다른 포트 · 내부망 · 그 밖의 인터넷으로는 갈 수 없다.
- 권한: root 아님(65534) · capability 전부 제거 · no-new-privileges · 루트 파일시스템 읽기 전용 · 메모리 폴더는 noexec ·
  프로세스 수 · 메모리 · CPU 제한 · Docker 기본 seccomp/AppArmor. 요청이 끝나면 컨테이너는 사라진다 (--rm).
- 로그인: 오래 쓰는 값은 넣지 않는다. Claude 는 접근 토큰(몇 시간짜리)을 환경 변수로, Codex 는 갱신 토큰을 뺀 로그인 사본만.
  컨테이너 안에서는 토큰을 갱신할 수 없으므로 서버의 로그인이 바뀌거나 풀릴 일이 없다.

Docker 를 쓸 수 없거나 이미지가 없으면 실행하지 않는다 (격리 없이 돌리는 대체 경로는 없다).
"""

import asyncio
import logging
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from app.paths import data_dir

logger = logging.getLogger(__name__)

IMAGE = os.getenv("UNIVDASH_LLM_IMAGE", "ubuntu:latest")
LABEL = "univdash-llm"
PROXY_PORT = 3128
ALLOWED_HOSTS = frozenset({"api.anthropic.com", "chatgpt.com", "api.openai.com"})
MAX_TUNNELS = 64
CONTAINER_UID = "65534:65534"

# 컨테이너 안에서 도는 작은 중계기: 127.0.0.1:PORT 로 온 연결을 바깥 프록시의 유닉스 소켓으로 그대로 넘기고,
# 뒤에 적힌 명령(CLI)을 실행한다. 환경 변수로 받은 파일 하나(UD_FILE · UD_FILE_DATA)를 먼저 메모리 폴더에 쓴다.
# 기본 이미지에 있는 perl 만 쓴다.
SHIM = r"""#!/usr/bin/perl
use strict; use warnings;
use IO::Socket::INET; use IO::Socket::UNIX; use IO::Select; use POSIX ();
my ($sock, $port, @cmd) = @ARGV;
# 넘겨받은 파일 하나(로그인 사본)를 메모리 폴더에 쓴다 → 서버 디스크에는 남지 않는다
if (defined $ENV{UD_FILE} && defined $ENV{UD_FILE_DATA}) {
    my $path = $ENV{UD_FILE}; (my $dir = $path) =~ s{/[^/]+$}{};
    umask 077; mkdir $dir unless -d $dir;
    open(my $fh, '>', $path) or die "write: $!"; print $fh $ENV{UD_FILE_DATA}; close $fh;
    delete $ENV{UD_FILE}; delete $ENV{UD_FILE_DATA};
}
my $listen = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $port, Listen => 64, ReuseAddr => 1) or die "listen: $!";
$SIG{CHLD} = 'IGNORE';
my $pid = fork();
die "fork: $!" unless defined $pid;
if ($pid) { close $listen; exec { $cmd[0] } @cmd or die "exec: $!"; }
close STDIN; close STDOUT;
while (my $client = $listen->accept) {
    my $child = fork();
    if (defined $child && $child == 0) {
        close $listen;
        my $up = IO::Socket::UNIX->new(Peer => $sock) or POSIX::_exit(1);
        my $sel = IO::Select->new($client, $up);
        my %peer = (fileno($client) => $up, fileno($up) => $client);
        while (my @ready = $sel->can_read) {
            for my $fh (@ready) {
                my $n = sysread($fh, my $buf, 65536);
                POSIX::_exit(0) unless $n;
                my $out = $peer{fileno($fh)}; my $off = 0;
                while ($off < $n) { my $w = syswrite($out, $buf, $n - $off, $off); POSIX::_exit(0) unless defined $w; $off += $w; }
            }
        }
        POSIX::_exit(0);
    }
    close $client;
}
"""

_server: asyncio.AbstractServer | None = None
_tunnels = 0
_ready_cache: tuple[float, str | None] = (0.0, "unchecked")


def _root() -> Path:
    path = data_dir() / "llm-api"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)  # 이 아래는 서버의 다른 사용자가 들어올 수 없다
    return path


def _proxy_dir() -> Path:
    path = _root() / "proxy"
    path.mkdir(exist_ok=True)
    os.chmod(path, 0o755)
    return path


def _shim_path() -> Path:
    path = _root() / "shim.pl"
    try:
        if path.read_text(encoding="utf-8") == SHIM:
            return path
    except OSError:
        pass
    path.write_text(SHIM, encoding="utf-8")
    os.chmod(path, 0o644)
    return path


def docker_bin() -> str | None:
    return shutil.which("docker")


def problem() -> str | None:
    """격리 실행을 할 수 없는 이유 (할 수 있으면 None). 30초 캐시."""
    global _ready_cache
    now = time.monotonic()
    if now - _ready_cache[0] < 30 and _ready_cache[1] != "unchecked":
        return _ready_cache[1]
    docker = docker_bin()
    reason = None
    if not docker:
        reason = "Docker 가 설치되어 있지 않아요."
    else:
        try:
            done = subprocess.run(
                [docker, "image", "inspect", "--format", "{{.Id}}", IMAGE],
                capture_output=True,
                timeout=10,
                check=False,
            )
            if done.returncode != 0:
                detail = done.stderr.decode("utf-8", "replace").lower()
                reason = (
                    f"격리용 이미지({IMAGE})가 없어요. 서버에서 docker pull {IMAGE} 를 한 번 해 주세요."
                    if "no such image" in detail
                    else "Docker 를 쓸 수 없어요 (데몬이 꺼져 있거나 권한이 없어요)."
                )
        except (OSError, subprocess.TimeoutExpired):
            reason = "Docker 가 응답하지 않아요."
    _ready_cache = (now, reason)
    return reason


# ── 바깥으로 나가는 하나뿐인 길: 허용 목록 프록시 ────────────────────────────────
async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """HTTP CONNECT 만 받는다. 허용한 호스트의 443 포트가 아니면 403."""
    global _tunnels
    upstream = None
    counted = False
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        parts = head.split(b"\r\n", 1)[0].decode("latin-1").split(" ")
        host, _, port = (parts[1] if len(parts) == 3 else "").rpartition(":")
        host = host.lower().strip("[]")
        allowed = (
            len(parts) == 3
            and parts[0] == "CONNECT"
            and port == "443"
            and host in ALLOWED_HOSTS
            and _tunnels < MAX_TUNNELS
        )
        if not allowed:
            if host and host not in ALLOWED_HOSTS:
                logger.debug(
                    "LLM 격리 프록시: 허용하지 않은 주소 거절 · %s", host[:100]
                )
            writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            await writer.drain()
            return
        _tunnels += 1
        counted = True
        up_reader, upstream = await asyncio.wait_for(
            asyncio.open_connection(host, 443), timeout=15
        )
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(_pipe(reader, upstream), _pipe(up_reader, writer))
    except (
        OSError,
        TimeoutError,
        asyncio.IncompleteReadError,
        asyncio.LimitOverrunError,
        ValueError,
    ):
        pass
    finally:
        if counted:
            _tunnels -= 1
        for stream in (writer, upstream):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass


async def ensure_proxy() -> Path:
    """프록시 소켓을 연다 (이미 열려 있으면 그대로). 소켓이 든 폴더를 돌려준다."""
    global _server
    folder = _proxy_dir()
    sock = folder / "proxy.sock"
    if _server is not None and _server.is_serving() and sock.exists():
        return folder
    if _server is not None:
        _server.close()
    sock.unlink(missing_ok=True)
    _server = await asyncio.start_unix_server(_handle, path=str(sock), limit=16384)
    os.chmod(
        sock, 0o666
    )  # 컨테이너 안의 사용자(65534)가 붙을 수 있게. 바깥에서는 위 폴더(700)가 막는다.
    return folder


# ── 컨테이너 ──────────────────────────────────────────────────────────────────
def new_name() -> str:
    return f"{LABEL}-{secrets.token_hex(8)}"


def run_argv(
    name: str,
    proxy_folder: Path,
    binary: str,
    command: list[str],
    *,
    timeout: float,
    env: dict[str, str] | None = None,
    pass_env: tuple[str, ...] = (),
) -> list[str]:
    """docker run 명령. binary 는 컨테이너 안 /usr/local/bin/<이름> 으로 읽기 전용으로 붙는다.

    pass_env 의 값은 명령줄에 적지 않고 docker 클라이언트의 환경에서 넘긴다 (ps 에 토큰이 보이지 않게).
    """
    docker = docker_bin()
    if not docker:
        raise RuntimeError("docker not found")
    real = os.path.realpath(binary)
    inside = f"/usr/local/bin/{command[0]}"
    proxy = f"http://127.0.0.1:{PROXY_PORT}"
    argv = [
        docker,
        "run",
        "--rm",
        "-i",
        "--pull",
        "never",
        "--name",
        name,
        "--label",
        LABEL,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "--cpus",
        "2",
        "--user",
        CONTAINER_UID,
        "--log-driver",
        "none",
        "--tmpfs",
        "/work:rw,nosuid,nodev,noexec,size=64m,mode=1777",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
        "-v",
        f"{proxy_folder}:/px:ro",
        "-v",
        f"{_shim_path()}:/shim.pl:ro",
        "-v",
        "/etc/ssl/certs:/etc/ssl/certs:ro",
        "-v",
        f"{real}:{inside}:ro",
        "-w",
        "/work",
    ]
    fixed = {
        "HOME": "/work",
        "HTTPS_PROXY": proxy,
        "HTTP_PROXY": proxy,
        "ALL_PROXY": proxy,
        "NO_COLOR": "1",
        "TERM": "dumb",
        **(env or {}),
    }
    for key, value in fixed.items():
        argv += ["-e", f"{key}={value}"]
    for key in pass_env:
        argv += ["-e", key]
    # 대시보드가 죽어도 컨테이너가 남지 않게 안에서도 시간 제한을 건다
    argv += [
        IMAGE,
        "perl",
        "/shim.pl",
        "/px/proxy.sock",
        str(PROXY_PORT),
        "timeout",
        "-k",
        "5",
        str(int(timeout) + 30),
        *command,
    ]
    return argv


def client_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """docker 클라이언트에 넘길 환경 (대시보드 비밀값은 넣지 않는다)."""
    env = {
        k: os.environ[k]
        for k in ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
        if os.environ.get(k)
    }
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.update(extra or {})
    return env


def kill(name: str) -> None:
    """컨테이너를 바로 없앤다 (기다리지 않는다). docker 클라이언트만 죽이면 컨테이너는 계속 돌기 때문."""
    docker = docker_bin()
    if not docker:
        return
    try:
        subprocess.Popen(
            [docker, "kill", name],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=client_env(),
            start_new_session=True,
        )
    except OSError:
        logger.warning("LLM 격리: 컨테이너 %s 를 끝내지 못함", name)
