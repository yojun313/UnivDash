"""Codex 업데이트 안내를 정확히 알아보는지 시험한다."""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_restart, agent_update_all as updates

PROMPT = [
    "  Update available · 0.166.0 → 0.167.0",
    "  Release notes: https://github.com/openai/codex/releases/latest",
    "› 1. Update now (runs `sh -c 'x'`)",
    "  2. Skip",
    "  3. Skip until next version",
    "  enter continue · esc skip",
]


class UpdatePromptTest(unittest.TestCase):
    def test_reads_new_version(self):
        self.assertEqual(agent_restart.update_prompt_version(PROMPT), "0.167.0")

    def test_same_words_in_conversation_do_not_count(self):
        for lines in (
            ["Update available · 0.166.0 → 0.167.0", "› Ask Codex", "? for shortcuts"],
            PROMPT[:-1] + ["› Ask Codex"],
            ["1. Update now 안내가 나왔어요", "enter continue · esc skip"],
            [],
        ):
            self.assertIsNone(agent_restart.update_prompt_version(lines))


class PendingRestartTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        data = patch.dict(os.environ, {"UNIVDASH_DATA_DIR": temp.name})
        data.start()
        self.addCleanup(data.stop)
        updates._prompt_restarted.clear()
        self.status = "busy"
        self.restarted = []
        window = lambda: SimpleNamespace(key="w:0", status=self.status)  # noqa: E731
        pane = SimpleNamespace(id="%1")
        self.prompts = [("%1", "w:0", "2.0.0")]
        for target, name, value in (
            (updates, "_agent_panes", lambda agent: [(window(), pane)]),
            (updates, "_dismiss_update_prompts", self.take_prompts),
            (updates, "_ensure_installed", lambda version: True),
            (updates.codex_accounts, "apply_status", lambda: {"state": "idle"}),
            (
                agent_restart,
                "restart",
                lambda pane, update=False: self.restarted.append(pane),
            ),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def take_prompts(self):
        found, self.prompts = self.prompts, []
        return found

    def test_busy_window_is_restarted_once_idle(self):
        self.assertEqual(updates.sweep_update_prompts(), [])
        self.assertTrue(updates._pending_file().exists())
        self.assertEqual(updates.sweep_update_prompts(), [])
        self.status = "idle"
        self.assertEqual(updates.sweep_update_prompts(), ["w:0"])
        self.assertEqual(self.restarted, ["%1"])
        self.assertFalse(updates._pending_file().exists())
        self.assertEqual(updates.sweep_update_prompts(), [])
        self.assertEqual(self.restarted, ["%1"])

    def test_closed_window_is_forgotten(self):
        updates.sweep_update_prompts()
        with patch.object(updates, "_agent_panes", lambda agent: []):
            self.status = "idle"
            self.assertEqual(updates.sweep_update_prompts(), [])
        self.assertFalse(updates._pending_file().exists())
        self.assertEqual(self.restarted, [])


if __name__ == "__main__":
    unittest.main()
