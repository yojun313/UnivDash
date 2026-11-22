"""PM2 ecosystem.config.js: reading · adding · editing · deleting apps.

- Read: node requires the file the same way pm2 does and returns it as JSON.
- Add: instead of rewriting the whole file, only the new entry is inserted right before the closing `]`
  of `apps: [ ... ]`, leaving existing formatting · comments · function values untouched. Before
  writing, the result is read back with node to verify it, and the original is backed up and then
  replaced atomically.
- Edit: only the values of the changed properties inside that entry are swapped (properties not in the form · comments stay as they are).
- Delete: only that entry is cut out.
- Both edit and delete read the result back with node and save only after confirming that every app config is unchanged except the part being changed.
- Every string value is escaped with json.dumps and inserted as a JS string literal (prevents code injection).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from app.i18n import _

APP_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
SCRIPT_CANDIDATES = [
    "run.py",
    "main.py",
    "app.py",
    "manage.py",
    "server.py",
    "server.js",
    "index.js",
    "app.js",
    "main.js",
]
_lock = threading.Lock()


class EcosystemError(Exception):
    pass


def ecosystem_path() -> Path:
    configured = os.getenv("PM2_ECOSYSTEM_FILE")
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / "ecosystem.config.js"
    )


def child_env() -> dict[str, str]:
    """Environment variables for launching node / pm2.

    When this server runs under pm2 it inherits pm2's IPC channel variables (NODE_CHANNEL_FD etc.). Passed
    on as is, the child node tries to open a file descriptor its process does not have as the IPC channel
    and dies with abort(-6).
    """
    env = dict(os.environ)
    for key in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"):
        env.pop(key, None)
    return env


def _node() -> str:
    node = shutil.which("node")
    if not node:
        raise EcosystemError(_("node 를 찾을 수 없습니다."))
    return node


_LOAD_JS = """
const path = process.argv[1];
const config = require(path);
const apps = Array.isArray(config) ? config : (config && config.apps) || [];
process.stdout.write(JSON.stringify(apps.map((app) => {
  const out = {};
  for (const [key, value] of Object.entries(app || {})) {
    if (['name', 'cwd', 'script', 'interpreter', 'args', 'watch', 'time', 'instances', 'exec_mode', 'autorestart'].includes(key)) out[key] = value;
  }
  return out;
})));
"""


def load_apps(path: Path | None = None) -> list[dict]:
    path = path or ecosystem_path()
    if not path.is_file():
        return []
    try:
        result = subprocess.run(
            [_node(), "-e", _LOAD_JS, str(path.resolve())],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env=child_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise EcosystemError(_("ecosystem 파일을 읽지 못했습니다.")) from error
    if result.returncode != 0:
        detail = (
            result.stderr.strip().splitlines()[-1]
            if result.stderr.strip()
            else _("node 종료 코드 {code}", code=result.returncode)
        )
        raise EcosystemError(
            _("ecosystem 파일을 해석하지 못했습니다: {detail}", detail=detail)
        )
    try:
        apps = json.loads(result.stdout or "[]")
    except ValueError as error:
        raise EcosystemError(_("ecosystem 파일 형식이 올바르지 않습니다.")) from error
    return [app for app in apps if isinstance(app, dict)]


_LOAD_FULL_JS = """
const path = process.argv[1];
const config = require(path);
const apps = Array.isArray(config) ? config : (config && config.apps) || [];
process.stdout.write(JSON.stringify(apps));
"""


def _load_full(path: Path) -> list:
    """The full app configs (used for the verification comparison; function values drop out of the JSON)."""
    try:
        result = subprocess.run(
            [_node(), "-e", _LOAD_FULL_JS, str(path.resolve())],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env=child_env(),
        )
        if result.returncode != 0:
            raise EcosystemError(_("ecosystem 파일을 해석하지 못했습니다."))
        apps = json.loads(result.stdout or "[]")
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        raise EcosystemError(_("ecosystem 파일을 읽지 못했습니다.")) from error
    if not isinstance(apps, list):
        raise EcosystemError(_("ecosystem 파일 형식이 올바르지 않습니다."))
    return apps


def inspect_directory(cwd: str) -> dict:
    """Looks at the working folder and suggests a script · interpreter."""
    directory = Path(os.path.expanduser(cwd or "")).resolve() if cwd else None
    if directory is None or not directory.is_dir():
        return {"exists": False}
    script = next(
        (name for name in SCRIPT_CANDIDATES if (directory / name).is_file()), ""
    )
    interpreter = ""
    if script.endswith(".py"):
        venv = directory / ".venv" / "bin" / "python"
        interpreter = str(venv) if venv.exists() else "python3"
    return {
        "exists": True,
        "cwd": str(directory),
        "name": re.sub(r"[^A-Za-z0-9._-]+", "-", directory.name)
        .strip("-._")
        .lower()[:64],
        "script": script,
        "interpreter": interpreter,
    }


def _mask_code(source: str, string_fill: str = " ") -> str:
    """Masks strings · template strings · comments with spaces of the same length (positions are kept).

    With string_fill, strings are filled with that character instead (so a property whose value is only a string does not vanish into spaces)."""
    out = list(source)
    index, length = 0, len(source)
    while index < length:
        char = source[index]
        fill = " "
        if char in "\"'`":
            fill = string_fill
            start = index
            index += 1
            while index < length and source[index] != char:
                index += 2 if source[index] == "\\" else 1
            stop = min(index + 1, length)
        elif source.startswith("//", index):
            start = index
            newline = source.find("\n", index)
            stop = length if newline < 0 else newline
        elif source.startswith("/*", index):
            start = index
            close = source.find("*/", index + 2)
            stop = length if close < 0 else close + 2
        else:
            index += 1
            continue
        for position in range(start, stop):
            if out[position] != "\n":
                out[position] = fill
        index = stop
    return "".join(out)


def _find_apps_array_end(source: str) -> int:
    """Position of the `]` that matches `apps: [` in the code part."""
    masked = _mask_code(source)
    match = re.search(r"\bapps\s*:\s*\[", masked)
    if not match:
        raise EcosystemError(_("ecosystem 파일에서 apps 배열을 찾지 못했습니다."))
    depth = 0
    for index in range(match.end() - 1, len(masked)):
        char = masked[index]
        if char in "[{(":
            depth += 1
        elif char in "]})":
            depth -= 1
            if depth == 0:
                return index
    raise EcosystemError(_("apps 배열의 끝을 찾지 못했습니다."))


def _entry_source(app: dict, indent: str, step: str) -> str:
    lines = [f"{indent}{{"]
    fields = list(app.items())
    for position, (key, value) in enumerate(fields):
        comma = "," if position < len(fields) - 1 else ""
        if key == "env":
            lines.append(f"{indent}{step}env: {{")
            env_items = list(value.items())
            for env_position, (env_key, env_value) in enumerate(env_items):
                env_comma = "," if env_position < len(env_items) - 1 else ""
                lines.append(
                    f"{indent}{step}{step}{env_key}: {json.dumps(env_value, ensure_ascii=False)}{env_comma}"
                )
            lines.append(f"{indent}{step}}}{comma}")
        else:
            lines.append(
                f"{indent}{step}{key}: {json.dumps(value, ensure_ascii=False)}{comma}"
            )
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def build_app(data: dict) -> dict:
    name = str(data.get("name") or "").strip()
    if not APP_NAME.match(name):
        raise ValueError(_("앱 이름은 영문 · 숫자 · . _ - 로 64자 이하여야 합니다."))
    cwd = Path(os.path.expanduser(str(data.get("cwd") or "").strip())).resolve()
    if not cwd.is_dir():
        raise ValueError(_("작업 폴더(cwd)가 존재하지 않습니다."))
    script = str(data.get("script") or "").strip()
    if not script or "\n" in script or len(script) > 500:
        raise ValueError(_("실행 파일(script)을 입력하십시오."))
    script_path = Path(script) if Path(script).is_absolute() else cwd / script
    if not script_path.exists() and not shutil.which(script):
        raise ValueError(_("실행 파일을 찾을 수 없습니다: {script}", script=script))
    app: dict = {"name": name, "cwd": str(cwd), "script": script}
    interpreter = str(data.get("interpreter") or "").strip()
    if interpreter:
        if "\n" in interpreter or len(interpreter) > 500:
            raise ValueError(_("인터프리터 값이 올바르지 않습니다."))
        if "/" in interpreter and not Path(os.path.expanduser(interpreter)).exists():
            raise ValueError(
                _(
                    "인터프리터를 찾을 수 없습니다: {interpreter}",
                    interpreter=interpreter,
                )
            )
        app["interpreter"] = (
            os.path.expanduser(interpreter) if "/" in interpreter else interpreter
        )
    args = str(data.get("args") or "").strip()
    if args:
        if "\n" in args or len(args) > 500:
            raise ValueError(_("실행 인자(args)가 올바르지 않습니다."))
        app["args"] = args
    app["watch"] = bool(data.get("watch"))
    app["time"] = bool(data.get("time", True))
    env = {}
    for line in str(data.get("env") or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not ENV_KEY.match(key):
            raise ValueError(
                _("환경 변수는 KEY=VALUE 형식이어야 합니다: {line}", line=line[:40])
            )
        if len(value) > 2000:
            raise ValueError(_("{key} 값이 너무 깁니다.", key=key))
        env[key] = value.strip()
    if env:
        app["env"] = env
    return app


def add_app(data: dict, path: Path | None = None) -> dict:
    path = path or ecosystem_path()
    app = build_app(data)
    with _lock:
        existing = load_apps(path) if path.exists() else []
        if any(item.get("name") == app["name"] for item in existing):
            raise ValueError(
                _("'{name}' 앱이 이미 ecosystem 파일에 있습니다.", name=app["name"])
            )

        if path.exists():
            source = path.read_text(encoding="utf-8")
            end = _find_apps_array_end(source)
            head = source[:end].rstrip()
            # Follow the indentation of the existing entries
            indent_match = re.search(r"\n([ \t]+)\{\s*\n([ \t]+)name\s*:", source)
            indent, step = ("    ", "  ")
            if indent_match:
                indent = indent_match.group(1)
                step = indent_match.group(2)[len(indent) :] or "  "
            # Going by the code with comments masked, add a comma unless the last character is [ or ,.
            last_code = _mask_code(source[:end]).rstrip()[-1:]
            if last_code not in {"[", ","}:
                # The comma has to go at the end of the code (before any trailing comment)
                code_end = len(_mask_code(source[:end]).rstrip())
                head = source[:code_end] + "," + source[code_end:end].rstrip()
            separator = ""
            closing_indent = re.search(r"([ \t]*)$", source[:end]).group(1)
            new_source = f"{head}{separator}\n{_entry_source(app, indent, step)}\n{closing_indent}{source[end:]}"
        else:
            new_source = (
                "module.exports = {\n  apps: [\n"
                + _entry_source(app, "    ", "  ")
                + "\n  ]\n};\n"
            )

        expected = [a.get("name") for a in existing] + [app["name"]]
        # Before writing, read it back with node and check that the existing apps + the new app come out intact.
        backup = _save(
            path,
            new_source,
            lambda temp: [a.get("name") for a in load_apps(temp)] == expected,
        )
    return {"app": app, "backup": backup, "path": str(path)}


def _save(path: Path, new_source: str, verify) -> str | None:
    """Writes to a temp file and, only if verify(temp) is true, backs up the original and replaces it atomically. Returns the backup path."""
    fd, temp_name = tempfile.mkstemp(
        dir=path.parent, prefix=".ecosystem.", suffix=".js"
    )
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(new_source)
        if path.exists():
            os.chmod(temp, path.stat().st_mode & 0o777)
        if not verify(temp):
            raise EcosystemError(
                _("수정한 ecosystem 파일을 검증하지 못해 저장하지 않았습니다.")
            )
        backup = None
        if path.exists():
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = path.with_name(f"{path.name}.bak-{stamp}")
            serial = 1
            while backup.exists():  # several edits within the same second must not overwrite an earlier backup
                serial += 1
                backup = path.with_name(f"{path.name}.bak-{stamp}-{serial}")
            shutil.copy2(path, backup)
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return str(backup) if backup else None


# ── Edit · delete: locating entries · properties in the apps array ────────


def _skip_space(masked: str, index: int, step: int = 1) -> int:
    """Skips whitespace (including comments) in the masked code."""
    while 0 <= index < len(masked) and masked[index].isspace():
        index += step
    return index


def _split_top(masked: str, start: int, stop: int) -> list[tuple[int, int, int | None]]:
    """Splits start..stop at depth-0 commas. A list of (start, end, trailing comma position). Empty pieces are dropped."""
    parts = []
    depth = 0
    piece = start
    for index in range(start, stop):
        char = masked[index]
        if char in "[{(":
            depth += 1
        elif char in "]})":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append((piece, index, index))
            piece = index + 1
    parts.append((piece, stop, None))
    out = []
    for begin, end, comma in parts:
        begin = _skip_space(masked, begin)
        end = _skip_space(masked, end - 1, -1) + 1
        if begin < end:
            out.append((begin, end, comma))
    return out


def _app_elements(
    source: str, masked: str, count: int
) -> list[tuple[int, int, int | None]]:
    """Positions of the entries in the apps array. All must be `{ ... }` object literals and match the number of apps node read."""
    end = _find_apps_array_end(source)
    start = re.search(r"\bapps\s*:\s*\[", masked).end()
    elements = _split_top(masked, start, end)
    if len(elements) != count or any(
        masked[begin] != "{" or masked[stop - 1] != "}"
        for begin, stop, _comma in elements
    ):
        raise EcosystemError(
            _(
                "apps 배열이 단순한 객체 목록이 아니라 자동으로 고칠 수 없습니다. 파일을 직접 수정하십시오."
            )
        )
    return elements


_KEY = re.compile(r"([A-Za-z_$][\w$]*|\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')\s*:")


def _props(source: str, masked: str, begin: int, stop: int) -> dict[str, dict]:
    """Top-level properties of an object literal: key → {start, value_start, value_end, comma}."""
    props: dict[str, dict] = {}
    for start, end, comma in _split_top(masked, begin + 1, stop - 1):
        match = _KEY.match(source, start)
        if not match or match.end() > end:
            raise EcosystemError(
                _(
                    "이 항목에 자동으로 고칠 수 없는 문법(전개 · 메서드 등)이 있습니다. 파일을 직접 수정하십시오."
                )
            )
        key = match.group(1)
        if key[0] in "\"'":
            key = key[1:-1]
        if key in props:
            raise EcosystemError(
                _(
                    "'{key}' 속성이 두 번 나옵니다. 파일을 직접 수정하십시오.",
                    key=key,
                )
            )
        props[key] = {
            "start": start,
            "value_start": _skip_space(masked, match.end()),
            "value_end": end,
            "comma": comma,
        }
    return props


def _cut_lines(source: str, start: int, end: int) -> tuple[int, int]:
    """If cutting leaves the line empty, the whole line (indentation · newline included) is cut with it."""
    line_start = source.rfind("\n", 0, start) + 1
    line_end = source.find("\n", end)
    line_end = len(source) if line_end < 0 else line_end
    if not source[line_start:start].strip() and not source[end:line_end].strip():
        return line_start, min(line_end + 1, len(source))
    return start, end


def _removal(source: str, item: tuple[int, int, int | None]) -> tuple[int, int, str]:
    """Cuts an entry (or property) through its trailing comma. For the last entry the previous entry's comma remains as a trailing comma, which is fine in JS."""
    begin, end, comma = item
    return (*_cut_lines(source, begin, end if comma is None else comma + 1), "")


def _apply(source: str, edits: list[tuple[int, int, str]]) -> str:
    # Applied from the end backwards. At the same position cuts go first so inserted text is not cut off.
    for start, end, text in sorted(edits, key=lambda edit: edit[:2], reverse=True):
        source = source[:start] + text + source[end:]
    return source


def _indent_of(source: str, position: int) -> str | None:
    line_start = source.rfind("\n", 0, position) + 1
    head = source[line_start:position]
    return head if not head.strip() else None


def _literal(value, indent: str, step: str, multiline: bool) -> str:
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{key}: {json.dumps(item, ensure_ascii=False)}"
            for key, item in value.items()
        ]
        if not multiline:
            return "{ " + ", ".join(items) + " }"
        inner = ",\n".join(f"{indent}{step}{item}" for item in items)
        return "{\n" + inner + f"\n{indent}}}"
    return json.dumps(value, ensure_ascii=False)


def _find(apps: list, name: str) -> int:
    index = next(
        (
            i
            for i, app in enumerate(apps)
            if isinstance(app, dict) and app.get("name") == name
        ),
        None,
    )
    if index is None:
        raise KeyError(_("ecosystem 파일에 없는 앱입니다."))
    return index


def _args_text(value) -> str:
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return "" if value is None else str(value)


def get_app(name: str, path: Path | None = None) -> dict:
    """Values to fill the edit form with. Also reports the names of properties not in the form (to tell the user they are kept as is)."""
    path = path or ecosystem_path()
    apps = _load_full(path)
    app = apps[_find(apps, name)]
    env = app.get("env") if isinstance(app.get("env"), dict) else {}
    return {
        "name": app.get("name"),
        "cwd": app.get("cwd") or "",
        "script": app.get("script") or "",
        "interpreter": app.get("interpreter") or "",
        "args": _args_text(app.get("args")),
        "watch": bool(app.get("watch")),
        "watch_custom": isinstance(app.get("watch"), list),
        "time": bool(app.get("time")),
        "env": "\n".join(f"{key}={_env_text(value)}" for key, value in env.items()),
        "env_editable": "env" not in app or isinstance(app.get("env"), dict),
        "kept": sorted(set(app) - EDITABLE),
    }


EDITABLE = {"name", "cwd", "script", "interpreter", "args", "watch", "time", "env"}


def _env_text(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


def _changes(before: dict, app: dict) -> dict:
    """Only the form values that actually changed. A value of None removes that property."""
    changes: dict = {}
    if before.get("name") != app["name"]:
        changes["name"] = app["name"]
    cwd = str(before.get("cwd") or "")
    if not cwd or Path(os.path.expanduser(cwd)).resolve() != Path(app["cwd"]):
        changes["cwd"] = app["cwd"]
    if before.get("script") != app["script"]:
        changes["script"] = app["script"]
    if (before.get("interpreter") or "") != app.get("interpreter", ""):
        changes["interpreter"] = app.get("interpreter")
    if _args_text(before.get("args")) != app.get("args", ""):
        changes["args"] = app.get("args")
    for flag in ("watch", "time"):
        if bool(before.get(flag)) != app[flag]:
            changes[flag] = app[flag]
    env = before.get("env") if isinstance(before.get("env"), dict) else {}
    if {key: _env_text(value) for key, value in env.items()} != app.get("env", {}):
        changes["env"] = app.get("env")
    return changes


def update_app(name: str, data: dict, path: Path | None = None) -> dict:
    """Edits only the properties of the app `name` that changed in the form."""
    path = path or ecosystem_path()
    app = build_app(data)
    with _lock:
        apps = _load_full(path)
        index = _find(apps, name)
        before = apps[index]
        if app["name"] != name and any(
            isinstance(other, dict) and other.get("name") == app["name"]
            for other in apps
        ):
            raise ValueError(
                _("'{name}' 앱이 이미 ecosystem 파일에 있습니다.", name=app["name"])
            )
        if "env" in before and not isinstance(before["env"], dict):
            raise EcosystemError(_("env 값이 객체가 아니라 자동으로 고칠 수 없습니다."))
        changes = _changes(before, app)
        if not changes:
            return {"app": app, "changed": [], "backup": None, "path": str(path)}

        source = path.read_text(encoding="utf-8")
        masked = _mask_code(source, "s")
        begin, stop, _comma = _app_elements(source, masked, len(apps))[index]
        props = _props(source, masked, begin, stop)
        multiline = "\n" in source[begin:stop]
        first = next(iter(props.values()))
        indent = _indent_of(source, first["start"]) if multiline else None
        object_indent = _indent_of(source, begin) or ""
        step = (indent or "")[len(object_indent) :] or "  "

        edits, added = [], []
        removed = [
            key
            for key, value in changes.items()
            if value in (None, "", {}) and key in props
        ]
        for key, value in changes.items():
            if key in removed:
                continue
            if value in (None, "", {}):
                continue  # a property that was never there was left empty
            if key in props:
                prop = props[key]
                prop_multiline = "\n" in source[prop["value_start"] : prop["value_end"]]
                prop_indent = _indent_of(source, prop["start"]) or ""
                edits.append(
                    (
                        prop["value_start"],
                        prop["value_end"],
                        _literal(value, prop_indent, step, prop_multiline),
                    )
                )
            else:
                added.append((key, value))
        for key in removed:
            prop = props[key]
            edits.append(
                _removal(source, (prop["start"], prop["value_end"], prop["comma"]))
            )
        if added:
            remaining = [k for k in props if k not in removed]
            if not remaining:
                raise EcosystemError(
                    _("항목을 고칠 수 없습니다. 파일을 직접 수정하십시오.")
                )
            last = props[remaining[-1]]
            if multiline and indent is not None:
                text = "".join(
                    f"\n{indent}{key}: {_literal(value, indent, step, True)},"
                    for key, value in added
                )
                # Appended as new lines at the end of the last property's line (after any trailing comment)
                after = (
                    last["value_end"] if last["comma"] is None else last["comma"] + 1
                )
                line_end = source.find("\n", after)
                line_end = len(source) if line_end < 0 else line_end
                at = line_end if not masked[after:line_end].strip() else after
                if last["comma"] is None:
                    text = text[:-1]
                    if at == last["value_end"]:
                        text = "," + text
                    else:
                        edits.append((last["value_end"], last["value_end"], ","))
                edits.append((at, at, text))
            else:
                text = "".join(
                    f", {key}: {_literal(value, '', step, False)}"
                    for key, value in added
                )
                edits.append((last["value_end"], last["value_end"], text))
        new_source = _apply(source, edits)

        expected = json.loads(json.dumps(apps))
        target = expected[index]
        for key, value in changes.items():
            if value in (None, "", {}):
                target.pop(key, None)
            else:
                target[key] = value
        backup = _save(path, new_source, lambda temp: _load_full(temp) == expected)
    return {"app": app, "changed": sorted(changes), "backup": backup, "path": str(path)}


def delete_app(name: str, path: Path | None = None) -> dict:
    path = path or ecosystem_path()
    with _lock:
        apps = _load_full(path)
        index = _find(apps, name)
        source = path.read_text(encoding="utf-8")
        masked = _mask_code(source, "s")
        elements = _app_elements(source, masked, len(apps))
        new_source = _apply(source, [_removal(source, elements[index])])
        expected = json.loads(json.dumps(apps[:index] + apps[index + 1 :]))
        backup = _save(path, new_source, lambda temp: _load_full(temp) == expected)
    return {"backup": backup, "path": str(path)}


def start_app(name: str, path: Path | None = None) -> tuple[bool, str]:
    path = path or ecosystem_path()
    if not APP_NAME.match(name or ""):
        raise ValueError(_("잘못된 앱 이름입니다."))
    if not any(app.get("name") == name for app in load_apps(path)):
        raise KeyError(_("ecosystem 파일에 없는 앱입니다."))
    pm2 = shutil.which("pm2")
    if not pm2:
        raise EcosystemError(_("pm2 를 찾을 수 없습니다."))
    try:
        result = subprocess.run(
            [pm2, "start", str(path), "--only", name],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            cwd=str(path.parent),
            env=child_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise EcosystemError(_("pm2 start 를 실행하지 못했습니다.")) from error
    output = re.sub(r"\x1b\[[0-9;]*m", "", (result.stdout + result.stderr).strip())
    return result.returncode == 0, output[-4000:]
