"""LLM API 격리 실행: Claude · Codex CLI 를 '나갈 수 없는' Docker 컨테이너 안에서만 돌린다.

API 서버가 켜져 있는 동안 컨테이너 하나(univdash-llm)를 계속 띄워 두고, 요청은 그 안에서 실행한다 (docker exec).
계정마다 사용자 번호 · 폴더(700)가 달라 다른 계정의 요청끼리 서로의 토큰 · 파일을 볼 수 없다.

컨테이너가 볼 수 있는 것
- 파일: 기본 이미지(ubuntu) + CLI 실행 파일 하나(읽기 전용) + 공개 CA 인증서(읽기 전용) + 빈 메모리 폴더(/work · /tmp).
  서버의 홈 폴더 · 프로젝트 · 대시보드 데이터 · SSH 키 · tmux/docker 소켓은 아예 붙이지 않는다 → 볼 수도 쓸 수도 없다.
- 프로세스: 자기 것만 (PID 네임스페이스). 서버의 tmux · 다른 프로세스에 신호를 보낼 수 없다.
- 네트워크: 없음 (--network none · 인터페이스는 loopback 뿐). 바깥으로 나가는 길은 대시보드가 여는 프록시 소켓 하나이고,
  이 프록시는 AI 서비스 주소(api.anthropic.com · chatgpt.com · api.openai.com)의 443 포트로 가는 연결만 이어 준다.
  서버의 다른 포트 · 내부망 · 그 밖의 인터넷으로는 갈 수 없다.
- 권한: root 아님(65534) · capability 전부 제거 · no-new-privileges · 루트 파일시스템 읽기 전용 · 메모리 폴더는 noexec ·
  프로세스 수 · 메모리 · CPU 제한 · Docker 기본 seccomp/AppArmor. 안의 파일은 메모리에만 있어 컨테이너를 내리면 사라진다.
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
ALLOWED_HOSTS = frozenset(
    {
        "api.anthropic.com",
        "chatgpt.com",
        "api.openai.com",
        # Gemini (Antigravity CLI) 의 모델 API. 로그인 갱신 주소(oauth2.googleapis.com)는 열지 않는다
        "daily-cloudcode-pa.googleapis.com",
        "cloudcode-pa.googleapis.com",
        # Antigravity CLI 가 시작할 때 계정 확인(oauth2/v2/userinfo)을 여기로 한다 — 막으면 실행되지 않는다
        "www.googleapis.com",
    }
)
MAX_TUNNELS = 64
CONTAINER_UID = "65534:65534"

# 컨테이너 안에서 도는 작은 중계기: 127.0.0.1:PORT 로 온 연결을 바깥 프록시의 유닉스 소켓으로 그대로 넘기고,
# 뒤에 적힌 명령을 실행한다.
# 기본 이미지에 있는 perl 만 쓴다.
SHIM = r"""#!/usr/bin/perl
use strict; use warnings;
use IO::Socket::INET; use IO::Socket::UNIX; use IO::Select; use POSIX ();
my ($sock, $port, @cmd) = @ARGV;
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
        reason = "Docker 가 설치되어 있지 않습니다."
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
                    f"격리용 이미지({IMAGE})가 없습니다. 서버에서 docker pull {IMAGE} 를 한 번 실행해 주십시오."
                    if "no such image" in detail
                    else "Docker 를 쓸 수 없습니다 (데몬이 꺼져 있거나 권한이 없습니다)."
                )
        except (OSError, subprocess.TimeoutExpired):
            reason = "Docker 가 응답하지 않습니다."
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


# ── 컨테이너: API 서버가 켜져 있는 동안 하나를 계속 띄워 두고, 요청은 그 안에서 실행한다 ─────────
CONTAINER = "univdash-llm"
SPEC_LABEL = "univdash-llm.spec"
WORK_SIZE = "512m"
_container_lock: asyncio.Lock | None = None
_container_ok: tuple[float, str] = (0.0, "")  # (확인한 시각, 그때의 spec)

# 컨테이너 안에서 요청 하나를 실행하는 껍데기 (sh). 계정마다 폴더 · 사용자 번호가 다르다 → 다른 계정의 요청이
# 서로의 토큰 · 파일을 볼 수 없다 (폴더는 700). 같은 계정의 요청끼리는 폴더를 같이 써서 CLI 가 받아 둔 캐시를
# 다시 쓴다 (매번 처음부터 준비하지 않아 빠르다).
EXEC_SCRIPT = (
    'D=/work/$UD_HOME; umask 077; mkdir -p "$D/cwd" && cd "$D/cwd" || exit 97; '
    'if [ -n "$UD_FILE" ]; then mkdir -p "$(dirname "$D/$UD_FILE")" && printf %s "$UD_FILE_DATA" > "$D/$UD_FILE.new" '
    '&& mv -f "$D/$UD_FILE.new" "$D/$UD_FILE" || exit 98; fi; '
    'unset UD_FILE_DATA; echo $$ > "$D/.pid-$UD_REQ"; '
    'exec timeout -k 5 "$UD_TIMEOUT" "$@"'
)
KILL_SCRIPT = (
    # sh 내장 kill 은 프로세스 묶음(-pid) 지정이 셸마다 달라 perl 로 보낸다
    'f=/work/$UD_HOME/.pid-$UD_REQ; p=$(cat "$f" 2>/dev/null); rm -f "$f"; '
    '[ -n "$p" ] && perl -e \'kill("KILL", -$ARGV[0]); kill("KILL", $ARGV[0])\' "$p"; exit 0'
)


def binaries() -> dict[str, str]:
    """컨테이너에 (읽기 전용으로) 붙일 CLI 실행 파일: {이름: 실제 경로}."""
    from app.paths import find_command

    found = {}
    for name in ("claude", "codex", "agy"):
        path = find_command(name)
        if path:
            found[name] = os.path.realpath(path)
    return found


def _spec(proxy_folder: Path) -> str:
    """컨테이너 구성이 바뀌었는지 알아보는 값 (CLI 가 업데이트되면 실행 파일 경로가 바뀐다 → 다시 띄운다)."""
    import hashlib

    parts = [
        IMAGE,
        str(proxy_folder),
        SHIM,
        EXEC_SCRIPT,
        WORK_SIZE,
        *sorted(f"{k}={v}" for k, v in binaries().items()),
    ]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def _create_argv(proxy_folder: Path, spec: str) -> list[str]:
    proxy = f"http://127.0.0.1:{PROXY_PORT}"
    argv = [
        docker_bin() or "docker",
        "run",
        "-d",
        "--pull",
        "never",
        "--name",
        CONTAINER,
        "--label",
        LABEL,
        "--label",
        f"{SPEC_LABEL}={spec}",
        "--restart",
        "no",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "--cpus",
        "4",
        "--user",
        CONTAINER_UID,
        "--log-driver",
        "none",
        "--tmpfs",
        f"/work:rw,nosuid,nodev,noexec,size={WORK_SIZE},mode=1777",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
        "-v",
        f"{proxy_folder}:/px:ro",
        "-v",
        f"{_shim_path()}:/shim.pl:ro",
        "-v",
        "/etc/ssl/certs:/etc/ssl/certs:ro",
    ]
    for name, path in binaries().items():
        argv += ["-v", f"{path}:/usr/local/bin/{name}:ro"]
    for key, value in {
        "HTTPS_PROXY": proxy,
        "HTTP_PROXY": proxy,
        "ALL_PROXY": proxy,
        "NO_COLOR": "1",
        "TERM": "dumb",
    }.items():
        argv += ["-e", f"{key}={value}"]
    # 주 프로세스: 프록시 중계기를 띄워 두고 잠든다
    argv += [
        IMAGE,
        "perl",
        "/shim.pl",
        "/px/proxy.sock",
        str(PROXY_PORT),
        "sleep",
        "infinity",
    ]
    return argv


async def _docker(*args: str, timeout: float = 30) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        docker_bin() or "docker",
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=client_env(),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        return 124, "timeout"
    return proc.returncode or 0, out.decode("utf-8", "replace").strip()


async def ensure_container() -> None:
    """격리 컨테이너가 (지금 구성으로) 떠 있게 한다. 이미 떠 있으면 아무것도 하지 않는다."""
    global _container_lock, _container_ok
    folder = await ensure_proxy()
    spec = _spec(folder)
    if _container_ok[1] == spec and time.monotonic() - _container_ok[0] < 5:
        return
    if _container_lock is None:
        _container_lock = asyncio.Lock()
    async with _container_lock:
        code, out = await _docker(
            "inspect",
            "-f",
            '{{.State.Running}} {{index .Config.Labels "' + SPEC_LABEL + '"}}',
            CONTAINER,
        )
        if code == 0 and out == f"true {spec}":
            _container_ok = (time.monotonic(), spec)
            return
        if code == 0:  # 멈췄거나 구성이 달라졌다 → 다시 만든다
            await _docker("rm", "-f", CONTAINER)
        code, out = await _docker(*_create_argv(folder, spec)[1:], timeout=60)
        if code != 0:
            _container_ok = (0.0, "")
            logger.error("LLM 격리: 컨테이너를 띄우지 못함 · %s", out[-400:])
            raise RuntimeError("sandbox container failed to start")
        _container_ok = (time.monotonic(), spec)
        logger.info("LLM 격리 컨테이너를 띄움 · %s", CONTAINER)


async def stop_container() -> None:
    global _container_ok
    _container_ok = (0.0, "")
    if not docker_bin():
        return
    code, _ = await _docker("rm", "-f", CONTAINER)
    if code == 0:
        logger.info("LLM 격리 컨테이너를 내림 · %s", CONTAINER)


def container_running() -> bool:
    docker = docker_bin()
    if not docker:
        return False
    try:
        done = subprocess.run(
            [docker, "inspect", "-f", "{{.State.Running}}", CONTAINER],
            capture_output=True,
            timeout=10,
            check=False,
            env=client_env(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0 and done.stdout.strip() == b"true"


def new_request() -> str:
    return secrets.token_hex(8)


def account_home(provider: str, account_id: str) -> tuple[str, str]:
    """(컨테이너 안 폴더 이름, 사용자 번호) — 계정마다 정해진 값."""
    import hashlib

    digest = hashlib.sha256(f"{provider}:{account_id}".encode()).hexdigest()
    uid = 100000 + int(digest[:8], 16) % 60000
    return f"a-{digest[:12]}", f"{uid}:{uid}"


def exec_argv(
    request: str,
    home: str,
    user: str,
    command: list[str],
    *,
    timeout: float,
    env: dict[str, str] | None = None,
    pass_env: tuple[str, ...] = (),
) -> list[str]:
    """떠 있는 컨테이너 안에서 CLI 를 실행하는 명령 (docker exec).

    env 값의 {home} 은 컨테이너 안 계정 폴더(/work/<home>)로 바뀐다.
    pass_env 의 값은 명령줄에 적지 않고 docker 클라이언트의 환경에서 넘긴다 (ps 에 토큰이 보이지 않게).
    """
    base = f"/work/{home}"
    argv = [docker_bin() or "docker", "exec", "-i", "--user", user]
    fixed = {
        "HOME": base,
        "UD_HOME": home,
        "UD_REQ": request,
        "UD_TIMEOUT": str(int(timeout) + 30),  # 대시보드가 죽어도 안에서 스스로 끝난다
        **{k: v.replace("{home}", base) for k, v in (env or {}).items()},
    }
    for key, value in fixed.items():
        argv += ["-e", f"{key}={value}"]
    for key in pass_env:
        argv += ["-e", key]
    return [*argv, CONTAINER, "sh", "-c", EXEC_SCRIPT, "sh", *command]


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


def kill(request: str, home: str, user: str) -> None:
    """요청 하나의 프로세스 묶음을 컨테이너 안에서 끝낸다 (기다리지 않는다).

    docker exec 클라이언트만 죽이면 안의 프로세스는 계속 돌기 때문. 끝난 요청에 불러도 괜찮다 (pid 파일만 지운다).
    """
    docker = docker_bin()
    if not docker:
        return
    try:
        subprocess.Popen(
            [
                docker,
                "exec",
                "--user",
                user,
                "-e",
                f"UD_HOME={home}",
                "-e",
                f"UD_REQ={request}",
                CONTAINER,
                "sh",
                "-c",
                KILL_SCRIPT,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=client_env(),
            start_new_session=True,
        )
    except OSError:
        logger.warning("LLM 격리: 요청 %s 를 끝내지 못함", request)
