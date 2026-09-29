from __future__ import annotations

import tempfile
import textwrap
import time
import unittest
from pathlib import Path

import asr
import modelctld as d

TURBO = "mlx-community/whisper-large-v3-turbo"


def _wait(job: d.Job, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while job.state == "running" and time.time() < deadline:
        time.sleep(0.05)


def _finished_job(tmp: Path) -> d.Job:
    job = d.Job("asr", TURBO, [])
    t = asr.Transcript("Merhaba dünya.", (asr.Segment(0, 2, "Merhaba dünya."),), "tr", 2.0, TURBO)
    job.state, job.result = "done", t.to_json()
    job.params = {"path": str(tmp / "memo.m4a"), "language": "tr"}
    d.JOBS.add(job)
    return job


class ResultChannelTest(unittest.TestCase):
    def test_result_file_is_loaded_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake.py"
            script.write_text(textwrap.dedent("""
                import json, sys
                print("50%", flush=True)
                open(sys.argv[sys.argv.index("--out") + 1], "w").write(json.dumps({"text": "ok"}))
            """))
            out = Path(tmp) / "result.json"
            job = d.start_job("asr", "test/result-channel", ["--out", str(out)],
                              script=str(script), params={"path": "x"}, result_path=out)
            _wait(job)
            self.assertEqual(job.state, "done")
            self.assertEqual(job.result, {"text": "ok"})
            self.assertFalse(out.exists())
            self.assertEqual(job.as_dict()["result"], {"text": "ok"})
            self.assertNotIn("result", job.as_dict(include_log=False))
            self.assertEqual(job.as_dict(include_log=False)["params"], {"path": "x"})

    def test_exit_zero_without_a_result_is_a_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake.py"
            script.write_text("pass\n")
            out = Path(tmp) / "missing.json"
            job = d.start_job("asr", "test/no-result", [], script=str(script), result_path=out)
            _wait(job)
            self.assertEqual(job.state, "failed")
            self.assertIn("no result", job.error or "")


class AsrRouteValidationTest(unittest.TestCase):
    def test_relative_path_is_400(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.h_asr({"path": "memo.m4a"})
        self.assertEqual(cm.exception.status, 400)

    def test_missing_file_is_400(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.h_asr({"path": "/nonexistent/memo.m4a"})
        self.assertEqual(cm.exception.status, 400)

    def test_parakeet_turkish_is_refused_before_a_job_exists(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".m4a") as f:
            before = len(d.JOBS.all())
            with self.assertRaises(d.ApiError) as cm:
                d.h_asr({"path": f.name, "model": "mlx-community/parakeet-tdt-0.6b-v3",
                         "language": "tr"})
            self.assertEqual(cm.exception.status, 400)
            self.assertIn("cannot transcribe", str(cm.exception))
            self.assertEqual(len(d.JOBS.all()), before)

    def test_non_asr_model_is_400(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".m4a") as f:
            with self.assertRaises(d.ApiError) as cm:
                d.h_asr({"path": f.name, "model": "black-forest-labs/FLUX.1-schnell"})
            self.assertEqual(cm.exception.status, 400)


class SaveRouteTest(unittest.TestCase):
    def test_writes_markdown_and_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = _finished_job(Path(tmp))
            first = d.h_asr_save({"job_id": job.id, "dir": tmp, "filename": "memo"})
            second = d.h_asr_save({"job_id": job.id, "dir": tmp, "filename": "memo"})
            self.assertEqual(Path(first["path"]).name, "memo.md")
            self.assertEqual(Path(second["path"]).name, "memo-2.md")
            text = Path(first["path"]).read_text(encoding="utf-8")
            self.assertIn("[00:00] Merhaba dünya.", text)
            self.assertIn('language: "tr"', text)

    def test_default_filename_and_timestamps_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = _finished_job(Path(tmp))
            out = d.h_asr_save({"job_id": job.id, "dir": tmp, "timestamps": False,
                                "frontmatter": {"tags": "memo"}})
            name = Path(out["path"]).name
            self.assertTrue(name.endswith(" memo.md"), name)
            text = Path(out["path"]).read_text(encoding="utf-8")
            self.assertNotIn("[00:00]", text)
            self.assertIn('tags: "memo"', text)

    def test_running_job_is_refused(self) -> None:
        job = d.Job("asr", TURBO, [])
        d.JOBS.add(job)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(d.ApiError) as cm:
                d.h_asr_save({"job_id": job.id, "dir": tmp})
            self.assertEqual(cm.exception.status, 409)

    def test_relative_dir_is_400(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = _finished_job(Path(tmp))
            with self.assertRaises(d.ApiError) as cm:
                d.h_asr_save({"job_id": job.id, "dir": "notes"})
            self.assertEqual(cm.exception.status, 400)

    def test_bad_frontmatter_is_400(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = _finished_job(Path(tmp))
            with self.assertRaises(d.ApiError) as cm:
                d.h_asr_save({"job_id": job.id, "dir": tmp, "frontmatter": {"tags": [1]}})
            self.assertEqual(cm.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
