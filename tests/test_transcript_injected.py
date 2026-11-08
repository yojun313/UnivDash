"""사용자 메시지처럼 기록되는 에이전트 내부 문맥을 채팅에서 숨기는지 시험."""

import unittest

from app.services.transcript_service import _user_text

GOAL = """<codex_internal_context source="user_goal">
User set goal: 공공데이터 대회 기획하기

Call update_goal only after the completion or blocked audit passes.

</codex_internal_context>"""


class InjectedTextTest(unittest.TestCase):
    def test_codex_internal_context_is_hidden(self):
        self.assertIsNone(_user_text(GOAL))
        self.assertIsNone(
            _user_text("  " + GOAL.replace("</codex_internal_context>", ""))
        )

    def test_user_text_around_it_is_kept(self):
        self.assertEqual(
            _user_text(f"{GOAL}\n\n계속 진행해 줘"), ("user", "계속 진행해 줘")
        )

    def test_mentioning_the_tag_in_words_is_kept(self):
        text = "codex_internal_context 태그는 왜 보여?"
        self.assertEqual(_user_text(text), ("user", text))


if __name__ == "__main__":
    unittest.main()
