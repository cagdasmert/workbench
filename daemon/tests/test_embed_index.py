from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import embed as e

WORDS = lambda s: len(s.split())  # noqa: E731


class FakeEmbed:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, texts: list[str]) -> list[list[float]]:
        self.seen.extend(texts)
        return [[float(len(t)), 1.0, 0.0] for t in texts]


class IndexTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "vault"
        self.root.mkdir()
        (self.root / "a.md").write_text("# A\n\nalpha [[B]]\n")
        (self.root / "b.md").write_text("beta\n")
        self.conn = e.connect(Path(self.tmp.name) / "idx.sqlite")
        self.spec = e.FolderSpec("V", str(self.root), e.DEFAULT_MODEL, 50,
                                 e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE)
        e.upsert_folder(self.conn, self.spec)
        self.lines: list[str] = []

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def run_index(self, full: bool = False) -> tuple[dict, FakeEmbed]:
        fake = FakeEmbed()
        res = e.index_folder(self.conn, self.spec, embed=fake, count_tokens=WORDS,
                             full=full, progress=self.lines.append)
        return res, fake

    def test_first_run_embeds_everything_and_reports_progress(self) -> None:
        res, fake = self.run_index()
        self.assertEqual((res["files"], res["chunks"], res["embedded"]), (2, 2, 2))
        self.assertTrue(any("2/2" in l and "100%" in l for l in self.lines))
        [row] = e.list_folders(self.conn)
        self.assertEqual((row["changed"], row["chunks"]), (0, 2))
        self.assertIsNotNone(row["indexed_at"])
        self.assertEqual(self.conn.execute("SELECT target FROM links").fetchone()[0], "B")

    def test_second_run_embeds_nothing(self) -> None:
        self.run_index()
        res, fake = self.run_index()
        self.assertEqual((res["embedded"], fake.seen), (0, []))

    def test_touch_without_edit_updates_mtime_only(self) -> None:
        self.run_index()
        os.utime(self.root / "a.md", (1, 1))
        res, fake = self.run_index()
        self.assertEqual(res["embedded"], 0)
        self.assertEqual(e.list_folders(self.conn)[0]["changed"], 0)

    def test_edit_reembeds_one_file_and_delete_removes(self) -> None:
        self.run_index()
        (self.root / "a.md").write_text("# A\n\nalpha, edited\n")
        (self.root / "b.md").unlink()
        res, fake = self.run_index()
        self.assertEqual((res["embedded"], res["removed"], res["files"]), (1, 1, 1))
        self.assertEqual(len(fake.seen), 1)

    def test_full_reembeds_everything(self) -> None:
        self.run_index()
        res, _ = self.run_index(full=True)
        self.assertEqual(res["embedded"], 2)

    def test_vectors_roundtrip_as_float32(self) -> None:
        self.run_index()
        blob = self.conn.execute("SELECT vector FROM chunks LIMIT 1").fetchone()[0]
        self.assertEqual(len(e.unpack(blob)), 3)
