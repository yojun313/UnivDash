"""에이전트(Claude Code · Codex)를 업데이트하고 같은 대화로 다시 켠다.

순서: 작업 중이 아닌지 확인 → Ctrl+C 로 에이전트 종료(입력창 비우기 → 종료 확인 → 종료) → 같은 셸에
  `claude update; claude <원래 옵션> --resume <세션 ID>`  또는
  `codex update; codex resume <세션 ID> <원래 옵션>`
을 입력한다. 셸에서 직접 실행한 에이전트만 다룬다 (pane 자체가 에이전트면 종료하는 순간 창이 닫힌다).
"""

import json
import os
import re
import secrets
import shlex
import threading
import time
from pathlib import Path

import psutil

from app.paths import data_dir
from app.services import tmux_service, transcript_service
from app.services.ai_usage_service import AIUsageService

SHELLS = {"bash", "zsh", "fish", "sh", "dash", "ksh"}
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)

# 다시 켤 때 그대로 넘길 옵션 (값 개수). 모델 옵션은 뺀다 — 대화 중에 /model 로 바꿨을 수 있다.
# 프롬프트 같은 위치 인자나 --resume/--continue 는 넘기지 않는다.
CLAUDE_KEEP = {
    "--dangerously-skip-permissions": 0,
    "--allow-dangerously-skip-permissions": 0,
    "--permission-mode": 1,
    "--add-dir": 1,
    "--settings": 1,
    "--mcp-config": 1,
    "--strict-mcp-config": 0,
    "--append-system-prompt": 1,
    "--system-prompt": 1,
    "--allowedTools": 1,
    "--allowed-tools": 1,
    "--disallowedTools": 1,
    "--disallowed-tools": 1,
    "--agent": 1,
    "--verbose": 0,
    "--ide": 0,
    "--chrome": 0,
    "--no-chrome": 0,
}
CODEX_KEEP = {
    "-s": 1,
    "--sandbox": 1,
    "-a": 1,
    "--ask-for-approval": 1,
    "-c": 1,
    "--config": 1,
    "-p": 1,
    "--profile": 1,
    "--enable": 1,
    "--disable": 1,
    "--add-dir": 1,
    "--search": 0,
    "--dangerously-bypass-approvals-and-sandbox": 0,
    "--approve-for-me": 0,
    "--no-alt-screen": 0,
}


def keep_flags(argv: list[str], keep: dict[str, int]) -> list[str]:
    out: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        name, eq, _ = arg.partition("=")
        if name in keep:
            if eq or keep[name] == 0:
                out.append(arg)
            elif index + 1 < len(argv):
                out += [arg, argv[index + 1]]
                index += 1
        index += 1
    return out


def _find(pane_id: str):
    windows = tmux_service.list_windows()
    for window in windows:
        for pane in window.panes:
            if pane.id == pane_id:
                return window, pane
    raise KeyError("존재하지 않는 pane 입니다.")


def plan(pane_id: str) -> dict:
    """다시 켤 명령을 만든다 (아직 아무것도 하지 않음)."""
    window, pane = _find(pane_id)
    agent = pane.command if pane.command in tmux_service.AGENTS else window.agent
    if agent not in tmux_service.AGENTS:
        raise ValueError("Claude Code · Codex 가 실행 중인 창이 아닙니다.")
    proc = transcript_service._agent_process(pane.pid, agent)
    if proc is None:
        raise ValueError("에이전트 프로세스를 찾지 못했습니다.")
    try:
        parent = proc.parent()
        parent_name = parent.name() if parent else ""
        argv = proc.cmdline()[1:]
    except psutil.Error as error:
        raise ValueError("에이전트 프로세스 정보를 읽지 못했습니다.") from error
    if parent_name.lstrip("-") not in SHELLS:
        raise ValueError(
            "셸에서 실행한 에이전트만 다시 켤 수 있어요 (종료하면 창이 닫히는 구조입니다)."
        )
    log = transcript_service.find_log(pane.pid, agent, os.path.expanduser(pane.path))
    ids = _UUID.findall(log.name) if log else []
    if not ids:
        raise ValueError("이어갈 대화(세션 ID)를 찾지 못했습니다.")
    session_id = ids[-1]
    if agent == "claude":
        resume = [
            "claude",
            *max_permission("claude", keep_flags(argv, CLAUDE_KEEP)),
            "--resume",
            session_id,
        ]
    else:
        resume = [
            "codex",
            "resume",
            session_id,
            *max_permission("codex", keep_flags(argv, CODEX_KEEP)),
        ]
    return {
        "window": window,
        "pane": pane,
        "agent": agent,
        "proc": proc,
        "session_id": session_id,
        "resume": shlex.join(resume),
        "update": shlex.join([agent, "update"]),
    }


def _gone(proc: psutil.Process, timeout: float) -> bool:
    try:
        proc.wait(timeout=timeout)
        return True
    except psutil.TimeoutExpired:
        return False
    except psutil.Error:
        return True


def _stop(pane_id: str, proc: psutil.Process) -> None:
    """Ctrl+C: 입력창에 글이 있으면 비우고 → 한 번 더 누르라는 안내 → 종료. 끝나는 즉시 멈춘다."""
    for _ in range(4):
        tmux_service.send_keys(pane_id, ["C-c"])
        if _gone(proc, 0.6):
            break
    else:
        tmux_service.send_keys(pane_id, ["C-d"])
        if not _gone(proc, 2.0):
            raise RuntimeError(
                "에이전트가 종료되지 않았어요. 터미널 화면을 확인해 주세요."
            )
    time.sleep(0.4)  # 셸 프롬프트가 다시 뜰 때까지


BUSY_MESSAGE = (
    "지금 작업 중이에요. 끝난 뒤에 다시 시도하세요 (종료하면 작업이 끊깁니다)."
)


def restart(pane_id: str, update: bool = True) -> dict:
    info = plan(pane_id)
    if info["window"].status == "busy":
        raise ValueError(BUSY_MESSAGE)
    _stop(pane_id, info["proc"])
    command = f"{info['update']}; {info['resume']}" if update else info["resume"]
    tmux_service.send_literal(pane_id, command)
    tmux_service.send_keys(pane_id, ["Enter"])
    # 업데이트는 설치가 끝난 뒤에 켜진다
    watch_startup(pane_id, timeout=120.0 if update else 30.0, agent=info["agent"])
    tmux_service.invalidate_cache()
    return {
        "agent": info["agent"],
        "session_id": info["session_id"],
        "command": command,
    }


# 에이전트 바꾸기 (Claude ↔ Codex) · 셸만 있는 창에서 켜기. 새 세션 만들기와 같은 시작 명령을 쓴다.
# 대시보드에서 켜는 에이전트는 항상 가장 높은 권한으로 (사용자 요청):
# Claude = 권한 확인 모두 건너뛰기, Codex = 샌드박스 없음 · 승인 묻지 않음
MAX_PERMISSION = {
    "claude": ["--dangerously-skip-permissions"],
    "codex": ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
}
_PERMISSION_FLAGS = {
    "claude": {
        "--permission-mode": 1,
        "--dangerously-skip-permissions": 0,
        "--allow-dangerously-skip-permissions": 0,
    },
    "codex": {
        "-s": 1,
        "--sandbox": 1,
        "-a": 1,
        "--ask-for-approval": 1,
        "--dangerously-bypass-approvals-and-sandbox": 0,
        "--approve-for-me": 0,
    },
}


def max_permission(agent: str, flags: list[str]) -> list[str]:
    """권한 옵션을 빼고 가장 높은 권한 옵션을 붙인다 (다른 옵션은 그대로)."""
    drop = _PERMISSION_FLAGS[agent]
    out: list[str] = []
    index = 0
    while index < len(flags):
        arg = flags[index]
        name, eq, _ = arg.partition("=")
        if name in drop:
            index += 1 if eq or drop[name] == 0 else 2
            continue
        out.append(arg)
        index += 1
    return [*out, *MAX_PERMISSION[agent]]


LAUNCH = {
    "claude": ["claude", "--dangerously-skip-permissions"],
    "codex": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "never",
    ],
}


# 창(window key)마다 에이전트별 마지막 대화를 기억해 두고, 다시 그 에이전트로 바꾸면 그 대화를 이어서 켠다.
_MEMORY_LOCK = threading.Lock()
KEEP = {"claude": CLAUDE_KEEP, "codex": CODEX_KEEP}


def _memory_file() -> Path:
    return data_dir() / "agent-sessions.json"


def _read_memory() -> dict:
    try:
        data = json.loads(_memory_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _remember(
    window_key: str, agent: str, session_id: str, flags: list[str], cwd: str
) -> None:
    with _MEMORY_LOCK:
        data = _read_memory()
        data.setdefault(window_key, {})[agent] = {
            "id": session_id,
            "flags": flags,
            "cwd": cwd,
            "at": time.time(),
        }
        if len(data) > 300:  # 오래된 창 기록 정리
            for key in sorted(
                data,
                key=lambda k: max(
                    (v.get("at", 0) for v in data[k].values()), default=0
                ),
            )[:-300]:
                data.pop(key, None)
        path = _memory_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.replace(tmp, path)


def _session_exists(agent: str, session_id: str) -> bool:
    if not _UUID.fullmatch(session_id or ""):
        return False
    if agent == "claude":
        root = AIUsageService._data_root("CLAUDE_DATA_DIR", ".claude") / "projects"
        return any(root.glob(f"*/{session_id}.jsonl"))
    root = AIUsageService._data_root("CODEX_DATA_DIR", ".codex") / "sessions"
    return any(root.glob(f"*/*/*/rollout-*{session_id}.jsonl"))


def _open_session_ids() -> set[str]:
    """다른 창에서 지금 열려 있는 대화 (같은 대화를 두 곳에서 이어 쓰지 않게)."""
    found: set[str] = set()
    for window in tmux_service.list_windows(with_status=False):
        for pane in window.panes:
            if pane.command not in tmux_service.AGENTS:
                continue
            log = transcript_service.find_log(
                pane.pid, pane.command, os.path.expanduser(pane.path)
            )
            ids = _UUID.findall(log.name) if log else []
            if ids:
                found.add(ids[-1])
    return found


def _latest_in_folder(agent: str, cwd: str, skip: set[str]) -> str | None:
    """기억된 대화가 없을 때: 그 폴더의 가장 최근 대화."""
    if agent == "claude":
        root = AIUsageService._data_root("CLAUDE_DATA_DIR", ".claude") / "projects"
        folder = root / re.sub(r"[^A-Za-z0-9]", "-", cwd)
        logs = (
            sorted(
                folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
            )
            if folder.is_dir()
            else []
        )
        return next(
            (p.stem for p in logs if _UUID.fullmatch(p.stem) and p.stem not in skip),
            None,
        )
    root = AIUsageService._data_root("CODEX_DATA_DIR", ".codex") / "sessions"
    recent = (
        sorted(
            root.glob("*/*/*/rollout-*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:80]
        if root.is_dir()
        else []
    )
    for path in recent:
        try:
            with path.open(encoding="utf-8") as handle:
                first = json.loads(handle.readline())
        except (OSError, ValueError):
            continue
        if (first.get("payload") or {}).get("cwd") != cwd:
            continue
        ids = _UUID.findall(path.name)
        if ids and ids[-1] not in skip:
            return ids[-1]
    return None


def _launch_command(
    agent: str, session_id: str | None, flags: list[str] | None
) -> list[str]:
    flags = max_permission(agent, LAUNCH[agent][1:] if flags is None else flags)
    if not session_id:
        return [agent, *flags]
    if agent == "claude":
        return ["claude", *flags, "--resume", session_id]
    return ["codex", "resume", session_id, *flags]


def switch_agent(pane_id: str, target: str) -> dict:
    """지금 에이전트를 끄고(없으면 그대로) 다른 에이전트를 같은 셸에서 켠다.

    이 창에서 target 으로 하던 대화가 있으면 그 대화를 이어서(resume), 없으면 그 폴더의 최근 대화를,
    그것도 없으면 새 대화로 켠다. 끄는 에이전트의 대화도 기억해 두어 다시 바꾸면 이어진다.
    """
    if target not in LAUNCH:
        raise ValueError("Claude 또는 Codex 만 켤 수 있어요.")
    window, pane = _find(pane_id)
    cwd = os.path.expanduser(pane.path)
    current = pane.command if pane.command in tmux_service.AGENTS else None
    if current is None and pane.command.lstrip("-") not in SHELLS:
        # 다른 프로그램(vim 등)이 돌고 있거나, 에이전트가 이 pane 이 아닌 곳에서 도는 경우
        agent_proc = (
            transcript_service._agent_process(pane.pid, window.agent)
            if window.agent
            else None
        )
        if agent_proc is None:
            raise ValueError(
                f"이 창은 셸 프롬프트가 아니에요 (지금 실행 중: {pane.command}). 터미널을 확인해 주세요."
            )
        current = window.agent
    if current == target:
        raise ValueError(
            f"이미 {'Codex' if target == 'codex' else 'Claude'} 가 켜져 있어요."
        )
    if current:
        if window.status == "busy":
            raise ValueError(BUSY_MESSAGE)
        proc = transcript_service._agent_process(pane.pid, current)
        if proc is None:
            raise ValueError("에이전트 프로세스를 찾지 못했습니다.")
        try:
            parent = proc.parent()
            parent_name = parent.name() if parent else ""
            argv = proc.cmdline()[1:]
        except psutil.Error as error:
            raise ValueError("에이전트 프로세스 정보를 읽지 못했습니다.") from error
        if parent_name.lstrip("-") not in SHELLS:
            raise ValueError(
                "셸에서 실행한 에이전트만 바꿀 수 있어요 (종료하면 창이 닫히는 구조입니다)."
            )
        # 끄기 전에 지금 대화를 기억 (다시 이 에이전트로 바꾸면 이어진다)
        log = transcript_service.find_log(pane.pid, current, cwd)
        ids = _UUID.findall(log.name) if log else []
        if ids:
            _remember(
                window.key, current, ids[-1], keep_flags(argv, KEEP[current]), cwd
            )
        _stop(pane_id, proc)
    else:
        tmux_service.send_keys(pane_id, ["C-u"])  # 셸에 쓰다 만 명령이 있으면 지운다
        time.sleep(0.1)
    # 이어갈 대화: 이 창에서 하던 대화 → 그 폴더의 최근 대화 → 새 대화
    remembered = (_read_memory().get(window.key) or {}).get(target) or {}
    open_ids = _open_session_ids()
    session_id, flags, resumed = None, None, "new"
    if remembered.get("id") not in open_ids and _session_exists(
        target, remembered.get("id", "")
    ):
        session_id, resumed = remembered["id"], "window"
        flags = (
            remembered.get("flags")
            if isinstance(remembered.get("flags"), list)
            else None
        )
    else:
        session_id = _latest_in_folder(target, cwd, open_ids)
        resumed = "folder" if session_id else "new"
    command = shlex.join(_launch_command(target, session_id, flags))
    tmux_service.send_literal(pane_id, command)
    tmux_service.send_keys(pane_id, ["Enter"])
    watch_startup(pane_id, agent=target, ask_model=resumed == "new")
    tmux_service.invalidate_cache()
    return {"from": current, "to": target, "command": command, "resumed": resumed}


def codex_panes() -> list[tuple]:
    return [
        (window, pane)
        for window in tmux_service.list_windows()
        for pane in window.panes
        if pane.command == "codex"
    ]


def relaunch_codex(after_stop=None) -> dict:
    """모든 Codex 창을 끄고 → (after_stop: 예) 데몬 재시작) → 같은 대화로 다시 켠다.

    계정을 바꾼 뒤 쓴다. 작업 중인 창이 있으면 아무것도 하지 않고 거절한다.
    """
    targets = codex_panes()
    busy = [window.key for window, _ in targets if window.status == "busy"]
    if busy:
        raise ValueError(
            f"Codex 가 작업 중인 창이 있어요 ({', '.join(busy)}). 끝난 뒤에 다시 시도하세요."
        )
    home = AIUsageService._data_root("CODEX_DATA_DIR", ".codex").resolve()
    plans, skipped = [], []
    for window, pane in targets:
        proc = transcript_service._agent_process(pane.pid, "codex")
        try:
            parent = proc.parent() if proc else None
            parent_name = parent.name() if parent else ""
            argv = proc.cmdline()[1:] if proc else []
            proc_home = Path(
                (proc.environ().get("CODEX_HOME") if proc else None)
                or Path.home() / ".codex"
            ).expanduser()
        except psutil.Error:
            parent_name, proc_home = "", None
        # 다른 Codex 폴더(CODEX_HOME)를 쓰는 창은 이 계정과 상관없으니 건드리지 않는다
        if not proc or proc_home is None or proc_home.resolve() != home:
            continue
        if parent_name.lstrip("-") not in SHELLS:
            skipped.append(window.key)
            continue
        cwd = os.path.expanduser(pane.path)
        log = transcript_service.find_log(pane.pid, "codex", cwd)
        ids = _UUID.findall(log.name) if log else []
        if not ids:
            # 이어갈 대화를 모르면 끄지 않는다 (새 대화로 바뀌어 버리지 않게) — 직접 다시 켜야 한다
            skipped.append(window.key)
            continue
        flags = keep_flags(argv, CODEX_KEEP)
        _remember(window.key, "codex", ids[-1], flags, cwd)
        plans.append((window, pane, proc, ids[-1], flags))
    for _, pane, proc, _, _ in plans:
        _stop(pane.id, proc)
    extra = after_stop() if after_stop else None
    for _, pane, _, session_id, flags in plans:
        command = shlex.join(_launch_command("codex", session_id, flags))
        tmux_service.send_literal(pane.id, command)
        tmux_service.send_keys(pane.id, ["Enter"])
        watch_startup(pane.id, agent="codex")
    tmux_service.invalidate_cache()
    return {
        "relaunched": [window.key for window, *_ in plans],
        "skipped": skipped,
        "after_stop": extra,
    }


# ── 켠 직후 자동 응답: 폴더 신뢰 질문 · Codex 업데이트 안내 ─────────────────────────
# 대시보드에서 켠 에이전트는 사용자가 이미 고른 폴더에서 도는 것이므로 신뢰 질문에 "예"로 답한다.
# Codex 업데이트 안내는 켜는 게 막히지 않게 건너뛴다 (업데이트는 '업데이트' 버튼으로 따로).
_CURSOR = re.compile(r"^\s*[❯›>]")


def _screen_lines(pane_id: str) -> list[str]:
    try:
        text = tmux_service._run(["capture-pane", "-p", "-t", pane_id])
    except tmux_service.TmuxError:
        return []
    return [line.rstrip() for line in text.split("\n")]


_OPTION = re.compile(r"^\s*(?:[❯›>]\s*)?(?:\d\.\s+)?(.+?)\s*$")


def _option_line(lines: list[str], label: str) -> str | None:
    """선택지 줄(커서 표시 · 번호를 뺀 글자가 label 과 정확히 같은 줄)."""
    for line in lines:
        match = _OPTION.match(line)
        if match and match.group(1) == label:
            return line
    return None


def _answer_once(pane_id: str, lines: list[str]) -> str | None:
    """화면 맨 아래의 질문 창에 답한다 (채팅 글에 같은 문구가 있어도 반응하지 않게 줄 모양까지 본다)."""
    bottom = [line for line in lines if line.strip()][-16:]
    footer = bottom[-1].strip() if bottom else ""
    # Claude: "❯ No, exit / Yes, I trust this folder" + 맨 아래 "Enter to confirm · Esc to cancel"
    yes = _option_line(bottom, "Yes, I trust this folder")
    if (
        yes
        and _option_line(bottom, "No, exit")
        and footer.startswith("Enter to confirm")
    ):
        key = "Enter" if _CURSOR.match(yes) else "Down"
        tmux_service.send_keys(pane_id, [key])
        return f"claude-trust:{key}"
    # Claude: 권한 확인 건너뛰기 경고 "❯ No, exit / Yes, I accept" (처음 한 번만 뜬다)
    yes = _option_line(bottom, "Yes, I accept")
    if (
        yes
        and _option_line(bottom, "No, exit")
        and footer.startswith("Enter to confirm")
    ):
        key = "Enter" if _CURSOR.match(yes) else "Down"
        tmux_service.send_keys(pane_id, [key])
        return f"claude-bypass:{key}"
    # Codex: "Trust this folder? …" + "› 1. Trust and continue" + 맨 아래 "enter continue · esc back"
    yes = _option_line(bottom, "Trust and continue")
    if (
        yes
        and any("Trust this folder?" in line for line in bottom)
        and footer.startswith("enter continue")
    ):
        key = "Enter" if _CURSOR.match(yes) else "Up"
        tmux_service.send_keys(pane_id, [key])
        return f"codex-trust:{key}"
    # Codex: "Update available · …" + "› 1. Update now" + 맨 아래 "enter continue · esc skip"
    if (
        (
            _option_line(bottom, "Update now") is not None
            or any(line.lstrip(" ›>").startswith("1. Update now") for line in bottom)
        )
        and any("Update available" in line for line in bottom)
        and footer.endswith("esc skip")
    ):
        tmux_service.send_keys(pane_id, ["Escape"])
        return "codex-update:skip"
    return None


def _bottom(lines: list[str], count: int = 5) -> list[str]:
    return [line for line in lines if line.strip()][-count:]


def _ready(lines: list[str], agent: str | None) -> bool:
    """그 에이전트의 입력창이 떴다.

    Claude: 아래쪽에 입력칸 위아래 구분선(────)이 두 줄. Codex: "› …" 입력줄과 "? for shortcuts" 안내.
    """
    bottom = _bottom(lines, 6)
    if agent == "claude":
        return sum(1 for line in bottom if re.match(r"^\s*─{20,}\s*$", line)) >= 2
    if agent == "codex":
        return any(line.lstrip().startswith("› ") for line in bottom) and any(
            "for shortcuts" in line for line in bottom[-3:]
        )
    tail = "\n".join(bottom)
    return "for shortcuts" in tail or "⏵⏵" in tail


def _send_model_command(pane_id: str, agent: str) -> None:
    """새 대화로 켜졌을 때 모델 선택 창을 연다 (채팅 아래 카드에 선택지가 뜬다)."""
    tmux_service.send_literal(pane_id, "/model")
    time.sleep(
        0.45 if agent == "codex" else 0.25
    )  # Codex 는 붙여넣기 직후 Enter 를 줄바꿈으로 받는다
    tmux_service.send_keys(pane_id, ["Enter"])


def watch_startup(
    pane_id: str,
    timeout: float = 30.0,
    agent: str | None = None,
    ask_model: bool = False,
) -> None:
    """켠 직후 화면을 지켜보며 폴더 신뢰 · 권한 경고 · 업데이트 질문에 답한다 (백그라운드).

    켜기 전부터 화면에 있던 내용(예: 방금 끈 에이전트의 아래 안내 줄)에는 반응하지 않는다.
    그 에이전트의 입력창이 뜨면 멈추고, ask_model 이면 그때 /model 을 보내 모델을 고르게 한다.
    """
    initial = "\n".join(_screen_lines(pane_id))
    initial_bottom = _bottom(_screen_lines(pane_id))

    def run() -> None:
        deadline = time.monotonic() + timeout
        actions = 0
        answered = False
        while time.monotonic() < deadline and actions < 8:
            time.sleep(0.4)
            lines = _screen_lines(pane_id)
            if not lines:
                return
            if "\n".join(lines) == initial:
                continue  # 아직 새 화면이 아니다
            done = _answer_once(pane_id, lines)
            if done:
                actions += 1
                answered = True
                time.sleep(0.6)  # 화면이 다시 그려질 때까지
                continue
            fresh = _bottom(lines) != initial_bottom
            if fresh and _ready(lines, agent) and (agent or answered):
                if ask_model and agent in tmux_service.AGENTS:
                    time.sleep(0.5)
                    _send_model_command(pane_id, agent)
                return

    threading.Thread(target=run, daemon=True, name=f"startup-{pane_id}").start()
