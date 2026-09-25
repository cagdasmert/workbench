from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from PIL import Image

import image as imagegen
import modelctld as d


def _png(path: Path, w: int, h: int) -> Path:
    Image.new("RGB", (w, h), (120, 90, 60)).save(path)
    return path


class _ImageRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.started: list[tuple] = []
        self._orig = (d.start_job, d.mc.resolve, d._local_repos,
                      imagegen.DEFAULT_OUT_DIR, imagegen.DENIED_WRITE_ROOTS)
        imagegen.DEFAULT_OUT_DIR = self.tmp / "Pictures"
        imagegen.DENIED_WRITE_ROOTS = (self.tmp / "plugins",)

        def fake_start(kind, repo, args, **kw):
            self.started.append((kind, repo, args, kw))
            out = next(a for a in args if a.startswith("--out="))
            Path(out.split("=", 1)[1]).unlink(missing_ok=True)
            job = d.Job(kind, repo, args)
            job.params = kw.get("params") or {}
            return job

        d.start_job = fake_start
        d.mc.resolve = lambda repo, cfg=None: "/fake/snapshot"

    def tearDown(self) -> None:
        (d.start_job, d.mc.resolve, d._local_repos,
         imagegen.DEFAULT_OUT_DIR, imagegen.DENIED_WRITE_ROOTS) = self._orig
        self._tmp.cleanup()


class GenerateRouteTest(_ImageRoutes):
    def test_generate_starts_an_exclusive_image_job_and_leaves_steps_to_the_family(self) -> None:
        job = d.h_image("generate", {"prompt": "a green gate", "out_dir": str(self.tmp)})
        kind, repo, args, kw = self.started[0]
        self.assertEqual((job["kind"], kind, repo), ("image", "image", imagegen.DEFAULT_MODEL))
        self.assertTrue(kw["exclusive_kind"])
        self.assertEqual(kw["script"], d.IMAGE_PY)
        self.assertEqual(args[0], "generate")
        self.assertIn("--prompt=a green gate", args)
        self.assertFalse(any(a.startswith("--steps") for a in args))
        self.assertEqual(kw["params"], {"mode": "generate", "model": imagegen.DEFAULT_MODEL,
                                        "prompt": "a green gate"})

    def test_edit_passes_the_source_and_the_instruction(self) -> None:
        src = _png(self.tmp / "wall.jpg", 640, 480)
        d.h_image("edit", {"path": str(src), "instruction": "stone wall", "out_dir": str(self.tmp)})
        _, repo, args, _ = self.started[0]
        self.assertEqual(repo, imagegen.DEFAULT_EDIT_MODEL)
        self.assertIn(f"--source={src}", args)
        self.assertIn("--instruction=stone wall", args)

    def test_bad_requests_are_400_before_a_job_exists(self) -> None:
        cases = [
            ("generate", {}),
            ("generate", {"prompt": "x", "width": 100}),
            ("generate", {"prompt": "x", "model": "black-forest-labs/FLUX.1-schnell"}),
            ("generate", {"prompt": "x", "out_dir": "renders"}),
            ("generate", {"prompt": "x", "out_dir": str(self.tmp / "plugins")}),
            ("edit", {"path": "wall.jpg", "instruction": "x"}),
            ("upscale", {"path": str(self.tmp / "none.png")}),
        ]
        (self.tmp / "plugins").mkdir()
        for mode, body in cases:
            with self.subTest(mode=mode, body=body), self.assertRaises(d.ApiError) as cm:
                d.h_image(mode, body)
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(self.started, [])

    def test_a_model_not_downloaded_is_404_with_the_pull_command(self) -> None:
        d.mc.resolve = lambda repo, cfg=None: None
        src = _png(self.tmp / "small.png", 320, 240)
        with self.assertRaises(d.ApiError) as cm:
            d.h_image("upscale", {"path": str(src), "out_dir": str(self.tmp)})
        self.assertEqual(cm.exception.status, 404)
        self.assertIn("--include seedvr2_ema_3b_fp16.safetensors", cm.exception.hint or "")
        self.assertEqual(self.started, [])

    def test_models_lists_only_downloaded_image_models(self) -> None:
        d._local_repos = lambda: ["sentence-transformers/LaBSE", imagegen.DEFAULT_MODEL]
        rows = d.h_image_models()["models"]
        self.assertEqual([(r["repo"], r["role"]) for r in rows], [(imagegen.DEFAULT_MODEL, "generate")])


class FileRouteTest(_ImageRoutes):
    def test_returns_the_full_image_as_base64(self) -> None:
        src = _png(self.tmp / "big.png", 300, 200)
        got = d.h_image_file({"path": [str(src)]})
        self.assertEqual((got["path"], got["type"]), (str(src), "image/png"))
        self.assertEqual(base64.b64decode(got["b64"]), src.read_bytes())

    def test_refusals(self) -> None:
        (self.tmp / "notes.txt").write_text("x")
        _png(self.tmp / "big.png", 300, 200)
        d_max, d.IMAGE_FILE_MAX = d.IMAGE_FILE_MAX, 10
        try:
            for query, status in (({"path": ["notes.txt"]}, 400),
                                  ({"path": [str(self.tmp / "notes.txt")]}, 400),
                                  ({"path": [str(self.tmp / "gone.png")]}, 404),
                                  ({"path": [str(self.tmp / "big.png")]}, 413)):
                with self.subTest(query=query), self.assertRaises(d.ApiError) as cm:
                    d.h_image_file(query)
                self.assertEqual(cm.exception.status, status)
        finally:
            d.IMAGE_FILE_MAX = d_max


class SaveRouteTest(_ImageRoutes):
    def setUp(self) -> None:
        super().setUp()
        self.src = _png(self.tmp / "result.png", 64, 64)
        self.dest = self.tmp / "chosen"
        self.dest.mkdir()

    def test_copies_and_never_overwrites(self) -> None:
        first = d.h_image_save({"path": str(self.src), "dir": str(self.dest)})
        second = d.h_image_save({"path": str(self.src), "dir": str(self.dest)})
        self.assertEqual((Path(first["path"]).name, Path(second["path"]).name), ("result.png", "result-2.png"))
        self.assertEqual(Path(second["path"]).read_bytes(), self.src.read_bytes())

    def test_refusals(self) -> None:
        (self.tmp / "plugins").mkdir()
        (self.tmp / "a.gif").write_bytes(b"GIF89a")
        for body, status in (({"path": str(self.src), "dir": "chosen"}, 400),
                             ({"path": str(self.src), "dir": str(self.tmp / "plugins")}, 400),
                             ({"path": str(self.tmp / "a.gif"), "dir": str(self.dest)}, 400),
                             ({"path": str(self.tmp / "gone.png"), "dir": str(self.dest)}, 404)):
            with self.subTest(body=body), self.assertRaises(d.ApiError) as cm:
                d.h_image_save(body)
            self.assertEqual(cm.exception.status, status)
        self.assertEqual(list(self.dest.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
