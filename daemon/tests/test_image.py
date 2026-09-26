from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

import image


class FamilyTest(unittest.TestCase):
    def test_each_default_resolves_to_its_family(self) -> None:
        self.assertEqual(image.family_for(image.DEFAULT_MODEL, "generate").name, "z-image-turbo")
        self.assertEqual(image.family_for(image.DEFAULT_EDIT_MODEL, "edit").name, "qwen-image-edit")
        self.assertEqual(image.family_for(image.DEFAULT_UPSCALE_MODEL, "upscale").name, "seedvr2")

    def test_z_image_turbo_defaults_to_nine_steps(self) -> None:
        # PRD criterion 1: the panel never has to know this.
        f = image.family_for("Tongyi-MAI/Z-Image-Turbo", "generate")
        self.assertEqual((f.steps, f.width, f.height, f.negative), (9, 1024, 1024, False))

    def test_klein_9b_edits_in_four_steps(self) -> None:
        f = image.family_for("mflux-community/flux2-klein-9b-mflux-q8", "edit")
        self.assertEqual((f.name, f.steps, f.guidance), ("flux2-klein-9b", 4, 1.0))

    def test_wrong_role_is_refused_and_names_what_exists(self) -> None:
        with self.assertRaises(image.ImageError) as cm:
            image.family_for(image.DEFAULT_MODEL, "edit")
        self.assertIn("qwen-image-edit", str(cm.exception))

    def test_unknown_repo_is_refused(self) -> None:
        with self.assertRaises(image.ImageError):
            image.family_for("black-forest-labs/FLUX.1-schnell", "generate")


class CatalogTest(unittest.TestCase):
    def test_lists_only_image_models_once_each_with_defaults(self) -> None:
        rows = image.catalog(["sentence-transformers/LaBSE", image.DEFAULT_MODEL, image.DEFAULT_MODEL])
        self.assertEqual(rows, [{
            "repo": image.DEFAULT_MODEL, "family": "z-image-turbo", "role": "generate",
            "negative": False, "defaults": {"steps": 9, "width": 1024, "height": 1024},
        }])


class PullCommandTest(unittest.TestCase):
    def test_seedvr2_pulls_only_the_two_files_mflux_reads(self) -> None:
        self.assertEqual(
            image.pull_command("numz/SeedVR2_comfyUI"),
            "modelctl pull numz/SeedVR2_comfyUI --include "
            "seedvr2_ema_3b_fp16.safetensors ema_vae_fp16.safetensors",
        )

    def test_other_repos_pull_whole(self) -> None:
        self.assertEqual(image.pull_command(image.DEFAULT_MODEL), f"modelctl pull {image.DEFAULT_MODEL}")


def _png(path: Path, w: int, h: int) -> Path:
    Image.new("RGB", (w, h), (120, 90, 60)).save(path)
    return path


class RequestTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._orig = (image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS)
        image.DEFAULT_OUT_DIR = self.tmp / "Pictures"
        image.DENIED_WRITE_ROOTS = (self.tmp / "plugins",)
        self.out = str(self.tmp)

    def tearDown(self) -> None:
        image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS = self._orig
        self._tmp.cleanup()

    def test_generate_takes_the_default_model_and_leaves_steps_to_it(self) -> None:
        req = image.build_request("generate", out_dir=self.out, prompt="  a green gate ")
        self.assertEqual((req.model, req.prompt, req.steps, req.seed), (image.DEFAULT_MODEL, "a green gate", None, None))

    def test_zero_steps_and_seed_mean_default_and_random(self) -> None:
        # The plugin's command args declare 0 as "empty" for both.
        req = image.build_request("generate", out_dir=self.out, prompt="x", steps=0, seed=0)
        self.assertEqual((req.steps, req.seed), (None, None))

    def test_bad_generate_requests(self) -> None:
        for kw in ({"prompt": ""}, {"prompt": 5}, {"prompt": "x", "steps": 101},
                   {"prompt": "x", "steps": True}, {"prompt": "x", "width": 1000},
                   {"prompt": "x", "width": 128}, {"prompt": "x", "seed": -1},
                   {"prompt": "x", "negative": "blurry"},          # Z-Image Turbo takes none
                   {"prompt": "x", "model": "black-forest-labs/FLUX.1-schnell"}):
            with self.subTest(kw=kw), self.assertRaises(image.ImageError):
                image.build_request("generate", out_dir=self.out, **kw)

    def test_a_failed_request_creates_no_folder(self) -> None:
        with self.assertRaises(image.ImageError):
            image.build_request("generate", prompt="")
        self.assertFalse(image.DEFAULT_OUT_DIR.exists())

    def test_edit_needs_a_readable_png_jpeg_or_webp_and_an_instruction(self) -> None:
        good = _png(self.tmp / "wall.png", 640, 480)
        (self.tmp / "photo.heic").write_bytes(b"x")
        (self.tmp / "broken.png").write_bytes(b"not an image")
        req = image.build_request("edit", out_dir=self.out, source=str(good), instruction="stone")
        self.assertEqual((req.model, req.source, req.instruction), (image.DEFAULT_EDIT_MODEL, good, "stone"))
        cases = {
            "sips": {"source": str(self.tmp / "photo.heic"), "instruction": "x"},
            "absolute": {"source": "wall.png", "instruction": "x"},
            "no such file": {"source": str(self.tmp / "none.png"), "instruction": "x"},
            "not a readable image": {"source": str(self.tmp / "broken.png"), "instruction": "x"},
            "instruction is required": {"source": str(good), "instruction": "  "},
        }
        for needle, kw in cases.items():
            with self.subTest(needle=needle), self.assertRaises(image.ImageError) as cm:
                image.build_request("edit", out_dir=self.out, **kw)
            self.assertIn(needle, str(cm.exception))

    def test_upscale_factor_and_the_4096_limit(self) -> None:
        small = _png(self.tmp / "small.png", 1000, 800)
        wide = _png(self.tmp / "wide.png", 2100, 1000)
        self.assertEqual(image.build_request("upscale", out_dir=self.out, source=str(small)).factor, 2)
        self.assertEqual(image.build_request("upscale", out_dir=self.out, source=str(small), factor=3).factor, 3)
        for kw in ({"source": str(small), "factor": 4}, {"source": str(small), "factor": "2"},
                    {"source": str(small), "factor": True}):
            with self.subTest(kw=kw), self.assertRaises(image.ImageError):
                image.build_request("upscale", out_dir=self.out, **kw)
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("upscale", out_dir=self.out, source=str(wide))
        self.assertIn("4096", str(cm.exception))

    def test_argv_round_trips_for_every_mode(self) -> None:
        src = _png(self.tmp / "src.png", 320, 240)
        requests = [
            image.build_request("generate", out_dir=self.out, prompt="-starts with a dash",
                                seed=7, steps=12, width=768, height=512),
            image.build_request("edit", out_dir=self.out, source=str(src), instruction="oak, not pine", seed=3),
            image.build_request("upscale", out_dir=self.out, source=str(src), factor=3),
        ]
        for req in requests:
            with self.subTest(mode=req.mode):
                args = image.build_parser().parse_args(image.to_argv(req))
                self.assertEqual(image.request_from_args(args), req)

    def test_params_drop_what_was_not_asked(self) -> None:
        req = image.build_request("generate", out_dir=self.out, prompt="a gate")
        self.assertEqual(image.params_of(req), {"mode": "generate", "model": image.DEFAULT_MODEL, "prompt": "a gate"})

    def test_a_nul_byte_in_a_prompt_or_instruction_is_refused(self) -> None:
        # F1: Popen raises ValueError on a NUL in argv, which used to wedge the
        # job in 'running' forever. Refuse it here instead, as a 400.
        good = _png(self.tmp / "wall.png", 640, 480)
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("generate", out_dir=self.out, prompt="a gate\x00 with a NUL")
        self.assertIn("NUL", str(cm.exception))
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("edit", out_dir=self.out, source=str(good), instruction="stone\x00wall")
        self.assertIn("NUL", str(cm.exception))

    def test_a_nul_byte_in_a_source_path_is_refused(self) -> None:
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("edit", out_dir=self.out, source="/tmp/wall\x00.png", instruction="x")
        self.assertIn("NUL", str(cm.exception))


class SizeTest(unittest.TestCase):
    def test_fit_area_keeps_aspect_at_one_megapixel_in_multiples_of_16(self) -> None:
        self.assertEqual(image.fit_area(2048, 1536), (1168, 880))
        self.assertEqual(image.fit_area(4032, 3024), (1168, 880))
        self.assertEqual(image.fit_area(512, 384), (512, 384))
        self.assertEqual(image.fit_area(1000, 1000), (992, 992))

    def test_image_size_reads_the_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(image.image_size(_png(Path(tmp) / "a.png", 33, 17)), (33, 17))


class ModelPathTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._orig = (image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS)
        image.DEFAULT_OUT_DIR = self.tmp / "Pictures"
        image.DENIED_WRITE_ROOTS = (self.tmp / "plugins",)
        self.out = str(self.tmp)

    def tearDown(self) -> None:
        image.DEFAULT_OUT_DIR, image.DENIED_WRITE_ROOTS = self._orig
        self._tmp.cleanup()

    def test_a_folder_whose_path_names_the_family_is_used_as_given(self) -> None:
        folder = self.tmp / "models--mflux-community--z-image-turbo-mflux-q8" / "snapshots" / "abc"
        folder.mkdir(parents=True)
        req = image.build_request("generate", model=str(folder), out_dir=self.out, prompt="x")
        self.assertEqual(req.model, str(folder))
        self.assertEqual(image.model_dir(req.model, lambda repo: self.fail("a path is never looked up")), folder)

    def test_tilde_is_expanded(self) -> None:
        (self.tmp / "seedvr2-3b").mkdir()
        src = _png(self.tmp / "small.png", 100, 100)
        with mock.patch.dict(os.environ, {"HOME": str(self.tmp)}):
            req = image.build_request("upscale", model="~/seedvr2-3b", out_dir=self.out, source=str(src))
        self.assertEqual(req.model, str(self.tmp / "seedvr2-3b"))

    def test_a_missing_folder_is_refused(self) -> None:
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("generate", model=str(self.tmp / "z-image-turbo-gone"), out_dir=self.out, prompt="x")
        self.assertIn("does not exist", str(cm.exception))

    def test_a_folder_that_names_no_family_is_refused_listing_the_names(self) -> None:
        (self.tmp / "my-model").mkdir()
        with self.assertRaises(image.ImageError) as cm:
            image.build_request("generate", model=str(self.tmp / "my-model"), out_dir=self.out, prompt="x")
        self.assertIn("z-image-turbo", str(cm.exception))

    def test_a_repo_id_is_looked_up(self) -> None:
        self.assertEqual(image.model_dir(image.DEFAULT_MODEL, lambda repo: f"/snap/{repo}"),
                         Path(f"/snap/{image.DEFAULT_MODEL}"))
        self.assertIsNone(image.model_dir(image.DEFAULT_MODEL, lambda repo: None))

    def test_a_folder_model_round_trips_through_argv(self) -> None:
        folder = self.tmp / "z-image-turbo"
        folder.mkdir()
        req = image.build_request("generate", model=str(folder), out_dir=self.out, prompt="x")
        self.assertEqual(image.request_from_args(image.build_parser().parse_args(image.to_argv(req))), req)


if __name__ == "__main__":
    unittest.main()
