from __future__ import annotations

import base64
import contextlib
import io
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image

import image


class FakeRegistry:
    def __init__(self) -> None:
        self.items: list = []

    def register(self, callback) -> None:
        self.items.append(callback)


class FakeModel:
    """Stands in for an mflux model: runs the registered callbacks the way mflux does, then returns a picture."""

    def __init__(self) -> None:
        self.callbacks = FakeRegistry()
        self.calls: list[dict] = []

    def generate_image(self, **kwargs):
        self.calls.append(kwargs)
        steps = kwargs.get("num_inference_steps") or 1
        time_steps = SimpleNamespace(total=steps)
        for cb in self.callbacks.items:
            cb.call_before_loop(seed=kwargs["seed"], prompt="", latents=None, config=None)
        for t in range(steps):
            for cb in self.callbacks.items:
                cb.call_in_loop(t=t, seed=kwargs["seed"], prompt="", latents=None, config=None,
                                time_steps=time_steps)
        size = (kwargs.get("width") or 64, kwargs.get("height") or 32)
        return SimpleNamespace(image=Image.new("RGB", size, (10, 20, 30)))


class RunTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.model = FakeModel()
        self.lines: list[str] = []
        self.loaded: list = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, req: image.Request) -> dict:
        def loader(family, model_dir):
            self.loaded.append((family.name, model_dir))
            return self.model
        return image.run(req, Path("/fake/snapshot"), loader=loader, out=self.lines.append,
                         now=lambda: datetime(2026, 9, 25, 21, 0, 0))

    def test_generate_uses_the_family_default_steps_and_writes_everything(self) -> None:
        req = image.build_request("generate", out_dir=str(self.tmp), prompt="a gate", seed=42,
                                  width=256, height=256)
        result = self._run(req)
        self.assertEqual(self.loaded, [("z-image-turbo", Path("/fake/snapshot"))])
        call = self.model.calls[0]
        self.assertEqual((call["seed"], call["num_inference_steps"], call["width"], call["prompt"]),
                         (42, 9, 256, "a gate"))
        self.assertEqual(Path(result["path"]).name, "20260925-210000_generate_42.png")
        self.assertTrue(Path(result["path"]).is_file())
        self.assertTrue(Path(result["path"]).with_suffix(".json").is_file())
        self.assertEqual((result["steps"], result["width"], result["height"], result["mode"]),
                         (9, 256, 256, "generate"))
        self.assertNotIn("instruction", result)
        for key in ("load_s", "gen_s", "peak_gb"):
            self.assertIn(key, result)
        with Image.open(io.BytesIO(base64.b64decode(result["preview_b64"]))) as im:
            self.assertEqual(im.format, "JPEG")

    def test_no_percent_is_printed_until_the_loop_starts(self) -> None:
        # The panel reads percent == null as "Loading model...".
        self._run(image.build_request("generate", out_dir=str(self.tmp), prompt="x", seed=1))
        self.assertTrue(self.lines[0].startswith("loading "))
        self.assertNotIn("%", self.lines[0])
        self.assertEqual(self.lines[1], "generating  0%")
        self.assertEqual(self.lines[2], "step 1/9  11%")
        self.assertEqual(self.lines[-1], "step 9/9  100%")

    def test_an_unset_seed_is_chosen_and_recorded(self) -> None:
        result = self._run(image.build_request("generate", out_dir=str(self.tmp), prompt="x"))
        self.assertTrue(1 <= result["seed"] <= image.MAX_SEED)
        self.assertEqual(self.model.calls[0]["seed"], result["seed"])

    def test_edit_runs_at_one_megapixel_from_the_source(self) -> None:
        src = self.tmp / "wall.png"
        Image.new("RGB", (2048, 1536)).save(src)
        req = image.build_request("edit", out_dir=str(self.tmp), source=str(src),
                                  instruction="natural stone", seed=5)
        result = self._run(req)
        call = self.model.calls[0]
        self.assertEqual((call["width"], call["height"]), (1168, 880))
        self.assertEqual((call["prompt"], call["image_paths"], call["guidance"]),
                         ("natural stone", [str(src)], 2.5))
        self.assertEqual(call["num_inference_steps"], 20)
        self.assertEqual((result["instruction"], result["source"]), ("natural stone", str(src)))

    def test_upscale_passes_the_factor_to_mflux(self) -> None:
        src = self.tmp / "small.png"
        Image.new("RGB", (320, 240)).save(src)
        result = self._run(image.build_request("upscale", out_dir=str(self.tmp), source=str(src), factor=3))
        self.assertEqual(str(self.model.calls[0]["resolution"]), "3x")
        self.assertEqual(result["factor"], 3)
        self.assertNotIn("steps", result)


class MainTest(unittest.TestCase):
    def test_a_model_not_downloaded_exits_1_with_the_pull_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ), \
                mock.patch("modelctl.resolve", return_value=None):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = image.main(["generate", "--prompt", "x", "--out-dir", tmp])
        self.assertEqual(code, 1)
        self.assertIn(f"modelctl pull {image.DEFAULT_MODEL}", err.getvalue())


if __name__ == "__main__":
    unittest.main()
