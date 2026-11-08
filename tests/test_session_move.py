"""작업 폴더 바꾸기 시험. tmux · 에이전트는 가짜로 대체한다 (실제 세션을 건드리지 않는다)."""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_restart, session_move

LID = "bbbbbbbb-2222-4222-8222-222222222222"


def cwd_prompt(cursor: int) -> list[str]:
    labels = [
        "Use session directory (/old)",
        "Use current directory (/new)",
        "Always use current directory (/new)",
    ]
    rows = [
        ("› " if i == cursor else "  ") + f"{i + 1}. {l}" for i, l in enumerate(labels)
    ]
    return ["  Working directory", "", *rows, "", "  Press enter to continue"]


class CodexCwdPromptTest(unittest.TestCase):
    def answer(self, lines):
        sent = []
        with patch.object(
            agent_restart.tmux_service,
            "send_keys",
            lambda pane, keys: sent.append(keys),
        ):
            result = agent_restart._answer_codex_cwd("%1", lines)
        return result, sent

    def test_picks_current_directory_once(self):
        self.assertEqual(
            self.answer(cwd_prompt(0)), ("codex-cwd:current", [["Down", "Enter"]])
        )
        self.assertEqual(self.answer(cwd_prompt(1))[1], [["Enter"]])
        self.assertEqual(self.answer(cwd_prompt(2))[1], [["Up", "Enter"]])

    def test_other_screens_are_ignored(self):
        talk = [
            "• Use current directory (/x) 를 고르면 돼요",
            "› Ask Codex",
            "? for shortcuts",
        ]
        self.assertEqual(self.answer(talk), (None, []))


class ClaudeLogTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, {"CLAUDE_DATA_DIR": str(self.root)})
        env.start()
        self.addCleanup(env.stop)

    def test_project_dir_follows_claude_naming(self):
        name = lambda p: agent_restart.claude_project_dir(Path(p)).name
        self.assertEqual(
            name("/home/yojun/yojun313.github.io"), "-home-yojun-yojun313-github-io"
        )
        self.assertEqual(name("/home/yojun/자소서"), "-home-yojun----")
        with self.assertRaises(ValueError):
            agent_restart.claude_project_dir(Path("/" + "a" * 250))

    def test_copies_conversation_and_keeps_original(self):
        old = self.root / "projects/-old"
        (old / LID / "subagents").mkdir(parents=True)
        (old / f"{LID}.jsonl").write_text("talk\n")
        (old / LID / "subagents/a.jsonl").write_text("sub\n")
        agent_restart.carry_claude_log(LID, Path("/new/dir"))
        new = self.root / "projects/-new-dir"
        self.assertEqual((new / f"{LID}.jsonl").read_text(), "talk\n")
        self.assertTrue((new / LID / "subagents/a.jsonl").exists())
        self.assertTrue((old / f"{LID}.jsonl").exists())

    def test_rejects_bad_id_and_missing_log(self):
        with self.assertRaises(ValueError):
            agent_restart.carry_claude_log("../../x", Path("/new"))
        with self.assertRaises(ValueError):
            agent_restart.carry_claude_log(LID, Path("/new"))


class MoveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        pane = lambda pid, cmd: SimpleNamespace(id=pid, command=cmd)
        self.windows = [
            SimpleNamespace(
                key="s:0",
                session="s",
                session_id="$1",
                status="idle",
                panes=[pane("%1", "codex")],
            ),
            SimpleNamespace(
                key="s:1",
                session="s",
                session_id="$1",
                status="shell",
                panes=[pane("%2", "zsh")],
            ),
            SimpleNamespace(
                key="s:2",
                session="s",
                session_id="$1",
                status="shell",
                panes=[pane("%3", "node")],
            ),
            SimpleNamespace(
                key="o:0",
                session="o",
                session_id="$2",
                status="idle",
                panes=[pane("%9", "codex")],
            ),
        ]
        tm = session_move.tmux_service
        for target, name, value in (
            (tm, "list_windows", lambda: self.windows),
            (tm, "_run", lambda args, **kw: self.calls.append(("run", args))),
            (
                tm,
                "send_literal",
                lambda pane, text: self.calls.append(("text", pane, text)),
            ),
            (
                tm,
                "send_keys",
                lambda pane, keys: self.calls.append(("keys", pane, keys)),
            ),
            (tm, "invalidate_cache", lambda: None),
            (agent_restart, "plan", lambda pane: {"agent": "codex"}),
            (
                agent_restart,
                "restart",
                lambda pane, update, cwd: self.calls.append(
                    ("restart", pane, update, str(cwd))
                ),
            ),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_moves_only_this_session(self):
        result = session_move.move("$1", self.temp.name)
        path = str(Path(self.temp.name).resolve())
        self.assertIn(("restart", "%1", False, path), self.calls)
        self.assertIn(
            ("run", ["-C", "attach-session", "-t", "$1", "-c", path]), self.calls
        )
        self.assertTrue(
            any(c[0] == "text" and c[1] == "%2" and path in c[2] for c in self.calls)
        )
        self.assertFalse(any("%3" in c or "%9" in c for c in self.calls))
        self.assertEqual(result["skipped"], ["s:2 (node)"])

    def test_busy_or_waiting_agent_changes_nothing(self):
        for status in ("busy", "waiting"):
            self.windows[0].status = status
            with self.assertRaises(ValueError):
                session_move.move("$1", self.temp.name)
        self.assertEqual(self.calls, [])

    def test_bad_input_changes_nothing(self):
        for session, path in (
            ("$1", "/nonexistent/x"),
            ("$1", "a\nb"),
            ("$7", self.temp.name),
            ("1;x", self.temp.name),
        ):
            with self.assertRaises((ValueError, KeyError)):
                session_move.move(session, path)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
