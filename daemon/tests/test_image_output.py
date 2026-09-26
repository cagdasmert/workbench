from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from PIL import Image

import image


def _tmp_volume_is_case_insensitive() -> bool:
    """True when tempfile's default folder is on a case-insensitive volume (normal macOS/APFS)."""
    with tempfile.TemporaryDirectory() as d:
        probe = Path(d) / "CaseProbe"
        probe.write_text("x")
        swapped = Path(d) / "caseprobe"
        try:
            return swapped.stat().st_ino == probe.stat().st_ino
        except OSError:
            return False


_CASE_INSENSITIVE_VOLUME = _tmp_volume_is_case_insensitive()


class _TmpDirs(unittest.TestCase):
    """Point the default output folder and the deny-list into a temp dir."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._orig = (image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS)
        image.DEFAULT_OUT_DIR = self.tmp / "Pictures" / "Workbench"
        image.DENIED_WRITE_ROOTS = (self.tmp / "plugins",)

    def tearDown(self) -> None:
        image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS = self._orig
        self._tmp.cleanup()


class DeniedWriteRootsTest(unittest.TestCase):
    def test_the_default_root_is_the_whole_workbench_app_folder_not_just_plugins(self) -> None:
        # F9: the TS broker (fs-grants.ts) denies all of .../Workbench, not
        # only .../Workbench/plugins -- settings and other app state live in
        # siblings of plugins/, and the daemon's own deny-list should match.
        self.assertEqual(image.DENIED_WRITE_ROOTS,
                         (Path.home() / "Library" / "Application Support" / "Workbench",))


class OutDirTest(_TmpDirs):
    def test_empty_means_the_default_which_is_created(self) -> None:
        for raw in (None, ""):
            self.assertEqual(image.resolve_out_dir(raw), image.DEFAULT_OUT_DIR)
        self.assertTrue(image.DEFAULT_OUT_DIR.is_dir())

    def test_an_explicit_folder_must_exist_and_be_absolute(self) -> None:
        for raw in ("renders", str(self.tmp / "missing"), 5):
            with self.subTest(raw=raw), self.assertRaises(image.ImageError):
                image.resolve_out_dir(raw)
        self.assertEqual(image.resolve_out_dir(str(self.tmp)), self.tmp)

    def test_the_plugin_folder_is_refused_even_through_a_symlink(self) -> None:
        inside = self.tmp / "plugins" / "evil"
        inside.mkdir(parents=True)
        link = self.tmp / "innocent"
        link.symlink_to(self.tmp / "plugins")
        for raw in (str(inside), str(link / "evil"), str(self.tmp / "plugins")):
            with self.subTest(raw=raw), self.assertRaises(image.ImageError) as cm:
                image.resolve_out_dir(raw)
            self.assertIn("application folder", str(cm.exception))

    @unittest.skipUnless(_CASE_INSENSITIVE_VOLUME, "temp volume is case-sensitive")
    def test_a_differently_cased_spelling_of_the_root_is_still_denied(self) -> None:
        # F2: the macOS volume is case-insensitive, but Path.resolve() keeps the
        # caller's own spelling and the old check compared strings -- so
        # .../PLUGINS/x got through even though it is the same folder on disk.
        (self.tmp / "plugins").mkdir()
        swapped = self.tmp / "PLUGINS"
        with self.assertRaises(image.ImageError) as cm:
            image.resolve_out_dir(str(swapped))
        self.assertIn("application folder", str(cm.exception))


class OpenNewTest(_TmpDirs):
    def test_never_overwrites(self) -> None:
        (self.tmp / "a.png").write_bytes(b"old")
        path, f = image.open_new(self.tmp, "a.png")
        f.close()
        self.assertEqual(path.name, "a-2.png")
        self.assertEqual((self.tmp / "a.png").read_bytes(), b"old")

    def test_a_symlink_planted_at_the_name_is_not_followed(self) -> None:
        outside = self.tmp / "outside"
        outside.mkdir()
        dest = self.tmp / "dest"
        dest.mkdir()
        (dest / "a.png").symlink_to(outside / "target.png")   # dangling on purpose
        path, f = image.open_new(dest, "a.png")
        with f:
            f.write(b"new")
        self.assertEqual(path.name, "a-2.png")
        self.assertFalse((outside / "target.png").exists())

    def test_output_name(self) -> None:
        self.assertEqual(image.output_name("edit", 42, datetime(2026, 9, 25, 21, 5, 9)),
                         "20260925-210509_edit_42.png")


class SavePngTest(_TmpDirs):
    def test_png_carries_text_chunks_and_a_sidecar(self) -> None:
        picture = Image.new("RGB", (64, 32), (1, 2, 3))
        meta = {"prompt": "a gate", "seed": 7, "mode": "generate"}
        path = image.save_png(picture, self.tmp, "x.png", meta)
        with Image.open(path) as im:
            im.load()
            self.assertEqual(im.text, {"prompt": "a gate", "seed": "7", "mode": "generate"})
        self.assertEqual(json.loads(path.with_suffix(".json").read_text(encoding="utf-8")), meta)

    def test_a_taken_name_moves_both_files(self) -> None:
        picture = Image.new("RGB", (8, 8))
        image.save_png(picture, self.tmp, "x.png", {"seed": 1})
        second = image.save_png(picture, self.tmp, "x.png", {"seed": 2})
        self.assertEqual(second.name, "x-2.png")
        self.assertEqual(json.loads((self.tmp / "x-2.json").read_text(encoding="utf-8")), {"seed": 2})

    def test_copy_new_never_overwrites(self) -> None:
        src = self.tmp / "src.png"
        src.write_bytes(b"\x89PNG-bytes")
        dest = self.tmp / "dest"
        dest.mkdir()
        first, second = image.copy_new(src, dest), image.copy_new(src, dest)
        self.assertEqual((first.name, second.name), ("src.png", "src-2.png"))
        self.assertEqual(second.read_bytes(), b"\x89PNG-bytes")

    @unittest.skipIf(os.getuid() == 0, "chmod 000 has no effect for root")
    def test_copy_new_leaves_nothing_when_the_source_is_unreadable(self) -> None:
        # F6: copy_new used to create the destination (open_new's exclusive
        # create) before ever opening the source, so an unreadable source left
        # an empty file behind. Opening the source first means a failure here
        # leaves the destination folder untouched.
        src = self.tmp / "secret.png"
        src.write_bytes(b"\x89PNG-bytes")
        src.chmod(0o000)
        dest = self.tmp / "dest"
        dest.mkdir()
        try:
            with self.assertRaises(PermissionError):
                image.copy_new(src, dest)
        finally:
            src.chmod(0o644)
        self.assertEqual(list(dest.iterdir()), [])

    def test_preview_is_a_jpeg_no_larger_than_512(self) -> None:
        b64 = image.preview_b64(Image.new("RGB", (2000, 1000)))
        with Image.open(io.BytesIO(base64.b64decode(b64))) as im:
            self.assertEqual((im.format, im.size), ("JPEG", (512, 256)))


if __name__ == "__main__":
    unittest.main()
