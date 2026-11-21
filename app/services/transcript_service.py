"""에이전트 대화 기록 (Claude Code / Codex 세션 로그).

Claude Code 는 tmux 의 alternate screen 에서 화면을 통째로 다시 그리므로 tmux 스크롤백에는
대화가 남지 않는다. 대신 에이전트가 직접 쓰는 세션 로그(JSONL)를 읽어 전체 대화를 보여준다.

pane → 로그 파일 찾기 (추측 없이 실행 중인 프로세스 기준):
- Claude Code: ~/.claude/sessions/<pid>.json 의 sessionId → ~/.claude/projects/*/<sessionId>.jsonl
- Codex: 프로세스가 열어 둔 ~/.codex/sessions/**/rollout-*.jsonl (/proc/<pid>/fd)
파일 경로는 모두 서버가 정하고, 에이전트 데이터 폴더 밖은 읽지 않는다.
"""

import base64
import difflib
import hashlib
import json
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil

SESSION_ID = re.compile(r"^[0-9a-fA-F-]{16,64}$")
MAX_TEXT = 20000
MAX_OUTPUT = 4000
MAX_SUMMARY = 300
CACHE_FILES = 96  # 에이전트 창 수보다 넉넉히: 모자라면 매 상태 확인마다 모든 로그를 처음부터 다시 파싱한다

# 사용자가 첨부한 그림: 기록 안의 base64 를 한 번만 풀어 캐시 파일로 두고 이름(내용 해시)만 항목에 넣는다
IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
IMAGE_NAME = re.compile(r"^[0-9a-f]{32}\.(png|jpg|gif|webp)$")
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_IMAGES = 12
IMAGE_CACHE_BYTES = 300 * 1024 * 1024
# Codex 는 그림 앞뒤에 <image name=[Image #1] path="…"> · </image> 글을 붙인다
_CODEX_IMAGE_TAG = re.compile(r"^\s*(?:<image\b[^>]*>|</image>)\s*$")
_IMAGE_PLACEHOLDER = "[이미지]"

# 사용자 입력처럼 보이지만 에이전트가 끼워 넣은 문맥은 숨긴다.
_INJECTED_PREFIXES = (
    "<environment_context",
    "<user_instructions",
    "<permissions",
    "<system-reminder",
    "<local-command-",
    "<command-message",
    "# AGENTS.md instructions",
    "<model_switch",
    "<turn_aborted",
    "<codex_internal_context",
    "Caveat: The messages below",
)
# Codex 목표 모드 등이 사용자 메시지에 넣는 내부 지시 (글 중간에 붙어 올 수도 있다)
_CODEX_INTERNAL = re.compile(
    r"<codex_internal_context\b[^>]*>.*?(?:</codex_internal_context>|\Z)", re.DOTALL
)
COMPACTED = "대화가 길어 압축(compact)됐어요"
# 대시보드의 '대화 넘기기'로 새 에이전트에 보낸 첫 지시 (agent_restart._handoff_prompt)
_HANDOFF_PREFIX = "이 작업은 다른 에이전트("
# Claude Code 가 붙여넣은 글을 <pasted_content id="N"> … </pasted_content id="N"> 로 감싼다 (내용만 남긴다)
_PASTED_TAG = re.compile(r"[ \t]*</?pasted_content\b[^>\n]*>[ \t]*\n?")
_COMMAND_NAME = re.compile(r"<command-name>(.*?)</command-name>", re.DOTALL)
_COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)


def _data_root(env_name: str, default: str) -> Path:
    configured = os.getenv(env_name)
    return (
        Path(configured).expanduser() if configured else Path.home() / default
    ).resolve()


def _clip(text: str, limit: int) -> str:
    text = text or ""
    return (
        text
        if len(text) <= limit
        else text[:limit] + f"\n… ({len(text) - limit:,}자 생략)"
    )


# ── pane → 로그 파일 ────────────────────────────────────────────────────────


def _agent_process(pane_pid: int, agent: str) -> psutil.Process | None:
    try:
        root = psutil.Process(pane_pid)
        for proc in [root, *root.children(recursive=True)]:
            try:
                if proc.name() == agent:
                    return proc
            except psutil.Error:
                continue
    except psutil.Error:
        return None
    return None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except (ValueError, OSError):
        return False


def _claude_log(proc: psutil.Process) -> Path | None:
    root = _data_root("CLAUDE_DATA_DIR", ".claude")
    try:
        meta = json.loads((root / "sessions" / f"{proc.pid}.json").read_text())
    except (OSError, ValueError):
        return None
    session_id = str(meta.get("sessionId") or "")
    if not SESSION_ID.match(session_id):
        return None
    matches = sorted(
        (root / "projects").glob(f"*/{session_id}.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return next((p for p in matches if _inside(p, root)), None)


_RESUME_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


# rollout 첫 줄(session_meta)은 바뀌지 않으므로 기억해 둔다: path → {"cwd", "sub"}
_meta_cache: dict[str, dict | None] = {}


def _rollout_meta(path: Path) -> dict | None:
    key = str(path)
    if key in _meta_cache:
        return _meta_cache[key]
    try:
        with path.open("rb") as handle:
            first = json.loads(handle.readline(8 * 1024 * 1024))
    except (OSError, ValueError):
        return None  # 아직 쓰는 중일 수 있으니 기억하지 않는다
    payload = first.get("payload") if isinstance(first, dict) else None
    meta = None
    if (
        isinstance(first, dict)
        and first.get("type") == "session_meta"
        and isinstance(payload, dict)
    ):
        source = payload.get("source")
        meta = {
            "id": payload.get("id"),
            "parent": payload.get("parent_thread_id"),
            "agent_path": payload.get("agent_path"),
            "cwd": payload.get("cwd"),
            "forked_from": payload.get("forked_from_id"),
            "created": payload.get("timestamp"),
            # 서브에이전트(thread_spawn)의 대화: 같은 작업 폴더에 따로 생기지만 사용자의 대화가 아니다
            "sub": bool(payload.get("parent_thread_id"))
            or (isinstance(source, dict) and "subagent" in source),
        }
    if len(_meta_cache) > 512:
        _meta_cache.clear()
    _meta_cache[key] = meta
    return meta


def _is_subagent(path: Path) -> bool:
    meta = _rollout_meta(path)
    return bool(meta and meta["sub"])


_fork_cache: dict[tuple[int, float], Path] = {}


def _codex_forked_log(proc: psutil.Process, source_id: str, root: Path) -> Path | None:
    """`codex fork <ID>` 로 켜진 창의 새 대화: 그 프로세스가 켜진 뒤 ID 에서 갈라져 나온 첫 기록."""
    try:
        started = proc.create_time()
    except psutil.Error:
        return None
    key = (proc.pid, started)
    cached = _fork_cache.get(key)
    if cached is not None and cached.exists():
        return cached
    earliest = time.strftime("rollout-%Y-%m-%dT%H-%M-%S", time.localtime(started - 60))
    # 파일 이름이 시각순이라 이름순으로 보면 먼저 생긴 것부터 나온다
    for path in sorted(
        (root / "sessions").glob("*/*/*/rollout-*.jsonl"), key=lambda p: p.name
    ):
        if path.name < earliest or not _inside(path, root):
            continue
        meta = _rollout_meta(path)
        if not meta or meta["sub"] or meta["forked_from"] != source_id:
            continue
        try:
            created = datetime.fromisoformat(meta["created"]).timestamp()
        except (TypeError, ValueError):
            continue
        if created >= started - 1:
            if len(_fork_cache) > 256:
                _fork_cache.clear()
            _fork_cache[key] = path
            return path
    return None


def _codex_log(proc: psutil.Process, cwd: str) -> Path | None:
    root = _data_root("CODEX_DATA_DIR", ".codex")
    # `codex resume <ID>` 로 켜진 창은 그 대화의 로그가 확실하다 (공유 데몬이 파일을 열고 있어 아래 방법으로는 못 찾을 때가 많다)
    try:
        argv = proc.cmdline()
    except psutil.Error:
        argv = []
    if "fork" in argv[:3]:
        index = argv.index("fork")
        source_id = next(
            (a for a in argv[index + 1 : index + 2] if _RESUME_ID.match(a)), None
        )
        if source_id:
            # 같은 폴더의 최근 대화로 추측하면 원본 창의 대화를 자기 것으로 착각한다 → 아직 없으면 없는 대로
            return _codex_forked_log(proc, source_id, root)
    if "resume" in argv:
        index = argv.index("resume")
        wanted = next(
            (a for a in argv[index + 1 : index + 2] if _RESUME_ID.match(a)), None
        )
        if wanted:
            found = sorted((root / "sessions").glob(f"*/*/*/rollout-*{wanted}.jsonl"))
            if found and _inside(found[-1], root):
                return found[-1]
    for candidate in [proc, *proc.children(recursive=True)]:
        try:
            for handle in candidate.open_files():
                path = Path(handle.path)
                if (
                    path.name.startswith("rollout-")
                    and path.suffix == ".jsonl"
                    and _inside(path, root)
                    and not _is_subagent(path)
                ):
                    return path
        except psutil.Error:
            continue
    # 파일을 잠시 닫고 있는 경우: 같은 작업 폴더의 가장 최근 세션 (폴더 이름이 바뀌었으면 켤 때의 경로로도 찾는다)
    folders = {cwd}
    try:
        folders.add(proc.environ().get("PWD") or cwd)
    except psutil.Error:
        pass
    sessions = root / "sessions"
    if not sessions.is_dir() or not cwd:
        return None
    recent = sorted(
        sessions.glob("*/*/*/rollout-*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[:40]
    for path in recent:
        meta = _rollout_meta(path)
        if meta and meta["cwd"] in folders and not meta["sub"]:
            return path
    return None


def find_log(pane_pid: int, agent: str | None, cwd: str) -> Path | None:
    if agent not in {"claude", "codex"}:
        return None
    proc = _agent_process(pane_pid, agent)
    if proc is None:
        return None
    return _claude_log(proc) if agent == "claude" else _codex_log(proc, cwd)


_AGENT_KEY = re.compile(r"^(?:[A-Za-z0-9_-]{1,64}|(?:/[A-Za-z0-9_.-]{1,64}){1,8})$")
_sub_cache: dict[tuple[str, str], Path] = {}


def find_subagent_log(main: Path, agent: str | None, key: str) -> Path | None:
    """본 대화 기록(main) 의 서브에이전트(key: Claude agentId · Codex /root/이름) 기록 파일."""
    if not _AGENT_KEY.match(key or ""):
        return None
    cached = _sub_cache.get((str(main), key))
    if cached is not None and cached.exists():
        return cached
    found: Path | None = None
    if agent == "claude":
        root = _data_root("CLAUDE_DATA_DIR", ".claude")
        path = main.with_suffix("") / "subagents" / f"agent-{key}.jsonl"
        if "/" not in key and path.is_file() and _inside(path, root):
            found = path
    elif agent == "codex":
        root = _data_root("CODEX_DATA_DIR", ".codex")
        meta = _rollout_meta(main)
        if meta and meta.get("id"):
            # 서브에이전트는 부모보다 나중에 생기므로 파일 이름(시각순)이 부모 이후인 것만 본다
            for path in sorted((root / "sessions").glob("*/*/*/rollout-*.jsonl")):
                if path.name < main.name or not _inside(path, root):
                    continue
                sub = _rollout_meta(path)
                if (
                    sub
                    and sub.get("parent") == meta["id"]
                    and sub.get("agent_path") == key
                ):
                    found = path
                    break
    if found is not None:
        if len(_sub_cache) > 256:
            _sub_cache.clear()
        _sub_cache[(str(main), key)] = found
    return found


# ── 파싱 ─────────────────────────────────────────────────────────────────────


def _blocks_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind in {"text", "input_text", "output_text"}:
            text = block.get("text") or ""
            if not _CODEX_IMAGE_TAG.match(text):
                parts.append(text)
        elif kind in {"image", "input_image", "localImage", "image_url"}:
            parts.append(_IMAGE_PLACEHOLDER)
    return "\n".join(p for p in parts if p)


def image_dir() -> Path:
    path = Path.home() / ".univdash" / "cache" / "chat-images"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _prune_images(root: Path) -> None:
    try:
        files = sorted(
            (p for p in root.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime
        )
        total = sum(p.stat().st_size for p in files)
        for file in files:
            if total <= IMAGE_CACHE_BYTES:
                break
            total -= file.stat().st_size
            file.unlink(missing_ok=True)
    except OSError:
        pass


def _save_image(media_type: str, data: str) -> str | None:
    """base64 그림을 캐시에 두고 파일 이름을 돌려준다 (같은 그림은 한 번만 푼다)."""
    ext = IMAGE_TYPES.get((media_type or "").lower())
    if not ext or not isinstance(data, str) or not data:
        return None
    if len(data) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        return None
    name = f"{hashlib.sha256(data.encode()).hexdigest()[:32]}.{ext}"
    root = image_dir()
    target = root / name
    if target.exists():
        return name
    try:
        raw = base64.b64decode(data, validate=False)
    except ValueError:
        return None
    if not raw:
        return None
    tmp = root / f".{name}.{secrets.token_hex(4)}.tmp"
    try:
        tmp.write_bytes(raw)
        os.replace(tmp, target)
    except OSError:
        tmp.unlink(missing_ok=True)
        return None
    _prune_images(root)
    return name


def _blocks_images(content: Any) -> list[str]:
    """사용자 메시지에 붙은 그림 (Claude: image · base64, Codex: input_image · data URL)."""
    if not isinstance(content, list):
        return []
    names: list[str] = []
    for block in content:
        if not isinstance(block, dict) or len(names) >= MAX_IMAGES:
            continue
        name = None
        if block.get("type") == "image":
            source = block.get("source") or {}
            if source.get("type") == "base64":
                name = _save_image(source.get("media_type", ""), source.get("data", ""))
        elif block.get("type") == "input_image":
            url = block.get("image_url")
            url = url.get("url") if isinstance(url, dict) else url
            match = re.match(r"^data:([\w/+.-]+);base64,", url or "")
            if match:
                name = _save_image(match.group(1), url[match.end() :])
        if name and name not in names:
            names.append(name)
    return names


def image_path(name: str) -> Path | None:
    if not IMAGE_NAME.match(name or ""):
        return None
    path = image_dir() / name
    return path if path.is_file() else None


def _tool_summary(name: str, data: Any) -> str:
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return _clip(
                data.strip().splitlines()[0] if data.strip() else "", MAX_SUMMARY
            )
    if isinstance(data, dict):
        for key in (
            "command",
            "cmd",
            "task_name",
            "target",
            "file_path",
            "path",
            "pattern",
            "url",
            "query",
            "description",
            "prompt",
        ):
            value = data.get(key)
            if isinstance(value, list):
                value = " ".join(map(str, value))
            if value and not _encrypted(value):
                return _clip(str(value).strip(), MAX_SUMMARY)
        shown = {k: v for k, v in data.items() if not _encrypted(v)}
        return (
            _clip(json.dumps(shown, ensure_ascii=False), MAX_SUMMARY) if shown else ""
        )
    return ""


def _user_text(text: str) -> tuple[str, str] | None:
    """(kind, text) — 끼워 넣은 문맥이면 None. 슬래시 명령은 system 으로."""
    stripped = _PASTED_TAG.sub("", _CODEX_INTERNAL.sub("", text)).strip()
    if not stripped:
        return None
    command = _COMMAND_NAME.search(stripped)
    if command:
        args = _COMMAND_ARGS.search(stripped)
        return (
            "system",
            f"{command.group(1).strip()} {args.group(1).strip() if args else ''}".strip(),
        )
    if stripped.startswith(_INJECTED_PREFIXES):
        return None
    if stripped.startswith(_HANDOFF_PREFIX) and "나눈 대화 전체가" in stripped:
        agent = stripped[len(_HANDOFF_PREFIX) :].split(")", 1)[0]
        return "system", f"{agent} 에서 넘겨받은 대화 기록을 읽고 이어 가요"
    if stripped.startswith("[Request interrupted"):
        return "system", "사용자가 중단함"
    return "user", stripped


# ── 서브에이전트 ──
# Claude: 백그라운드로 띄운 Agent 가 끝나면 "<task-notification>…" 이 사용자 메시지처럼 끼워진다 (사용자가 쓴 글이 아님)
_NOTIFY = "<task-notification>"
_NOTIFY_TAG = re.compile(
    r"<(task-id|tool-use-id|status|summary|result)>(.*?)</\1>", re.DOTALL
)
# Codex: 서브에이전트 → 부모 메시지 (agent_message). 중간 메시지는 암호화되어 있고 최종 보고만 평문이다.
_AGENT_MSG = re.compile(r"Message Type:\s*(\w+).*?Payload:\n?(.*)", re.DOTALL)
SUBAGENT_TOOLS = {"Agent", "Task", "spawn_agent"}

# ── 사용 현황 (스킬 · 플러그인 · MCP 서버 · 서브에이전트 · 내장 도구) ──
_CODEX_SKILL_FILE = re.compile(
    r"(?:/plugins/cache/[^/\s\"']+/([A-Za-z0-9_.-]{1,80})/[^/\s\"']+)?/skills/([A-Za-z0-9_.:-]{1,80})/SKILL\.md\b"
)
# Codex 코드 모드: exec 하나 안에서 tools.exec_command(...) · tools.apply_patch(...) 등을 부른다
_CODEX_INNER = re.compile(r"\btools\.([A-Za-z_][A-Za-z0-9_]{0,80})\s*\(")
_CODEX_STR = r"(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`[^`]*`)"
_CODEX_ARG = {
    "exec_command": re.compile(r"\bcmd\s*:\s*" + _CODEX_STR),
    "write_stdin": re.compile(r"\bchars\s*:\s*" + _CODEX_STR),
    "view_image": re.compile(r"\bpath\s*:\s*" + _CODEX_STR),
    "web__run": re.compile(r"\b(?:q|query|url|location)\s*:\s*" + _CODEX_STR),
}
_CODEX_PATCH_FILE = re.compile(r"\*\*\* (?:Add|Update|Delete) File: ([^\n\\\"]+)")
_CODEX_INNER_LABEL = {"web__run": "web"}


def _codex_inner(text: str) -> list[str]:
    """exec 안에서 부른 도구 이름들 (순서대로, 중복 없이)."""
    return list(dict.fromkeys(m.group(1) for m in _CODEX_INNER.finditer(text)))


def _unquote(value: str) -> str:
    if value[:1] in {'"', "'"}:
        try:
            return str(json.loads(value)) if value[0] == '"' else value[1:-1]
        except ValueError:
            return value[1:-1]
    return value[1:-1]


def _codex_act(text: str) -> list[str] | None:
    """Codex exec 가 실제로 하는 일: [도구 이름, 한 줄 내용] (하단바 '지금 쓰는 도구'용)."""
    inner = _codex_inner(text)
    if not inner:
        return None
    tool = inner[0]
    detail = ""
    pattern = _CODEX_ARG.get(tool)
    if pattern:
        match = pattern.search(text)
        if match:
            detail = _unquote(match.group(1))
    elif tool == "apply_patch":
        files = _CODEX_PATCH_FILE.findall(text)
        detail = ", ".join(dict.fromkeys(f.strip() for f in files))
    return [_CODEX_INNER_LABEL.get(tool, tool), detail]


_MCP_PLUGIN = re.compile(r"^plugin_([A-Za-z0-9_.-]+?)_([A-Za-z0-9_.-]+)$")
_USE_NAME = re.compile(r"^[A-Za-z0-9_.:@/ -]{1,120}$")


def _use_of(name: str, data: Any, namespace: str = "") -> list[list[str]]:
    """도구 호출 하나가 무엇을 썼는지: [[종류, 이름], ...] (종류: skill · plugin · mcp · agent · builtin)."""
    if isinstance(data, str):
        try:
            parsed = json.loads(data)
        except ValueError:
            parsed = data
        data = parsed
    args = data if isinstance(data, dict) else {}
    uses: list[list[str]] = []

    def add(group: str, value: Any) -> None:
        if isinstance(value, str):
            value = value.strip()
            if value and _USE_NAME.match(value) and [group, value] not in uses:
                uses.append([group, value])

    if name == "Skill":
        skill = args.get("skill") or args.get("name")
        if isinstance(skill, str) and skill.strip():
            add("skill", skill)
            if ":" in skill:
                add("plugin", skill.split(":", 1)[0])
            return uses
    if name in {"Agent", "Task"}:
        add("agent", args.get("subagent_type") or "general-purpose")
        return uses
    if name == "spawn_agent":
        add(
            "agent",
            args.get("agent_type")
            or args.get("task_name")
            or args.get("role")
            or "default",
        )
        return uses
    if name.startswith("mcp__") and name.count("__") >= 2:
        server = name.split("__")[1]
        plugin = _MCP_PLUGIN.match(server)
        if plugin:
            add("plugin", plugin.group(1))
            server = plugin.group(2)
        add("mcp", server)
        return uses
    text = json.dumps(data, ensure_ascii=False) if not isinstance(data, str) else data
    inner = _codex_inner(text or "") if name == "exec" else []
    if inner:
        # Codex 코드 모드: exec 자체가 아니라 안에서 부른 도구를 센다
        for tool in inner:
            if tool.startswith("mcp__") and tool.count("__") >= 2:
                add("mcp", tool.split("__")[1])
            else:
                add("builtin", _CODEX_INNER_LABEL.get(tool, tool))
    else:
        add("builtin", name)
    # Codex 는 스킬을 도구가 아니라 SKILL.md 를 읽어서 쓴다 (플러그인 스킬: …/plugins/cache/<곳>/<플러그인>/<버전>/skills/<스킬>)
    for match in _CODEX_SKILL_FILE.finditer(text or ""):
        plugin, skill = match.group(1), match.group(2)
        add("skill", f"{plugin}:{skill}" if plugin else skill)
        if plugin:
            add("plugin", plugin)
    return uses


# ── 코드 변경 (diff): 터미널처럼 채팅에도 바뀐 줄을 보인다 ──
DIFF_MAX_LINES = 400  # 도구 호출 하나에서 보일 최대 줄 수 (넘으면 잘라 cut 표시)
DIFF_LINE_CHARS = 400
_PATCH_FILE = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")
_PATCH_MOVE = re.compile(r"^\*\*\* Move to: (.+)$")
_CODEX_PATCH_ARG = re.compile(
    r"\btools\.apply_patch\s*\(\s*(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`[^`]*`)"
)


_CODEX_PATCH_LITERAL = re.compile(
    r"(\"\*\*\* Begin Patch(?:[^\"\\]|\\.)*\"|'\*\*\* Begin Patch(?:[^'\\]|\\.)*'|`\*\*\* Begin Patch[^`]*`)"
)


class _DiffBudget:
    """한 도구 호출의 diff 전체 줄 수 한도."""

    def __init__(self) -> None:
        self.left = DIFF_MAX_LINES
        self.cut = False

    def take(self, lines: list[str]) -> list[str]:
        if len(lines) > self.left:
            self.cut = True
        kept = lines[: max(0, self.left)]
        self.left -= len(kept)
        return [
            line if len(line) <= DIFF_LINE_CHARS else line[:DIFF_LINE_CHARS] + "…"
            for line in kept
        ]


def _diff_file(path: Any, op: str = "update") -> dict:
    return {"file": str(path or ""), "op": op, "hunks": [], "add": 0, "del": 0}


def _count(diff: dict, lines: list[str]) -> None:
    diff["add"] += sum(1 for line in lines if line.startswith("+"))
    diff["del"] += sum(1 for line in lines if line.startswith("-"))


def _diff_strings(path: Any, old: Any, new: Any, budget: _DiffBudget) -> dict | None:
    """Edit 의 old_string → new_string (파일 속 줄 번호는 모른다)."""
    if not isinstance(old, str) or not isinstance(new, str):
        return None
    diff = _diff_file(path)
    rows = list(
        difflib.unified_diff(
            old.splitlines(), new.splitlines(), lineterm="", n=max(len(old), 3)
        )
    )[2:]
    hunk: list[str] = []
    for row in rows:
        if row.startswith("@@"):
            continue
        hunk.append(row if row[:1] in {"+", "-", " "} else " " + row)
    _count(diff, hunk)
    diff["hunks"].append({"o": None, "n": None, "lines": budget.take(hunk)})
    return diff


def _diff_structured(path: Any, patch: Any, budget: _DiffBudget) -> dict | None:
    """Claude 가 결과에 남기는 structuredPatch (실제 파일 줄 번호 포함)."""
    if not isinstance(patch, list) or not patch:
        return None
    diff = _diff_file(path)
    for hunk in patch:
        if not isinstance(hunk, dict) or not isinstance(hunk.get("lines"), list):
            continue
        lines = [str(line) for line in hunk["lines"]]
        _count(diff, lines)
        diff["hunks"].append(
            {
                "o": hunk.get("oldStart"),
                "n": hunk.get("newStart"),
                "lines": budget.take(lines),
            }
        )
    return diff if diff["hunks"] else None


def _diff_created(path: Any, content: Any, budget: _DiffBudget) -> dict | None:
    if not isinstance(content, str):
        return None
    diff = _diff_file(path, "add")
    lines = ["+" + line for line in content.splitlines()]
    _count(diff, lines)
    diff["hunks"].append({"o": None, "n": 1, "lines": budget.take(lines)})
    return diff


def _diffs_from_patch(text: str, budget: _DiffBudget) -> list[dict]:
    """Codex apply_patch 형식 (*** Begin Patch / *** Update File: … / @@ / +-)."""
    diffs: list[dict] = []
    current: dict | None = None
    lines: list[str] = []

    def flush() -> None:
        if current is not None and lines:
            _count(current, lines)
            current["hunks"].append({"o": None, "n": None, "lines": budget.take(lines)})
        lines.clear()

    for raw in text.splitlines():
        head = _PATCH_FILE.match(raw)
        if head:
            flush()
            op = {"Add": "add", "Update": "update", "Delete": "delete"}[head.group(1)]
            current = _diff_file(head.group(2).strip(), op)
            diffs.append(current)
            continue
        move = _PATCH_MOVE.match(raw)
        if move and current is not None:
            current["file"] += f" → {move.group(1).strip()}"
            continue
        if current is None or raw.startswith("*** "):
            continue
        if raw.startswith("@@"):
            flush()
            continue
        if raw[:1] in {"+", "-", " "}:
            lines.append(raw)
        elif raw == "":
            lines.append(" ")
    flush()
    return [d for d in diffs if d["hunks"] or d["op"] == "delete"]


def _tool_diffs(name: str, data: Any) -> list[dict]:
    """도구 입력에서 바로 알 수 있는 코드 변경 (결과가 오기 전에도 보인다)."""
    budget = _DiffBudget()
    if isinstance(data, str) and name in {"apply_patch", "exec"}:
        text = data
        if name == "exec":
            if "tools.apply_patch" not in data:
                return []
            match = _CODEX_PATCH_ARG.search(data)
            # 패치를 변수에 먼저 담는 경우: const patch = "*** Begin Patch…"; tools.apply_patch(patch)
            match = match or _CODEX_PATCH_LITERAL.search(data)
            if not match:
                return []
            text = _unquote(match.group(1))
        diffs = _diffs_from_patch(text, budget)
    elif isinstance(data, dict) and name in {"Edit", "MultiEdit", "Write"}:
        path = data.get("file_path")
        if name == "Write":
            diffs = [_diff_created(path, data.get("content"), budget)]
        elif name == "Edit":
            diffs = [
                _diff_strings(
                    path, data.get("old_string"), data.get("new_string"), budget
                )
            ]
        else:
            merged = _diff_file(path)
            for edit in data.get("edits") or []:
                if isinstance(edit, dict):
                    one = _diff_strings(
                        path, edit.get("old_string"), edit.get("new_string"), budget
                    )
                    if one:
                        merged["hunks"] += one["hunks"]
                        merged["add"] += one["add"]
                        merged["del"] += one["del"]
            diffs = [merged] if merged["hunks"] else []
    else:
        return []
    diffs = [d for d in diffs if d]
    if diffs and budget.cut:
        diffs[-1]["cut"] = True
    return diffs


def _result_diffs(result: Any) -> list[dict]:
    """Claude 결과(toolUseResult)의 structuredPatch: 실제 줄 번호가 있는 diff."""
    if not isinstance(result, dict):
        return []
    budget = _DiffBudget()
    diff = _diff_structured(
        result.get("filePath"), result.get("structuredPatch"), budget
    )
    if diff is None and result.get("type") == "create":
        diff = _diff_created(result.get("filePath"), result.get("content"), budget)
    if diff and budget.cut:
        diff["cut"] = True
    return [diff] if diff else []


def _encrypted(value: Any) -> bool:
    """Codex 가 암호화해 기록한 값 (Fernet 토큰)."""
    return isinstance(value, str) and value.startswith("gAAAAA") and " " not in value


def _parse_notification(text: str) -> dict:
    return {key: value.strip() for key, value in _NOTIFY_TAG.findall(text)}


class _Log:
    """한 로그 파일의 파싱 상태. 끝에 추가된 줄만 이어서 읽는다."""

    def __init__(self, path: Path, agent: str):
        self.path = path
        self.agent = agent
        # Claude 서브에이전트 기록(…/subagents/agent-*.jsonl)은 모든 줄이 isSidechain 이다
        self.sidechain = path.parent.name == "subagents"
        self.offset = 0
        self.size = 0
        self.items: list[dict] = []
        self.by_call: dict[str, dict] = {}
        self.title = ""
        # Claude Code 대기열: 작업 중에 입력해 아직 전달되지 않은 프롬프트 (queue-operation enqueue/remove)
        self.queue: list[str] = []
        # Codex 대기열은 로그에 남지 않는다 → 입력 기록과 맞춰 본다 (_codex_queued)
        self.turn_open = False
        self.stretch_start: float | None = None  # 턴이 이어지는 동안의 시작 시각
        self.stretch_users = 0  # 그동안 로그에 기록된 사용자 메시지 수
        self.turn_ended_at: float | None = None
        self.agent_names: dict[str, str] = {}  # Claude 서브에이전트 ID → 설명(이름)
        # Codex 서브에이전트 경로(/root/ground) → spawn_agent 도구 항목
        self.subagents: dict[str, dict] = {}
        # Codex: 사용자가 보내 시작된 턴인데 아직 그 프롬프트가 기록되지 않았다 (보내자마자 대화 압축을
        # 하면 압축이 끝날 때까지 기록되지 않는다) → 그 턴이 시작된 시각 (epoch 초)
        self.thread_id = ""
        self.awaiting: float | None = None
        # Claude: 턴이 끝났는가 (system turn_duration · 중단). 프롬프트 · 도구가 새로 오면 다시 진행 중.
        self.claude_done = True

    def _add(self, kind: str, text: str = "", ts: str = "", **extra) -> dict:
        item = {
            "id": len(self.items),
            "kind": kind,
            "text": _clip(text, MAX_TEXT),
            "ts": ts,
            **extra,
        }
        self.items.append(item)
        if kind in {"user", "tool"}:
            self.claude_done = False
        elif kind == "system" and text == "사용자가 중단함":
            self.claude_done = True
        return item

    def _user(self, content: Any, ts: str, **flags) -> str | None:
        """사용자 메시지 (첨부한 그림이 있으면 images 로)."""
        text = _blocks_text(content)
        images = _blocks_images(content)
        if images:
            text = "\n".join(
                line for line in text.splitlines() if line.strip() != _IMAGE_PLACEHOLDER
            ).strip()
            parsed = _user_text(text) if text else ("user", "")
        else:
            parsed = _user_text(text)
        if not parsed:
            return None
        extra = {"images": images} if images and parsed[0] == "user" else {}
        self._add(parsed[0], parsed[1], ts, **flags, **extra)
        return parsed[0]

    def _tool(
        self, call_id: str, name: str, data: Any, ts: str, namespace: str = ""
    ) -> None:
        summary = _tool_summary(name, data)
        if name == "SendMessage" and isinstance(data, dict):
            # 서브에이전트에게 추가 지시: "받는 에이전트 이름 · 요약"
            to = str(data.get("to") or "")
            note = data.get("summary") or data.get("message") or ""
            summary = _clip(
                f"{self.agent_names.get(to) or to} · {note}".strip(" ·"), MAX_SUMMARY
            )
        item = self._add(
            "tool",
            ts=ts,
            name=name,
            summary=summary,
            output=None,
            error=False,
            use=_use_of(name, data, namespace),
        )
        if name == "exec" and isinstance(data, str):
            act = _codex_act(data)
            if act:
                item["act"] = act
        diffs = _tool_diffs(name, data)
        if diffs:
            item["diffs"] = diffs
        if call_id:
            self.by_call[call_id] = item

    def _result(
        self, call_id: str, output: Any, error: bool = False, launched: Any = None
    ) -> None:
        item = self.by_call.get(call_id)
        if (
            item is not None
            and isinstance(launched, dict)
            and isinstance(launched.get("agentId"), str)
        ):
            self.agent_names[launched["agentId"]] = item.get("summary") or ""
            if item.get("name") in SUBAGENT_TOOLS:
                item["agent"] = launched[
                    "agentId"
                ]  # 펼치면 이 서브에이전트의 대화를 보여 준다
        if item is not None and item.get("name") in SUBAGENT_TOOLS:
            # 백그라운드로 띄운 서브에이전트: 지금은 '시작됨' 일 뿐 — 끝날 때(알림 · 최종 보고)까지 진행 중으로 둔다
            if (
                isinstance(launched, dict)
                and launched.get("status") == "async_launched"
            ):
                item["running"] = True
                return
            if item.get("name") == "spawn_agent":
                try:
                    path = (
                        json.loads(output).get("task_name")
                        if isinstance(output, str)
                        else None
                    )
                except (ValueError, AttributeError):
                    path = None
                if isinstance(path, str) and path:
                    self.subagents[path] = item
                    item["agent"] = path
                    item["running"] = True
                    return
        if item is not None and not error:
            diffs = _result_diffs(launched)
            if diffs:
                item["diffs"] = diffs  # 실제 파일 줄 번호가 있는 것으로 바꾼다
        if item is not None:
            item["output"] = _clip(
                _blocks_text(output) if not isinstance(output, str) else output,
                MAX_OUTPUT,
            )
            item["error"] = bool(error)

    def _subagent_done(
        self, tool: dict | None, name: str, status: str, text: str, ts: str
    ) -> None:
        """서브에이전트가 끝났다(또는 보고했다): 도구 항목을 완료로 바꾸고, 보고 내용을 채팅에 보인다."""
        failed = status in {"failed", "error", "killed", "cancelled"}
        if tool is not None and tool.get("running"):
            tool["running"] = False
            tool["output"] = _clip(text or status, MAX_OUTPUT)
            tool["error"] = failed
        self._add(
            "subagent",
            text,
            ts,
            name=name or "서브에이전트",
            status=status,
            ref=tool["id"] if tool is not None else None,
        )

    def _notification(self, text: str, ts: str) -> None:
        info = _parse_notification(text)
        tool = self.by_call.get(info.get("tool-use-id", ""))
        name = self.agent_names.get(info.get("task-id", "")) or (
            tool.get("summary") if tool and tool.get("name") in SUBAGENT_TOOLS else ""
        )
        if not name:
            match = re.search(r'Agent "(.+?)"', info.get("summary", ""))
            name = match.group(1) if match else info.get("summary", "")
        self._subagent_done(
            tool, name, info.get("status", "completed"), info.get("result", ""), ts
        )

    def _claude(self, d: dict) -> None:
        kind, ts = d.get("type"), d.get("timestamp") or ""
        if (
            kind == "system"
            and d.get("subtype") == "turn_duration"
            and not (d.get("isSidechain") and not self.sidechain)
        ):
            self.claude_done = True
        if kind == "ai-title" and isinstance(d.get("aiTitle"), str):
            self.title = d["aiTitle"]
        if kind == "queue-operation":
            text = d.get("content")
            operation = d.get("operation")
            if operation == "enqueue" and isinstance(text, str):
                self.queue.append(
                    text
                )  # 서브에이전트 알림도 여기 들어온다 — 보여 줄 때 뺀다 (read)
            elif operation in {"remove", "dequeue", "popAll", "clear"}:
                if operation in {"popAll", "clear"}:
                    self.queue.clear()
                elif isinstance(text, str) and text in self.queue:
                    self.queue.remove(text)
                elif self.queue:
                    self.queue.pop(0)  # dequeue 는 내용 없이 가장 오래된 것을 꺼낸다
            return
        # 작업 도중에 받은 메시지는 user 가 아니라 attachment(queued_command) 로 기록된다
        side = d.get("isSidechain") and not self.sidechain
        if kind == "attachment" and not side:
            att = d.get("attachment") or {}
            prompt = att.get("prompt") if isinstance(att, dict) else None
            # prompt 는 글(str)이거나, 그림을 붙였으면 블록 목록([{text}, {image}])이다
            if (
                isinstance(att, dict)
                and att.get("type") == "queued_command"
                and isinstance(prompt, (str, list))
            ):
                ts = d.get("timestamp") or ""
                text = prompt if isinstance(prompt, str) else _blocks_text(prompt)
                if text.lstrip().startswith(_NOTIFY):
                    self._notification(text, ts)
                    return
                self._user(prompt, ts, queued=True)
            return
        if kind not in {"user", "assistant"} or d.get("isMeta") or side:
            return
        if d.get("isCompactSummary") or d.get("isVisibleInTranscriptOnly"):
            # 대화 압축(/compact · 자동 압축) 요약: 사용자가 쓴 글이 아니다 → 한 줄 안내만
            self._add("system", COMPACTED, d.get("timestamp") or "")
            return
        content = (d.get("message") or {}).get("content")
        if kind == "user":
            if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            ):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        self._result(
                            block.get("tool_use_id", ""),
                            block.get("content"),
                            block.get("is_error", False),
                            d.get("toolUseResult"),
                        )
                return
            text = _blocks_text(content)
            if text.lstrip().startswith(_NOTIFY):
                self._notification(text, ts)
                return
            self._user(content, ts)
            return
        for block in content or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and (block.get("text") or "").strip():
                self._add("assistant", block["text"].strip(), ts)
            elif (
                block.get("type") == "thinking"
                and (block.get("thinking") or "").strip()
            ):
                # 요즘 Claude Code 는 실제 생각은 비워 두고(서명만), 작업 중에 사용자에게 보여 주는 진행 안내를
                # thinking 블록에 적는다 — 터미널은 이것을 일반 답변처럼 보여 주므로 채팅에도 넣는다.
                self._add("assistant", block["thinking"].strip(), ts)
            elif block.get("type") == "tool_use":
                self._tool(
                    block.get("id", ""),
                    block.get("name", "tool"),
                    block.get("input"),
                    ts,
                )

    def _codex(self, d: dict) -> None:
        kind, ts = d.get("type"), d.get("timestamp") or ""
        p = d.get("payload") or {}
        if kind == "compacted":
            # 대화 압축: 기록에는 지난 대화를 다시 담지만(replacement_history) 채팅에는 한 줄 안내만
            self._add("system", COMPACTED, ts)
            return
        if kind == "session_meta" and not self.thread_id:
            self.thread_id = str(p.get("id") or p.get("session_id") or "")
            return
        if kind == "event_msg":
            event = p.get("type")
            if event == "task_started":
                trigger = (p.get("turn_attribution") or {}).get("turn_trigger")
                self.awaiting = _epoch(ts) if trigger == "user" else None
                # 앞 턴이 끝나자마자 이어진 턴이면(대기 메시지 전달) 같은 묶음으로 센다
                started = _epoch(ts)
                ended = self.turn_ended_at
                if (
                    self.turn_open
                    or started is None
                    or ended is None
                    or started - ended > FOLLOW_UP_GAP
                ):
                    self.stretch_start, self.stretch_users = started, 0
                self.turn_open = True
            elif event in {"task_complete", "turn_aborted"}:
                self.awaiting = None
                self.turn_open = False
                # 중단(Esc)하면 대기 메시지는 입력창으로 돌아가거나 바로 전달된다 → 묶음을 끊는다
                self.turn_ended_at = _epoch(ts) if event == "task_complete" else None
            return
        if kind != "response_item":
            return
        ptype = p.get("type")
        if ptype == "message" and p.get("role") == "user":
            if self._user(p.get("content"), ts) == "user":
                self.awaiting = None
                self.stretch_users += 1
        elif ptype == "message" and p.get("role") == "assistant":
            text = _blocks_text(p.get("content")).strip()
            if text:
                self._add("assistant", text, ts)
        elif ptype == "agent_message":
            self._agent_message(p, ts)
        elif ptype in {"function_call", "custom_tool_call", "local_shell_call"}:
            self._tool(
                p.get("call_id", ""),
                p.get("name") or "shell",
                p.get("arguments") or p.get("input") or p.get("action"),
                ts,
                str(p.get("namespace") or ""),
            )
        elif ptype in {
            "function_call_output",
            "custom_tool_call_output",
            "local_shell_call_output",
        }:
            self._result(p.get("call_id", ""), p.get("output"))

    def _agent_message(self, p: dict, ts: str) -> None:
        """Codex 서브에이전트가 부모에게 보낸 메시지. 평문(최종 보고 등)만 보인다."""
        text = "".join(
            b.get("text", "")
            for b in p.get("content") or []
            if isinstance(b, dict)
            and b.get("type") in {"input_text", "output_text", "text"}
        )
        match = _AGENT_MSG.search(text)
        kind, body = (
            (match.group(1), match.group(2).strip()) if match else ("", text.strip())
        )
        author = str(p.get("author") or "")
        tool = self.subagents.get(author)
        final = kind.upper() == "FINAL_ANSWER"
        if not body:  # 암호화된 중간 메시지: 내용은 못 보지만 진행 중임은 그대로
            return
        name = author.rsplit("/", 1)[-1] or "서브에이전트"
        if final:
            self._subagent_done(tool, name, "completed", body, ts)
        else:
            self._add("subagent", body, ts, name=name, status="message", ref=None)

    def refresh(self) -> None:
        size = self.path.stat().st_size
        if size < self.offset:  # 파일이 새로 쓰였으면 처음부터
            self.__init__(self.path, self.agent)
        if size == self.offset:
            return
        with self.path.open("rb") as handle:
            handle.seek(self.offset)
            chunk = handle.read(size - self.offset)
        end = chunk.rfind(b"\n")
        if end < 0:
            return  # 아직 줄이 끝나지 않았다
        self.offset += end + 1
        for raw in chunk[: end + 1].splitlines():
            try:
                record = json.loads(raw)
            except ValueError:
                continue
            if isinstance(record, dict):
                (self._claude if self.agent == "claude" else self._codex)(record)


def _epoch(ts: str) -> float | None:
    try:
        return datetime.fromisoformat(ts).timestamp()
    except ValueError:
        return None


HISTORY_TAIL = 256 * 1024
FOLLOW_UP_GAP = 3.0
# 슬래시 명령은 대화에 메시지로 남지 않는다. "/home/me/a.pdf 참고해" 같은 경로는 일반 메시지다.
_SLASH_COMMAND = re.compile(r"/[\w-]+(?:\s|$)")


def _codex_history() -> Path:
    return _data_root("CODEX_DATA_DIR", ".codex") / "history.jsonl"


def history_mark() -> float:
    """Codex 입력 기록 파일이 바뀌었는지 보는 표시 (실시간 구독이 프롬프트를 늦게 받지 않게)."""
    try:
        return _codex_history().stat().st_mtime
    except OSError:
        return 0.0


def _codex_submitted(thread_id: str, since: float) -> str | None:
    """Codex 가 입력하자마자 적어 두는 ~/.codex/history.jsonl 에서, 그 턴을 시작한 프롬프트를 찾는다."""
    try:
        with _codex_history().open("rb") as handle:
            handle.seek(max(0, handle.seek(0, os.SEEK_END) - HISTORY_TAIL))
            lines = handle.read().splitlines()
    except OSError:
        return None
    # 그 턴을 시작한 입력 = 턴 시작 이후 첫 입력 (뒤의 것은 작업 중에 더 보낸 것)
    found = None
    for raw in reversed(lines):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("session_id") != thread_id:
            continue
        ts = entry.get("ts")
        if not isinstance(ts, (int, float)) or ts < since - 2:  # 기록은 초 단위(버림)
            break
        text = entry.get("text")
        if isinstance(text, str) and text.strip():
            found = text
    return found


def _codex_queued(thread_id: str, since: float, delivered: int) -> list[str]:
    """보냈지만 아직 로그에 없는 입력 (작업 중에 더 보낸 메시지).

    Codex 는 전달할 때에야 로그에 적지만 입력 기록에는 보낸 즉시 적고, 보낸 순서대로 전달한다.
    → 이번 묶음의 입력 중 앞의 delivered 개를 뺀 나머지가 대기 중이다.
    """
    try:
        with _codex_history().open("rb") as handle:
            handle.seek(max(0, handle.seek(0, os.SEEK_END) - HISTORY_TAIL))
            lines = handle.read().splitlines()
    except OSError:
        return []
    entries: list[str] = []
    for raw in reversed(lines):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("session_id") != thread_id:
            continue
        ts = entry.get("ts")
        if not isinstance(ts, (int, float)) or ts < since - 2:  # 기록은 초 단위(버림)
            break
        text = entry.get("text")
        if (
            isinstance(text, str)
            and text.strip()
            and not _SLASH_COMMAND.match(text.strip())
        ):
            entries.append(text)
    entries.reverse()
    return entries[delivered:]


_cache: "OrderedDict[str, _Log]" = OrderedDict()
_lock = threading.Lock()


def _cached_log(path: Path, agent: str) -> _Log:
    """(_lock 안에서) 캐시된 기록을 최신으로 맞춰 돌려준다."""
    key = str(path)
    log = _cache.get(key)
    if log is None or log.agent != agent:
        log = _Log(path, agent)
        _cache[key] = log
    _cache.move_to_end(key)
    while len(_cache) > CACHE_FILES:
        _cache.popitem(last=False)
    log.refresh()
    return log


def all_items(path: Path, agent: str) -> list[dict]:
    """대화 전체 항목 (다른 에이전트로 대화를 넘길 때)."""
    with _lock:
        return [dict(item) for item in _cached_log(path, agent).items]


SEARCH_MAX_TERMS = 8
SEARCH_SNIPPET = 140


def _final_answer_ids(items: list[dict]) -> set[int]:
    """에이전트 최종 답변: 사용자 프롬프트 사이마다 마지막 답변 하나 (중간 진행 안내는 뺀다)."""
    finals: set[int] = set()
    last: int | None = None
    for item in items:
        kind = item.get("kind")
        if kind == "user":
            if last is not None:
                finals.add(last)
            last = None
        elif kind == "assistant":
            last = item["id"]
    if last is not None:
        finals.add(last)
    return finals


def _snippet(text: str, terms: list[str]) -> tuple[str, int]:
    """첫 번째로 맞은 곳 앞뒤만 (한 줄로). (조각, 조각 안에서 맞은 위치)"""
    flat = " ".join(text.split())
    lower = flat.lower()
    hits = [lower.find(term) for term in terms if term in lower]
    at = min(hits) if hits else 0
    begin = max(0, at - SEARCH_SNIPPET // 3)
    end = min(len(flat), begin + SEARCH_SNIPPET)
    begin = max(0, min(begin, end - SEARCH_SNIPPET))
    piece = flat[begin:end]
    return ("…" if begin else "") + piece + ("…" if end < len(flat) else ""), at


def search(path: Path, agent: str, query: str, limit: int = 100) -> dict:
    """대화 전체에서 사용자 프롬프트와 에이전트 최종 답변만 찾는다 (도구 · 중간 안내 · 서브에이전트 제외).

    띄어쓰기로 나눈 낱말이 모두 들어 있는 메시지 (대소문자 무시). 최신 것부터.
    """
    terms = list(dict.fromkeys(t.lower() for t in query.split() if t))[
        :SEARCH_MAX_TERMS
    ]
    limit = max(1, min(int(limit), 300))
    if not terms:
        return {"total": 0, "items": [], "matches": 0, "truncated": False}
    with _lock:
        log = _cached_log(path, agent)
        items = [
            (item["id"], item["kind"], item.get("ts") or "", item.get("text") or "")
            for item in log.items
            if item.get("kind") in {"user", "assistant"}
        ]
        finals = _final_answer_ids(log.items)
        total = len(log.items)
    found = []
    for item_id, kind, ts, text in reversed(items):
        if kind == "assistant" and item_id not in finals:
            continue
        lower = text.lower()
        if all(term in lower for term in terms):
            found.append((item_id, kind, ts, text))
    results = []
    for item_id, kind, ts, text in found[:limit]:
        snippet, _ = _snippet(text, terms)
        results.append({"id": item_id, "kind": kind, "ts": ts, "snippet": snippet})
    return {
        "total": total,
        "items": results,
        "matches": len(found),
        "truncated": len(found) > limit,
    }


USAGE_GROUPS = ("skill", "plugin", "mcp", "agent", "builtin")


def _one_line(text: Any, limit: int) -> str:
    """하단바용 한 줄: 첫 줄만, 공백 정리, 길면 … 로 자른다."""
    line = " ".join(str(text or "").split("\n", 1)[0].split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


def usage(path: Path, agent: str) -> dict:
    """이 대화에서 쓴 스킬 · 플러그인 · MCP 서버 · 서브에이전트 · 내장 도구.

    recent: 마지막 프롬프트 이후(지금 / 방금) 쓴 것. 상태는 running(실행 중) · error(오류) · ok(사용).
    """
    with _lock:
        log = _cached_log(path, agent)
        tools = []
        last_user = -1
        last_tool = None
        for item in log.items:
            if item.get("kind") == "user":
                last_user = item["id"]
                last_tool = None
            elif item.get("kind") == "tool":
                last_tool = item
            if item.get("kind") == "tool" and item.get("use"):
                running = bool(item.get("running")) or item.get("output") is None
                tools.append(
                    (item["id"], item["use"], running, bool(item.get("error")))
                )
        # 지금 답변 중인가: 기록에 턴 끝 표시가 있으면 바로 쉬는 중 (화면 표시보다 빠르고 정확하다)
        busy = log.turn_open if agent == "codex" else not log.claude_done
        # 지금 쓰는 도구 (실행 중인 것 중 마지막, 없으면 이번 질문의 마지막 도구)
        running_now = [
            item
            for item in log.items[last_user + 1 :]
            if item.get("kind") == "tool"
            and (item.get("running") or item.get("output") is None)
        ]
        pick = running_now[-1] if running_now else last_tool
        current = (
            {
                "name": (pick.get("act") or [pick.get("name")])[0] or "",
                "summary": _one_line(
                    pick["act"][1] if pick.get("act") else pick.get("summary"), 100
                ),
                "running": bool(running_now),
                "use": pick.get("use") or [],
                "more": max(0, len(running_now) - 1),
            }
            if busy and pick is not None
            else None
        )
    total: dict[tuple[str, str], dict] = {}
    recent: dict[tuple[str, str], dict] = {}
    for item_id, uses, running, error in tools:
        # 결과가 없는 도구 호출: 마지막 프롬프트 이후 것만 실행 중으로 본다 (예전 것은 중단된 것)
        live = busy and running and item_id > last_user
        state = "running" if live else "error" if error else "ok"
        for group, name in uses:
            for bucket, on in ((total, True), (recent, item_id > last_user)):
                if not on:
                    continue
                row = bucket.setdefault(
                    (group, name),
                    {
                        "group": group,
                        "name": name,
                        "count": 0,
                        "state": "ok",
                        "last": 0,
                    },
                )
                row["count"] += 1
                row["last"] = item_id
                if state == "running" or (state == "error" and row["state"] == "ok"):
                    row["state"] = state
                elif state == "ok" and row["state"] == "error" and bucket is recent:
                    row["state"] = "ok"  # 다시 해서 됐으면 사용으로
    for (group, name), row in total.items():
        row["recent"] = recent.get((group, name), {}).get("count", 0)
        if (group, name) in recent:
            row["state"] = recent[(group, name)]["state"]
        elif row["state"] == "running":
            row["state"] = "ok"
    order = {group: index for index, group in enumerate(USAGE_GROUPS)}
    recent_rows = sorted(recent.values(), key=lambda r: (order[r["group"]], -r["last"]))
    groups = []
    for group in USAGE_GROUPS:
        rows = sorted(
            (r for r in total.values() if r["group"] == group),
            key=lambda r: (-r["count"], r["name"].lower()),
        )
        groups.append({"group": group, "items": rows})
    states = [r["state"] for r in recent_rows]
    return {
        "recent": recent_rows,
        "groups": groups,
        "running": states.count("running"),
        "used": states.count("ok"),
        "errors": states.count("error"),
        "total": len(total),
        "busy": busy,
        "current": current,
    }


def read(path: Path, agent: str, start: int | None, limit: int) -> dict:
    """items[start:start+limit]. start 가 None 이면 마지막 limit 개."""
    limit = max(1, min(int(limit), 300))
    with _lock:
        log = _cached_log(path, agent)
        total = len(log.items)
        if start is None:
            start = max(0, total - limit)
        start = max(0, min(int(start), total))
        items = [dict(item) for item in log.items[start : start + limit]]
        # 서브에이전트가 끝나면 앞쪽(이미 받아 간) 도구 항목도 바뀐다 → 함께 보낸다
        refs = {
            item["ref"]
            for item in items
            if isinstance(item.get("ref"), int) and item["ref"] < start
        }
        related = [dict(log.items[i]) for i in sorted(refs) if i < total]
        title, queue = log.title, list(log.queue)
        awaiting, thread_id = log.awaiting, log.thread_id
        turn_open, stretch_start = log.turn_open, log.stretch_start
        stretch_users = log.stretch_users
    # 보낸 프롬프트가 아직 기록되지 않은 턴 (예: 대화 압축 중)
    submitted = (
        _codex_submitted(thread_id, awaiting)
        if agent == "codex" and awaiting is not None and thread_id
        else None
    )
    if agent == "codex" and turn_open and stretch_start is not None and thread_id:
        queue = _codex_queued(thread_id, stretch_start, stretch_users)
        if submitted and queue and queue[0] == submitted:
            queue = queue[1:]  # 턴을 시작한 입력은 "전달됨"으로 따로 보여 준다
    return {
        "related": related,
        "total": total,
        "start": start,
        "items": items,
        "title": title,
        "file": path.name,
        "queued": [
            _clip(_PASTED_TAG.sub("", text).strip(), MAX_TEXT)
            for text in queue
            if not text.lstrip().startswith(_NOTIFY)
        ],
        "submitted": [_clip(_PASTED_TAG.sub("", submitted).strip(), MAX_TEXT)]
        if submitted
        else [],
        # 작업 중에는 입력 기록 파일이 바뀌면 다시 읽어야 한다 (터미널에서 더 보낸 메시지 · 늦게 적힌 프롬프트)
        "awaiting": agent == "codex" and (turn_open or awaiting is not None),
    }


# Claude 의 /model 결과 줄 (버전에 따라 모양이 다르다)
#   예전: type=user,   message.content = "<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m and saved as ...</local-command-stdout>"
#   요즘: type=system, content         = "<local-command-stdout>Set model to `Opus 5.5` and saved as ...</local-command-stdout>"
#   실패: "<local-command-stdout>API error: 400 {... "message":"Claude Code 2.1.269 does not support this model; ..."}</local-command-stdout>"
_MODEL_SET = re.compile(
    r"<local-command-stdout>\s*(?:Set model to|Kept model as)\s+(.+?)(?:\s+and saved\b[^<]*|\s+for this session\b[^<]*)?\s*</local-command-stdout>",
    re.DOTALL,
)
_STDOUT = re.compile(r"<local-command-stdout>(.*?)</local-command-stdout>", re.DOTALL)
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _local_command_text(record: dict) -> str | None:
    """로컬 명령(/model 등) 기록이면 그 글자, 아니면 None."""
    if record.get("type") not in {"user", "system"}:
        return None
    content = record.get("content")
    if not isinstance(content, str):
        message = (
            record.get("message") if isinstance(record.get("message"), dict) else {}
        )
        content = message.get("content")
    if (
        not isinstance(content, str)
        or "<local-command-" not in content
        and "<command-name>" not in content
    ):
        return None
    return _ANSI.sub("", content)


def _model_set_name(text: str) -> str | None:
    match = _MODEL_SET.search(text)
    name = match.group(1).strip().strip("`*").strip().rstrip(".") if match else ""
    return name[:80] or None


def _model_error(text: str) -> str | None:
    """/model 이 실패했을 때 사람이 읽을 메시지."""
    match = _STDOUT.search(text)
    body = match.group(1).strip() if match else ""
    if (
        not body.lower().startswith(
            ("api error", "error", "invalid model", "model not found")
        )
        and "not support" not in body
    ):
        return None
    inner = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"', body)
    message = (
        inner.group(1).encode().decode("unicode_escape", errors="ignore")
        if inner
        else body
    )
    return message[:300]


def model_status(path: Path, agent: str | None) -> dict:
    """세션 로그 끝부분에서 지금 모델과, 가장 최근 /model 이 실패했으면 그 오류.

    Claude: 가장 최근의 assistant 메시지 model, 또는 그보다 뒤에 있는 /model 결과("Set model to …")의 표시 이름.
            그보다 더 뒤에 /model 실패(API 오류 등)가 있으면 error · error_at 도 준다.
    Codex: turn_context 의 model.
    """
    result: dict = {"model": None, "error": None, "error_at": None}
    try:
        with path.open("rb") as handle:
            handle.seek(max(0, path.stat().st_size - 1024 * 1024))
            lines = handle.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return result
    pending_error: tuple[str, str | None] | None = None
    for line in reversed(lines):
        if "model" not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        if agent == "codex":
            payload = (
                record.get("payload") if isinstance(record.get("payload"), dict) else {}
            )
            if record.get("type") == "turn_context" and isinstance(
                payload.get("model"), str
            ):
                result["model"] = payload["model"]
                return result
            continue
        text = _local_command_text(record)
        if text is not None:
            switched = _model_set_name(text)
            if switched:
                result["model"] = switched
                return result
            if "<command-name>/model</command-name>" in text:
                # 뒤(더 최근)에서 본 실패가 이 /model 의 결과였다
                if pending_error and result["error"] is None:
                    result["error"], result["error_at"] = pending_error
                pending_error = None
                continue
            error = _model_error(text)
            if error and pending_error is None and result["error"] is None:
                pending_error = (error, record.get("timestamp"))
            continue
        message = (
            record.get("message") if isinstance(record.get("message"), dict) else {}
        )
        model = message.get("model")
        if (
            record.get("type") == "assistant"
            and isinstance(model, str)
            and model
            and not model.startswith("<")
        ):
            result["model"] = model
            return result
    return result


def current_model(path: Path, agent: str | None) -> str | None:
    return model_status(path, agent)["model"]


_ALIASES = {
    "opus": "Opus",
    "sonnet": "Sonnet",
    "haiku": "Haiku",
    "fable": "Fable",
    "default": "기본 모델",
}


def claude_default_model() -> str | None:
    """Claude 기본 모델 (~/.claude/settings.json 의 model) — 새 대화라 기록에 모델이 아직 없을 때."""
    path = _data_root("CLAUDE_DATA_DIR", ".claude") / "settings.json"
    try:
        model = json.loads(path.read_text(encoding="utf-8")).get("model")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(model, str) or not model.strip():
        return None
    model = model.strip()[:60]
    base = model.split("[")[0].lower()
    return _ALIASES.get(base, model) + (" (1M)" if "[1m]" in model.lower() else "")
