"""Terminal (tmux 아님): 서버에서 로그인 셸을 가상 터미널(PTY)로 띄우고 WebSocket 으로 연결한다.

- 셸은 브라우저 연결과 따로 산다 → 새로고침 · 다른 페이지에 갔다 와도 탭이 다시 붙고 최근 출력(스크롤백)이 이어진다.
- 셸이 끝나면(exit) 연결된 화면에 알리고 목록에서 빠진다. 탭을 닫으면 셸도 끝낸다.
- 셸 환경에는 이 대시보드의 비밀값(.env 의 SECRET_KEY · ADMIN_PASS 등)을 넘기지 않는다.
"""

import asyncio
import codecs
import fcntl
import os
import pty
import pwd
import secrets
import signal
import struct
import termios
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.services.pm2_service import update_env

MAX_TERMINALS = 12
ORPHAN_SECONDS = (
    600  # 창(브라우저)을 닫아 아무 화면도 안 붙은 채 10분이 지나면 셸을 끝낸다
)
SCROLLBACK_CHARS = 400_000
DASH_ONLY_PREFIXES = ("UNIVDASH_", "EXPLORER_", "SESSION_", "ADMIN_", "PM2_ECOSYSTEM")
DASH_ONLY_KEYS = {
    "SECRET_KEY",
    "ALLOWED_HOSTS",
    "APP_ENV",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_UNIQUE_ID",
}


def _shell() -> str:
    candidate = (
        os.environ.get("SHELL") or pwd.getpwuid(os.getuid()).pw_shell or "/bin/bash"
    )
    return candidate if os.path.exists(candidate) else "/bin/bash"


def _env() -> dict[str, str]:
    env = {
        k: v
        for k, v in update_env().items()
        if k not in DASH_ONLY_KEYS and not k.startswith(DASH_ONLY_PREFIXES)
    }
    home = str(Path.home())
    env.update(
        {
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "HOME": env.get("HOME", home),
            "TERM_PROGRAM": "UnivDash",
        }
    )
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("USER", pwd.getpwuid(os.getuid()).pw_name)
    env.setdefault("PATH", os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"))
    env.pop("TMUX", None)
    return env


@dataclass
class Terminal:
    id: str
    pid: int
    fd: int
    cwd: str
    created: float
    buffer: str = ""
    alive: bool = True
    exit_code: int | None = None
    clients: set = field(default_factory=set)  # asyncio.Queue 들
    detached_at: float | None = None  # 마지막 화면이 떨어진 시각
    decoder: object = field(
        default_factory=lambda: codecs.getincrementaldecoder("utf-8")(errors="replace")
    )

    def info(self) -> dict:
        return {
            "id": self.id,
            "cwd": self.cwd,
            "created": self.created,
            "alive": self.alive,
            "exit_code": self.exit_code,
        }


_terminals: dict[str, Terminal] = {}


def list_terminals() -> list[dict]:
    return [t.info() for t in _terminals.values()]


def get(terminal_id: str) -> Terminal | None:
    return _terminals.get(terminal_id)


def _set_size(fd: int, cols: int, rows: int) -> None:
    cols = max(10, min(int(cols), 500))
    rows = max(3, min(int(rows), 300))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def create(cwd: str | None, cols: int = 100, rows: int = 30) -> Terminal:
    alive = [t for t in _terminals.values() if t.alive]
    if len(alive) >= MAX_TERMINALS:
        raise ValueError(
            f"터미널은 한 번에 {MAX_TERMINALS}개까지 열 수 있습니다. 안 쓰는 탭을 닫아 주세요."
        )
    directory = Path(os.path.expanduser(cwd or "~"))
    if not directory.is_dir():
        directory = Path.home()
    shell = _shell()
    env = _env()
    pid, fd = pty.fork()
    if pid == 0:  # 자식: 곧바로 셸로 바뀐다 (fork 뒤에는 exec 만)
        try:
            os.chdir(directory)
            os.execvpe(shell, [shell, "-l"], env)
        finally:
            os._exit(127)
    _set_size(fd, cols, rows)
    terminal = Terminal(
        id=secrets.token_urlsafe(9),
        pid=pid,
        fd=fd,
        cwd=str(directory),
        created=time.time(),
    )
    terminal.detached_at = time.monotonic()
    _terminals[terminal.id] = terminal
    loop = asyncio.get_running_loop()
    loop.add_reader(fd, _on_output, terminal)
    _ensure_sweeper(loop)
    return terminal


def attach_client(terminal: Terminal, queue) -> None:
    terminal.clients.add(queue)
    terminal.detached_at = None


def detach_client(terminal: Terminal, queue) -> None:
    terminal.clients.discard(queue)
    if not terminal.clients:
        terminal.detached_at = time.monotonic()


_sweeper_started = False


def _ensure_sweeper(loop) -> None:
    """아무 화면도 붙어 있지 않은 채 오래된 터미널(브라우저를 닫은 경우)을 정리한다."""
    global _sweeper_started
    if _sweeper_started:
        return
    _sweeper_started = True

    def sweep() -> None:
        now = time.monotonic()
        for terminal in list(_terminals.values()):
            if (
                terminal.alive
                and not terminal.clients
                and terminal.detached_at
                and now - terminal.detached_at > ORPHAN_SECONDS
            ):
                kill(terminal.id)
        loop.call_later(30, sweep)

    loop.call_later(30, sweep)


def _broadcast(terminal: Terminal, message: dict) -> None:
    for queue in list(terminal.clients):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            pass


def _on_output(terminal: Terminal) -> None:
    try:
        data = os.read(terminal.fd, 65536)
    except OSError:
        data = b""
    if not data:
        _finish(terminal)
        return
    text = terminal.decoder.decode(data)
    if not text:
        return
    terminal.buffer = (terminal.buffer + text)[-SCROLLBACK_CHARS:]
    _broadcast(terminal, {"t": "out", "d": text})


def _finish(terminal: Terminal) -> None:
    if not terminal.alive:
        return
    terminal.alive = False
    loop = asyncio.get_running_loop()
    loop.remove_reader(terminal.fd)
    try:
        os.close(terminal.fd)
    except OSError:
        pass
    _reap(terminal, loop, tries=20)
    _broadcast(terminal, {"t": "exit", "code": terminal.exit_code})
    # 끝난 터미널은 잠시 뒤 목록에서 뺀다 (그 사이 붙는 화면은 종료 안내를 받는다)
    loop.call_later(
        600, lambda: _terminals.pop(terminal.id, None) if not terminal.alive else None
    )


def _reap(terminal: Terminal, loop, tries: int) -> None:
    """끝난 셸의 종료 코드를 거둔다 (좀비 프로세스가 남지 않게). 아직이면 잠시 뒤 다시."""
    try:
        pid, status = os.waitpid(terminal.pid, os.WNOHANG)
    except ChildProcessError:
        return
    if pid == 0:
        if tries > 0:
            loop.call_later(0.5, _reap, terminal, loop, tries - 1)
        return
    terminal.exit_code = os.waitstatus_to_exitcode(status)


def write(terminal: Terminal, data: str) -> None:
    if terminal.alive and data:
        os.write(terminal.fd, data.encode("utf-8", errors="replace"))


def resize(terminal: Terminal, cols: int, rows: int) -> None:
    if terminal.alive:
        _set_size(terminal.fd, cols, rows)


def kill(terminal_id: str) -> bool:
    terminal = _terminals.pop(terminal_id, None)
    if not terminal:
        return False
    if terminal.alive:
        try:
            os.killpg(
                os.getpgid(terminal.pid), signal.SIGHUP
            )  # 셸과 그 안에서 돌던 작업까지
        except (ProcessLookupError, PermissionError):
            pass
        _finish(terminal)
        loop = asyncio.get_running_loop()

        def reap() -> None:
            try:
                if os.waitpid(terminal.pid, os.WNOHANG) == (0, 0):
                    os.killpg(os.getpgid(terminal.pid), signal.SIGKILL)
                    os.waitpid(terminal.pid, 0)
            except (ChildProcessError, ProcessLookupError, PermissionError):
                pass

        loop.call_later(2, reap)
    return True
