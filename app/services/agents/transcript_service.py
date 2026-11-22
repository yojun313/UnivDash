"""Agent conversations (Claude Code / Codex session logs).

Claude Code redraws the whole screen on tmux's alternate screen, so the conversation does not stay in the
tmux scrollback. Instead the session log (JSONL) written by the agent itself is read to show the whole conversation.

pane → finding the log file (no guessing, based on the running process):
- Claude Code: sessionId in ~/.claude/sessions/<pid>.json → ~/.claude/projects/*/<sessionId>.jsonl
- Codex: the ~/.codex/sessions/**/rollout-*.jsonl the process holds open (/proc/<pid>/fd)
Every file path is decided by the server, and nothing outside the agents' data folders is read.
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
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil

from app.i18n import N_, _

SESSION_ID = re.compile(r"^[0-9a-fA-F-]{16,64}$")
MAX_TEXT = 20000
MAX_OUTPUT = 4000
MAX_SUMMARY = 300
# Comfortably more than the number of agent windows: if too few, every status check re-parses all logs from the start
CACHE_FILES = 96

# Images the user attached: the base64 in the log is decoded only once into a cache file, and only its name
# (content hash) goes into the item
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
# Codex puts <image name=[Image #1] path="…"> · </image> text before and after an image
_CODEX_IMAGE_TAG = re.compile(r"^\s*(?:<image\b[^>]*>|</image>)\s*$")
_IMAGE_PLACEHOLDER = "[이미지]"

# Context injected by the agent that looks like user input is hidden.
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
# Internal instructions that Codex goal mode etc. put into user messages (they may also come attached mid-text)
_CODEX_INTERNAL = re.compile(
    r"<codex_internal_context\b[^>]*>.*?(?:</codex_internal_context>|\Z)", re.DOTALL
)
# System lines stored in chat items stay untranslated Korean constants: they are cached per log file and compared
# by text elsewhere (tmux_service: items[-1]["text"] == COMPACTED).
COMPACTED = "대화가 길어 압축(compact)됐습니다"
# The first instruction sent to the new agent by the dashboard's 'conversation handoff' (agent_restart._handoff_prompt)
_HANDOFF_PREFIX = "이 작업은 다른 에이전트("
# Claude Code wraps pasted text in <pasted_content id="N"> … </pasted_content id="N"> (only the content is kept)
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


# ── pane → log file ─────────────────────────────────────────────────────────


# Agent → executable name (same as tmux_service.AGENT_BIN; kept separately to avoid importing each other)
_AGENT_BIN = {"gemini": "agy"}


def _agent_process(pane_pid: int, agent: str) -> psutil.Process | None:
    try:
        root = psutil.Process(pane_pid)
        binary = _AGENT_BIN.get(agent, agent)
        for proc in [root, *root.children(recursive=True)]:
            try:
                if proc.name() == binary:
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


# The first rollout line (session_meta) never changes, so it is remembered: path → {"cwd", "sub"}
_meta_cache: dict[str, dict | None] = {}


def _rollout_meta(path: Path) -> dict | None:
    key = str(path)
    if key in _meta_cache:
        return _meta_cache[key]
    try:
        with path.open("rb") as handle:
            first = json.loads(handle.readline(8 * 1024 * 1024))
    except (OSError, ValueError):
        return None  # it may still be being written, so do not remember it
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
            # A subagent's (thread_spawn) conversation: created separately in the same working folder, but not
            # the user's conversation
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
    """The new conversation of a window started with `codex fork <ID>`: the first log forked from ID after that process started."""
    try:
        started = proc.create_time()
    except psutil.Error:
        return None
    key = (proc.pid, started)
    cached = _fork_cache.get(key)
    if cached is not None and cached.exists():
        return cached
    earliest = time.strftime("rollout-%Y-%m-%dT%H-%M-%S", time.localtime(started - 60))
    # File names are in time order, so sorting by name yields the earliest first
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
    # A window started with `codex resume <ID>` certainly uses that conversation's log (the shared daemon holds
    # the file open, so the method below often cannot find it)
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
            # Guessing from the folder's recent conversations would mistake the original window's conversation
            # for its own → if there is none yet, return none
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
    # When the file is closed for a moment: the most recent session of the same working folder (if the folder
    # was renamed, the start path is searched too)
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


# ── Gemini (Antigravity CLI · agy) ──
# Each conversation is written step by step to
# ~/.gemini/antigravity-cli/brain/<conversation ID>/.system_generated/logs/transcript_full.jsonl.
_GEMINI_LOG = (".system_generated", "logs", "transcript_full.jsonl")
_GEMINI_OPEN = re.compile(
    r"/(?:presence|conversations)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:lock|db)$"
)


def gemini_root() -> Path:
    return _data_root("GEMINI_DATA_DIR", ".gemini/antigravity-cli")


def gemini_log_path(conversation_id: str) -> Path | None:
    """Conversation ID → log file (None if it does not exist yet)."""
    if not _RESUME_ID.match(conversation_id or ""):
        return None
    root = gemini_root()
    path = root.joinpath("brain", conversation_id, *_GEMINI_LOG)
    return path if path.is_file() and _inside(path, root) else None


_gemini_summary_cache: tuple[int, dict[str, dict]] = (0, {})


def gemini_summaries() -> dict[str, dict]:
    """Conversation ID → {"title", "cwd", "parent"} (Antigravity CLI's conversation_summaries.db, read-only)."""
    global _gemini_summary_cache
    path = gemini_root() / "conversation_summaries.db"
    try:
        wal = path.with_name(path.name + "-wal")
        version = path.stat().st_mtime_ns + (
            wal.stat().st_mtime_ns if wal.exists() else 0
        )
    except OSError:
        return {}
    if _gemini_summary_cache[0] == version:
        return _gemini_summary_cache[1]
    import sqlite3
    from urllib.parse import unquote, urlsplit

    found: dict[str, dict] = {}
    try:
        with closing(
            sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.0)
        ) as db:
            rows = db.execute(
                "select conversation_id, title, workspace_uris, parent_conversation_id"
                " from conversation_summaries"
            ).fetchall()
    except sqlite3.Error:
        return _gemini_summary_cache[1]
    for conversation, title, uris, parent in rows:
        cwd = None
        try:
            first = (json.loads(uris) or [None])[0] if uris else None
        except (ValueError, TypeError, IndexError):
            first = None
        if isinstance(first, str) and first.startswith("file://"):
            cwd = unquote(urlsplit(first).path) or None
        found[str(conversation)] = {
            "title": str(title or "")[:200],
            "cwd": cwd,
            "parent": str(parent or ""),
        }
    _gemini_summary_cache = (version, found)
    return found


def _gemini_log(proc: psutil.Process) -> Path | None:
    # The process holds the current conversation's lock file (presence/<ID>.lock) · DB (conversations/<ID>.db)
    # open (also correct for a conversation changed by /clear)
    try:
        for handle in proc.open_files():
            match = _GEMINI_OPEN.search(handle.path)
            if match:
                found = gemini_log_path(match.group(1))
                if found:
                    return found
    except psutil.Error:
        pass
    # Before the first prompt: if started with `agy --conversation <ID>`, that conversation
    try:
        argv = proc.cmdline()
    except psutil.Error:
        return None
    for index, arg in enumerate(argv):
        value = (
            arg.split("=", 1)[1]
            if arg.startswith("--conversation=")
            else argv[index + 1]
            if arg == "--conversation" and index + 1 < len(argv)
            else ""
        )
        if value:
            return gemini_log_path(value)
    return None


def find_log(pane_pid: int, agent: str | None, cwd: str) -> Path | None:
    if agent not in {"claude", "codex", "gemini"}:
        return None
    proc = _agent_process(pane_pid, agent)
    if proc is None:
        return None
    if agent == "gemini":
        return _gemini_log(proc)
    return _claude_log(proc) if agent == "claude" else _codex_log(proc, cwd)


def conversation_id(log: Path | None) -> str:
    """Log file → conversation (session) ID. For Claude · Codex it is in the file name, for Gemini in the folder name."""
    ids = _ANY_ID.findall(str(log)) if log else []
    return ids[-1] if ids else ""


_ANY_ID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)


_AGENT_KEY = re.compile(r"^(?:[A-Za-z0-9_-]{1,64}|(?:/[A-Za-z0-9_.-]{1,64}){1,8})$")
_sub_cache: dict[tuple[str, str], Path] = {}


def find_subagent_log(main: Path, agent: str | None, key: str) -> Path | None:
    """Log file of a subagent (key: Claude agentId · Codex /root/name) of the main conversation log (main)."""
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
            # A subagent is created after its parent, so only files whose name (time order) follows the parent's are checked
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


# ── Parsing ──────────────────────────────────────────────────────────────────


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
    """Put a base64 image into the cache and return its file name (the same image is decoded only once)."""
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
    """Images attached to a user message (Claude: image · base64, Codex: input_image · data URL)."""
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
    """(kind, text) — None for injected context. Slash commands become system."""
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
        return "system", f"{agent} 에서 넘겨받은 대화 기록을 읽고 이어 갑니다"
    if stripped.startswith("[Request interrupted"):
        return "system", "사용자가 중단함"
    return "user", stripped


# ── Subagents ──
# Claude: when an Agent started in the background finishes, "<task-notification>…" is injected like a user
# message (not written by the user)
_NOTIFY = "<task-notification>"
_NOTIFY_TAG = re.compile(
    r"<(task-id|tool-use-id|status|summary|result)>(.*?)</\1>", re.DOTALL
)
# Codex: subagent → parent message (agent_message). Intermediate messages are encrypted; only the final report is plain text.
_AGENT_MSG = re.compile(r"Message Type:\s*(\w+).*?Payload:\n?(.*)", re.DOTALL)
SUBAGENT_TOOLS = {"Agent", "Task", "spawn_agent"}

# ── Usage (skills · plugins · MCP servers · subagents · built-in tools) ──
_CODEX_SKILL_FILE = re.compile(
    r"(?:/plugins/cache/[^/\s\"']+/([A-Za-z0-9_.-]{1,80})/[^/\s\"']+)?/skills/([A-Za-z0-9_.:-]{1,80})/SKILL\.md\b"
)
# Codex code mode: a single exec calls tools.exec_command(...) · tools.apply_patch(...) etc. inside it
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
    """Names of the tools called inside an exec (in order, without duplicates)."""
    return list(dict.fromkeys(m.group(1) for m in _CODEX_INNER.finditer(text)))


def _unquote(value: str) -> str:
    if value[:1] in {'"', "'"}:
        try:
            return str(json.loads(value)) if value[0] == '"' else value[1:-1]
        except ValueError:
            return value[1:-1]
    return value[1:-1]


def _codex_act(text: str) -> list[str] | None:
    """What a Codex exec actually does: [tool name, one-line content] (for the bottom bar's 'tool in use now')."""
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
    """What one tool call used: [[kind, name], ...] (kind: skill · plugin · mcp · agent · builtin)."""
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
        # Codex code mode: count the tools called inside, not the exec itself
        for tool in inner:
            if tool.startswith("mcp__") and tool.count("__") >= 2:
                add("mcp", tool.split("__")[1])
            else:
                add("builtin", _CODEX_INNER_LABEL.get(tool, tool))
    else:
        add("builtin", name)
    # Codex uses a skill by reading its SKILL.md, not as a tool
    # (plugin skill: …/plugins/cache/<source>/<plugin>/<version>/skills/<skill>)
    for match in _CODEX_SKILL_FILE.finditer(text or ""):
        plugin, skill = match.group(1), match.group(2)
        add("skill", f"{plugin}:{skill}" if plugin else skill)
        if plugin:
            add("plugin", plugin)
    return uses


# ── Code changes (diff): the changed lines are shown in chat too, like in the terminal ──
# Maximum lines shown for one tool call (beyond that it is truncated and marked cut)
DIFF_MAX_LINES = 400
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
    """Limit on the total diff lines of one tool call."""

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
    """Edit's old_string → new_string (line numbers within the file are unknown)."""
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
    """The structuredPatch Claude leaves in the result (with real file line numbers)."""
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
    """Codex apply_patch format (*** Begin Patch / *** Update File: … / @@ / +-)."""
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
    """Code changes known directly from the tool input (shown even before the result arrives)."""
    budget = _DiffBudget()
    if isinstance(data, str) and name in {"apply_patch", "exec"}:
        text = data
        if name == "exec":
            if "tools.apply_patch" not in data:
                return []
            match = _CODEX_PATCH_ARG.search(data)
            # When the patch is put in a variable first: const patch = "*** Begin Patch…"; tools.apply_patch(patch)
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
    """structuredPatch of a Claude result (toolUseResult): a diff with real line numbers."""
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
    """A value Codex logged encrypted (Fernet token)."""
    return isinstance(value, str) and value.startswith("gAAAAA") and " " not in value


def _parse_notification(text: str) -> dict:
    return {key: value.strip() for key, value in _NOTIFY_TAG.findall(text)}


class _Log:
    """Parsing state of one log file. Only lines appended at the end are read on."""

    def __init__(self, path: Path, agent: str):
        self.path = path
        self.agent = agent
        # In a Claude subagent log (…/subagents/agent-*.jsonl) every line is isSidechain
        self.sidechain = path.parent.name == "subagents"
        self.offset = 0
        self.size = 0
        self.items: list[dict] = []
        self.by_call: dict[str, dict] = {}
        self.title = ""
        # Claude Code queue: prompts typed while working and not delivered yet (queue-operation enqueue/remove)
        self.queue: list[str] = []
        # The Codex queue is not logged → it is matched against the input history (_codex_queued)
        self.turn_open = False
        # Start time of the stretch while turns keep following one another
        self.stretch_start: float | None = None
        self.stretch_users = 0  # user messages logged during that stretch
        self.turn_ended_at: float | None = None
        # Claude subagent ID → description (name)
        self.agent_names: dict[str, str] = {}
        # Codex subagent path (/root/ground) → spawn_agent tool item
        self.subagents: dict[str, dict] = {}
        # Codex: a turn started by the user whose prompt is not logged yet (if the conversation is compacted
        # right after sending, it is not logged until the compaction ends) → when that turn started (epoch seconds)
        self.thread_id = ""
        self.awaiting: float | None = None
        # Claude: whether the turn has ended (system turn_duration · interrupt). In progress again when a new
        # prompt · tool arrives.
        self.claude_done = True
        # Gemini: tool results are written separately in call order, without a call ID → calls still awaiting a result
        self.gemini_pending: list[str] = []

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
        """A user message (attached images, if any, go into images)."""
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
            # Further instruction to a subagent: "recipient agent name · summary"
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
                # Expanding it shows this subagent's conversation
                item["agent"] = launched["agentId"]
        if item is not None and item.get("name") in SUBAGENT_TOOLS:
            # A subagent started in the background: for now it is only 'started' — kept in progress until it
            # ends (notification · final report)
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
                item["diffs"] = diffs  # replaced by the one with real file line numbers
        if item is not None:
            item["output"] = _clip(
                _blocks_text(output) if not isinstance(output, str) else output,
                MAX_OUTPUT,
            )
            item["error"] = bool(error)

    def _subagent_done(
        self, tool: dict | None, name: str, status: str, text: str, ts: str
    ) -> None:
        """A subagent finished (or reported): mark the tool item done and show the report in chat."""
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
                # Subagent notifications arrive here too — they are left out when shown (read)
                self.queue.append(text)
            elif operation in {"remove", "dequeue", "popAll", "clear"}:
                if operation in {"popAll", "clear"}:
                    self.queue.clear()
                elif isinstance(text, str) and text in self.queue:
                    self.queue.remove(text)
                elif self.queue:
                    # dequeue takes out the oldest one, without content
                    self.queue.pop(0)
            return
        # A message received mid-work is logged as an attachment (queued_command), not as user
        side = d.get("isSidechain") and not self.sidechain
        if kind == "attachment" and not side:
            att = d.get("attachment") or {}
            prompt = att.get("prompt") if isinstance(att, dict) else None
            # prompt is text (str) or, when an image is attached, a list of blocks ([{text}, {image}])
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
            # Compaction (/compact · auto-compact) summary: not written by the user → just a one-line notice
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
                # Recent Claude Code leaves the actual thinking empty (signature only) and writes the progress
                # notes shown to the user while working into thinking blocks — the terminal shows them like a
                # normal answer, so they go into chat too.
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
            # Compaction: the log holds the past conversation again (replacement_history), but chat gets only a one-line notice
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
                # A turn that follows right after the previous one ended (a queued message delivered) counts as the same stretch
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
                # On an interrupt (Esc) queued messages go back to the input box or are delivered right away → end the stretch
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

    def _gemini(self, d: dict) -> None:
        """One line of Antigravity CLI's transcript_full.jsonl (one step)."""
        kind, ts = d.get("type"), str(d.get("created_at") or "")
        content = d.get("content") if isinstance(d.get("content"), str) else ""
        if kind == "USER_INPUT":
            match = _GEMINI_REQUEST.search(content)
            text = (match.group(1) if match else _GEMINI_META.sub("", content)).strip()
            self.gemini_pending.clear()
            if text:
                self._user(text, ts)
        elif kind == "PLANNER_RESPONSE":
            thinking = d.get("thinking")
            if isinstance(thinking, str) and thinking.strip() and not content.strip():
                self._add("assistant", thinking.strip(), ts)
            if content.strip():
                self._add("assistant", content.strip(), ts)
            calls = [c for c in d.get("tool_calls") or [] if isinstance(c, dict)]
            for number, call in enumerate(calls):
                call_id = f"g{d.get('step_index')}-{number}"
                name = str(call.get("name") or "tool")
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                self._tool(call_id, name, _gemini_args(args), ts)
                diffs = _gemini_diffs(name, args)
                if diffs:
                    self.by_call[call_id]["diffs"] = diffs
                self.gemini_pending.append(call_id)
            if not calls:
                # An answer without tools means the turn has ended
                self.claude_done = True
        elif kind == "GENERIC":
            if self.gemini_pending:
                output = _GEMINI_STAMP.sub("", content).strip()
                failed = _GEMINI_EXIT.search(output)
                self._result(
                    self.gemini_pending.pop(0),
                    output,
                    bool(failed and failed.group(1) != "0"),
                )
        elif isinstance(kind, str) and "ERROR" in kind and content.strip():
            self._add("system", _clip(content.strip(), MAX_SUMMARY), ts)
            self.claude_done = True

    def _agent_message(self, p: dict, ts: str) -> None:
        """A message a Codex subagent sent to its parent. Only plain text (the final report, etc.) is shown."""
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
        # An encrypted intermediate message: the content is unreadable, but it is still in progress
        if not body:
            return
        name = author.rsplit("/", 1)[-1] or "서브에이전트"
        if final:
            self._subagent_done(tool, name, "completed", body, ts)
        else:
            self._add("subagent", body, ts, name=name, status="message", ref=None)

    def refresh(self) -> None:
        size = self.path.stat().st_size
        if self.agent == "gemini" and size != self.offset:
            # Antigravity CLI records the conversation title separately (summary DB)
            info = gemini_summaries().get(self.path.parents[2].name)
            if info and info["title"]:
                self.title = info["title"]
        if size < self.offset:  # the file was rewritten → from the start
            self.__init__(self.path, self.agent)
        if size == self.offset:
            return
        with self.path.open("rb") as handle:
            handle.seek(self.offset)
            chunk = handle.read(size - self.offset)
        end = chunk.rfind(b"\n")
        if end < 0:
            return  # the line is not finished yet
        self.offset += end + 1
        for raw in chunk[: end + 1].splitlines():
            try:
                record = json.loads(raw)
            except ValueError:
                continue
            if isinstance(record, dict):
                if self.agent == "gemini":
                    self._gemini(record)
                else:
                    (self._claude if self.agent == "claude" else self._codex)(record)


_GEMINI_REQUEST = re.compile(r"<USER_REQUEST>\n?(.*?)\n?</USER_REQUEST>", re.DOTALL)
_GEMINI_META = re.compile(
    r"<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE)>.*?</\1>", re.DOTALL
)
# Timestamp lines put before a tool result
_GEMINI_STAMP = re.compile(r"^(?:(?:Created|Completed) At: [^\n]*\n)+")
_GEMINI_EXIT = re.compile(r"exited with code (-?\d+)")
# Antigravity tool argument names (CommandLine · Path …) → the names the summary · statistics know
_GEMINI_KEYS = {
    "CommandLine": "command",
    "Path": "file_path",
    "TargetFile": "file_path",
    "AbsolutePath": "file_path",
    "File": "file_path",
    "DirectoryPath": "path",
    "SearchPath": "path",
    "Query": "query",
    "Pattern": "pattern",
    "Url": "url",
    "Prompt": "prompt",
}


def _gemini_args(args: dict) -> dict:
    out: dict = {}
    for key, value in args.items():
        out.setdefault(_GEMINI_KEYS.get(key, key), value)
    if "command" not in out and isinstance(args.get("toolSummary"), str):
        out.setdefault("description", args["toolSummary"])
    return out


def _gemini_diffs(name: str, args: dict) -> list[dict]:
    """Code changes of the tools that write or edit files (write_file · edit_file …)."""
    path = next(
        (
            args[k]
            for k in ("Path", "TargetFile", "AbsolutePath", "File")
            if args.get(k)
        ),
        None,
    )
    if not path:
        return []
    budget = _DiffBudget()
    diffs: list[dict | None] = []
    content = next(
        (args[k] for k in ("Content", "CodeContent") if isinstance(args.get(k), str)),
        None,
    )
    if isinstance(args.get("Target"), str) and isinstance(args.get("Replacement"), str):
        diffs.append(_diff_strings(path, args["Target"], args["Replacement"], budget))
    elif isinstance(args.get("ReplacementChunks"), list):
        merged = _diff_file(path)
        for chunk in args["ReplacementChunks"]:
            if isinstance(chunk, dict):
                one = _diff_strings(
                    path,
                    chunk.get("TargetContent") or chunk.get("Target"),
                    chunk.get("ReplacementContent") or chunk.get("Replacement"),
                    budget,
                )
                if one:
                    merged["hunks"] += one["hunks"]
                    merged["add"] += one["add"]
                    merged["del"] += one["del"]
        diffs.append(merged if merged["hunks"] else None)
    elif content is not None and "write" in name.lower():
        diffs.append(_diff_created(path, content, budget))
    found = [d for d in diffs if d]
    if found and budget.cut:
        found[-1]["cut"] = True
    return found


def _epoch(ts: str) -> float | None:
    try:
        return datetime.fromisoformat(ts).timestamp()
    except ValueError:
        return None


HISTORY_TAIL = 256 * 1024
FOLLOW_UP_GAP = 3.0
# Slash commands are not kept as messages in the conversation. A path like "/home/me/a.pdf see this" is a normal message.
_SLASH_COMMAND = re.compile(r"/[\w-]+(?:\s|$)")


def _codex_history() -> Path:
    return _data_root("CODEX_DATA_DIR", ".codex") / "history.jsonl"


def history_mark() -> float:
    """Mark for telling whether the Codex input history file changed (so the live subscription does not get prompts late)."""
    try:
        return _codex_history().stat().st_mtime
    except OSError:
        return 0.0


def _codex_submitted(thread_id: str, since: float) -> str | None:
    """Find the prompt that started that turn in ~/.codex/history.jsonl, which Codex writes as soon as input is entered."""
    try:
        with _codex_history().open("rb") as handle:
            handle.seek(max(0, handle.seek(0, os.SEEK_END) - HISTORY_TAIL))
            lines = handle.read().splitlines()
    except OSError:
        return None
    # The input that started the turn = the first input after the turn start (later ones were sent mid-work)
    found = None
    for raw in reversed(lines):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("session_id") != thread_id:
            continue
        ts = entry.get("ts")
        # The history is in whole seconds (truncated)
        if not isinstance(ts, (int, float)) or ts < since - 2:
            break
        text = entry.get("text")
        if isinstance(text, str) and text.strip():
            found = text
    return found


def _codex_queued(thread_id: str, since: float, delivered: int) -> list[str]:
    """Input that was sent but is not in the log yet (messages sent mid-work).

    Codex writes to the log only on delivery, but writes to the input history as soon as it is sent, and delivers
    in sending order. → Of this stretch's inputs, all but the first `delivered` are still queued.
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
        # The history is in whole seconds (truncated)
        if not isinstance(ts, (int, float)) or ts < since - 2:
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
    """(Inside _lock) Bring the cached log up to date and return it."""
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
    """Every item of the conversation (for handing the conversation over to another agent)."""
    with _lock:
        return [dict(item) for item in _cached_log(path, agent).items]


SEARCH_MAX_TERMS = 8
SEARCH_SNIPPET = 140


def _final_answer_ids(items: list[dict]) -> set[int]:
    """The agent's final answers: the last answer between each pair of user prompts (intermediate progress notes excluded)."""
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
    """Only the surroundings of the first match (as one line). (snippet, match position)"""
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
    """Search only user prompts and the agent's final answers over the whole conversation (tools · progress notes · subagents excluded).

    Messages containing every space-separated word (case-insensitive). Newest first.
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
        snippet, _at = _snippet(text, terms)
        results.append({"id": item_id, "kind": kind, "ts": ts, "snippet": snippet})
    return {
        "total": total,
        "items": results,
        "matches": len(found),
        "truncated": len(found) > limit,
    }


USAGE_GROUPS = ("skill", "plugin", "mcp", "agent", "builtin")


def _one_line(text: Any, limit: int) -> str:
    """One line for the bottom bar: first line only, whitespace collapsed, cut with … when long."""
    line = " ".join(str(text or "").split("\n", 1)[0].split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


def usage(path: Path, agent: str) -> dict:
    """Skills · plugins · MCP servers · subagents · built-in tools used in this conversation.

    recent: what was used since the last prompt (now / just now). States: running · error · ok (used).
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
        # Answering right now?: a turn-end mark in the log means idle immediately (faster and more accurate than the screen)
        busy = log.turn_open if agent == "codex" else not log.claude_done
        # Tool in use now (the last of the running ones; otherwise the last tool of this question)
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
        # Tool calls without a result: only those since the last prompt count as running (older ones were interrupted)
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
                    row["state"] = "ok"  # a retry that worked counts as used
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
    """items[start:start+limit]. If start is None, the last limit items."""
    limit = max(1, min(int(limit), 300))
    with _lock:
        log = _cached_log(path, agent)
        total = len(log.items)
        if start is None:
            start = max(0, total - limit)
        start = max(0, min(int(start), total))
        items = [dict(item) for item in log.items[start : start + limit]]
        # When a subagent finishes, an earlier (already fetched) tool item changes too → sent along
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
    # A turn whose sent prompt is not logged yet (e.g. during a compaction)
    submitted = (
        _codex_submitted(thread_id, awaiting)
        if agent == "codex" and awaiting is not None and thread_id
        else None
    )
    if agent == "codex" and turn_open and stretch_start is not None and thread_id:
        queue = _codex_queued(thread_id, stretch_start, stretch_users)
        if submitted and queue and queue[0] == submitted:
            # The input that started the turn is shown separately as "delivered"
            queue = queue[1:]
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
        # While working, it must be re-read when the input history file changes (messages sent from the
        # terminal · prompts logged late)
        "awaiting": agent == "codex" and (turn_open or awaiting is not None),
    }


# Claude's /model result line (its shape differs by version)
#   older: type=user,   message.content = "<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m and saved as ...</local-command-stdout>"
#   recent: type=system, content        = "<local-command-stdout>Set model to `Opus 5.5` and saved as ...</local-command-stdout>"
#   failure: "<local-command-stdout>API error: 400 {... "message":"Claude Code 2.1.269 does not support this model; ..."}</local-command-stdout>"
_MODEL_SET = re.compile(
    r"<local-command-stdout>\s*(?:Set model to|Kept model as)\s+(.+?)(?:\s+and saved\b[^<]*|\s+for this session\b[^<]*)?\s*</local-command-stdout>",
    re.DOTALL,
)
_STDOUT = re.compile(r"<local-command-stdout>(.*?)</local-command-stdout>", re.DOTALL)
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _local_command_text(record: dict) -> str | None:
    """The text if this is a local command (/model, etc.) record, otherwise None."""
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
    """A human-readable message for a failed /model."""
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
    """From the tail of the session log: the current model and, if the most recent /model failed, that error.

    Claude: the model of the most recent assistant message, or the display name of a later /model result ("Set model to …").
            If a /model failure (API error, etc.) comes even later, error · error_at are given too.
    Codex: the model of turn_context.
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
        if agent == "gemini":
            if record.get("type") == "PLANNER_RESPONSE" and isinstance(
                record.get("model"), str
            ):
                result["model"] = record["model"]
                return result
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
                # The failure seen later (more recent) was the result of this /model
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
    "default": N_("기본 모델"),
}


def claude_default_model() -> str | None:
    """Claude's default model (model in ~/.claude/settings.json) — for a new conversation with no model in the log yet."""
    path = _data_root("CLAUDE_DATA_DIR", ".claude") / "settings.json"
    try:
        model = json.loads(path.read_text(encoding="utf-8")).get("model")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(model, str) or not model.strip():
        return None
    model = model.strip()[:60]
    base = model.split("[")[0].lower()
    label = _(_ALIASES[base]) if base in _ALIASES else model
    return label + (" (1M)" if "[1m]" in model.lower() else "")
