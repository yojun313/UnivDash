"""실제 git 으로 임시 저장소를 만들어 자동 Pull 이 안전한 경우에만 받는지 확인한다."""

import hashlib
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import git_auto_pull
from app.services.git_service import GitService

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}


def git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    ).stdout.strip()


class AutoPullTest(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        root = Path(self._temp.name).resolve()
        self.remote = root / "remote.git"
        self.other = root / "other"
        self.local = root / "local"
        git(root, "init", "--bare", "-b", "main", str(self.remote))
        git(root, "clone", str(self.remote), str(self.other))
        git(self.other, "checkout", "-b", "main")
        self.commit_remote("a.txt", "1")
        git(self.other, "push", "-u", "origin", "main")
        git(root, "clone", str(self.remote), str(self.local))
        env = {
            "UNIVDASH_DATA_DIR": str(root / "data"),
            "GIT_REPOSITORIES": str(self.local),
        }
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._temp.cleanup)
        self.id = hashlib.sha256(str(self.local).encode()).hexdigest()[:16]

    def commit_remote(self, name, content):
        (self.other / name).write_text(content)
        git(self.other, "add", "-A")
        git(self.other, "commit", "-m", f"{name}={content}")

    def push_remote(self, name, content):
        self.commit_remote(name, content)
        git(self.other, "push")

    def commit_local(self, name, content):
        (self.local / name).write_text(content)
        git(self.local, "add", "-A")
        git(self.local, "commit", "-m", "local")

    def head(self):
        return git(self.local, "rev-parse", "HEAD")

    def test_receives_new_commits_fast_forward(self):
        self.assertTrue(git_auto_pull.pull(self.id)["message"].startswith("이미 최신"))
        self.push_remote("a.txt", "2")
        result = git_auto_pull.pull(self.id)
        self.assertEqual((result["ok"], result["commits"]), (True, 1))
        self.assertEqual((self.local / "a.txt").read_text(), "2")
        self.assertEqual(self.head(), git(self.other, "rev-parse", "HEAD"))

    def test_keeps_unrelated_local_changes(self):
        (self.local / "note.txt").write_text("keep")
        self.push_remote("b.txt", "x")
        self.assertTrue(git_auto_pull.pull(self.id)["ok"])
        self.assertEqual((self.local / "note.txt").read_text(), "keep")
        self.assertEqual((self.local / "b.txt").read_text(), "x")

    def test_overlapping_local_change_is_untouched(self):
        (self.local / "a.txt").write_text("mine")
        before = self.head()
        self.push_remote("a.txt", "2")
        result = git_auto_pull.pull(self.id)
        self.assertFalse(result["ok"])
        self.assertIn("겹치는", result["message"])
        self.assertEqual(self.head(), before)
        self.assertEqual((self.local / "a.txt").read_text(), "mine")

    def test_autostash_config_does_not_touch_local_change(self):
        git(self.local, "config", "merge.autoStash", "true")
        (self.local / "a.txt").write_text("mine")
        self.push_remote("a.txt", "2")
        self.assertFalse(git_auto_pull.pull(self.id)["ok"])
        self.assertEqual((self.local / "a.txt").read_text(), "mine")
        self.assertEqual(git(self.local, "stash", "list"), "")

    def test_diverged_history_is_untouched_even_with_rebase_config(self):
        git(self.local, "config", "pull.rebase", "true")
        self.commit_local("mine.txt", "1")
        before = self.head()
        self.push_remote("a.txt", "2")
        result = git_auto_pull.pull(self.id)
        self.assertFalse(result["ok"])
        self.assertIn("갈라져", result["message"])
        self.assertEqual(self.head(), before)

    def test_no_upstream_and_detached_and_merge_in_progress(self):
        git(self.local, "checkout", "-q", "-b", "solo")
        self.assertIn("upstream", git_auto_pull.pull(self.id)["message"])
        git(self.local, "checkout", "-q", "--detach")
        self.assertIn("detached", git_auto_pull.pull(self.id)["message"])
        git(self.local, "checkout", "-q", "main")
        git_dir = Path(git(self.local, "rev-parse", "--absolute-git-dir"))
        (git_dir / "MERGE_HEAD").write_text(self.head() + "\n")
        self.addCleanup((git_dir / "MERGE_HEAD").unlink, missing_ok=True)
        self.assertIn("merge", git_auto_pull.pull(self.id)["message"])

    def test_busy_repository_is_skipped_without_record(self):
        git_auto_pull.configure(self.id, True, 15)
        lock = GitService._lock_for(self.id)
        lock.acquire()
        self.addCleanup(lock.release)
        git_auto_pull._run_one(self.id)
        self.assertIsNone(git_auto_pull.status(self.id)["last_run"])
        self.assertEqual(git_auto_pull._due(time.time()), [self.id])

    def test_schedule_and_settings(self):
        self.assertEqual(git_auto_pull.status(self.id)["interval_minutes"], 15)
        self.assertEqual(git_auto_pull._due(time.time()), [])
        git_auto_pull.configure(self.id, True, 5)
        self.assertEqual(git_auto_pull._due(time.time()), [self.id])  # 켜면 바로 한 번
        git_auto_pull._run_one(self.id)
        state = git_auto_pull.status(self.id)
        self.assertTrue(state["ok"])
        self.assertEqual(state["next_run"], state["last_run"] + 300)
        self.assertEqual(git_auto_pull._due(state["last_run"] + 299), [])
        self.assertEqual(git_auto_pull._due(state["last_run"] + 300), [self.id])
        git_auto_pull.configure(self.id, False, 5)
        self.assertEqual(git_auto_pull._due(state["last_run"] + 9999), [])
        self.assertEqual(git_auto_pull.status(self.id)["last_run"], state["last_run"])
        mode = (git_auto_pull._path().stat().st_mode) & 0o777
        self.assertEqual(mode, 0o600)

    def test_unknown_repository_cannot_be_registered(self):
        with self.assertRaises(KeyError):
            git_auto_pull.configure("0" * 16, True, 15)

    def test_credentials_are_masked(self):
        git_auto_pull.configure(self.id, True, 15)
        git(
            self.local,
            "remote",
            "set-url",
            "origin",
            "https://user:secret@127.0.0.1:9/x.git",
        )
        git_auto_pull._run_one(self.id)
        state = git_auto_pull.status(self.id)
        self.assertFalse(state["ok"])
        self.assertNotIn("secret", state["message"])
        self.assertNotIn("secret", git_auto_pull._path().read_text())


if __name__ == "__main__":
    unittest.main()
