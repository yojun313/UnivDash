"""에이전트 대화 기록 (Claude Code / Codex 세션 로그).

Claude Code 는 tmux 의 alternate screen 에서 화면을 통째로 다시 그리므로 tmux 스크롤백에는
대화가 남지 않는다. 대신 에이전트가 직접 쓰는 세션 로그(JSONL)를 읽어 전체 대화를 보여준다.

pane → 로그 파일 찾기 (추측 없이 실행 중인 프로세스 기준):
- Claude Code: ~/.claude/sessions/<pid>.json 의 sessionId → ~/.claude/projects/*/<sessionId>.jsonl
- Codex: 프로세스가 열어 둔 ~/.codex/sessions/**/rollout-*.jsonl (/proc/<pid>/fd)
파일 경로는 모두 서버가 정하고, 에이전트 데이터 폴더 밖은 읽지 않는다.
"""

import json
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import psutil

SESSION_ID = re.compile(r"^[0-9a-fA-F-]{16,64}$")
MAX_TEXT = 20000
MAX_OUTPUT = 4000
MAX_SUMMARY = 300
CACHE_FILES = 16

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
        try:
            with path.open(encoding="utf-8") as handle:
                first = json.loads(handle.readline())
            if (first.get("payload") or {}).get("cwd") == cwd:
                return path
        except (OSError, ValueError):
            continue
    return None


def find_log(pane_pid: int, agent: str | None, cwd: str) -> Path | None:
    if agent not in {"claude", "codex"}:
        return None
    proc = _agent_process(pane_pid, agent)
    if proc is None:
        return None
    return _claude_log(proc) if agent == "claude" else _codex_log(proc, cwd)


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
            parts.append(block.get("text") or "")
        elif kind in {"image", "input_image", "localImage", "image_url"}:
            parts.append("[이미지]")
    return "\n".join(p for p in parts if p)


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
            if value:
                return _clip(str(value).strip(), MAX_SUMMARY)
        return _clip(json.dumps(data, ensure_ascii=False), MAX_SUMMARY)
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
    if stripped.startswith("[Request interrupted"):
        return "system", "사용자가 중단함"
    return "user", stripped


class _Log:
    """한 로그 파일의 파싱 상태. 끝에 추가된 줄만 이어서 읽는다."""

    def __init__(self, path: Path, agent: str):
        self.path = path
        self.agent = agent
        self.offset = 0
        self.size = 0
        self.items: list[dict] = []
        self.by_call: dict[str, dict] = {}
        self.title = ""
        # Claude Code 대기열: 작업 중에 입력해 아직 전달되지 않은 프롬프트 (queue-operation enqueue/remove)
        self.queue: list[str] = []

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

    def _tool(self, call_id: str, name: str, data: Any, ts: str) -> None:
        item = self._add(
            "tool",
            ts=ts,
            name=name,
            summary=_tool_summary(name, data),
            output=None,
            error=False,
        )
        if call_id:
            self.by_call[call_id] = item

    def _result(self, call_id: str, output: Any, error: bool = False) -> None:
        item = self.by_call.get(call_id)
        if item is not None:
            item["output"] = _clip(
                _blocks_text(output) if not isinstance(output, str) else output,
                MAX_OUTPUT,
            )
            item["error"] = bool(error)

    def _claude(self, d: dict) -> None:
        kind, ts = d.get("type"), d.get("timestamp") or ""
        if kind == "ai-title" and isinstance(d.get("aiTitle"), str):
            self.title = d["aiTitle"]
        if kind == "queue-operation":
            text = d.get("content")
            operation = d.get("operation")
            if operation == "enqueue" and isinstance(text, str):
                self.queue.append(text)
            elif operation in {"remove", "dequeue", "popAll", "clear"}:
                if operation in {"popAll", "clear"}:
                    self.queue.clear()
                elif isinstance(text, str) and text in self.queue:
                    self.queue.remove(text)
                elif self.queue:
                    self.queue.pop(0)  # dequeue 는 내용 없이 가장 오래된 것을 꺼낸다
            return
        # 작업 도중에 받은 메시지는 user 가 아니라 attachment(queued_command) 로 기록된다
        if kind == "attachment" and not d.get("isSidechain"):
            att = d.get("attachment") or {}
            if (
                isinstance(att, dict)
                and att.get("type") == "queued_command"
                and isinstance(att.get("prompt"), str)
            ):
                parsed = _user_text(att["prompt"])
                if parsed:
                    self._add(
                        parsed[0], parsed[1], d.get("timestamp") or "", queued=True
                    )
            return
        if kind not in {"user", "assistant"} or d.get("isMeta") or d.get("isSidechain"):
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
                        )
                return
            parsed = _user_text(_blocks_text(content))
            if parsed:
                self._add(parsed[0], parsed[1], ts)
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
        if kind != "response_item":
            return
        ptype = p.get("type")
        if ptype == "message" and p.get("role") == "user":
            parsed = _user_text(_blocks_text(p.get("content")))
            if parsed:
                self._add(parsed[0], parsed[1], ts)
        elif ptype == "message" and p.get("role") == "assistant":
            text = _blocks_text(p.get("content")).strip()
            if text:
                self._add("assistant", text, ts)
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


_cache: "OrderedDict[str, _Log]" = OrderedDict()
_lock = threading.Lock()


def read(path: Path, agent: str, start: int | None, limit: int) -> dict:
    """items[start:start+limit]. start 가 None 이면 마지막 limit 개."""
    limit = max(1, min(int(limit), 300))
    key = str(path)
    with _lock:
        log = _cache.get(key)
        if log is None or log.agent != agent:
            log = _Log(path, agent)
            _cache[key] = log
        _cache.move_to_end(key)
        while len(_cache) > CACHE_FILES:
            _cache.popitem(last=False)
        log.refresh()
        total = len(log.items)
        if start is None:
            start = max(0, total - limit)
        start = max(0, min(int(start), total))
        items = [dict(item) for item in log.items[start : start + limit]]
        return {
            "total": total,
            "start": start,
            "items": items,
            "title": log.title,
            "file": path.name,
            "queued": [_clip(text, MAX_TEXT) for text in log.queue],
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
