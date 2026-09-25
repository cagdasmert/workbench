from __future__ import annotations

import io
import json
import math
import tempfile
import unittest
from pathlib import Path

import embed as e

WORDS = lambda s: len(s.split())  # noqa: E731


def fake_embed(texts: list[str]) -> list[list[float]]:
    out = []
    for t in texts:
        low = t.lower()
        v = [1.0 if "kedi" in low else 0.0, 1.0 if "köpek" in low else 0.0, 0.1]
        n = math.sqrt(sum(x * x for x in v))
        out.append([x / n for x in v])
    return out


class SearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.a, self.b = base / "A", base / "B"
        self.a.mkdir()
        self.b.mkdir()
        (self.a / "kedi.md").write_text("# Kediler\n\nkedi miyavlar\n")
        (self.a / "köpek.md").write_text("# Köpekler\n\nköpek havlar\n")
        # Two chunks that both mention kedi: must come back as one hit.
        (self.a / "uzun.md").write_text("# Uzun\n\n## Bir\n\nkedi bir iki üç\n\n## İki\n\nkedi dört beş altı\n")
        (self.b / "diğer.md").write_text("kedi başka klasörde\n")
        self.conn = e.connect(base / "idx.sqlite")
        for name, path in (("A", self.a), ("B", self.b)):
            spec = e.FolderSpec(name, str(path), e.DEFAULT_MODEL, 6, e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE)
            e.upsert_folder(self.conn, spec)
            e.index_folder(self.conn, spec, embed=fake_embed, count_tokens=WORDS, progress=lambda s: None)
        self.searcher = e.Searcher(self.conn, fake_embed, e.DEFAULT_MODEL)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def handle(self, req: dict) -> dict:
        return e.handle_request(self.conn, req, lambda m: self.searcher, lambda m: fake_embed)

    def test_best_hit_carries_folder_path_and_line(self) -> None:
        res = self.searcher.search("kedi", 10, None)
        top = res["hits"][0]
        self.assertIn(top["folder"], ("A", "B"))
        self.assertTrue(Path(top["path"]).is_absolute())
        self.assertGreater(top["score"], 0.9)
        self.assertGreaterEqual(top["start_line"], 1)
        self.assertEqual(res["model"], e.DEFAULT_MODEL)

    def test_one_hit_per_note(self) -> None:
        paths = [h["rel_path"] for h in self.searcher.search("kedi", 10, None)["hits"]]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertIn("uzun.md", paths)

    def test_per_note_returns_the_best_passages_of_each_note(self) -> None:
        hits = self.searcher.search("kedi", 10, None, per_note=3)["hits"]
        uzun = next(h for h in hits if h["rel_path"] == "uzun.md")
        self.assertGreaterEqual(len(uzun["passages"]), 2)
        scores = [p["score"] for p in uzun["passages"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        # The top-level fields stay the best passage, so cards do not change.
        self.assertEqual((uzun["chunk"], uzun["score"]), (uzun["passages"][0]["chunk"], scores[0]))
        self.assertEqual(set(uzun["passages"][0]), {"heading", "chunk", "start_line", "score"})

    def test_per_note_one_is_the_old_shape_plus_one_passage(self) -> None:
        for h in self.searcher.search("kedi", 10, None)["hits"]:
            self.assertEqual(len(h["passages"]), 1)

    def test_per_note_does_not_change_which_notes_come_back(self) -> None:
        one = [h["rel_path"] for h in self.searcher.search("kedi", 2, None)["hits"]]
        three = [h["rel_path"] for h in self.searcher.search("kedi", 2, None, per_note=3)["hits"]]
        self.assertEqual(one, three)

    def test_handle_clamps_per_note(self) -> None:
        r = self.handle({"op": "search", "query": "kedi", "per_note": 99})
        self.assertTrue(all(len(h["passages"]) <= 5 for h in r["hits"]))

    def test_folder_filter(self) -> None:
        hits = self.searcher.search("kedi", 10, ["B"])["hits"]
        self.assertEqual([h["folder"] for h in hits], ["B"])

    def test_limit(self) -> None:
        self.assertEqual(len(self.searcher.search("kedi", 2, None)["hits"]), 2)

    def test_generation_reload_sees_edits(self) -> None:
        self.searcher.search("kedi", 10, None)
        (self.b / "diğer.md").write_text("köpek artık burada\n")
        spec = e.get_folder(self.conn, "B")
        assert spec is not None
        e.index_folder(self.conn, spec, embed=fake_embed, count_tokens=WORDS, progress=lambda s: None)
        hits = self.searcher.search("köpek", 10, ["B"])["hits"]
        self.assertIn("köpek artık burada", hits[0]["chunk"])

    def test_handle_unknown_folder_is_404(self) -> None:
        r = self.handle({"op": "search", "query": "kedi", "folders": ["Yok"]})
        self.assertEqual((r["ok"], r["status"]), (False, 404))

    def test_handle_mixed_models_is_409(self) -> None:
        spec = e.get_folder(self.conn, "B")
        assert spec is not None
        self.conn.execute("UPDATE folders SET model = 'other/model' WHERE name = 'B'")
        self.conn.commit()
        r = self.handle({"op": "search", "query": "kedi"})
        self.assertEqual((r["ok"], r["status"]), (False, 409))
        r = self.handle({"op": "search", "query": "kedi", "folders": ["A"]})
        self.assertTrue(r["ok"])

    def test_handle_no_folders_is_404(self) -> None:
        e.delete_folder(self.conn, "A")
        e.delete_folder(self.conn, "B")
        r = self.handle({"op": "search", "query": "kedi"})
        self.assertEqual((r["ok"], r["status"]), (False, 404))
        self.assertIn("hint", r)

    def test_handle_embed_and_unknown_op(self) -> None:
        r = self.handle({"op": "embed", "texts": ["kedi"]})
        self.assertEqual((r["ok"], len(r["vectors"])), (True, 1))
        self.assertEqual(self.handle({"op": "nope"})["status"], 400)


class ServeLoopTest(unittest.TestCase):
    def test_bad_line_is_an_error_reply_and_loop_continues(self) -> None:
        out = io.StringIO()
        e.serve_loop(iter(['not json\n', '\n', '{"op": "x"}\n']), out.write,
                     lambda req: {"ok": True, "op": req["op"]})
        replies = [json.loads(l) for l in out.getvalue().splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[1], {"ok": True, "op": "x"})
