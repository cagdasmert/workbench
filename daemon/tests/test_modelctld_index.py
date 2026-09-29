from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import modelctld as d


class IndexRoutesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["MODELCTL_VAULT_INDEX"] = str(Path(self.tmp.name) / "idx.sqlite")
        self.vault = Path(self.tmp.name) / "Notlar"
        self.vault.mkdir()
        (self.vault / "a.md").write_text("alpha\n")
        self.started: list[tuple] = []
        self._orig = d.start_job
        self._orig_resolve = d.mc.resolve

        def fake_start(kind, repo, args, **kw):
            self.started.append((kind, repo, args, kw.get("params")))
            job = d.Job(kind, repo, args)
            job.params = kw.get("params") or {}
            return job

        d.start_job = fake_start
        d.mc.resolve = lambda repo, cfg=None: "/fake/snapshot"

    def tearDown(self) -> None:
        d.start_job = self._orig
        d.mc.resolve = self._orig_resolve
        del os.environ["MODELCTL_VAULT_INDEX"]
        self.tmp.cleanup()

    def test_add_registers_and_starts_an_embed_job(self) -> None:
        job = d.h_index_add({"path": str(self.vault)})
        self.assertEqual(job["kind"], "embed")
        kind, repo, args, params = self.started[0]
        self.assertEqual(repo, "sentence-transformers/LaBSE")
        self.assertEqual(args[:2], ["index", "--folder"])
        self.assertIn("Notlar", args)
        self.assertEqual(params, {"folders": ["Notlar"], "full": False})
        [row] = d.h_index_list()["folders"]
        self.assertEqual((row["name"], row["changed"]), ("Notlar", 1))

    def test_add_rejects_relative_and_missing_paths(self) -> None:
        for bad in ("relative/dir", str(self.vault / "nope")):
            with self.assertRaises(d.ApiError):
                d.h_index_add({"path": bad})

    def test_add_same_name_other_path_is_409(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        other = Path(self.tmp.name) / "x" / "Notlar"
        other.mkdir(parents=True)
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_add({"path": str(other)})
        self.assertEqual(cm.exception.status, 409)

    def test_model_not_downloaded_is_404(self) -> None:
        d.mc.resolve = lambda repo, cfg=None: None
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_add({"path": str(self.vault)})
        self.assertEqual(cm.exception.status, 404)

    def test_refresh_mismatch_needs_full(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_refresh({"name": "Notlar", "chunk_size": 256})
        self.assertEqual(cm.exception.status, 409)
        d.h_index_refresh({"name": "Notlar", "chunk_size": 256, "full": True})
        self.assertEqual(self.started[-1][3], {"folders": ["Notlar"], "full": True})
        self.assertEqual(d.h_index_list()["folders"][0]["chunk_size"], 256)

    def test_refresh_all_and_unknown(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_refresh({})
        self.assertEqual(cm.exception.status, 404)
        d.h_index_add({"path": str(self.vault)})
        d.h_index_refresh({})
        self.assertEqual(self.started[-1][3]["folders"], ["Notlar"])
        with self.assertRaises(d.ApiError):
            d.h_index_refresh({"name": "nope"})

    def test_delete(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        self.assertEqual(d.h_index_delete("Notlar"), {"ok": True})
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_delete("Notlar")
        self.assertEqual(cm.exception.status, 404)
        self.assertTrue((self.vault / "a.md").exists())

    # net.fetch speaks GET and POST only, so removal also has a POST route.
    def route(self, method: str, path: str) -> dict:
        handler = object.__new__(d.Handler)
        parts = [p for p in path.strip("/").split("/") if p]
        return handler._route(method, parts, {}, {})

    def test_post_remove_and_quoted_names(self) -> None:
        spaced = Path(self.tmp.name) / "Not lar"
        spaced.mkdir()
        d.h_index_add({"path": str(spaced)})
        self.assertEqual(self.route("POST", "/v1/index/folders/Not%20lar/remove"), {"ok": True})
        with self.assertRaises(d.ApiError) as cm:
            self.route("POST", "/v1/index/folders/Not%20lar/remove")
        self.assertEqual(cm.exception.status, 404)

    def test_delete_still_works(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        self.assertEqual(self.route("DELETE", "/v1/index/folders/Notlar"), {"ok": True})
