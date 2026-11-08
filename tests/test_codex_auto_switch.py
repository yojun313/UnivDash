"""자동 전환 판단 시험. 계정 전환 · tmux · 사용량 조회는 가짜로 대체한다."""

import json
import os
import tempfile
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import codex_auto_switch as auto


def _at(seconds_ago=0):
    return (datetime.now(UTC) - timedelta(seconds=seconds_ago)).isoformat()


def event(kind, **fields):
    return json.dumps(
        {"timestamp": _at(), "type": "event_msg", "payload": {"type": kind, **fields}}
    )


LIMIT = {"codex_error_info": "usage_limit_exceeded", "message": "Your limit"}
OK = {"windows": [{"used_percent": 10}], "reached_type": None}
FULL = {"windows": [{"used_percent": 100, "resets_at": "2099-01-01T00:00:00+00:00"}]}
CREDITS = {
    "windows": [{"used_percent": 20}],
    "reached_type": "workspace_owner_credits_depleted",
}
ACCOUNTS = [
    {"id": "aaaaaaaaaaaa", "email": "a@x", "active": True},
    {"id": "bbbbbbbbbbbb", "email": "b@x", "active": False},
    {"id": "cccccccccccc", "email": "c@x", "active": False},
]


class FailureLogTest(unittest.TestCase):
    def read(self, *lines):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            handle.write("\n".join(lines) + "\n")
        self.addCleanup(os.unlink, handle.name)
        return auto._read_failure(Path(handle.name))

    def test_limit_error_is_found(self):
        failure = self.read(
            event("task_started"), event("task_complete", turn_id="t1", error=LIMIT)
        )
        self.assertEqual(failure["turn"], "t1")

    def test_later_activity_clears_it(self):
        for later in ("task_started", "user_message"):
            self.assertIsNone(
                self.read(
                    event("task_complete", turn_id="t1", error=LIMIT), event(later)
                )
            )

    def test_success_and_other_errors_do_not_count(self):
        self.assertIsNone(self.read(event("task_complete", turn_id="t1", error=None)))
        other = {"codex_error_info": "server_overloaded"}
        self.assertIsNone(self.read(event("task_complete", turn_id="t1", error=other)))

    def test_same_words_in_conversation_do_not_count(self):
        talk = event("agent_message", message="You've hit your usage limit")
        self.assertIsNone(
            self.read(talk, event("task_complete", turn_id="t", error=None))
        )


class TickTest(unittest.TestCase):
    real_stopped = staticmethod(auto._stopped_panes)

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        data = patch.dict(os.environ, {"UNIVDASH_DATA_DIR": temp.name})
        data.start()
        self.addCleanup(data.stop)
        self.stopped = {}
        self.limits = {"current": FULL, "bbbbbbbbbbbb": OK, "cccccccccccc": FULL}
        self.accounts = ACCOUNTS
        self.switched = []
        self.prompts = []
        self.apply = {
            "state": "idle",
            "seq": 0,
            "result": None,
            "error": None,
            "waiting": [],
        }
        window = SimpleNamespace(key="w:0", status="idle", starting=False)
        pane = SimpleNamespace(id="%1")
        self.panes = [(window, pane)]
        self.screen = ["› ", "? for shortcuts"]
        self.existing = {"%1"}
        self.log = None
        for target, name, value in (
            (auto, "_stopped_panes", lambda: dict(self.stopped)),
            (auto, "_log_of", lambda pane: self.log),
            (auto.tmux_service, "_pane_ids", lambda: set(self.existing)),
            (auto, "_current_limits", lambda: self.limits["current"]),
            (auto, "_saved_limits", lambda account: self.limits[account]),
            (auto.codex_accounts, "list_accounts", lambda: {"accounts": self.accounts}),
            (auto.codex_accounts, "switch", self.fake_switch),
            (auto.codex_accounts, "apply_status", lambda: dict(self.apply)),
            (auto.agent_restart, "codex_panes", lambda: self.panes),
            (auto.agent_restart, "_screen_lines", lambda pane: self.screen),
            (
                auto.tmux_service,
                "send_prompt",
                lambda pane, text: self.prompts.append((pane, text)),
            ),
            (auto.tmux_service, "invalidate_cache", lambda: None),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def fake_switch(self, account, update=True):
        self.assertFalse(update)
        self.switched.append(account)
        self.apply = {
            "state": "waiting",
            "seq": 7,
            "result": None,
            "error": None,
            "waiting": [],
        }
        return {"applied": self.apply}

    def stop(self, turn="t1", recent=True, busy=False):
        self.stopped = {
            "%1": {"key": "w:0", "turn": turn, "recent": recent, "busy": busy}
        }

    def finish_apply(self, relaunched=("w:0",)):
        self.apply = {
            "state": "done",
            "seq": 7,
            "error": None,
            "waiting": [],
            "result": {"relaunched": list(relaunched)},
        }

    def test_nothing_without_a_stopped_window(self):
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.switched, [])

    def test_switches_to_available_account_and_resumes(self):
        self.stop()
        notices = auto.tick()
        self.assertEqual(self.switched, ["bbbbbbbbbbbb"])
        self.assertIn("b@x", notices[0]["body"])
        self.assertEqual(self.prompts, [])
        auto.tick()  # 아직 적용 중
        self.assertEqual(self.prompts, [])
        self.finish_apply()
        auto.tick()  # 적용 끝 → 이어갈 창 등록
        auto.tick()  # 입력창 확인 → 전송
        self.assertEqual(self.prompts, [("%1", auto.RESUME_TEXT)])
        self.stopped = {}
        auto.tick()
        self.assertEqual(len(self.prompts), 1)
        self.assertEqual(len(self.switched), 1)

    def test_credit_depleted_account_is_not_chosen(self):
        self.limits["bbbbbbbbbbbb"] = CREDITS
        self.limits["cccccccccccc"] = {"windows": [{"used_percent": 50}]}
        self.stop()
        auto.tick()
        self.assertEqual(self.switched, ["cccccccccccc"])

    def test_most_remaining_account_wins(self):
        self.limits["bbbbbbbbbbbb"] = {"windows": [{"used_percent": 70}]}
        self.limits["cccccccccccc"] = {"windows": [{"used_percent": 5}]}
        self.stop()
        auto.tick()
        self.assertEqual(self.switched, ["cccccccccccc"])

    def test_account_with_unreadable_limits_is_skipped(self):
        self.limits["bbbbbbbbbbbb"] = None
        self.limits["cccccccccccc"] = FULL
        self.stop()
        notices = auto.tick()
        self.assertEqual(self.switched, [])
        self.assertIn("모두", notices[0]["title"])

    def test_single_account_does_nothing(self):
        self.accounts = ACCOUNTS[:1]
        self.stop()
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.prompts, [])

    def test_disabled_does_nothing(self):
        auto.set_enabled(False)
        self.stop()
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.switched, [])

    def test_enabled_by_default(self):
        self.assertTrue(auto.status()["enabled"])

    def test_old_failure_is_left_alone(self):
        self.stop(recent=False)
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.switched, [])

    def test_same_turn_is_handled_once(self):
        self.stop()
        auto.tick()
        self.finish_apply()
        auto.tick()
        auto.tick()
        self.apply = {
            "state": "done",
            "seq": 7,
            "error": None,
            "waiting": [],
            "result": {},
        }
        for _ in range(3):
            auto.tick()
        self.assertEqual(len(self.switched), 1)
        self.assertEqual(len(self.prompts), 1)

    def test_all_out_waits_once_then_resumes_after_reset(self):
        self.limits["bbbbbbbbbbbb"] = FULL
        self.stop()
        notices = auto.tick()
        self.assertIn("모두", notices[0]["title"])
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.switched, [])
        self.limits["current"] = OK
        with auto._lock:
            state = auto._load()
            state.update(retry_at=0.0, next_check=0.0)
            auto._save(state)
        notices = auto.tick()
        self.assertIn("초기화", notices[0]["title"])
        self.assertEqual(self.prompts, [("%1", auto.RESUME_TEXT)])
        self.assertEqual(self.switched, [])

    def test_person_resuming_cancels_waiting(self):
        self.limits["bbbbbbbbbbbb"] = FULL
        self.stop()
        auto.tick()
        self.stopped = {}  # 로그의 마지막 턴이 더는 한도 오류가 아니다
        self.log = Path("/fake.jsonl")
        auto.tick()
        self.assertEqual(auto.status()["waiting"], 0)

    def wait_all_out(self):
        self.limits["bbbbbbbbbbbb"] = FULL
        self.stop()
        auto.tick()
        self.assertEqual(auto.status()["waiting"], 1)

    def check_now(self):
        with auto._lock:
            state = auto._load()
            state.update(retry_at=0.0, next_check=0.0)
            auto._save(state)

    def test_busy_misread_keeps_waiting_and_resumes(self):
        self.wait_all_out()
        self.stop(recent=False, busy=True)  # 30분 뒤 화면을 잠깐 잘못 읽었다
        auto.tick()
        self.assertEqual(auto.status()["waiting"], 1)
        self.stop(recent=False)
        self.limits["current"] = OK
        self.check_now()
        auto.tick()
        self.assertEqual(self.prompts, [("%1", auto.RESUME_TEXT)])

    def test_busy_failure_is_not_handled_until_idle(self):
        self.stop(busy=True)
        self.assertEqual(auto.tick(), [])
        self.assertEqual(self.switched, [])
        self.stop()
        auto.tick()
        self.assertEqual(self.switched, ["bbbbbbbbbbbb"])

    def test_codex_restarting_keeps_waiting(self):
        self.wait_all_out()
        self.stopped, self.panes = {}, []  # 업데이트 등으로 Codex 가 잠깐 꺼졌다
        auto.tick()
        self.assertEqual(auto.status()["waiting"], 1)

    def test_starting_window_and_missing_log_keep_waiting(self):
        self.wait_all_out()
        self.stopped = {}
        auto.tick()  # 로그를 아직 못 찾는다
        self.assertEqual(auto.status()["waiting"], 1)
        self.log = Path("/fake.jsonl")
        self.panes[0][0].starting = True
        auto.tick()  # 켜지는 중에는 찾은 로그를 믿지 않는다
        self.assertEqual(auto.status()["waiting"], 1)

    def test_closed_window_stops_waiting(self):
        self.wait_all_out()
        self.stopped, self.panes, self.existing = {}, [], set()
        auto.tick()
        self.assertEqual(auto.status()["waiting"], 0)

    def test_tmux_failure_keeps_waiting(self):
        self.wait_all_out()
        self.stopped = {}
        with (
            patch.object(
                auto.tmux_service,
                "_pane_ids",
                side_effect=auto.tmux_service.TmuxError("x"),
            ),
            self.assertRaises(auto.tmux_service.TmuxError),
        ):
            auto.tick()
        self.assertEqual(auto.status()["waiting"], 1)

    def soon(self, seconds):
        return {
            "windows": [
                {
                    "used_percent": 100,
                    "resets_at": datetime.fromtimestamp(
                        time.time() + seconds, UTC
                    ).isoformat(),
                }
            ]
        }

    def test_next_check_follows_reset_time(self):
        self.limits["bbbbbbbbbbbb"] = self.soon(60)
        self.stop()
        auto.tick()
        with auto._lock:
            state = auto._load()
        self.assertAlmostEqual(
            state["next_check"], state["reset_at"] + auto.RESET_MARGIN, delta=1
        )

    def test_far_reset_keeps_normal_interval(self):
        self.limits["bbbbbbbbbbbb"] = self.soon(3600)
        self.stop()
        auto.tick()
        with auto._lock:
            state = auto._load()
        self.assertAlmostEqual(
            state["next_check"], time.time() + auto.RECHECK_ALL_OUT, delta=2
        )

    def test_polls_often_only_right_after_reset(self):
        self.limits["bbbbbbbbbbbb"] = self.soon(3600)  # 다음 초기화는 한참 뒤
        self.stop()
        auto.tick()
        with auto._lock:
            state = auto._load()
            state.update(reset_at=time.time() - 5, next_check=0.0)
            auto._save(state)
        auto.tick()  # 방금 초기화됐지만 서버에는 아직 반영되지 않았다
        with auto._lock:
            state = auto._load()
        self.assertAlmostEqual(
            state["next_check"], time.time() + auto.RESET_POLL, delta=2
        )
        with auto._lock:
            state.update(next_check=0.0)
            auto._save(state)
        auto.tick()  # 새 초기화 시각이 잡혀 있어도 마감까지만 자주 본다
        with auto._lock:
            state = auto._load()
        self.assertLessEqual(state["watch_until"], time.time() + auto.RESET_WATCH)

    def test_stopped_panes_reports_busy(self):
        self.panes[0][0].status = "busy"
        failure = {"turn": "t", "at": _at()}
        real = TickTest.real_stopped
        with patch.object(auto, "_failure_of", return_value=failure):
            self.assertTrue(real()["%1"]["busy"])

    def test_person_switching_during_wait_takes_over(self):
        self.stop()
        auto.tick()
        self.apply = {**self.apply, "seq": 8, "state": "waiting"}
        auto.tick()
        with auto._lock:
            self.assertIsNone(auto._load()["pending"])

    def test_restart_during_switch_reapplies(self):
        self.stop()
        auto.tick()
        self.apply = {
            "state": "idle",
            "seq": 0,
            "result": None,
            "error": None,
            "waiting": [],
        }
        with patch.object(
            auto.codex_accounts, "schedule_apply", return_value={"seq": 3}
        ) as schedule:
            auto.tick()
        schedule.assert_called_once_with("bbbbbbbbbbbb", False)

    def test_apply_error_is_reported(self):
        self.stop()
        auto.tick()
        self.apply = {
            "state": "error",
            "seq": 7,
            "error": "안 됨",
            "result": None,
            "waiting": [],
        }
        notices = auto.tick()
        self.assertIn("실패", notices[0]["title"])

    def test_window_not_relaunched_is_reported(self):
        self.stop()
        auto.tick()
        self.finish_apply(relaunched=())
        notices = auto.tick()
        self.assertIn("다시 켜지 못", notices[0]["title"])
        self.assertEqual(self.prompts, [])

    def test_switch_rate_is_limited(self):
        with auto._lock:
            state = auto._load()
            state["switches"] = [time.time() - 3000 + i * 100 for i in range(6)]
            auto._save(state)
        self.stop()
        notices = auto.tick()
        self.assertEqual(self.switched, [])
        self.assertIn("멈췄어요", notices[0]["title"])

    def test_settings_file_is_private(self):
        auto.set_enabled(True)
        self.assertEqual(auto._path().stat().st_mode & 0o777, 0o600)


class RelaunchPlanTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        data = patch.dict(os.environ, {"UNIVDASH_DATA_DIR": temp.name})
        data.start()
        self.addCleanup(data.stop)
        self.sent = []
        self.windows = [
            self.window("a:0", "%1", "zsh"),
            self.window("b:0", "%2", "codex"),
        ]
        for target, name, value in (
            (auto.tmux_service, "list_windows", lambda: self.windows),
            (
                auto.tmux_service,
                "send_literal",
                lambda pane, text: self.sent.append((pane, text)),
            ),
            (auto.tmux_service, "send_keys", lambda pane, keys: None),
            (auto.tmux_service, "invalidate_cache", lambda: None),
            (auto.agent_restart, "watch_startup", lambda pane, agent=None: None),
            (
                auto.agent_restart,
                "_session_exists",
                lambda agent, session: session == "sid",
            ),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def window(key, pane, command):
        return SimpleNamespace(
            key=key, panes=[SimpleNamespace(id=pane, command=command)]
        )

    def plan(self, pane, key, session="sid"):
        return {"pane": pane, "key": key, "session": session, "flags": []}

    def test_only_stopped_panes_in_same_window_come_back(self):
        auto.agent_restart._write_relaunch(
            [
                self.plan("%1", "a:0"),  # 꺼진 채 남음 → 다시 켠다
                self.plan("%2", "b:0"),  # 이미 켜져 있음
                self.plan("%1", "other:0"),  # 다른 창이 됨
                self.plan("%9", "gone:0"),  # 창이 사라짐
                self.plan("%1", "a:0", session="unknown"),  # 대화가 없음
            ]
        )
        calls = []
        restored = auto.agent_restart.recover_relaunch(lambda: calls.append(1))
        self.assertEqual(restored, ["a:0"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("resume sid", self.sent[0][1])
        self.assertFalse(auto.agent_restart._relaunch_file().exists())

    def test_nothing_to_recover_does_nothing(self):
        calls = []
        self.assertEqual(
            auto.agent_restart.recover_relaunch(lambda: calls.append(1)), []
        )
        self.assertEqual(calls, [])
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
