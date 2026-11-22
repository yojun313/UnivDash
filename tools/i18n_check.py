"""Translation check: which strings are missing from the English catalog, and which are not wrapped yet.

    uv run python tools/i18n_check.py                      # whole project
    uv run python tools/i18n_check.py app/static/git.js    # only these files
    uv run python tools/i18n_check.py --unwrapped app/services/git

Exit code 1 when something is missing. See app/i18n/__init__.py for how translation works.
"""

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
HANGUL = re.compile(r"[가-힣]")
# t('…') / t("…") / t(`…`) in JavaScript and Jinja ({{ t("…") }}); the first argument only
CALL = re.compile(
    r"""(?<![\w.$])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)"""
)
STRING = re.compile(
    r"""'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`"""
)
LOG_CALLS = {"debug", "info", "warning", "error", "exception", "critical", "log"}


def unescape(text: str) -> str:
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m[1], m[1]), text)


def python_strings(path: Path) -> tuple[set[str], list[tuple[int, str]]]:
    """(wrapped keys, [(line, unwrapped Korean string)])."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    keys: set[str] = set()
    skip: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
            ):
                skip.add(id(body[0].value))  # docstring
        if not isinstance(node, ast.Call):
            continue
        name = (
            node.func.id
            if isinstance(node.func, ast.Name)
            else node.func.attr
            if isinstance(node.func, ast.Attribute)
            else ""
        )
        if (
            name in {"_", "N_", "translate"}
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
            skip.add(id(node.args[0]))
        elif name in LOG_CALLS or name in {
            "compile",
            "search",
            "match",
            "fullmatch",
            "sub",
            "findall",
        }:
            for inner in ast.walk(
                node
            ):  # log messages and regular expressions are not UI text
                if isinstance(inner, ast.Constant):
                    skip.add(id(inner))
    unwrapped = [
        (node.lineno, node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and HANGUL.search(node.value)
        and id(node) not in skip
    ]
    return keys, sorted(set(unwrapped))


def script_strings(path: Path) -> tuple[set[str], list[tuple[int, str]]]:
    text = path.read_text(encoding="utf-8")
    keys = {
        unescape(next(g for g in m.groups() if g is not None))
        for m in CALL.finditer(text)
    }
    unwrapped: list[tuple[int, str]] = []
    comment = re.compile(r"^\s*(//|\*|/\*|<!--|\{#)")
    for number, line in enumerate(text.splitlines(), 1):
        if comment.match(line) or not HANGUL.search(line):
            continue
        code = re.sub(r"\s//\s.*$", "", line)
        for match in STRING.finditer(code):
            value = unescape(next(g for g in match.groups() if g is not None))
            before = code[: match.start()].rstrip()
            if HANGUL.search(value) and not before.endswith("t(") and value not in keys:
                unwrapped.append((number, value))
        if path.suffix == ".html":  # Korean text directly in the markup
            bare = re.sub(r"\{\{.*?\}\}|\{%.*?%\}|<!--.*?-->|<[^>]*>", " ", line)
            if HANGUL.search(bare):
                unwrapped.append((number, bare.strip()))
    return keys, unwrapped


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_unwrapped = "--unwrapped" in sys.argv
    targets = [ROOT / a for a in args] or [ROOT / "app"]
    files: list[Path] = []
    for target in targets:
        found = (
            [target]
            if target.is_file()
            else [*target.rglob("*.py"), *target.rglob("*.js"), *target.rglob("*.html")]
        )
        files += [
            f
            for f in found
            if "vendor" not in f.parts
            and "__pycache__" not in f.parts
            and "i18n" not in f.parts
        ]
    from app import i18n

    catalog = i18n.catalog("en")
    missing: dict[str, list[str]] = {}
    unwrapped_total = 0
    for path in sorted(set(files)):
        try:
            keys, unwrapped = (
                python_strings(path) if path.suffix == ".py" else script_strings(path)
            )
        except SyntaxError as error:
            print(f"{path.relative_to(ROOT)}: cannot parse ({error})")
            return 1
        for key in keys:
            if HANGUL.search(key) and key not in catalog:
                missing.setdefault(key, []).append(str(path.relative_to(ROOT)))
        if show_unwrapped and unwrapped:
            unwrapped_total += len(unwrapped)
            for line, value in unwrapped:
                print(f"UNWRAPPED {path.relative_to(ROOT)}:{line}: {value[:110]!r}")
    for key, where in sorted(missing.items(), key=lambda item: item[1]):
        print(f"MISSING {where[0]}: {json.dumps(key, ensure_ascii=False)[:160]}")
    print(
        f"\n{len(catalog)} translations · {len(missing)} missing"
        + (f" · {unwrapped_total} unwrapped" if show_unwrapped else "")
    )
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
