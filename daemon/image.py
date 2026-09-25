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
