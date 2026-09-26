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
    if is_path(repo):
        folder = Path(repo).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ImageError(f"model folder {repo!r} does not exist")
        repo = str(folder)
    family = family_for(repo, mode)   # a folder's path must name its family, as modelctl's layout does
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
        folder = model_dir(req.model, mc.resolve)
        if folder is None:
            raise ImageError(f"{req.model} is not downloaded. Fetch it with: {pull_command(req.model)}")
        result = run(req, folder, out=say)
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
