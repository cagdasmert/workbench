#!/usr/bin/env python3
"""
image_gen.py - minimal text-to-image runtime for locally cached HF models.

Companion to modelctl.py, not a replacement for it. This script owns nothing
about storage: it calls modelctl.resolve() to find a model's local snapshot
directory wherever it lives (internal SSD or external drive) and hands that
path to diffusers, which auto-detects the right pipeline class from the
model's model_index.json. Move a model with `modelctl mv` and this script
keeps working unchanged.

Requires (install once, ideally in a venv):
    pip install --upgrade diffusers transformers accelerate torch safetensors \\
        sentencepiece protobuf pillow

Usage
-----
    python image_gen.py black-forest-labs/FLUX.1-schnell "a cat wearing a hat"
    python image_gen.py stabilityai/stable-diffusion-xl-base-1.0 "..." --steps 40 --seed 7
    python image_gen.py <repo> "prompt" --n 4 --out ./renders
    python image_gen.py <repo> "prompt" --pull --to external      # fetch first if missing
    python image_gen.py --list                                     # local image models
    python image_gen.py --families                                 # known step/guidance presets

Scope: single-call `pipe(prompt)` pipelines only (SD 1.x/2.x/XL/3, FLUX, PixArt,
Playground, etc). Multi-stage pipelines (Stable Cascade, DeepFloyd IF, Kandinsky's
separate prior+decoder) need their own script — check the model card.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import modelctl  # noqa: E402

# ---------------------------------------------------------------------------
# per-family generation defaults
#
# DiffusionPipeline.from_pretrained() already picks the right pipeline CLASS
# from model_index.json -- that part is generic. What differs per family is
# the sane default for steps/guidance (a distilled model like FLUX-schnell
# wants 4 steps and guidance_scale=0; SDXL wants ~30 steps and guidance~7).
# Getting this wrong doesn't error, it just produces a bad image, so a lookup
# table beats guessing.
# ---------------------------------------------------------------------------

FAMILY_DEFAULTS: list[tuple[list[str], dict]] = [
    (["flux.1-schnell", "flux-schnell"], dict(steps=4, guidance=0.0, size=1024)),
    (["flux.1-dev", "flux-dev"], dict(steps=25, guidance=3.5, size=1024)),
    (["sdxl-turbo", "sdxl_turbo"], dict(steps=1, guidance=0.0, size=512)),
    (["sd-turbo", "sd_turbo"], dict(steps=1, guidance=0.0, size=512)),
    (["stable-diffusion-xl", "sdxl"], dict(steps=30, guidance=7.0, size=1024)),
    (["stable-diffusion-3", "sd3"], dict(steps=28, guidance=7.0, size=1024)),
    (["pixart"], dict(steps=20, guidance=4.5, size=1024)),
    (["playground-v2"], dict(steps=25, guidance=3.0, size=1024)),
    (["stable-diffusion-2", "stable-diffusion-v2"], dict(steps=25, guidance=7.5, size=768)),
    (["stable-diffusion-v1", "stable-diffusion-1", "runwayml/stable-diffusion"], dict(steps=25, guidance=7.5, size=512)),
]
DEFAULT_PRESET = dict(steps=25, guidance=7.0, size=1024)


def family_defaults(repo: str) -> dict:
    key = repo.lower()
    for names, preset in FAMILY_DEFAULTS:
        if any(n in key for n in names):
            return preset
    return DEFAULT_PRESET


def print_families():
    print(f"{'MATCHES REPO CONTAINING':40}  STEPS  GUIDANCE  SIZE")
    for names, p in FAMILY_DEFAULTS:
        print(f"{', '.join(names):40}  {p['steps']:>5}  {p['guidance']:>8}  {p['size']}")
    print(f"{'(anything else)':40}  {DEFAULT_PRESET['steps']:>5}  {DEFAULT_PRESET['guidance']:>8}  {DEFAULT_PRESET['size']}")
    print("\nOverride any of these per-run with --steps / --guidance / --width / --height.")


# ---------------------------------------------------------------------------
# pure helpers (no torch/diffusers import -- keep --list/--families/--help fast
# and usable even before those heavy packages are installed)
# ---------------------------------------------------------------------------


def repo_slug(repo: str) -> str:
    return repo.replace("/", "__")


def build_kwargs(args, preset: dict) -> dict:
    kwargs = dict(
        prompt=args.prompt,
        num_inference_steps=args.steps if args.steps is not None else preset["steps"],
        guidance_scale=args.guidance if args.guidance is not None else preset["guidance"],
    )
    if args.negative:
        kwargs["negative_prompt"] = args.negative
    width = args.width or args.size or preset["size"]
    height = args.height or args.size or preset["size"]
    kwargs["width"] = width
    kwargs["height"] = height
    return kwargs


def strip_unsupported_kwarg(err_msg: str, kwargs: dict) -> str | None:
    """Diffusers pipelines don't all share a call signature (FLUX-schnell has
    no `negative_prompt`, some have no `guidance_scale`, etc). Rather than
    special-case every pipeline class, pop whichever kwarg the TypeError
    names and let the caller retry. Returns the dropped key, or None if the
    error doesn't look like an unsupported-kwarg error.
    """
    if "unexpected keyword argument" not in err_msg:
        return None
    for k in list(kwargs):
        if f"'{k}'" in err_msg:
            del kwargs[k]
            return k
    return None


def list_local_image_models(cfg: "modelctl.Config") -> list[tuple[str, str, int]]:
    rows = []
    for name, root in cfg.roots.items():
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            if not d.name.startswith("models--") or not d.is_dir():
                continue
            meta = modelctl.read_sidecar(d)
            tag = meta.get("pipeline_tag")
            if tag and tag not in ("text-to-image", "image-to-image"):
                continue
            rows.append((modelctl.repo_for(d.name), name, modelctl.dir_size(d)))
    return rows


# ---------------------------------------------------------------------------
# heavy path (torch/diffusers) -- imported lazily so the above stays usable
# without either installed
# ---------------------------------------------------------------------------


def pick_device(preferred: str | None) -> str:
    import torch

    if preferred:
        return preferred
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def pick_dtype(device: str, preferred: str | None):
    import torch

    if preferred:
        return getattr(torch, preferred)
    return torch.bfloat16 if device in ("mps", "cuda") else torch.float32


def load_pipeline(model_dir: str, device: str, dtype, variant: str | None, low_vram: bool):
    import torch
    from diffusers import DiffusionPipeline

    kwargs = dict(torch_dtype=dtype, local_files_only=True, use_safetensors=True)
    if variant:
        kwargs["variant"] = variant
    try:
        pipe = DiffusionPipeline.from_pretrained(model_dir, **kwargs)
    except Exception as e:
        if dtype is not torch.float32:
            print(f"note: load failed under {dtype}, retrying as float32 ({e})", file=sys.stderr)
            kwargs["torch_dtype"] = torch.float32
            pipe = DiffusionPipeline.from_pretrained(model_dir, **kwargs)
            dtype = torch.float32
        else:
            raise

    pipe = pipe.to(device)

    if low_vram:
        for method in ("enable_attention_slicing", "enable_vae_slicing", "enable_vae_tiling"):
            fn = getattr(pipe, method, None)
            if fn:
                try:
                    fn()
                except Exception:
                    pass

    return pipe, dtype


def apply_scheduler(pipe, name: str):
    import diffusers

    cls = getattr(diffusers, name, None)
    if cls is None:
        print(f"warning: no scheduler named {name!r} in diffusers, keeping default", file=sys.stderr)
        return
    pipe.scheduler = cls.from_config(pipe.scheduler.config)


def apply_lora(pipe, lora: str, scale: float | None):
    try:
        pipe.load_lora_weights(lora)
        if scale is not None and hasattr(pipe, "fuse_lora"):
            pipe.fuse_lora(lora_scale=scale)
    except Exception as e:
        print(f"warning: could not load LoRA {lora!r}: {e}", file=sys.stderr)


def call_pipe(pipe, kwargs: dict):
    """Run the pipeline, adapting kwargs to whatever this pipeline class
    actually accepts (see strip_unsupported_kwarg)."""
    kwargs = dict(kwargs)
    while True:
        try:
            return pipe(**kwargs)
        except TypeError as e:
            dropped = strip_unsupported_kwarg(str(e), kwargs)
            if dropped is None:
                raise
            print(f"note: this pipeline doesn't accept '{dropped}', dropping it", file=sys.stderr)


def generate(pipe, device: str, args, preset: dict):
    import torch

    base_kwargs = build_kwargs(args, preset)
    seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)

    # MPS's own RNG for diffusion sampling is inconsistent across torch
    # versions; a CPU generator produces the same image deterministically
    # regardless of which accelerator runs the actual denoising.
    gen_device = "cpu" if device == "mps" else device

    results = []
    for i in range(args.n):
        this_seed = seed + i
        kwargs = dict(base_kwargs)
        kwargs["generator"] = torch.Generator(device=gen_device).manual_seed(this_seed)
        out = call_pipe(pipe, kwargs)
        results.append((out.images[0], this_seed))
    return results


def save_outputs(images, args, repo: str, preset: dict):
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    saved = []
    for img, seed in images:
        base = f"{repo_slug(repo)}_{stamp}_{seed}"
        img_path = out_dir / f"{base}.png"

        try:
            from PIL.PngImagePlugin import PngInfo

            info = PngInfo()
            info.add_text("prompt", args.prompt)
            if args.negative:
                info.add_text("negative_prompt", args.negative)
            info.add_text("repo", repo)
            info.add_text("seed", str(seed))
            img.save(img_path, pnginfo=info)
        except Exception:
            img.save(img_path)

        meta = {
            "repo": repo,
            "prompt": args.prompt,
            "negative_prompt": args.negative,
            "seed": seed,
            "steps": args.steps if args.steps is not None else preset["steps"],
            "guidance_scale": args.guidance if args.guidance is not None else preset["guidance"],
            "width": args.width or args.size or preset["size"],
            "height": args.height or args.size or preset["size"],
            "generated_at": stamp,
        }
        (out_dir / f"{base}.json").write_text(json.dumps(meta, indent=2))
        saved.append(img_path)
    return saved


# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("repo", nargs="?", help="HF repo id, e.g. black-forest-labs/FLUX.1-schnell")
    p.add_argument("prompt", nargs="?")
    p.add_argument("--negative", help="negative prompt")
    p.add_argument("--steps", type=int)
    p.add_argument("--guidance", type=float)
    p.add_argument("--size", type=int, help="square size shorthand, e.g. 1024")
    p.add_argument("--width", type=int)
    p.add_argument("--height", type=int)
    p.add_argument("--seed", type=int)
    p.add_argument("--n", type=int, default=1, help="number of images")
    p.add_argument("--out", default="./renders")
    p.add_argument("--variant", help="weight variant, e.g. fp16")
    p.add_argument("--scheduler", help="diffusers scheduler class name to override the default")
    p.add_argument("--lora", help="local path or repo id of LoRA weights to apply")
    p.add_argument("--lora-scale", type=float)
    p.add_argument("--device", choices=["mps", "cuda", "cpu"])
    p.add_argument("--dtype", choices=["bfloat16", "float16", "float32"])
    p.add_argument("--low-vram", action="store_true", help="enable attention/VAE slicing & tiling")
    p.add_argument("--pull", action="store_true", help="download the model first if not present locally")
    p.add_argument("--to", choices=["internal", "external"], help="where to pull to (with --pull)")
    p.add_argument("--list", action="store_true", help="list locally available image models and exit")
    p.add_argument("--families", action="store_true", help="show known per-family defaults and exit")
    return p


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    if args.families:
        print_families()
        return 0

    cfg = modelctl.Config.load()

    if args.list:
        rows = list_local_image_models(cfg)
        if not rows:
            print("no local image models. pull one with:  modelctl pull <repo>")
            return 0
        w = max(len(r[0]) for r in rows)
        for repo, loc, size in sorted(rows, key=lambda r: -r[2]):
            print(f"{repo.ljust(w)}  {loc.ljust(8)}  {modelctl.human(size):>8}")
        return 0

    if not args.repo or not args.prompt:
        modelctl.die("usage: image_gen.py <repo> \"<prompt>\"  (or --list / --families)")

    model_dir = modelctl.resolve(args.repo, cfg=cfg, auto_pull=args.pull, to=args.to)
    if model_dir is None:
        modelctl.die(
            f"{args.repo} not downloaded. Run with --pull, or:\n"
            f"  modelctl pull {args.repo}" + (f" --to {args.to}" if args.to else "")
        )
    if args.pull:
        print(f"note: --pull uses a plain snapshot_download (no format filtering). "
              f"For large repos, `modelctl pull {args.repo}` first is usually smaller.\n")

    preset = family_defaults(args.repo)
    device = pick_device(args.device)
    dtype = pick_dtype(device, args.dtype)
    print(f"{args.repo}\n  device={device}  dtype={dtype}  steps={args.steps or preset['steps']}  "
          f"guidance={args.guidance if args.guidance is not None else preset['guidance']}")

    pipe, dtype = load_pipeline(model_dir, device, dtype, args.variant, args.low_vram)

    if args.scheduler:
        apply_scheduler(pipe, args.scheduler)
    if args.lora:
        apply_lora(pipe, args.lora, args.lora_scale)

    t0 = time.time()
    images = generate(pipe, device, args, preset)
    elapsed = time.time() - t0

    paths = save_outputs(images, args, args.repo, preset)
    for p in paths:
        print(p)
    print(f"\n{len(paths)} image(s) in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
