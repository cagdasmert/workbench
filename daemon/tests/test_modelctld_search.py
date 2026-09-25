from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import modelctld as d

FAKE_WORKER = textwrap.dedent("""
    import json, os, sys
    for line in sys.stdin:
        req = json.loads(line)
        if req.get("op") == "die":
            print("worker fell over", file=sys.stderr, flush=True)
            sys.exit(3)
        if req.get("op") == "reply":
            print(json.dumps(req["reply"]), flush=True)
            continue
        print(json.dumps({"ok": True, "pid": os.getpid(), "echo": req}), flush=True)
""")


class EmbedWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        script = Path(self.tmp.name) / "worker.py"
        script.write_text(FAKE_WORKER)
        self.worker = d.EmbedWorker([sys.executable, str(script)])

    def tearDown(self) -> None:
        self.worker.stop()
        self.tmp.cleanup()

    def test_one_process_serves_many_calls(self) -> None:
        a = self.worker.call({"op": "x"})
        b = self.worker.call({"op": "y"})
        self.assertEqual(a["pid"], b["pid"])
        self.assertEqual(b["echo"], {"op": "y"})

    def test_death_is_a_503_naming_the_cause_and_the_next_call_respawns(self) -> None:
        first = self.worker.call({"op": "x"})["pid"]
        with self.assertRaises(d.ApiError) as cm:
            self.worker.call({"op": "die"})
        self.assertEqual(cm.exception.status, 503)
        self.assertIn("worker fell over", str(cm.exception))
        self.assertNotEqual(self.worker.call({"op": "x"})["pid"], first)


class SearchRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sent: list[dict] = []
        self.reply: dict = {"ok": True, "hits": [], "model": "m", "took_ms": 1}
        test = self

        class Stub:
            def call(self, req: dict) -> dict:
                test.sent.append(req)
                return test.reply

        self._orig = d._worker
        d._worker = lambda: Stub()  # type: ignore[assignment]

    def tearDown(self) -> None:
        d._worker = self._orig

    def test_validation(self) -> None:
        for body in ({}, {"query": ""}, {"query": "  "}, {"query": "x", "folders": "a"},
                     {"query": "x", "limit": "8"}, {"query": "x", "folders": [1]}):
            with self.assertRaises(d.ApiError, msg=body):
                d.h_search(body)
        self.assertEqual(self.sent, [])

    def test_per_note_is_validated_and_forwarded(self) -> None:
        with self.assertRaises(d.ApiError):
            d.h_search({"query": "x", "per_note": "3"})
        d.h_search({"query": "x", "per_note": 3})
        self.assertEqual(self.sent[-1]["per_note"], 3)

    def test_forwards_and_strips_ok(self) -> None:
        out = d.h_search({"query": "kedi", "limit": 3, "folders": ["A"]})
        self.assertEqual(self.sent[0], {"op": "search", "query": "kedi", "limit": 3, "folders": ["A"]})
        self.assertEqual(out, {"hits": [], "model": "m", "took_ms": 1})

    def test_worker_errors_keep_status_and_hint(self) -> None:
        self.reply = {"ok": False, "status": 404, "error": "no folders", "hint": "index one"}
        with self.assertRaises(d.ApiError) as cm:
            d.h_search({"query": "kedi"})
        self.assertEqual((cm.exception.status, cm.exception.hint), (404, "index one"))

    def test_embed_validation(self) -> None:
        for body in ({}, {"texts": []}, {"texts": "a"}, {"texts": ["a"] * 257}):
            with self.assertRaises(d.ApiError, msg=body):
                d.h_embed(body)
        self.reply = {"ok": True, "vectors": [[0.1]], "model": "m"}
        self.assertEqual(d.h_embed({"texts": ["a"]})["vectors"], [[0.1]])
