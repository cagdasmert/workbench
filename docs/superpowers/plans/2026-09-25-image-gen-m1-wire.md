# Images M1 — the wire: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate, edit and upscale images through `modelctld` over `curl`, using mflux models from the modelctl catalog, one image job at a time.

**Architecture:** A new runtime script, `daemon/image.py`, holds a family table (repo name → mflux class and defaults), request validation, and file output. None of that imports mflux. `modelctld.py` imports it in-process to validate each request, so a bad request is a 400, and then runs `image.py <mode> …` as a job subprocess. The subprocess loads the model, prints its own progress lines, writes the PNG and a JSON sidecar, and leaves the result in an `--out` file. This is the same machinery `asr` and `text` use, plus a new `JobStore.claim` that refuses a second image job of any model under one lock.

**Tech Stack:** Python 3.12 (venv at `~/work/tools/huggingface/.venv`), mflux 0.20.0 (MLX), Pillow, stdlib `unittest`, `http.server`.

**Spec:** `docs/superpowers/specs/2026-09-25-image-gen-design.md`. Decisions 1–13 and 23–24 apply to this milestone, as do the wire contract and the M1 row of the milestone table. The source PRD is vault `02_Projects/Huggingface/PRD/P4-image.md`.

## Global Constraints

- All daemon code lives in `workbench/daemon/`. Run it with `~/work/tools/huggingface/.venv/bin/python`. Install packages from `~/work/tools/huggingface`, where the venv is, then refresh `daemon/requirements.txt` in the same commit.
- **The daemon never imports mflux, mlx or torch.** `image.py`'s top-level imports are stdlib only. Pillow is imported inside `image_size`, `save_png` and `preview_b64`, and mflux and mlx inside `load_model`, `_generate` and `peak_gb`.
- mflux is pinned to **`0.20.0`**.
- The default models, copied verbatim:
  - `DEFAULT_MODEL = "mflux-community/z-image-turbo-mflux-q8"`
  - `DEFAULT_EDIT_MODEL = "mflux-community/qwen-image-edit-2511-mflux-q6"`
  - `DEFAULT_UPSCALE_MODEL = "numz/SeedVR2_comfyUI"`
- **Every file the daemon writes uses exclusive create** (`open(…, "xb")`), gets `-2`, `-3`, … after a name collision, and never overwrites. Nothing is ever written under `~/Library/Application Support/Workbench/plugins/`.
- **One `image` job at a time, across all models**, refused with a 409 whose hint names the running job's id.
- **Error messages are written for the user.** Hints name the fix (a `modelctl pull …` command, a `sips` command, and so on).
- **Tests never load weights.** A fake model stands in for mflux. Real generation is checked only at the Task 9 gate.
- **No agent downloads models.** The user pulls them with `modelctl`. A step that needs weights checks `modelctl ls`, and if they are missing it stops and names the pull commands. *(Added 2026-09-26.)*
- **A model is a repo id or an absolute folder path** (spec decision 5, amended 2026-09-26).
- **The full suite stays green after every task.** `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests` passes 91 tests before this plan starts.
- Work on branch `image-gen`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `daemon/image.py` (create) | families, output files, request validation, the mflux runner, the CLI |
| `daemon/modelctld.py` (modify) | `JobStore.claim`, `start_job(exclusive_kind=)`, six `/v1/generate/image*` routes |
| `daemon/tests/test_image.py` (create) | families, catalog, pull command, requests, sizes, argv round-trip |
| `daemon/tests/test_image_output.py` (create) | out dir, the deny-list, exclusive naming, PNG and sidecar, copy, preview |
| `daemon/tests/test_image_run.py` (create) | the runner with a fake model: progress lines, defaults, result shape |
| `daemon/tests/test_modelctld_jobs.py` (create) | `JobStore.claim` and `start_job(exclusive_kind=True)` |
| `daemon/tests/test_modelctld_image.py` (create) | the six routes |
| `daemon/requirements.txt`, `daemon/README.md`, `docs/m1-shell-change-log.md` (modify) | deps, the script table, change log entry 42 |

Test helper used by several test files, to make a real image file without weights:

```python
from PIL import Image

def _png(path: Path, w: int, h: int) -> Path:
    Image.new("RGB", (w, h), (120, 90, 60)).save(path)
    return path
```

---

### Task 1: mflux installed, and the family table

**Files:**
- Modify: `daemon/requirements.txt`
- Create: `daemon/image.py`
- Test: `daemon/tests/test_image.py`

**Interfaces:**
- Produces:
  - `ImageError(Exception)`
  - `Family` (frozen dataclass: `name, role, match, steps, width, height, negative, guidance, include`, plus `to_json() -> dict`)
  - `FAMILIES: tuple[Family, ...]`, `ROLES`, `DEFAULTS: dict[str, str]`, `DEFAULT_MODEL`, `DEFAULT_EDIT_MODEL`, `DEFAULT_UPSCALE_MODEL`
  - `family_for(repo: str, role: str) -> Family`
  - `catalog(repos: list[str]) -> list[dict]`
  - `pull_command(repo: str) -> str`

- [ ] **Step 1: Install mflux into the shared venv and record it**

```bash
cd ~/work/tools/huggingface && uv pip install "mflux==0.20.0"
~/work/tools/huggingface/.venv/bin/python -c "import mflux, PIL; from importlib.metadata import version as v; print(v('mflux'), v('mlx'), v('mlx-lm'), v('pillow'))"
```

Expected: `0.20.0 0.32.2 0.31.3 12.x`. **mlx and mlx-lm must be unchanged.** If either moved, stop and report: the vault-search and transcribe runtimes depend on them.

```bash
cd ~/work/tools/huggingface && { echo "# uv pip freeze of ~/work/tools/huggingface/.venv (Python $(.venv/bin/python -c 'import platform;print(platform.python_version())'))."; echo "# Rebuild: uv venv --python 3.12 && uv pip install -r requirements.txt"; uv pip freeze; } > /Users/cagdasmert/work/WS/workbench/daemon/requirements.txt
grep -E "^(mflux|pillow|mlx)==" /Users/cagdasmert/work/WS/workbench/daemon/requirements.txt
```

Expected: `mflux==0.20.0`, `pillow==…` and the two `mlx` lines.

- [ ] **Step 2: Write the failing tests**

Create `daemon/tests/test_image.py`:

```python
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image -v`
Expected: `ModuleNotFoundError: No module named 'image'`

- [ ] **Step 4: Create `daemon/image.py`**

The import block is the file's final one; later tasks use the imports this task does not.

```python
#!/usr/bin/env python3
"""
image - generate, edit and upscale images with the models in the modelctl catalog.

Runs mflux, which is MLX-native: Z-Image Turbo generates, Qwen-Image-Edit or
FLUX.2 Klein edits by instruction, and SeedVR2 upscales. modelctld runs it as an
`image` job, one at a time, and reads the result from --out; it works by hand
too.

Importing this module is cheap on purpose, as with asr.py. The family table,
request validation, sizing and file naming are plain top-level functions, so
modelctld can refuse a bad request before a job exists. mflux and mlx are
imported only inside the functions that load or run a model, and Pillow only
where pixels or headers are read.

image_gen.py beside this is the older standalone diffusers CLI. The daemon does
not use it.

Usage
-----
    PY=~/work/tools/huggingface/.venv/bin/python
    $PY image.py generate --prompt "a green garden gate in a stone wall"
    $PY image.py edit --source ~/wall.jpg --instruction "natural stone instead of concrete"
    $PY image.py upscale --source ~/small.png --factor 2
    $PY image.py generate --prompt "..." --out-dir /tmp --out result.json    # what modelctld runs
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import random
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Callable

DEFAULT_MODEL = "mflux-community/z-image-turbo-mflux-q8"
DEFAULT_EDIT_MODEL = "mflux-community/qwen-image-edit-2511-mflux-q6"
DEFAULT_UPSCALE_MODEL = "numz/SeedVR2_comfyUI"

ROLES = ("generate", "edit", "upscale")
DEFAULTS = {"generate": DEFAULT_MODEL, "edit": DEFAULT_EDIT_MODEL, "upscale": DEFAULT_UPSCALE_MODEL}


class ImageError(Exception):
    """A request image.py cannot run. The message is written for the user."""


@dataclass(frozen=True)
class Family:
    name: str
    role: str                       # one of ROLES
    match: tuple[str, ...]          # lowercase substrings of a repo id
    steps: int | None               # None: the role has no step count
    width: int | None               # None: follows the source image
    height: int | None
    negative: bool                  # takes a negative prompt
    guidance: float | None          # None: the model decides
    include: tuple[str, ...] = ()   # files to pull when the repo holds more than mflux reads

    def to_json(self) -> dict[str, Any]:
        return {"family": self.name, "role": self.role, "negative": self.negative,
                "defaults": {"steps": self.steps, "width": self.width, "height": self.height}}


# How to run each model family. This is the one place "Z-Image Turbo wants 9
# steps" is written down: the panel reads it from GET /v1/generate/image/models
# rather than hardcoding it. Steps and guidance are mflux 0.20's own defaults
# (mflux/cli/defaults/defaults.py).
FAMILIES: tuple[Family, ...] = (
    Family("z-image-turbo", "generate", ("z-image-turbo", "zimage-turbo"),
           steps=9, width=1024, height=1024, negative=False, guidance=None),
    Family("qwen-image-edit", "edit", ("qwen-image-edit",),
           steps=20, width=None, height=None, negative=False, guidance=2.5),
    Family("flux2-klein-9b", "edit", ("flux2-klein-9b",),
           steps=4, width=None, height=None, negative=False, guidance=1.0),
    # numz/SeedVR2_comfyUI is 60 GB of variants, and mflux reads two files of it.
    Family("seedvr2", "upscale", ("seedvr2",),
           steps=None, width=None, height=None, negative=False, guidance=None,
           include=("seedvr2_ema_3b_fp16.safetensors", "ema_vae_fp16.safetensors")),
)


def _matches(family: Family, repo: str) -> bool:
    name = repo.lower()
    return any(m in name for m in family.match)


def family_for(repo: str, role: str) -> Family:
    """The family that runs `repo` in `role`, or an ImageError naming the ones that exist."""
    for family in FAMILIES:
        if family.role == role and _matches(family, repo):
            return family
    known = ", ".join(f.name for f in FAMILIES if f.role == role)
    raise ImageError(f"{repo} is not a model image.py can {role} with (it knows: {known})")


def catalog(repos: list[str]) -> list[dict[str, Any]]:
    """One row per downloaded repo and the family it matches, for GET .../models."""
    return [{"repo": repo, **family.to_json()}
            for repo in sorted(set(repos)) for family in FAMILIES if _matches(family, repo)]


def pull_command(repo: str) -> str:
    """The modelctl command that fetches `repo`, narrowed with --include where mflux reads only part of it."""
    for family in FAMILIES:
        if family.include and _matches(family, repo):
            return f"modelctl pull {repo} --include {' '.join(family.include)}"
    return f"modelctl pull {repo}"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image -v`
Expected: 8 tests, `OK`

- [ ] **Step 6: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/image.py daemon/tests/test_image.py daemon/requirements.txt
git commit -m "image: mflux 0.20, and the family table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Output files — where results go and how they are written

**Files:**
- Modify: `daemon/image.py` (add a section after `pull_command`)
- Test: `daemon/tests/test_image_output.py`

**Interfaces:**
- Consumes: `ImageError` (Task 1)
- Produces:
  - `DEFAULT_OUT_DIR: Path`, `DENIED_WRITE_ROOTS: tuple[Path, ...]` (tests patch both), `PREVIEW_EDGE = 512`
  - `write_denied(directory: Path) -> str | None`
  - `resolve_out_dir(raw: object) -> Path`
  - `output_name(mode: str, seed: int, when: datetime) -> str`
  - `open_new(directory: Path, filename: str) -> tuple[Path, BinaryIO]`
  - `save_png(image: Any, directory: Path, filename: str, meta: dict) -> Path`
  - `copy_new(source: Path, directory: Path) -> Path`
  - `preview_b64(image: Any, edge: int = PREVIEW_EDGE) -> str`

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_image_output.py`:

```python
from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from PIL import Image

import image


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
            self.assertIn("plugin folder", str(cm.exception))


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

    def test_preview_is_a_jpeg_no_larger_than_512(self) -> None:
        b64 = image.preview_b64(Image.new("RGB", (2000, 1000)))
        with Image.open(io.BytesIO(base64.b64decode(b64))) as im:
            self.assertEqual((im.format, im.size), ("JPEG", (512, 256)))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image_output -v`
Expected: errors such as `AttributeError: module 'image' has no attribute 'DEFAULT_OUT_DIR'`

- [ ] **Step 3: Add the output section to `daemon/image.py`, after `pull_command`**

```python
# ---------------------------------------------------------------------------
# output files
# ---------------------------------------------------------------------------

DEFAULT_OUT_DIR = Path.home() / "Pictures" / "Workbench"
PREVIEW_EDGE = 512

# Workbench loads plugins from here at launch, so a file written into it is code
# that runs on the next start with no prompt (workbench CLAUDE.md, "Watch for").
# The fs broker deny-lists it; the daemon's writes do too.
DENIED_WRITE_ROOTS: tuple[Path, ...] = (
    Path.home() / "Library" / "Application Support" / "Workbench" / "plugins",
)


def write_denied(directory: Path) -> str | None:
    """Why `directory` must not be written to, or None.

    Both sides are resolved first, so a symlink that leads into the plugin
    folder is caught as well as the folder itself.
    """
    real = directory.resolve()
    for root in DENIED_WRITE_ROOTS:
        denied = root.resolve()
        if real == denied or real.is_relative_to(denied):
            return f"{directory} is inside Workbench's plugin folder, which is never written to"
    return None


def resolve_out_dir(raw: object) -> Path:
    """Where results go: `raw` when it is an existing absolute folder, else the default.

    The default is created on first use. An explicit folder must already exist,
    so a typo in the panel's settings cannot scatter new folders around the disk.
    """
    if raw is None or raw == "":
        DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)
        return DEFAULT_OUT_DIR
    if not isinstance(raw, str):
        raise ImageError(f"out_dir must be a folder path, got {raw!r}")
    folder = Path(raw).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise ImageError(f"out_dir must be an existing absolute folder, got {raw!r}")
    problem = write_denied(folder)
    if problem:
        raise ImageError(problem)
    return folder


def output_name(mode: str, seed: int, when: datetime) -> str:
    return f"{when:%Y%m%d-%H%M%S}_{mode}_{seed}.png"


def open_new(directory: Path, filename: str) -> tuple[Path, BinaryIO]:
    """Create `filename` in `directory` for writing, never over an existing entry.

    A taken name gets -2, -3, ... before the extension. Exclusive create is also
    what refuses a symlink planted at the name: O_EXCL fails on any existing
    entry, a dangling link included, so a write cannot be redirected outside
    `directory`. The broker's COPYFILE_EXCL rests on the same reasoning.
    """
    stem, suffix = Path(filename).stem, Path(filename).suffix
    for n in range(1, 1000):
        candidate = directory / (filename if n == 1 else f"{stem}-{n}{suffix}")
        try:
            return candidate, candidate.open("xb")
        except FileExistsError:
            continue
    raise ImageError(f"{directory} already holds 999 files named like {filename}")


def save_png(image: Any, directory: Path, filename: str, meta: dict[str, Any]) -> Path:
    """Write `image` as PNG with `meta` in text chunks, plus a JSON sidecar of the same stem.

    The sidecar is skipped rather than overwritten if its name is somehow taken.
    The text chunks still carry everything in it.
    """
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    for key, value in meta.items():
        info.add_text(key, str(value))
    path, f = open_new(directory, filename)
    with f:
        image.save(f, format="PNG", pnginfo=info)
    try:
        with path.with_suffix(".json").open("x", encoding="utf-8") as side:
            json.dump(meta, side, ensure_ascii=False, indent=2)
    except FileExistsError:
        pass
    return path


def copy_new(source: Path, directory: Path) -> Path:
    """Copy `source` into `directory` under its own name, never overwriting."""
    path, f = open_new(directory, source.name)
    with f, source.open("rb") as src:
        shutil.copyfileobj(src, f)
    return path


def preview_b64(image: Any, edge: int = PREVIEW_EDGE) -> str:
    """A JPEG of at most `edge` px on the long side, as base64. C3: never the full PNG."""
    small = image.convert("RGB")
    small.thumbnail((edge, edge))
    buf = io.BytesIO()
    small.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("ascii")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image_output -v`
Expected: 10 tests, `OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/image.py daemon/tests/test_image_output.py
git commit -m "image: output files — default folder, plugin-folder deny, exclusive names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Requests — one validator for the daemon and the CLI

**Files:**
- Modify: `daemon/image.py` (add a section after the output section)
- Test: `daemon/tests/test_image.py` (append)

**Interfaces:**
- Consumes: `family_for`, `DEFAULTS` (Task 1); `resolve_out_dir` (Task 2)
- Produces:
  - `MIME_TYPES: dict[str, str]`, `EDIT_MAX_AREA`, `UPSCALE_FACTORS = (2, 3)`, `UPSCALE_MAX_EDGE = 4096`, `SIZE_MULTIPLE = 16`, `MAX_SEED`
  - `validate_source(raw: object) -> Path`
  - `image_size(path: Path) -> tuple[int, int]`
  - `fit_area(width: int, height: int, max_area: int = EDIT_MAX_AREA) -> tuple[int, int]`
  - `upscaled_size(width: int, height: int, factor: int) -> tuple[int, int]`
  - `Request` (frozen dataclass: `mode, model, out_dir, prompt, negative, instruction, source, factor, steps, seed, width, height`)
  - `build_request(mode: str, *, model=None, out_dir=None, prompt=None, negative=None, instruction=None, source=None, factor=None, steps=None, seed=None, width=None, height=None) -> Request`
  - `to_argv(req: Request) -> list[str]`
  - `params_of(req: Request) -> dict`
  - `build_parser() -> argparse.ArgumentParser`
  - `request_from_args(args: argparse.Namespace) -> Request`

- [ ] **Step 1: Write the failing tests** (append to `daemon/tests/test_image.py`, before `if __name__`)

Add these imports at the top of the file, next to `import unittest`:

```python
import tempfile
from pathlib import Path

from PIL import Image
```

```python
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


class SizeTest(unittest.TestCase):
    def test_fit_area_keeps_aspect_at_one_megapixel_in_multiples_of_16(self) -> None:
        self.assertEqual(image.fit_area(2048, 1536), (1168, 880))
        self.assertEqual(image.fit_area(4032, 3024), (1168, 880))
        self.assertEqual(image.fit_area(512, 384), (512, 384))
        self.assertEqual(image.fit_area(1000, 1000), (992, 992))

    def test_image_size_reads_the_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(image.image_size(_png(Path(tmp) / "a.png", 33, 17)), (33, 17))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image -v`
Expected: the 8 Task 1 tests pass, and the new ones fail with `AttributeError: module 'image' has no attribute 'build_request'` (or `fit_area`, `image_size`)

- [ ] **Step 3: Add the requests section to `daemon/image.py`, after the output section**

```python
# ---------------------------------------------------------------------------
# requests -- one validator for modelctld (a 400) and the CLI
# ---------------------------------------------------------------------------

MIME_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
EDIT_MAX_AREA = 1024 * 1024         # edits run at about one megapixel
UPSCALE_FACTORS = (2, 3)
UPSCALE_MAX_EDGE = 4096
SIZE_MULTIPLE = 16
MAX_SEED = 2**31 - 1


def validate_source(raw: object) -> Path:
    """An absolute path to an existing PNG, JPEG or WebP, or an ImageError that says why not."""
    if not isinstance(raw, str) or not raw:
        raise ImageError("path to a source image is required")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise ImageError(f"path must be absolute, got {raw!r}")
    suffix = p.suffix.lower()
    if suffix in (".heic", ".heif"):
        raise ImageError(f"{p.name} is HEIC, which image.py does not read. Convert it first: "
                         f"sips -s format jpeg '{p}' --out '{p.with_suffix('.jpg')}'")
    if suffix not in MIME_TYPES:
        raise ImageError(f"{p.name} is not a PNG, JPEG or WebP image")
    if not p.is_file():
        raise ImageError(f"no such file: {p}")
    return p


def image_size(path: Path) -> tuple[int, int]:
    """(width, height) from the file header. Pillow does not decode pixels for this."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as im:
            return im.size
    except (UnidentifiedImageError, OSError) as e:
        raise ImageError(f"{path.name} is not a readable image ({e})") from None


def _down(value: float) -> int:
    return max(SIZE_MULTIPLE, int(value) // SIZE_MULTIPLE * SIZE_MULTIPLE)


def fit_area(width: int, height: int, max_area: int = EDIT_MAX_AREA) -> tuple[int, int]:
    """`width` x `height` scaled to at most `max_area` pixels, aspect kept, sides multiples of 16.

    A 12 MP phone photo edited at full size would not fit in memory, and the
    edit models work at about one megapixel anyway.
    """
    scale = min(1.0, math.sqrt(max_area / (width * height)))
    return _down(width * scale), _down(height * scale)


def upscaled_size(width: int, height: int, factor: int) -> tuple[int, int]:
    out_w, out_h = width * factor, height * factor
    if max(out_w, out_h) > UPSCALE_MAX_EDGE:
        raise ImageError(f"{width}x{height} at {factor}x would be {out_w}x{out_h}. The limit is "
                         f"{UPSCALE_MAX_EDGE} px on the long edge, so use a smaller factor or image")
    return out_w, out_h


def _opt_int(name: str, value: object, lo: int, hi: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ImageError(f"{name} must be a whole number from {lo} to {hi}, got {value!r}")
    return value


def _size(name: str, value: object) -> int | None:
    v = _opt_int(name, value, 256, 2048)
    if v is not None and v % SIZE_MULTIPLE:
        raise ImageError(f"{name} must be a multiple of {SIZE_MULTIPLE}, got {v}")
    return v


def _text(name: str, value: object, *, required: bool) -> str | None:
    if value is not None and not isinstance(value, str):
        raise ImageError(f"{name} must be text, got {value!r}")
    stripped = (value or "").strip()
    if not stripped:
        if required:
            raise ImageError(f"{name} is required")
        return None
    return stripped


@dataclass(frozen=True)
class Request:
    mode: str                          # one of ROLES
    model: str
    out_dir: Path
    prompt: str | None = None          # generate
    negative: str | None = None        # generate, where the family takes one
    instruction: str | None = None     # edit
    source: Path | None = None         # edit, upscale
    factor: int | None = None          # upscale
    steps: int | None = None           # None: the family's default
    seed: int | None = None            # None: random, chosen when the job runs
    width: int | None = None           # generate; None: the family's default
    height: int | None = None


def build_request(mode: str, *, model: object = None, out_dir: object = None,
                  prompt: object = None, negative: object = None, instruction: object = None,
                  source: object = None, factor: object = None, steps: object = None,
                  seed: object = None, width: object = None, height: object = None) -> Request:
    """Validate one request. modelctld turns an ImageError into a 400; the CLI prints it.

    0 for steps or seed means "not set", as the plugin's command args define it.
    The output folder is resolved last, so a request that fails creates nothing.
    """
    if mode not in ROLES:
        raise ImageError(f"mode must be one of {', '.join(ROLES)}, got {mode!r}")
    repo = _text("model", model, required=False) or DEFAULTS[mode]
    family = family_for(repo, mode)
    seed_v = _opt_int("seed", seed, 0, MAX_SEED) or None

    if mode == "upscale":
        src = validate_source(source)
        factor_v = 2 if factor is None else factor
        if isinstance(factor_v, bool) or not isinstance(factor_v, int) or factor_v not in UPSCALE_FACTORS:
            raise ImageError(f"factor must be 2 or 3, got {factor!r}")
        upscaled_size(*image_size(src), factor_v)
        return Request(mode, repo, resolve_out_dir(out_dir), source=src, factor=factor_v, seed=seed_v)

    steps_v = _opt_int("steps", steps, 0, 100) or None
    if mode == "edit":
        src = validate_source(source)
        image_size(src)            # an unreadable file is a 400 now, not a failed job later
        text = _text("instruction", instruction, required=True)
        return Request(mode, repo, resolve_out_dir(out_dir), instruction=text, source=src,
                       steps=steps_v, seed=seed_v)

    text = _text("prompt", prompt, required=True)
    neg = _text("negative", negative, required=False)
    if neg is not None and not family.negative:
        raise ImageError(f"{repo} takes no negative prompt")
    w, h = _size("width", width), _size("height", height)
    return Request(mode, repo, resolve_out_dir(out_dir), prompt=text, negative=neg,
                   steps=steps_v, seed=seed_v, width=w, height=h)


def to_argv(req: Request) -> list[str]:
    """image.py's arguments for `req`, which is what modelctld hands the subprocess.

    Every value is attached with '=' so a prompt that starts with '-' is not
    read as a flag.
    """
    argv = [req.mode, f"--model={req.model}", f"--out-dir={req.out_dir}"]
    for flag, value in (("--prompt", req.prompt), ("--negative", req.negative),
                        ("--instruction", req.instruction), ("--source", req.source),
                        ("--factor", req.factor), ("--steps", req.steps), ("--seed", req.seed),
                        ("--width", req.width), ("--height", req.height)):
        if value is not None:
            argv.append(f"{flag}={value}")
    return argv


def params_of(req: Request) -> dict[str, Any]:
    """The request as job params, so a panel re-attaching knows what is running."""
    fields = {"mode": req.mode, "model": req.model, "prompt": req.prompt, "negative": req.negative,
              "instruction": req.instruction, "source": None if req.source is None else str(req.source),
              "factor": req.factor, "steps": req.steps, "seed": req.seed,
              "width": req.width, "height": req.height}
    return {k: v for k, v in fields.items() if v is not None}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="image", description="generate, edit and upscale images over the modelctl catalog")
    sub = p.add_subparsers(dest="mode", required=True)
    for mode in ROLES:
        s = sub.add_parser(mode)
        s.add_argument("--model", help=f"repo id (default {DEFAULTS[mode]})")
        s.add_argument("--out-dir", default="", help=f"where images go (default {DEFAULT_OUT_DIR})")
        s.add_argument("--out", type=Path, help="write the result as JSON here")
        s.add_argument("--seed", type=int, help="0 or absent: random")
        if mode == "generate":
            s.add_argument("--prompt", required=True)
            s.add_argument("--negative")
            s.add_argument("--width", type=int)
            s.add_argument("--height", type=int)
        else:
            s.add_argument("--source", required=True, help="a PNG, JPEG or WebP")
        if mode == "edit":
            s.add_argument("--instruction", required=True)
        if mode == "upscale":
            s.add_argument("--factor", type=int, default=2)
        else:
            s.add_argument("--steps", type=int, help="absent: the model's default")
    return p


def _absolute(raw: str | None) -> str | None:
    """A path typed by hand may be relative; the validator wants it absolute."""
    return None if not raw else str(Path(raw).expanduser().absolute())


def request_from_args(args: argparse.Namespace) -> Request:
    return build_request(
        args.mode, model=args.model, out_dir=_absolute(args.out_dir),
        prompt=getattr(args, "prompt", None), negative=getattr(args, "negative", None),
        instruction=getattr(args, "instruction", None), source=_absolute(getattr(args, "source", None)),
        factor=getattr(args, "factor", None), steps=getattr(args, "steps", None), seed=args.seed,
        width=getattr(args, "width", None), height=getattr(args, "height", None),
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image -v`
Expected: 18 tests, `OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/image.py daemon/tests/test_image.py
git commit -m "image: requests — one validator for the daemon and the CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The runner — load, generate, save, report

**Files:**
- Modify: `daemon/image.py` (add the running and CLI sections at the end)
- Test: `daemon/tests/test_image_run.py`

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces:
  - `Progress(out: Callable[[str], None])`, an mflux callback with `call_before_loop(**kw)` and `call_in_loop(*, time_steps=None, **kw)`
  - `load_model(family: Family, model_dir: Path) -> Any` (real mflux; not unit-tested)
  - `peak_gb() -> float | None`
  - `run(req: Request, model_dir: Path, *, loader=load_model, out=print, now=datetime.now) -> dict`

    It returns `{mode, model, seed, steps?, prompt?, negative?, instruction?, source?, factor?, width, height, path, preview_b64, load_s, gen_s, peak_gb}`.
  - `main(argv: list[str] | None = None) -> int`

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_image_run.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image_run -v`
Expected: `AttributeError: module 'image' has no attribute 'run'` (and `main`)

- [ ] **Step 3: Add the running and CLI sections at the end of `daemon/image.py`**

```python
# ---------------------------------------------------------------------------
# running -- mflux is imported only below this line, and only when called
# ---------------------------------------------------------------------------


class Progress:
    """An mflux callback that prints the lines modelctld turns into a job's percent.

    Nothing printed before the sampling loop contains '%', so percent stays null
    exactly while the model loads. That is how the panel tells "Loading model..."
    from "Generating" without a new job field. tqdm is switched off
    (TQDM_DISABLE), so these are the only percentages in the log.
    """

    def __init__(self, out: Callable[[str], None]) -> None:
        self.out = out
        self.done = 0

    def call_before_loop(self, **_: Any) -> None:
        self.out("generating  0%")

    def call_in_loop(self, *, time_steps: Any = None, **_: Any) -> None:
        self.done += 1
        total = getattr(time_steps, "total", None) or self.done
        self.out(f"step {self.done}/{total}  {min(100, round(100 * self.done / total))}%")


def load_model(family: Family, model_dir: Path) -> Any:
    """The mflux model for `family`, from a local snapshot that modelctl resolved.

    `quantize` is left unset, so pre-quantized weights (the mflux-community
    repos) load at the bits they were saved with. MemorySaver is what mflux's
    own CLI always registers: it evicts the text encoders once the prompt is
    encoded, 8-12 GB by mflux's measurement.
    """
    os.environ["TQDM_DISABLE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    from mflux.callbacks.instances.memory_saver import MemorySaver
    from mflux.models.common.config.model_config import ModelConfig

    path = str(model_dir)
    model: Any
    if family.name == "z-image-turbo":
        from mflux.models.z_image.variants.z_image import ZImage
        model = ZImage(model_path=path, model_config=ModelConfig.z_image_turbo())
    elif family.name == "qwen-image-edit":
        from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
        model = QwenImageEdit(model_path=path, model_config=ModelConfig.qwen_image_edit())
    elif family.name == "flux2-klein-9b":
        from mflux.models.flux2.variants import Flux2KleinEdit
        model = Flux2KleinEdit(model_path=path, model_config=ModelConfig.flux2_klein_9b())
    elif family.name == "seedvr2":
        from mflux.models.seedvr2.variants.upscale.seedvr2 import SeedVR2
        model = SeedVR2(model_path=path, model_config=ModelConfig.seedvr2_3b())
    else:
        raise ImageError(f"image.py has no loader for {family.name}")
    model.callbacks.register(MemorySaver(model=model, keep_transformer=True, cache_limit_bytes=None))
    return model


def _generate(family: Family, model: Any, req: Request, seed: int, steps: int | None,
              size: tuple[int, int] | None) -> Any:
    """One mflux call. Each family's generate_image takes different arguments."""
    if family.role == "upscale":
        from mflux.utils.scale_factor import ScaleFactor
        return model.generate_image(seed=seed, image_path=str(req.source),
                                    resolution=ScaleFactor(value=req.factor or 2), softness=0.0)
    if size is None:
        raise ImageError(f"no output size for a {family.role} request")
    width, height = size
    if family.role == "generate":
        return model.generate_image(seed=seed, prompt=req.prompt, num_inference_steps=steps,
                                    width=width, height=height, negative_prompt=req.negative)
    sources = [str(req.source)]
    if family.name == "qwen-image-edit":
        return model.generate_image(seed=seed, prompt=req.instruction, image_paths=sources,
                                    image_path=sources[0], num_inference_steps=steps,
                                    width=width, height=height, guidance=family.guidance)
    return model.generate_image(seed=seed, prompt=req.instruction, image_paths=sources,
                                num_inference_steps=steps, width=width, height=height,
                                guidance=family.guidance)


def peak_gb() -> float | None:
    """MLX's peak memory for this process, in GB. PRD §9 asks for it in every job."""
    try:
        import mlx.core as mx
    except ImportError:
        return None
    return round(mx.get_peak_memory() / 1e9, 1)


Loader = Callable[[Family, Path], Any]


def run(req: Request, model_dir: Path, *, loader: Loader = load_model,
        out: Callable[[str], None] = print,
        now: Callable[[], datetime] = datetime.now) -> dict[str, Any]:
    """Load, generate, write the PNG and sidecar, and return the job result."""
    family = family_for(req.model, req.mode)
    seed = req.seed or random.randint(1, MAX_SEED)
    steps = req.steps or family.steps
    size: tuple[int, int] | None = None
    if req.mode == "generate":
        size = (req.width or family.width or 1024, req.height or family.height or 1024)
    elif req.mode == "edit" and req.source is not None:
        size = fit_area(*image_size(req.source))

    out(f"loading {req.model}")
    started = time.monotonic()
    model = loader(family, model_dir)
    model.callbacks.register(Progress(out))
    loaded = time.monotonic()
    generated = _generate(family, model, req, seed, steps, size)
    finished = time.monotonic()

    picture = generated.image
    meta = {k: v for k, v in {
        "mode": req.mode, "model": req.model, "seed": seed, "steps": steps,
        "prompt": req.prompt, "negative": req.negative, "instruction": req.instruction,
        "source": None if req.source is None else str(req.source), "factor": req.factor,
        "width": picture.width, "height": picture.height,
    }.items() if v is not None}
    path = save_png(picture, req.out_dir, output_name(req.mode, seed, now()), meta)
    return {**meta, "path": str(path), "preview_b64": preview_b64(picture),
            "load_s": round(loaded - started, 2), "gen_s": round(finished - loaded, 2),
            "peak_gb": peak_gb()}


# ---------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    # Before anything imports huggingface_hub or tqdm: both read these once, at import.
    os.environ["TQDM_DISABLE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    import modelctl as mc

    args = build_parser().parse_args(argv)

    def say(line: str) -> None:
        print(line, flush=True)

    try:
        req = request_from_args(args)
        model_dir = mc.resolve(req.model)
        if model_dir is None:
            raise ImageError(f"{req.model} is not downloaded. Fetch it with: {pull_command(req.model)}")
        result = run(req, Path(model_dir), out=say)
    except ImageError as e:
        # modelctld reports a failed job's last line verbatim, so this line is the error the user sees.
        print(f"error: {e}", file=sys.stderr, flush=True)
        return 1

    if args.out is not None:
        args.out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    say(f"done: {result['path']}  load {result['load_s']}s  generate {result['gen_s']}s  "
        f"peak {result['peak_gb']} GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image_run -v`
Expected: 6 tests, `OK`

- [ ] **Step 5: Check that the module stays cheap to import**

Run:

```bash
cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -c "
import sys, image
heavy = [m for m in ('mflux', 'mlx', 'torch', 'PIL') if m in sys.modules]
print('heavy modules after import:', heavy or 'none')"
```

Expected: `heavy modules after import: none`

- [ ] **Step 6: Run the full suite, then commit**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests`
Expected: `OK` (91 existing + 34 new = 125)

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/image.py daemon/tests/test_image_run.py
git commit -m "image: the runner — load, generate, save, and say when loading ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: One image job at a time — `JobStore.claim`

**Files:**
- Modify: `daemon/modelctld.py`: `JobStore` (around lines 149–186) and `start_job` (around lines 190–215)
- Test: `daemon/tests/test_modelctld_jobs.py`

**Interfaces:**
- Produces:
  - `JobStore.claim(job: Job, *, exclusive_kind: bool = False) -> Job | None`. It returns the conflicting running job, or `None` after adding `job`.
  - `start_job(kind, repo, args, *, script=..., params=None, result_path=None, exclusive_kind: bool = False) -> Job`
- Removes: `JobStore.running_for`. Its only caller is `start_job`; `grep -rn running_for daemon/` must come back empty afterwards.

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_modelctld_jobs.py`:

```python
from __future__ import annotations

import unittest

import modelctld as d


class ClaimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = d.JobStore()

    def test_a_free_store_takes_the_job(self) -> None:
        job = d.Job("image", "a/x", [])
        self.assertIsNone(self.store.claim(job))
        self.assertIn(job, self.store.all())

    def test_the_same_repo_conflicts_whatever_the_kind(self) -> None:
        pull = d.Job("pull", "a/x", [])
        self.store.claim(pull)
        second = d.Job("image", "a/x", [])
        self.assertIs(self.store.claim(second), pull)
        self.assertNotIn(second, self.store.all())

    def test_the_same_kind_conflicts_only_when_exclusive(self) -> None:
        first = d.Job("image", "a/x", [])
        self.store.claim(first)
        self.assertIs(self.store.claim(d.Job("image", "b/y", []), exclusive_kind=True), first)
        self.assertIsNone(self.store.claim(d.Job("asr", "c/z", []), exclusive_kind=True))

    def test_finished_jobs_do_not_conflict(self) -> None:
        first = d.Job("image", "a/x", [])
        self.store.claim(first)
        first.state = "done"
        self.assertIsNone(self.store.claim(d.Job("image", "a/x", []), exclusive_kind=True))


class StartJobExclusiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.blocker = d.Job("image", "a/x", [])
        d.JOBS.add(self.blocker)

    def tearDown(self) -> None:
        self.blocker.state = "done"     # JOBS is shared with every other test module

    def test_a_second_image_job_is_409_and_names_the_first(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.start_job("image", "b/y", [], script="/nonexistent.py", exclusive_kind=True)
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("another image job", str(cm.exception))
        self.assertIn(self.blocker.id, cm.exception.hint or "")

    def test_the_same_repo_message_is_unchanged(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.start_job("pull", "a/x", [], script="/nonexistent.py")
        self.assertEqual(str(cm.exception), "a/x already has a running image job")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_jobs -v`
Expected: `AttributeError: 'JobStore' object has no attribute 'claim'` and `TypeError: start_job() got an unexpected keyword argument 'exclusive_kind'`

- [ ] **Step 3: Replace `JobStore.add` and `JobStore.running_for` in `daemon/modelctld.py`**

Replace the `add` method with a locked helper plus the public `add`, and replace `running_for` with `claim`:

```python
    def add(self, job: Job) -> None:
        with self._lock:
            self._add_locked(job)

    def _add_locked(self, job: Job) -> None:
        self._jobs[job.id] = job
        self._order.append(job.id)
        # Keep the list bounded, but never evict something still running.
        while len(self._order) > JOB_RETENTION:
            oldest = self._order[0]
            if self._jobs[oldest].state == "running":
                break
            self._order.popleft()
            self._jobs.pop(oldest, None)
```

```python
    def claim(self, job: Job, *, exclusive_kind: bool = False) -> Job | None:
        """Add `job` unless a running job conflicts with it, and return that job instead.

        A job conflicts when it has the same repo, or, with `exclusive_kind`, the
        same kind. The check and the add share one lock hold, so two requests
        arriving together cannot both pass the check.
        """
        with self._lock:
            for i in self._order:
                other = self._jobs[i]
                if other.state != "running":
                    continue
                if other.repo == job.repo or (exclusive_kind and other.kind == job.kind):
                    return other
            self._add_locked(job)
        return None
```

- [ ] **Step 4: Use `claim` in `start_job`**

Change the signature and the head of `start_job`:

```python
def start_job(kind: str, repo: str, args: list[str], *, script: str = MODELCTL_PY,
              params: dict | None = None, result_path: Path | None = None,
              exclusive_kind: bool = False) -> Job:
```

Append one paragraph to its docstring, after the `result_path` paragraph:

```python
    `exclusive_kind` also refuses the job while any job of the same kind runs,
    whatever its repo. Image generation needs this: two different image models
    resident together swap on 48 GB, which the per-repo rule alone allows.
```

Replace the block from `existing = JOBS.running_for(repo)` through `JOBS.add(job)` with:

```python
    argv = [sys.executable, script, *args]
    job = Job(kind, repo, argv)
    job.params = params or {}
    existing = JOBS.claim(job, exclusive_kind=exclusive_kind)
    if existing is not None:
        if existing.repo == repo:
            raise ApiError(
                f"{repo} already has a running {existing.kind} job",
                status=409,
                hint=f"poll /v1/jobs/{existing.id}, or cancel it first",
            )
        raise ApiError(
            f"another {kind} job is running ({existing.repo})",
            status=409,
            hint=f"one {kind} job at a time -- poll /v1/jobs/{existing.id}, or cancel it first",
        )
```

The rest of `start_job` (the `run` thread) is unchanged.

- [ ] **Step 5: Run the new tests and the full suite**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_jobs -v && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests && grep -rn --include='*.py' running_for . ; echo "grep exit $?"`
Expected: 6 new tests OK, the full suite OK, and `grep exit 1` (no `running_for` left)

- [ ] **Step 6: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/modelctld.py daemon/tests/test_modelctld_jobs.py
git commit -m "modelctld: claim a job under one lock, and allow one job per kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Routes — generate, edit, upscale, models

**Files:**
- Modify: `daemon/modelctld.py`: module docstring, imports, constants, a new handler section after `h_text`, `_route`, `serve()`
- Test: `daemon/tests/test_modelctld_image.py`

**Interfaces:**
- Consumes: `image.build_request`, `to_argv`, `params_of`, `catalog`, `pull_command`, `ImageError`, `DEFAULT_*` (Tasks 1–3); `start_job(..., exclusive_kind=True)` (Task 5)
- Produces:
  - `IMAGE_PY: str`
  - `_local_repos() -> list[str]`
  - `h_image_models() -> dict`
  - `h_image(mode: str, body: dict) -> dict`
  - Routes: `GET /v1/generate/image/models`, `POST /v1/generate/image`, `POST /v1/generate/image/edit`, `POST /v1/generate/image/upscale`

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_modelctld_image.py`:

```python
from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_image -v`
Expected: `AttributeError: module 'modelctld' has no attribute '_local_repos'` (the `setUp` reads it)

- [ ] **Step 3: Wire the module-level pieces in `daemon/modelctld.py`**

In the module docstring, replace the `/v1/generate/*` bullet with:

```python
* **`/v1/generate/*` is where runtime scripts mount.** `asr`, `text` and `image` are
  live. Each script is imported in-process to validate a request (cheap -- MLX
  loads only in the subprocess), then run as a job like a pull. `image` jobs run
  one at a time, whatever the model. The rest answer 501 until their scripts
  exist; the namespace was claimed early so clients never reshaped.
```

After `import embed  # noqa: E402 ...`, add:

```python
import image as imagegen  # noqa: E402  -- cheap: families and validation; mflux loads in the subprocess
```

After `TEXT_PY = ...`, add:

```python
IMAGE_PY = str(Path(__file__).resolve().parent / "image.py")
```

- [ ] **Step 4: Add the handler section after `h_text`**

```python
# ---------------------------------------------------------------------------
# generate/image -- validated in-process, run as an image.py subprocess
# ---------------------------------------------------------------------------


def _local_repos() -> list[str]:
    """Every repo folder on a mounted root. Folder presence is what `ls` calls downloaded."""
    repos: list[str] = []
    for root in _cfg().roots.values():
        if root.exists():
            repos += [mc.repo_for(d.name) for d in sorted(root.iterdir())
                      if d.name.startswith("models--") and d.is_dir()]
    return repos


def h_image_models() -> dict:
    return {"models": imagegen.catalog(_local_repos())}


def h_image(mode: str, body: dict) -> dict:
    try:
        req = imagegen.build_request(
            mode, model=body.get("model"), out_dir=body.get("out_dir"),
            prompt=body.get("prompt"), negative=body.get("negative"),
            instruction=body.get("instruction"), source=body.get("path"),
            factor=body.get("factor"), steps=body.get("steps"), seed=body.get("seed"),
            width=body.get("width"), height=body.get("height"),
        )
    except imagegen.ImageError as e:
        raise ApiError(str(e)) from None
    if mc.resolve(req.model, cfg=_cfg()) is None:
        raise ApiError(f"{req.model} is not downloaded", status=404,
                       hint=imagegen.pull_command(req.model))

    fd, out = tempfile.mkstemp(prefix="modelctld-image-", suffix=".json")
    os.close(fd)
    try:
        job = start_job("image", req.model, [*imagegen.to_argv(req), f"--out={out}"],
                        script=IMAGE_PY, params=imagegen.params_of(req),
                        result_path=Path(out), exclusive_kind=True)
    except ApiError:
        Path(out).unlink(missing_ok=True)   # 409: nothing will ever read it
        raise
    return job.as_dict()
```

- [ ] **Step 5: Route them, and update the 501 hint and the banner**

In `Handler._route`, before `if method == "POST" and rest == ["generate", "text"]:`, add:

```python
        if rest[:2] == ["generate", "image"]:
            leaf = rest[2:]
            if method == "GET" and leaf == ["models"]:
                return h_image_models()
            if method == "POST" and leaf == []:
                return h_image("generate", body)
            if method == "POST" and leaf in (["edit"], ["upscale"]):
                return h_image(leaf[0], body)
```

In the 501 `ApiError` below it, change the hint to:

```python
                hint=("asr, text and image are live; tts and the rest mount under "
                      "/v1/generate/* as their scripts land"),
```

In `serve()`, after the `/v1/generate/asr` banner line, add:

```python
    print("           /v1/generate/image[/edit|/upscale] (POST)  /v1/generate/image/models")
```

- [ ] **Step 6: Run the tests and the full suite**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_image -v && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests`
Expected: 5 new tests OK; full suite OK

- [ ] **Step 7: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/modelctld.py daemon/tests/test_modelctld_image.py
git commit -m "modelctld: /v1/generate/image — generate, edit, upscale, models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Routes — the full image, and *Save as…*

**Files:**
- Modify: `daemon/modelctld.py`: `import base64`, a constant, two handlers after `h_image`, `_route`, `serve()`
- Test: `daemon/tests/test_modelctld_image.py` (append)

**Interfaces:**
- Consumes: `image.MIME_TYPES`, `image.write_denied`, `image.copy_new`, `image.ImageError`
- Produces:
  - `IMAGE_FILE_MAX: int` (tests patch it)
  - `h_image_file(q: dict) -> dict`, which returns `{path, type, b64}`
  - `h_image_save(body: dict) -> dict`, which returns `{path}`
  - Routes: `GET /v1/generate/image/file?path=`, `POST /v1/generate/image/save`

- [ ] **Step 1: Write the failing tests** (append to `daemon/tests/test_modelctld_image.py`, before `if __name__`)

Add `import base64` to the file's imports.

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_image -v`
Expected: the 5 Task 6 tests pass; the new ones fail with `AttributeError: module 'modelctld' has no attribute 'h_image_file'`

- [ ] **Step 3: Implement**

Add `import base64` to `modelctld.py`'s stdlib imports, keeping them alphabetical. After `IMAGE_PY = ...`, add:

```python
IMAGE_FILE_MAX = 50 * 1024 * 1024   # the full image travels as base64 in JSON (C3)
```

After `h_image`, add:

```python
def h_image_file(q: dict) -> dict:
    """The full-resolution image, for Send to viewer and the before/after view."""
    raw = _required(q, "path")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ApiError(f"path must be absolute, got {raw!r}")
    kind = imagegen.MIME_TYPES.get(path.suffix.lower())
    if kind is None:
        raise ApiError(f"{path.name} is not a PNG, JPEG or WebP image")
    if not path.is_file():
        raise ApiError(f"no such file: {path}", status=404)
    size = path.stat().st_size
    if size > IMAGE_FILE_MAX:
        raise ApiError(f"{path.name} is {size / 2**20:.0f} MB; the limit is "
                       f"{IMAGE_FILE_MAX // 2**20} MB", status=413)
    return {"path": str(path), "type": kind, "b64": base64.b64encode(path.read_bytes()).decode("ascii")}


def h_image_save(body: dict) -> dict:
    """Save as...: copy one image into a folder the user chose, never overwriting."""
    raw = _required(body, "path")
    source = Path(raw).expanduser()
    if not source.is_absolute() or source.suffix.lower() not in imagegen.MIME_TYPES:
        raise ApiError(f"path must be an absolute PNG, JPEG or WebP file, got {raw!r}")
    if not source.is_file():
        raise ApiError(f"no such file: {source}", status=404)
    folder = Path(_required(body, "dir")).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise ApiError(f"dir must be an existing absolute folder, got {str(folder)!r}")
    problem = imagegen.write_denied(folder)
    if problem:
        raise ApiError(problem)
    try:
        written = imagegen.copy_new(source, folder)
    except imagegen.ImageError as e:
        raise ApiError(str(e)) from None
    return {"path": str(written)}
```

In `_route`, inside the `if rest[:2] == ["generate", "image"]:` block, add:

```python
            if method == "GET" and leaf == ["file"]:
                return h_image_file(q)
            if method == "POST" and leaf == ["save"]:
                return h_image_save(body)
```

In `serve()`, after the image banner line from Task 6, add:

```python
    print("           /v1/generate/image/file  /v1/generate/image/save (POST)")
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_modelctld_image -v && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests`
Expected: 9 tests in the file OK; full suite OK (91 + 49 = 140)

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/modelctld.py daemon/tests/test_modelctld_image.py
git commit -m "modelctld: /v1/generate/image/file and /save

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A model is a repo id or a folder path

*(Added 2026-09-26, spec decision 5 amended.)* The user manages downloads with modelctl and wants every model setting to accept the path of a downloaded model as well as a repo id.

**Files:**
- Modify: `daemon/image.py`: `is_path` and `model_dir` in the families section, the model check in `build_request`, and the lookup in `main`
- Modify: `daemon/modelctld.py`: the 404 check in `h_image`
- Test: `daemon/tests/test_image.py`, `daemon/tests/test_modelctld_image.py` (append)

**Interfaces:**
- Consumes: `family_for`, `DEFAULTS`, `build_request`, `to_argv`, `build_parser`, `request_from_args` (Tasks 1–3); `h_image` (Task 6)
- Produces:
  - `is_path(model: str) -> bool`
  - `model_dir(model: str, resolve: Callable[[str], str | None]) -> Path | None`
  - `Request.model` now holds the repo id **or the expanded absolute folder path**. `to_argv` passes it through `--model=` unchanged.

- [ ] **Step 1: Write the failing tests**

In `daemon/tests/test_image.py`, add `import os` and `from unittest import mock` to the imports, then append before `if __name__`:

```python
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
```

In `daemon/tests/test_modelctld_image.py`, append to `GenerateRouteTest`:

```python
    def test_a_model_folder_runs_without_a_catalog_lookup(self) -> None:
        d.mc.resolve = lambda repo, cfg=None: self.fail("a folder path is never looked up in the catalog")
        folder = self.tmp / "z-image-turbo-q8"
        folder.mkdir()
        job = d.h_image("generate", {"prompt": "x", "model": str(folder), "out_dir": str(self.tmp)})
        _, repo, args, _ = self.started[0]
        self.assertEqual((job["repo"], repo), (str(folder), str(folder)))
        self.assertIn(f"--model={folder}", args)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image tests.test_modelctld_image -v`
Expected: the new tests fail, with `AttributeError: module 'image' has no attribute 'model_dir'`, the "does not exist" assertion, and a folder the route tries to look up in the catalog. The 18 + 9 existing tests still pass.

- [ ] **Step 3: Implement in `daemon/image.py`**

After `pull_command`, still in the families section, add:

```python
def is_path(model: str) -> bool:
    """A model given as a folder, rather than as a repo id for modelctl to find."""
    return model.startswith(("/", "~"))


def model_dir(model: str, resolve: Callable[[str], str | None]) -> Path | None:
    """The folder to load `model` from.

    A folder path is used as given. A repo id is wherever modelctl keeps it
    (`resolve`), or None when it has not been pulled.
    """
    if is_path(model):
        return Path(model)
    found = resolve(model)
    return None if found is None else Path(found)
```

In `build_request`, replace the two lines

```python
    repo = _text("model", model, required=False) or DEFAULTS[mode]
    family = family_for(repo, mode)
```

with:

```python
    repo = _text("model", model, required=False) or DEFAULTS[mode]
    if is_path(repo):
        folder = Path(repo).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ImageError(f"model folder {repo!r} does not exist")
        repo = str(folder)
    family = family_for(repo, mode)   # a folder's path must name its family, as modelctl's layout does
```

In `main`, replace

```python
        model_dir = mc.resolve(req.model)
        if model_dir is None:
            raise ImageError(f"{req.model} is not downloaded. Fetch it with: {pull_command(req.model)}")
        result = run(req, Path(model_dir), out=say)
```

with:

```python
        folder = model_dir(req.model, mc.resolve)
        if folder is None:
            raise ImageError(f"{req.model} is not downloaded. Fetch it with: {pull_command(req.model)}")
        result = run(req, folder, out=say)
```

- [ ] **Step 4: Use `model_dir` in `h_image` (`daemon/modelctld.py`)**

Replace

```python
    if mc.resolve(req.model, cfg=_cfg()) is None:
```

with:

```python
    if imagegen.model_dir(req.model, lambda repo: mc.resolve(repo, cfg=_cfg())) is None:
```

The next two lines (the 404 with `pull_command`) are unchanged. A folder path never reaches them, because `build_request` has already checked that it exists.

- [ ] **Step 5: Run the tests and the full suite**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest tests.test_image tests.test_modelctld_image tests.test_image_run -v && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests`
Expected: `test_image` 24, `test_modelctld_image` 10 and `test_image_run` 6, all OK; full suite `OK` (147 tests)

- [ ] **Step 6: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/image.py daemon/modelctld.py daemon/tests/test_image.py daemon/tests/test_modelctld_image.py
git commit -m "image: a model is a repo id or a folder path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The gate — real models over `curl`, then the record

**Files:**
- Modify: `daemon/README.md` (the script table), `docs/m1-shell-change-log.md` (entry 42)

This task runs the real models, which **the user downloads with modelctl**. No agent pulls them.

Pick a scratch folder (your session scratchpad, or `mktemp -d`) and use it as `G` below. **Every shell block declares `G` and `PY` again**, because shell state does not carry between tool calls.

- [ ] **Step 1: Check that the user has pulled the two M1 models**

```bash
modelctl ls
```

Expected: `mflux-community/z-image-turbo-mflux-q8` at about 11.0 GB and `numz/SeedVR2_comfyUI` at about 7.3 GB. **If either is missing or short, STOP** and report NEEDS_CONTEXT with these commands for the user:

```bash
modelctl pull mflux-community/z-image-turbo-mflux-q8 --to internal
modelctl pull numz/SeedVR2_comfyUI --to internal --include seedvr2_ema_3b_fp16.safetensors ema_vae_fp16.safetensors
```

- [ ] **Step 2: Start a test daemon on port 8078, in the background**

Use 8078 so a daemon you already run on 8077 is not disturbed. Start it with the Bash tool's `run_in_background`, or in a second terminal:

```bash
cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python modelctld.py --port 8078
```

Check: `curl -s localhost:8078/v1/generate/image/models`. It should list two rows, `z-image-turbo` (generate) and `seedvr2` (upscale).

- [ ] **Step 3: Gate 1 — nine steps without asking, loading visible as `percent: null`, and a 409 for a second job**

```bash
G=<scratch>/imagegen-m1; mkdir -p "$G"; PY=~/work/tools/huggingface/.venv/bin/python
BODY='{"prompt":"a green wooden garden gate set in an old stone wall, morning light","seed":1234,"out_dir":"'"$G"'"}'
J1=$(curl -s -X POST localhost:8078/v1/generate/image -H 'content-type: application/json' -d "$BODY")
ID1=$(echo "$J1" | $PY -c 'import json,sys; print(json.load(sys.stdin)["id"])'); echo "job $ID1"
curl -s localhost:8078/v1/jobs/$ID1 | $PY -c 'import json,sys; j=json.load(sys.stdin); print("while loading: percent =", j["percent"], "| last:", j["log"][-1:])'
$PY -c 'from PIL import Image; import sys; Image.new("RGB", (256, 256), (10, 20, 30)).save(sys.argv[1])' "$G/probe.png"
curl -s -w ' %{http_code}\n' -X POST localhost:8078/v1/generate/image/upscale -H 'content-type: application/json' -d '{"path":"'"$G"'/probe.png","out_dir":"'"$G"'"}'
while [ "$(curl -s localhost:8078/v1/jobs/$ID1 | $PY -c 'import json,sys; print(json.load(sys.stdin)["state"])')" = running ]; do sleep 3; done
curl -s localhost:8078/v1/jobs/$ID1 > "$G/job1.json"
$PY -c 'import json,sys; j=json.load(open(sys.argv[1])); r=j["result"] or {}; print(j["state"], j["error"]); print({k: r.get(k) for k in ("path","steps","seed","width","height","load_s","gen_s","peak_gb")}); print("\n".join(l for l in j["log"] if l.startswith(("loading","generating","step 1/","step 9/","done"))))' "$G/job1.json"
```

Expected:
- `while loading: percent = None`.
- The second request is an **upscale** of the small PNG just created with PIL (its default model is
  `numz/SeedVR2_comfyUI`, a different repo from the running generate job's `mflux-community/z-image-turbo-mflux-q8`).
  Sending the *same* model here, as an identical second `generate` POST would, only exercises the same-repo 409
  ("… already has a running image job") -- the point of this step is the **cross-model** one:
  `{"error": "another image job is running (mflux-community/z-image-turbo-mflux-q8)", "hint": "one image job at a
  time -- poll /v1/jobs/<ID1>…"}`, status **409** (the `-w '%{http_code}'` above prints it).
- `done None`, `steps: 9`, `seed: 1234`, `1024x1024`, and numbers for `load_s`, `gen_s` and `peak_gb`.
- In the log: `loading …`, `generating  0%`, `step 1/9  11%`, `step 9/9  100%`, `done: …`.

If the job failed, its `error` is `image.py`'s last line. Fix the cause, and add a unit test if the cause is in our code, before going on.

- [ ] **Step 4: Gate 2 — the same seed gives the same pixels (PRD criterion 3), with the model given as a folder path**

This run gives the model as the folder `modelctl path` prints instead of the repo id, so it proves two things at once: that a folder path loads the same weights, and that a fixed seed is deterministic.

```bash
G=<scratch>/imagegen-m1; PY=~/work/tools/huggingface/.venv/bin/python
MODEL_DIR=$(modelctl path mflux-community/z-image-turbo-mflux-q8); echo "$MODEL_DIR"
BODY='{"prompt":"a green wooden garden gate set in an old stone wall, morning light","seed":1234,"model":"'"$MODEL_DIR"'","out_dir":"'"$G"'"}'
ID2=$(curl -s -X POST localhost:8078/v1/generate/image -H 'content-type: application/json' -d "$BODY" | $PY -c 'import json,sys; print(json.load(sys.stdin)["id"])')
while [ "$(curl -s localhost:8078/v1/jobs/$ID2 | $PY -c 'import json,sys; print(json.load(sys.stdin)["state"])')" = running ]; do sleep 3; done
curl -s localhost:8078/v1/jobs/$ID2 > "$G/job2.json"
$PY - "$G/job1.json" "$G/job2.json" <<'EOF'
import hashlib, json, sys
from PIL import Image
paths = [json.load(open(p))["result"]["path"] for p in sys.argv[1:]]
digests = [hashlib.sha256(Image.open(p).tobytes()).hexdigest() for p in paths]
print(paths[0], paths[1], sep="\n")
print("IDENTICAL" if digests[0] == digests[1] else "DIFFERENT", json.load(open(sys.argv[2]))["result"]["load_s"], "s load (warm cache)")
EOF
```

Expected: two different file names (the second one ends `-2.png` only if both ran in the same second), and `IDENTICAL`. **If `DIFFERENT`, stop and report**: criterion 3 does not hold on MLX, and the panel's seed lock would promise something false. That is a spec question for the user, not a code fix.

- [ ] **Step 5: Gate 3 — upscale, the full image, and *Save as…***

```bash
G=<scratch>/imagegen-m1; PY=~/work/tools/huggingface/.venv/bin/python
SRC=$($PY -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["path"])' "$G/job1.json")
ID3=$(curl -s -X POST localhost:8078/v1/generate/image/upscale -H 'content-type: application/json' -d '{"path":"'"$SRC"'","factor":2,"out_dir":"'"$G"'"}' | $PY -c 'import json,sys; print(json.load(sys.stdin)["id"])')
while [ "$(curl -s localhost:8078/v1/jobs/$ID3 | $PY -c 'import json,sys; print(json.load(sys.stdin)["state"])')" = running ]; do sleep 3; done
curl -s localhost:8078/v1/jobs/$ID3 > "$G/job3.json"
$PY -c 'import json,sys; j=json.load(open(sys.argv[1])); r=j["result"] or {}; print(j["state"], j["error"], {k: r.get(k) for k in ("path","width","height","factor","load_s","gen_s","peak_gb")})' "$G/job3.json"
curl -s "localhost:8078/v1/generate/image/file?path=$SRC" | $PY -c 'import json,sys,base64; j=json.load(sys.stdin); print(j["type"], len(base64.b64decode(j["b64"])), "bytes")'
mkdir -p "$G/saved"
for i in 1 2; do curl -s -X POST localhost:8078/v1/generate/image/save -H 'content-type: application/json' -d '{"path":"'"$SRC"'","dir":"'"$G/saved"'"}'; echo; done
curl -s -w ' %{http_code}\n' -X POST localhost:8078/v1/generate/image/edit -H 'content-type: application/json' -d '{"path":"'"$SRC"'","instruction":"x","out_dir":"'"$G"'"}'
```

Expected:
- `done None` with `width` and `height` about 2048, and `factor: 2`.
- `image/png` and a byte count that matches the file.
- Two save paths, `…png` and `…-2.png`.
- The edit request answers **404** with a hint of `modelctl pull mflux-community/qwen-image-edit-2511-mflux-q6`, because the edit model is pulled at the facade spike, not now.

- [ ] **Step 6: Stop the test daemon**

```bash
pkill -f "modelctld.py --port 8078"; sleep 1; pgrep -fl "modelctld.py --port 8078" || echo stopped
```

- [ ] **Step 7: Record it**

In `daemon/README.md`, replace the `image_gen.py` table row with these two rows:

```markdown
| `image.py` | mflux: generate, edit, upscale | `image-gen` |
| `image_gen.py` | diffusers: a standalone CLI, not wired to the daemon | — |
```

Append entry 42 to `docs/m1-shell-change-log.md`. Follow entry 37's shape, and use the numbers from Steps 3–5:

```markdown
## 42 · Images M1: an mflux runtime, and one image job at a time

**Plugin:** image-gen (vault PRD P4) · **Verdict:** DAEMON ONLY — no workbench code yet

`image.py` beside `asr.py`, and six routes under `/v1/generate/image` on `modelctld`. Design
deltas over the PRD are in `docs/superpowers/specs/2026-09-25-image-gen-design.md`; the plan is
`docs/superpowers/plans/2026-09-25-image-gen-m1-wire.md`.

**The PRD's runtime was not the runtime.** `image_gen.py` uses diffusers and a single `pipe(prompt)` call: no
image input, no Z-Image preset, and Qwen-Image-Edit at bf16 does not fit in 48 GB. `image.py` runs mflux 0.20 on
pre-quantized `mflux-community` weights instead. `image_gen.py` stays as the standalone CLI.

**One image job at a time, under one lock.** `JobStore.claim` checks for a conflict and adds the job in a single
lock hold. Same repo conflicts as before; with `exclusive_kind`, so does the same kind. That closes the
check-then-add gap `running_for` left, and it is what stops two image models swapping together.

**Loading has no percent.** `image.py` switches tqdm off and prints its own `step i/n  p%` lines from an mflux
callback. Nothing before the loop contains `%`, so `percent: null` means "loading model" without a new job field.

**A model is a repo id or a folder path.** Downloads are the user's, through modelctl. A repo id is found wherever
modelctl put it. A value starting with `/` or `~` is loaded exactly as given, never looked up, and must name its family
in its path, as modelctl's `models--org--name` layout always does.

**Verified** on the real models (Z-Image Turbo q8, SeedVR2 3B, M4 Pro, 48 GB):
- Generate, 1024², no steps sent → 9 steps. load <load_s> s, generate <gen_s> s, peak <peak_gb> GB.
- The same seed twice → pixel-identical (sha256 of the decoded pixels).
- A second POST while one ran → 409 naming the running job.
- Upscale 2× → <W>×<H>, load <load_s> s, generate <gen_s> s, peak <peak_gb> GB.
- `/file` and `/save` (the second save lands as `-2.png`).
- The second run gave the model as a folder path (`modelctl path`) and produced the same pixels.
- 56 new daemon tests (147 total). No test loads weights.

**Not yet verified:** editing — the edit model is pulled at the facade spike, which decides `editModel`.

**Contract impact:** none. Workbench is untouched so far.
```

Replace every `<…>` with the measured value. Do not commit the entry until every one is filled in.

- [ ] **Step 8: Run the full suite once more, then commit**

Run: `cd /Users/cagdasmert/work/WS/workbench/daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests`
Expected: `OK` (147 tests)

```bash
cd /Users/cagdasmert/work/WS/workbench
git add daemon/README.md docs/m1-shell-change-log.md
git commit -m "docs: change log 42 — images M1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: STOP at the gate**

Report to the user: the numbers from Steps 3–5, the determinism result, and anything that surprised you. Do not start the facade spike or M2 without the user.

---

## After M1: the facade spike (for the user, not part of this plan)

This decides `editModel` before any Edit UI exists (spec, milestone table). It needs a real photo of the front wall, exported as JPEG. For HEIC, use the `sips` command the 400 names. Then:

```bash
modelctl pull mflux-community/qwen-image-edit-2511-mflux-q6 --to internal      # 32.4 GB
modelctl pull mflux-community/flux2-klein-9b-mflux-q8 --to internal            # 17.9 GB
```

Run the same instruction and seed through both models on the test daemon (8078). For each, compare the two before/after pairs and the `gen_s` and `peak_gb` values:

```bash
curl -s -X POST localhost:8078/v1/generate/image/edit -H 'content-type: application/json' \
  -d '{"path":"/abs/front-wall.jpg","instruction":"replace the concrete wall with natural stone, keep everything else","seed":7,"model":"<repo>"}'
```

If neither result is usable, stop and rethink use case 1 before M3.

**If an edit model fails to load** with an offline or "not found" error, the pre-quantized repo
is missing a file mflux expects. Qwen's vision processor config is the likely one. Report which
file it is. Do not unset `HF_HUB_OFFLINE`: the file should come in through `modelctl`, not
through a silent download.
