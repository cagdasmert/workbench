from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

import modelctld as d


class ClaimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = d.JobStore()

    def test_a_free_store_takes_the_job(self) -> None:
        job = d.Job("image", "a/x", [])
        self.assertIsNone(self.store.claim(job))
        self.assertIn(job, self.store.all())

    def test_the_same_repo_conflicts_whatever_the_kind(self) -> None:
        pull = d.Job("pull", "a/x", [])
        self.store.claim(pull)
        second = d.Job("image", "a/x", [])
        self.assertIs(self.store.claim(second), pull)
        self.assertNotIn(second, self.store.all())

    def test_the_same_kind_conflicts_only_when_exclusive(self) -> None:
        first = d.Job("image", "a/x", [])
        self.store.claim(first)
        self.assertIs(self.store.claim(d.Job("image", "b/y", []), exclusive_kind=True), first)
        self.assertIsNone(self.store.claim(d.Job("asr", "c/z", []), exclusive_kind=True))

    def test_finished_jobs_do_not_conflict(self) -> None:
        first = d.Job("image", "a/x", [])
        self.store.claim(first)
        first.state = "done"
        self.assertIsNone(self.store.claim(d.Job("image", "a/x", []), exclusive_kind=True))


class StartJobExclusiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.blocker = d.Job("image", "a/x", [])
        d.JOBS.add(self.blocker)

    def tearDown(self) -> None:
        self.blocker.state = "done"     # JOBS is shared with every other test module

    def test_a_second_image_job_is_409_and_names_the_first(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.start_job("image", "b/y", [], script="/nonexistent.py", exclusive_kind=True)
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("another image job", str(cm.exception))
        self.assertIn(self.blocker.id, cm.exception.hint or "")

    def test_the_same_repo_message_is_unchanged(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.start_job("pull", "a/x", [], script="/nonexistent.py")
        self.assertEqual(str(cm.exception), "a/x already has a running image job")


def _wait_until_not_running(job: d.Job, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while job.state == "running" and time.monotonic() < deadline:
        time.sleep(0.02)


class StartJobNulByteTest(unittest.TestCase):
    """F1: a NUL byte in argv must fail the job, not wedge it in 'running'."""

    def test_a_nul_byte_in_argv_fails_the_job_and_frees_the_slot(self) -> None:
        fd, out = tempfile.mkstemp(prefix="modelctld-f1-nul-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("{}")
        result_path = Path(out)
        job = d.start_job("image", "nul/repo", ["--prompt=bad\x00value"],
                          script="/nonexistent.py", result_path=result_path, exclusive_kind=True)
        _wait_until_not_running(job)
        self.assertEqual(job.state, "failed")
        self.assertIn("null byte", job.error or "")
        self.assertFalse(result_path.exists())

        # The slot freed up: a new image job (a different repo, exclusive_kind)
        # is accepted rather than getting the 409 a stuck 'running' job would cause.
        second = d.start_job("image", "other/repo", [], script="/nonexistent.py", exclusive_kind=True)
        _wait_until_not_running(second)


class JobOutputTest(unittest.TestCase):
    def _run(self, source: str, repo: str) -> d.Job:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "child.py"
            script.write_text(source)
            job = d.start_job("test-output", repo, [], script=str(script))
            deadline = time.time() + 10
            while job.state == "running" and time.time() < deadline:
                time.sleep(0.05)
        return job

    def test_bytes_that_are_not_utf8_do_not_wedge_the_job(self) -> None:
        job = self._run('import sys; sys.stdout.buffer.write(b"\\xff bad\\n"); sys.stdout.flush()\n',
                        "test/bad-bytes")
        self.assertEqual(job.state, "done")
        self.assertIn("�", job.lines[0])

    def test_a_finished_job_holds_no_pipe(self) -> None:
        job = self._run('print("ok")\n', "test/pipe-closed")
        self.assertEqual(job.state, "done")
        self.assertTrue(job._proc is not None and job._proc.stdout is not None and job._proc.stdout.closed)


if __name__ == "__main__":
    unittest.main()
