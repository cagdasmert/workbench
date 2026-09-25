from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
