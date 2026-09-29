from __future__ import annotations

import json
import unittest
from pathlib import Path

import modelctld as d

MSGS = [{"role": "user", "content": "Soru?"}]


class TextRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.started: list[tuple] = []
        self._orig, self._orig_resolve = d.start_job, d.mc.resolve

        def fake_start(kind, repo, args, **kw):
            messages = Path(args[args.index("--messages") + 1])
            self.started.append((kind, repo, args, kw.get("params"), json.loads(messages.read_text())))
            messages.unlink()
            Path(args[args.index("--out") + 1]).unlink(missing_ok=True)
            job = d.Job(kind, repo, args)
            job.params = kw.get("params") or {}
            return job

        d.start_job = fake_start
        d.mc.resolve = lambda repo, cfg=None: "/fake/snapshot"

    def tearDown(self) -> None:
        d.start_job, d.mc.resolve = self._orig, self._orig_resolve

    def test_starts_a_text_job_with_messages_in_a_file(self) -> None:
        job = d.h_text({"messages": MSGS, "model": "org/m", "max_tokens": 64})
        kind, repo, args, params, written = self.started[0]
        self.assertEqual((job["kind"], kind, repo), ("text", "text", "org/m"))
        self.assertIn("--out", args)
        self.assertEqual(args[args.index("--max-tokens") + 1], "64")
        self.assertEqual(written, MSGS)
        self.assertEqual(params, {"model": "org/m", "max_tokens": 64})

    def test_bad_messages_and_max_tokens_are_400(self) -> None:
        for body in ({"messages": "hi"}, {"messages": MSGS, "max_tokens": 0},
                     {"messages": MSGS, "max_tokens": "9"}):
            with self.assertRaises(d.ApiError) as cm:
                d.h_text(body)
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(self.started, [])

    def test_model_not_downloaded_is_404(self) -> None:
        d.mc.resolve = lambda repo, cfg=None: None
        with self.assertRaises(d.ApiError) as cm:
            d.h_text({"messages": MSGS})
        self.assertEqual(cm.exception.status, 404)
        self.assertIn("pull", cm.exception.hint or "")
