from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

import asr

TURBO = "mlx-community/whisper-large-v3-turbo"
PARAKEET = "mlx-community/parakeet-tdt-0.6b-v3"


def _t(*segments: tuple[float, float, str], language: str | None = "tr") -> asr.Transcript:
    segs = tuple(asr.Segment(s, e, x) for s, e, x in segments)
    return asr.Transcript(text=" ".join(s.text for s in segs), segments=segs,
                          language=language, duration=segs[-1].end if segs else 0.0, model=TURBO)


class RuntimeTest(unittest.TestCase):
    def test_families_by_name(self) -> None:
        self.assertEqual(asr.runtime_for(TURBO), "whisper")
        self.assertEqual(asr.runtime_for(PARAKEET), "parakeet")

    def test_unknown_family_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            asr.runtime_for("black-forest-labs/FLUX.1-schnell")


class LanguageTest(unittest.TestCase):
    def test_parakeet_refuses_turkish_and_names_the_fix(self) -> None:
        problem = asr.check_language(PARAKEET, "tr")
        self.assertIsNotNone(problem)
        assert problem is not None
        self.assertIn(asr.DEFAULT_MODEL, problem)

    def test_parakeet_accepts_its_own_languages(self) -> None:
        self.assertIsNone(asr.check_language(PARAKEET, "en"))
        self.assertIsNone(asr.check_language(PARAKEET, "de"))

    def test_auto_always_passes(self) -> None:
        self.assertIsNone(asr.check_language(PARAKEET, "auto"))

    def test_whisper_takes_anything(self) -> None:
        self.assertIsNone(asr.check_language(TURBO, "tr"))

    def test_unlisted_repo_is_not_second_guessed(self) -> None:
        self.assertIsNone(asr.check_language("someone/whisper-small-mlx", "tr"))


class TimestampTest(unittest.TestCase):
    def test_under_an_hour(self) -> None:
        self.assertEqual(asr.format_timestamp(0), "00:00")
        self.assertEqual(asr.format_timestamp(83.9), "01:23")

    def test_past_an_hour(self) -> None:
        self.assertEqual(asr.format_timestamp(3725), "1:02:05")

    def test_negative_clamps(self) -> None:
        self.assertEqual(asr.format_timestamp(-1), "00:00")


class TranscriptJsonTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        t = _t((0, 1.5, " Merhaba"), (1.5, 3.0, " dünya"))
        self.assertEqual(asr.Transcript.from_json(t.to_json()), t)


class MarkdownTest(unittest.TestCase):
    def _render(self, **kw: object) -> str:
        t = _t((0, 2, " Merhaba dünya. "), (65, 70, "İkinci cümle."), (70, 71, "   "))
        return asr.render_markdown(t, title="memo", source="/a/memo.m4a",
                                   transcribed=date(2026, 9, 11), **kw)  # type: ignore[arg-type]

    def test_front_matter_is_json_quoted_yaml(self) -> None:
        md = self._render()
        head = md.split("---")[1]
        self.assertIn('title: "memo"', head)
        self.assertIn('source: "/a/memo.m4a"', head)
        self.assertIn('language: "tr"', head)
        self.assertIn("duration: 71", head)
        self.assertIn('transcribed: "2026-09-11"', head)
        self.assertTrue(md.startswith("---\n"))

    def test_timestamps_on(self) -> None:
        md = self._render()
        self.assertIn("# memo", md)
        self.assertIn("[00:00] Merhaba dünya.", md)
        self.assertIn("[01:05] İkinci cümle.", md)

    def test_blank_segments_are_dropped(self) -> None:
        self.assertEqual(self._render().count("["), 2)

    def test_timestamps_off(self) -> None:
        md = self._render(timestamps=False)
        self.assertIn("\nMerhaba dünya.\n", md)
        self.assertNotIn("[00:00]", md)

    def test_extra_keys_cannot_override_fixed_ones(self) -> None:
        md = self._render(extra={"model": "evil", "tags": "voice-memo"})
        self.assertIn(f'model: "{TURBO}"', md)
        self.assertNotIn("evil", md)
        self.assertIn('tags: "voice-memo"', md)

    def test_bad_extra_key_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            self._render(extra={"a: b\nc": "x"})

    def test_non_scalar_extra_value_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            self._render(extra={"tags": ["a", "b"]})


class FilenameTest(unittest.TestCase):
    def test_default_is_dated_stem(self) -> None:
        self.assertEqual(asr.default_filename(Path("/x/Voice 012.m4a"), date(2026, 9, 11)),
                         "2026-09-11 Voice 012.md")

    def test_separators_and_leading_dots_are_neutralised(self) -> None:
        self.assertEqual(asr.safe_filename("../a/b:c"), "-a-b-c.md")

    def test_md_suffix_is_not_doubled(self) -> None:
        self.assertEqual(asr.safe_filename("notes.MD"), "notes.MD")

    def test_empty_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            asr.safe_filename(" .. ")


class WriteNewTest(unittest.TestCase):
    def test_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            first = asr.write_new(Path(d), "memo.md", "one")
            second = asr.write_new(Path(d), "memo.md", "two")
            third = asr.write_new(Path(d), "memo.md", "three")
            self.assertEqual([first.name, second.name, third.name], ["memo.md", "memo-2.md", "memo-3.md"])
            self.assertEqual(first.read_text(encoding="utf-8"), "one")


if __name__ == "__main__":
    unittest.main()
