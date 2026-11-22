"""Isolated execution for the LLM API: the Claude · Codex CLIs run only inside a Docker container they "cannot leave".

While the API server is on, one container (univdash-llm) is kept running and requests execute inside it (docker exec).
Each account has its own user number · folder (700), so requests of different accounts cannot see each other's tokens · files.

What the container can see
- Files: the base image (ubuntu) + one CLI executable (read-only) + the public CA certificates (read-only) + empty
  in-memory folders (/work · /tmp). The server's home folder · projects · dashboard data · SSH keys · tmux/docker
  sockets are not mounted at all → they can be neither read nor written.
- Processes: only its own (PID namespace). It cannot signal the server's tmux · other processes.
- Network: none (--network none · the only interface is loopback). The single way out is one proxy socket opened by
  the dashboard, and this proxy only relays connections to port 443 of the AI service addresses
  (api.anthropic.com · chatgpt.com · api.openai.com). Other ports of the server · the internal network · the rest
  of the internet are unreachable.
- Privileges: not root (65534) · all capabilities dropped · no-new-privileges · read-only root filesystem ·
  in-memory folders are noexec · limits on process count · memory · CPU · Docker's default seccomp/AppArmor.
  Files inside exist only in memory and vanish when the container is removed.
- Login: nothing long-lived goes in. Claude gets the access token (valid a few hours) in an environment variable,
  Codex only a copy of the login without the refresh token. Tokens cannot be refreshed inside the container, so the
  server's login never changes or gets signed out.

If Docker is unavailable or the image is missing, nothing is run (there is no fallback path without isolation).
"""

import asyncio
import logging
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from app.i18n import N_, _
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
        # The model API of Gemini (Antigravity CLI). The login refresh address (oauth2.googleapis.com) is not opened
        "daily-cloudcode-pa.googleapis.com",
        "cloudcode-pa.googleapis.com",
        # The Antigravity CLI checks the account here on start-up (oauth2/v2/userinfo) — it does not run if blocked
        "www.googleapis.com",
    }
)
MAX_TUNNELS = 64
CONTAINER_UID = "65534:65534"

# A small relay that runs inside the container: it forwards connections arriving at 127.0.0.1:PORT unchanged to the
# outside proxy's unix socket, and executes the command given after it.
# It uses only the perl found in the base image.
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
# (time checked, reason) — the reason is kept untranslated as (Korean source text, placeholder values) and
# translated when returned, because the cache is shared by requests in different languages
_ready_cache: tuple[float, tuple[str, dict] | str | None] = (0.0, "unchecked")


def _root() -> Path:
    path = data_dir() / "llm-api"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)  # other users of the server cannot get in below this
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
    """Why isolated execution is not possible (None if it is). Cached for 30 seconds."""
    global _ready_cache
    now = time.monotonic()
    if now - _ready_cache[0] >= 30 or _ready_cache[1] == "unchecked":
        _ready_cache = (now, _check())
    reason = _ready_cache[1]
    if not isinstance(reason, tuple):
        return None
    return _(reason[0], **reason[1])


def _check() -> tuple[str, dict] | None:
    """The reason as (Korean source text, placeholder values), or None when isolation works."""
    docker = docker_bin()
    if not docker:
        return N_("Docker 가 설치되어 있지 않습니다."), {}
    try:
        done = subprocess.run(
            [docker, "image", "inspect", "--format", "{{.Id}}", IMAGE],
            capture_output=True,
            timeout=10,
            check=False,
        )
        if done.returncode != 0:
            detail = done.stderr.decode("utf-8", "replace").lower()
            if "no such image" in detail:
                return (
                    N_(
                        "격리용 이미지({image})가 없습니다. 서버에서 docker pull {image} 를 한 번 실행해 주십시오."
                    ),
                    {"image": IMAGE},
                )
            return (
                N_("Docker 를 쓸 수 없습니다 (데몬이 꺼져 있거나 권한이 없습니다)."),
                {},
            )
    except (OSError, subprocess.TimeoutExpired):
        return N_("Docker 가 응답하지 않습니다."), {}
    return None


# ── The only way out: the allow-list proxy ──────────────────────────────────────
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
    """Accepts only HTTP CONNECT. 403 unless it is port 443 of an allowed host."""
    global _tunnels
    upstream = None
    counted = False
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        parts = head.split(b"\r\n", 1)[0].decode("latin-1").split(" ")
        host, _sep, port = (parts[1] if len(parts) == 3 else "").rpartition(":")
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
                    "LLM sandbox proxy: refused a host that is not allowed · %s",
                    host[:100],
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
    """Opens the proxy socket (left as is if already open). Returns the folder containing the socket."""
    global _server
    folder = _proxy_dir()
    sock = folder / "proxy.sock"
    if _server is not None and _server.is_serving() and sock.exists():
        return folder
    if _server is not None:
        _server.close()
    sock.unlink(missing_ok=True)
    _server = await asyncio.start_unix_server(_handle, path=str(sock), limit=16384)
    # So the user inside the container (65534) can connect. From outside, the parent folder (700) blocks access.
    os.chmod(sock, 0o666)
    return folder


# ── Container: one is kept running while the API server is on, and requests execute inside it ──
CONTAINER = "univdash-llm"
SPEC_LABEL = "univdash-llm.spec"
WORK_SIZE = "512m"
_container_lock: asyncio.Lock | None = None
_container_ok: tuple[float, str] = (0.0, "")  # (time checked, the spec at that time)

# The wrapper (sh) that runs one request inside the container. Each account has a different folder · user number →
# requests of different accounts cannot see each other's tokens · files (folders are 700). Requests of the same
# account share the folder and so reuse the cache the CLI downloaded (fast: no setup from scratch every time).
EXEC_SCRIPT = (
    'D=/work/$UD_HOME; umask 077; mkdir -p "$D/cwd" && cd "$D/cwd" || exit 97; '
    'if [ -n "$UD_FILE" ]; then mkdir -p "$(dirname "$D/$UD_FILE")" && printf %s "$UD_FILE_DATA" > "$D/$UD_FILE.new" '
    '&& mv -f "$D/$UD_FILE.new" "$D/$UD_FILE" || exit 98; fi; '
    'unset UD_FILE_DATA; echo $$ > "$D/.pid-$UD_REQ"; '
    'exec timeout -k 5 "$UD_TIMEOUT" "$@"'
)
KILL_SCRIPT = (
    # The sh built-in kill handles process groups (-pid) differently per shell, so perl sends the signal
    'f=/work/$UD_HOME/.pid-$UD_REQ; p=$(cat "$f" 2>/dev/null); rm -f "$f"; '
    '[ -n "$p" ] && perl -e \'kill("KILL", -$ARGV[0]); kill("KILL", $ARGV[0])\' "$p"; exit 0'
)


def binaries() -> dict[str, str]:
    """CLI executables to mount into the container (read-only): {name: real path}."""
    from app.paths import find_command

    found = {}
    for name in ("claude", "codex", "agy"):
        path = find_command(name)
        if path:
            found[name] = os.path.realpath(path)
    return found


def _spec(proxy_folder: Path) -> str:
    """A value that reveals whether the container setup changed (a CLI update changes the executable path → recreate)."""
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
    # Main process: starts the proxy relay and then sleeps
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
        out, _err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        return 124, "timeout"
    return proc.returncode or 0, out.decode("utf-8", "replace").strip()


async def ensure_container() -> None:
    """Makes sure the sandbox container is running (with the current setup). Does nothing if it already is."""
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
        if code == 0:  # stopped or the setup changed → recreate
            await _docker("rm", "-f", CONTAINER)
        code, out = await _docker(*_create_argv(folder, spec)[1:], timeout=60)
        if code != 0:
            _container_ok = (0.0, "")
            logger.error("LLM sandbox: could not start the container · %s", out[-400:])
            raise RuntimeError("sandbox container failed to start")
        _container_ok = (time.monotonic(), spec)
        logger.info("LLM sandbox container started · %s", CONTAINER)


async def stop_container() -> None:
    global _container_ok
    _container_ok = (0.0, "")
    if not docker_bin():
        return
    code, _out = await _docker("rm", "-f", CONTAINER)
    if code == 0:
        logger.info("LLM sandbox container removed · %s", CONTAINER)


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
    """(folder name inside the container, user number) — fixed values per account."""
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
    """The command that runs the CLI inside the running container (docker exec).

    {home} in env values is replaced by the account folder inside the container (/work/<home>).
    Values of pass_env are not written on the command line but passed from the docker client's environment (so tokens do not show in ps).
    """
    base = f"/work/{home}"
    argv = [docker_bin() or "docker", "exec", "-i", "--user", user]
    fixed = {
        "HOME": base,
        "UD_HOME": home,
        "UD_REQ": request,
        # it ends by itself inside even if the dashboard dies
        "UD_TIMEOUT": str(int(timeout) + 30),
        **{k: v.replace("{home}", base) for k, v in (env or {}).items()},
    }
    for key, value in fixed.items():
        argv += ["-e", f"{key}={value}"]
    for key in pass_env:
        argv += ["-e", key]
    return [*argv, CONTAINER, "sh", "-c", EXEC_SCRIPT, "sh", *command]


def client_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment passed to the docker client (without the dashboard secrets)."""
    env = {
        k: os.environ[k]
        for k in ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
        if os.environ.get(k)
    }
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.update(extra or {})
    return env


def kill(request: str, home: str, user: str) -> None:
    """Ends the process group of one request inside the container (without waiting).

    Killing only the docker exec client leaves the process inside running. Safe to call for a finished request (it only removes the pid file).
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
        logger.warning("LLM sandbox: could not end request %s", request)
