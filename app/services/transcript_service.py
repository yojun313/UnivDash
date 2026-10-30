"""에이전트 대화 기록 (Claude Code / Codex 세션 로그).

Claude Code 는 tmux 의 alternate screen 에서 화면을 통째로 다시 그리므로 tmux 스크롤백에는
대화가 남지 않는다. 대신 에이전트가 직접 쓰는 세션 로그(JSONL)를 읽어 전체 대화를 보여준다.

pane → 로그 파일 찾기 (추측 없이 실행 중인 프로세스 기준):
- Claude Code: ~/.claude/sessions/<pid>.json 의 sessionId → ~/.claude/projects/*/<sessionId>.jsonl
- Codex: 프로세스가 열어 둔 ~/.codex/sessions/**/rollout-*.jsonl (/proc/<pid>/fd)
파일 경로는 모두 서버가 정하고, 에이전트 데이터 폴더 밖은 읽지 않는다.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import threading
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
    "Caveat: The messages below",
)
COMPACTED = "대화가 길어 압축(compact)됐어요"
# 대시보드의 '대화 넘기기'로 새 에이전트에 보낸 첫 지시 (agent_restart._handoff_prompt)
_HANDOFF_PREFIX = "이 작업은 다른 에이전트("
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


def _codex_log(proc: psutil.Process, cwd: str) -> Path | None:
    root = _data_root("CODEX_DATA_DIR", ".codex")
    # `codex resume <ID>` 로 켜진 창은 그 대화의 로그가 확실하다 (공유 데몬이 파일을 열고 있어 아래 방법으로는 못 찾을 때가 많다)
    try:
        argv = proc.cmdline()
    except psutil.Error:
        argv = []
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
    # 파일을 잠시 닫고 있는 경우: 같은 작업 폴더의 가장 최근 세션
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
        if meta and meta["cwd"] == cwd and not meta["sub"]:
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
    stripped = text.strip()
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
        self.agent_names: dict[str, str] = {}  # Claude 서브에이전트 ID → 설명(이름)
        # Codex 서브에이전트 경로(/root/ground) → spawn_agent 도구 항목
        self.subagents: dict[str, dict] = {}
        # Codex: 사용자가 보내 시작된 턴인데 아직 그 프롬프트가 기록되지 않았다 (보내자마자 대화 압축을
        # 하면 압축이 끝날 때까지 기록되지 않는다) → 그 턴이 시작된 시각 (epoch 초)
        self.thread_id = ""
        self.awaiting: float | None = None

    def _add(self, kind: str, text: str = "", ts: str = "", **extra) -> dict:
        item = {
            "id": len(self.items),
            "kind": kind,
            "text": _clip(text, MAX_TEXT),
            "ts": ts,
            **extra,
        }
        self.items.append(item)
        return item

    def _user(self, content: Any, ts: str) -> str | None:
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
        self._add(parsed[0], parsed[1], ts, **extra)
        return parsed[0]

    def _tool(self, call_id: str, name: str, data: Any, ts: str) -> None:
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
        )
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
            if (
                isinstance(att, dict)
                and att.get("type") == "queued_command"
                and isinstance(att.get("prompt"), str)
            ):
                if att["prompt"].lstrip().startswith(_NOTIFY):
                    self._notification(att["prompt"], d.get("timestamp") or "")
                    return
                parsed = _user_text(att["prompt"])
                if parsed:
                    self._add(
                        parsed[0], parsed[1], d.get("timestamp") or "", queued=True
                    )
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
            elif event in {"task_complete", "turn_aborted"}:
                self.awaiting = None
            return
        if kind != "response_item":
            return
        ptype = p.get("type")
        if ptype == "message" and p.get("role") == "user":
            if self._user(p.get("content"), ts) == "user":
                self.awaiting = None
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
    # 보낸 프롬프트가 아직 기록되지 않은 턴 (예: 대화 압축 중)
    submitted = (
        _codex_submitted(thread_id, awaiting)
        if agent == "codex" and awaiting is not None and thread_id
        else None
    )
    return {
        "related": related,
        "total": total,
        "start": start,
        "items": items,
        "title": title,
        "file": path.name,
        "queued": [
            _clip(text, MAX_TEXT)
            for text in queue
            if not text.lstrip().startswith(_NOTIFY)
        ],
        "submitted": [_clip(submitted, MAX_TEXT)] if submitted else [],
        # 프롬프트를 아직 못 찾았다: 입력 기록 파일이 바뀌면 다시 읽어야 한다
        "awaiting": awaiting is not None and not submitted and agent == "codex",
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
