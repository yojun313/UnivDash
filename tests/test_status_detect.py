"""화면으로 에이전트 상태를 판정하는 시험. 실제 tmux 는 쓰지 않는다."""

import unittest
from types import SimpleNamespace

from app.services import agent_restart
from app.services.tmux_service import detect_status

SEP = "─" * 53


def status(screen: str, agent: str = "claude", title: str = "✳ 작업") -> str:
    pane = SimpleNamespace(active=True, dead=False, title=title)
    return detect_status(SimpleNamespace(panes=[pane], agent=agent), screen)


def claude(
    body: str, footer: str = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · …"
) -> str:
    return f"{body}\n\n{SEP}\n❯ \n{SEP}\n{footer}\n"


CLAUDE_BUSY_NARROW = claude(
    """● The FAQ misses class registration.

  Running 1 shell command…
  ⎿  $ sed -n 1,120p report.md

· Accomplishing… (3m 19s · still thinking)
  ⎿  Tip: Use /btw to ask a quick side question
     without interrupting Claude's current work
""",
    "  ⏵⏵ bypass permissions on · 1 shell · esc to inte…",
)

CLAUDE_IDLE_QUOTING_PROMPTS = claude(
    """● 안내 문구는 Enter to confirm · Esc to cancel 이고
  선택지는 ❯ 1. Yes 처럼 보여요. (y/n) 질문도 있어요.
  enter to select · esc to go back · Press enter to continue

✻ Worked for 2m 50s
"""
)

CLAUDE_PERMISSION = """● Bash(rm -rf build)

╭───────────────────────────────────────────────────╮
 Bash command

   rm -rf build
   Remove build output

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend
"""

CLAUDE_QUESTION_LONG = f"""● 몇 가지 정할 게 있어요.

{SEP}
 ← ☐ 방식  ☐ 범위  ✔ Submit →

어떤 방식으로 만들까요?

  1. 새 페이지로 만들기
     설명이 아주 길어서 두 줄로
     넘어가는 선택지입니다.
  2. 기존 페이지에 넣기
     기존 화면 아래에 카드로
     붙입니다.
❯ 3. 둘 다
     두 곳 모두에 넣습니다.
  4. Type something.
{SEP}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to canc…
"""

CODEX_IDLE_NARROW = """• 정리했어요.

› Ask Codex to do anything

  GPT-6-Astra medium · ~/ParkSy… Pursuing goal (3m)
  ← for agents · ? for sho  ⚠ 1 warning · f2 to view
"""

CODEX_BUSY = """• Compacting context (22s • esc to interrupt)
  └ Making room to continue.

› Ask Codex to do anything

  GPT-6-Astra medium · ~/ParkSy…
  ← for agents · ? for sho
"""

CODEX_APPROVAL = """• I need to run a command.

  Would you like to run the following command?

  $ rm -rf build

› 1. Yes, proceed (y)
  2. Yes, and don't ask again (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
"""

CODEX_PICKER_SECOND = """  Select Model and Effort

  1. GPT-6-Astra (current)  빠름
› 2. GPT-6-Sol              깊음

  Press enter to select reasoning effort, or esc to dismiss.
"""

CODEX_IDLE_QUOTING = """• 선택지는 › 1. Yes 처럼 보이고 Press enter to confirm or esc to cancel 이에요.

› Ask Codex to do anything

  GPT-6-Astra medium · ~/x
  ? for shortcuts
"""


class StatusTest(unittest.TestCase):
    def test_claude_busy_with_truncated_footer(self):
        self.assertEqual(status(CLAUDE_BUSY_NARROW), "busy")

    def test_claude_spinner_alone_is_busy(self):
        screen = CLAUDE_BUSY_NARROW.replace("esc to inte…", "")
        self.assertEqual(status(screen), "busy")

    def test_claude_text_about_prompts_is_not_waiting(self):
        self.assertEqual(status(CLAUDE_IDLE_QUOTING_PROMPTS), "idle")

    def test_claude_permission_prompt(self):
        self.assertEqual(status(CLAUDE_PERMISSION), "waiting")

    def test_claude_question_with_cursor_low_and_long_options(self):
        self.assertEqual(status(CLAUDE_QUESTION_LONG), "waiting")

    def test_claude_limit_is_idle(self):
        screen = claude("You've hit your session limit · resets 1am")
        self.assertEqual(status(screen), "idle")

    def test_codex_idle_narrow(self):
        self.assertEqual(status(CODEX_IDLE_NARROW, "codex", "공공"), "idle")
        self.assertTrue(agent_restart._ready(CODEX_IDLE_NARROW.split("\n"), "codex"))

    def test_codex_busy(self):
        self.assertEqual(status(CODEX_BUSY, "codex", "공공"), "busy")
        self.assertEqual(status(CODEX_IDLE_NARROW, "codex", "⠙ 공공"), "busy")

    def test_codex_approval_and_picker(self):
        self.assertEqual(status(CODEX_APPROVAL, "codex", "공공"), "waiting")
        self.assertEqual(status(CODEX_PICKER_SECOND, "codex", "공공"), "waiting")
        self.assertFalse(agent_restart._ready(CODEX_APPROVAL.split("\n"), "codex"))

    def test_codex_text_about_prompts_is_not_waiting(self):
        self.assertEqual(status(CODEX_IDLE_QUOTING, "codex", "공공"), "idle")


if __name__ == "__main__":
    unittest.main()
