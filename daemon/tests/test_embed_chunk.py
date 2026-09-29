from __future__ import annotations

import unittest

import embed as e

WORDS = lambda s: len(s.split())  # noqa: E731


class ParseNoteTest(unittest.TestCase):
    def test_short_note_is_one_chunk_with_title_prefix(self) -> None:
        note = e.parse_note("# Zettel\n\nKısa bir not.\n", "zettel", 50, WORDS)
        self.assertEqual(note.title, "Zettel")
        self.assertEqual(len(note.chunks), 1)
        c = note.chunks[0]
        self.assertEqual(c.text, "# Zettel\n\nKısa bir not.")
        self.assertEqual(c.start_line, 1)
        self.assertTrue(c.embed_text.startswith("Zettel\n\n"))

    def test_front_matter_is_stripped_and_lines_stay_true(self) -> None:
        raw = "---\ntags: [a]\n---\nBody line.\n"
        note = e.parse_note(raw, "stem", 50, WORDS)
        self.assertEqual(note.title, "stem")
        self.assertEqual(note.chunks[0].text, "Body line.")
        self.assertEqual(note.chunks[0].start_line, 4)

    def test_long_note_splits_on_headings_with_heading_path(self) -> None:
        raw = "# T\n\nintro words here\n\n## A\n\n" + "a " * 8 + "\n\n### B\n\n" + "b " * 8 + "\n"
        note = e.parse_note(raw, "t", 10, WORDS)
        heads = [c.heading for c in note.chunks]
        self.assertIn("T › A", heads)
        self.assertIn("T › A › B", heads)
        b = next(c for c in note.chunks if c.heading == "T › A › B")
        self.assertTrue(b.embed_text.startswith("T › A › B\n\n"))
        # "### B" is line 9, line 10 is blank: start_line is the passage's first non-blank line
        self.assertEqual(b.start_line, 11)
        self.assertEqual([c.ord for c in note.chunks], list(range(len(note.chunks))))

    def test_oversized_section_splits_on_paragraphs_then_words(self) -> None:
        raw = "# T\n\n" + "p1 " * 6 + "\n\n" + "p2 " * 6 + "\n\n" + "w " * 25 + "\n"
        note = e.parse_note(raw, "t", 10, WORDS)
        self.assertTrue(all(WORDS(c.text) <= 10 for c in note.chunks))
        self.assertGreaterEqual(len(note.chunks), 5)

    def test_wikilinks_are_collected(self) -> None:
        note = e.parse_note("See [[Alpha]] and [[Beta|b]] and [[Gamma#x]].", "s", 50, WORDS)
        self.assertEqual(note.links, ("Alpha", "Beta", "Gamma"))

    def test_empty_note_has_no_chunks(self) -> None:
        self.assertEqual(e.parse_note("---\na: 1\n---\n\n", "s", 50, WORDS).chunks, ())
