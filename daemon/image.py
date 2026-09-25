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
