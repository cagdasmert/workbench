from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
