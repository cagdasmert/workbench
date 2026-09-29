#!/usr/bin/env python3
"""
modelctl - a unified catalog for local Hugging Face models across two drives.

Design notes
------------
* Storage is unified, inference is not. This tool owns *where models live* and
  nothing else. Inference scripts call `resolve()` / `modelctl path` and stay
  ignorant of which drive a model is on.
* The registry is the filesystem. There is no separate database to drift out of
  sync; `ls` scans the cache roots. A small `.modelctl.json` sidecar is written
  at pull time to record pipeline_tag / revision so `ls` needs no network.
* A HF cache repo folder (`models--org--name/`) is self-contained and uses
  *relative* symlinks internally, so moving one between roots is a plain copy.
  The only wrinkle is filesystems without symlink support (exFAT/FAT32), where
  we dereference on the way out. `mv` handles this automatically.

Usage
-----
    modelctl init                          # write config, pick drives
    modelctl doctor                        # check both roots are sane
    modelctl search "flux" --task image
    modelctl pull black-forest-labs/FLUX.1-schnell --to external
    modelctl ls
    modelctl mv black-forest-labs/FLUX.1-schnell internal
    modelctl path black-forest-labs/FLUX.1-schnell
    modelctl rm black-forest-labs/FLUX.1-schnell
    modelctl serve                         # HTTP transport for GUI clients

From Python
-----------
    from modelctl import resolve
    p = resolve("black-forest-labs/FLUX.1-schnell")     # -> local snapshot dir
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    try:
        import tomli as tomllib  # type: ignore
    except ModuleNotFoundError:
        tomllib = None

CONFIG_PATH = Path(os.environ.get("MODELCTL_CONFIG", Path.home() / ".config" / "modelctl" / "config.toml"))
SIDECAR = ".modelctl.json"

# Friendly modality names -> HF pipeline tags.
TASK_ALIASES = {
    "image": "text-to-image",
    "image2image": "image-to-image",
    "video": "text-to-video",
    "image2video": "image-to-video",
    "tts": "text-to-speech",
    "stt": "automatic-speech-recognition",
    "asr": "automatic-speech-recognition",
    "text": "text-generation",
    "code": "text-generation",
    "embed": "feature-extraction",
}

# Formats that usually duplicate weights already present as .safetensors.
DUP_WEIGHT_FORMATS = ["*.bin", "*.pth", "*.ckpt", "*.msgpack", "*.h5", "*.onnx"]

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


@dataclass
class Config:
    roots: dict[str, Path]
    default: str = "internal"

    @classmethod
    def load(cls) -> "Config":
        if not CONFIG_PATH.exists():
            die(f"no config at {CONFIG_PATH}\nRun:  modelctl init")
        if tomllib is None:
            die("Python 3.11+ required (tomllib missing).")
        data = tomllib.loads(CONFIG_PATH.read_text())
        roots = {k: Path(v).expanduser() for k, v in (data.get("roots") or {}).items()}
        if not roots:
            die(f"no [roots] defined in {CONFIG_PATH}")
        return cls(roots=roots, default=data.get("default", next(iter(roots))))

    def root(self, name: str | None) -> tuple[str, Path]:
        name = name or self.default
        if name not in self.roots:
            die(f"unknown location {name!r}. known: {', '.join(self.roots)}")
        return name, self.roots[name]


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def die(msg: str, code: int = 1):
    print(f"modelctl: {msg}", file=sys.stderr)
    raise SystemExit(code)


def folder_for(repo: str) -> str:
    """black-forest-labs/FLUX.1-schnell -> models--black-forest-labs--FLUX.1-schnell"""
    return "models--" + repo.replace("/", "--")


def repo_for(folder: str) -> str:
    return folder.removeprefix("models--").replace("--", "/", 1)


def human(n: float) -> str:
    for unit in ("B", "K", "M", "G", "T"):
        if n < 1024 or unit == "T":
            return f"{n:.0f}{unit}" if unit in ("B", "K") else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}T"


def dir_size(path: Path) -> int:
    """Actual on-disk bytes. Uses `du` so hardlinks/symlinks aren't double-counted."""
    try:
        out = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, check=True)
        return int(out.stdout.split()[0]) * 1024
    except Exception:
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file() and not f.is_symlink())


def free_space(path: Path) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def supports_symlinks(root: Path) -> bool:
    """Empirical test. More reliable than guessing from filesystem name."""
    root.mkdir(parents=True, exist_ok=True)
    probe = root / f".modelctl-symlink-probe-{os.getpid()}"
    target = root / f".modelctl-symlink-target-{os.getpid()}"
    try:
        target.write_text("x")
        probe.symlink_to(target.name)
        return probe.resolve().read_text() == "x"
    except (OSError, NotImplementedError):
        return False
    finally:
        for p in (probe, target):
            try:
                p.unlink()
            except OSError:
                pass


def fs_type(path: Path) -> str:
    """Best-effort filesystem name (macOS `diskutil`, then `mount`)."""
    try:
        out = subprocess.run(
            ["diskutil", "info", "-plist", str(path)], capture_output=True, text=True, timeout=10
        )
        if out.returncode == 0:
            import plistlib

            info = plistlib.loads(out.stdout.encode())
            return info.get("FilesystemType") or info.get("FilesystemName") or "?"
    except Exception:
        pass
    try:
        out = subprocess.run(["mount"], capture_output=True, text=True, timeout=10).stdout
        best, best_len = "?", -1
        for line in out.splitlines():
            if " on " not in line:
                continue
            mp = line.split(" on ", 1)[1].split(" (")[0]
            if str(path).startswith(mp) and len(mp) > best_len:
                best_len = len(mp)
                best = line.split("(")[-1].split(",")[0].rstrip(")")
        return best
    except Exception:
        return "?"


def _hf(root: Path):
    """Import huggingface_hub with symlink support matched to `root`.

    HF reads HF_HUB_DISABLE_SYMLINKS at import time, so this must be set before
    the first import. Because it is process-global, each modelctl invocation
    targets exactly one root -- which is why pull/mv are separate commands.
    """
    if not supports_symlinks(root):
        os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
        os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    try:
        import huggingface_hub  # noqa: F401
    except ModuleNotFoundError:
        die("huggingface_hub not installed. Run:  pip install -U 'huggingface_hub[cli,hf_transfer]'")
    return huggingface_hub


def find(cfg: Config, repo: str) -> tuple[str, Path] | tuple[None, None]:
    """Locate a repo across all roots. Returns (location_name, repo_folder)."""
    folder = folder_for(repo)
    for name, root in cfg.roots.items():
        p = root / folder
        if p.is_dir():
            return name, p
    return None, None


def snapshot_dir(repo_folder: Path) -> Path | None:
    """The single usable snapshot directory inside a cache repo folder."""
    snaps = repo_folder / "snapshots"
    if not snaps.is_dir():
        return None
    candidates = sorted(
        (d for d in snaps.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True
    )
    return candidates[0] if candidates else None


def read_sidecar(repo_folder: Path) -> dict:
    p = repo_folder / SIDECAR
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


def cmd_init(args):
    internal = Path(args.internal).expanduser()
    external = Path(args.external).expanduser() if args.external else None

    # NOTE: `default` must precede [roots], or TOML nests it inside that table.
    lines = [f'default = "{args.default}"', "", "[roots]", f'internal = "{internal}"']
    if external:
        lines.append(f'external = "{external}"')
    lines.append("")

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CONFIG_PATH.exists() and not args.force:
        die(f"{CONFIG_PATH} already exists (use --force to overwrite)")
    CONFIG_PATH.write_text("\n".join(lines))
    print(f"wrote {CONFIG_PATH}")
    for p in filter(None, (internal, external)):
        p.mkdir(parents=True, exist_ok=True)
    print("\nNow run:  modelctl doctor")


def cmd_doctor(args):
    cfg = Config.load()
    print(f"config: {CONFIG_PATH}\n")
    problems = []
    for name, root in cfg.roots.items():
        exists = root.exists()
        mark = "ok " if exists else "MISSING"
        print(f"[{name}] {root}   {mark}")
        if not exists:
            problems.append(f"{name}: {root} does not exist (drive not mounted?)")
            print()
            continue
        fst = fs_type(root)
        syms = supports_symlinks(root)
        print(f"    filesystem   {fst}")
        print(f"    symlinks     {'yes' if syms else 'NO'}")
        print(f"    free space   {human(free_space(root))}")
        n = len([d for d in root.iterdir() if d.name.startswith('models--')])
        print(f"    models       {n}")
        if not syms:
            problems.append(
                f"{name}: no symlink support -> HF cache runs degraded (files duplicated, "
                f"no dedup across revisions). Reformat as APFS to fix."
            )
        if fst and fst.upper().startswith("MSDOS") or fst.upper() == "FAT32":
            problems.append(
                f"{name}: FAT32 has a 4GB per-file limit. Most video/image model weights "
                f"exceed this and downloads will fail outright. Reformat required."
            )
        print()

    if problems:
        print("issues:")
        for p in problems:
            print(f"  ! {p}")
    else:
        print("all good.")


def _effective_file_size(files: list[tuple[str, int]]) -> int:
    """Bytes that would actually land on disk after `modelctl pull` -- excludes
    redundant weight formats (.bin/.pth/.ckpt/...) when .safetensors are also
    present, mirroring pull's own dedup logic. The raw repo listing total is
    misleading here since many repos ship the same weights twice."""
    dup_suffixes = tuple(pat.lstrip("*") for pat in DUP_WEIGHT_FORMATS)  # ('.bin', '.pth', ...)
    has_safetensors = any(n.endswith(".safetensors") for n, _ in files)
    if has_safetensors:
        files = [(n, sz) for n, sz in files if not n.endswith(dup_suffixes)]
    return sum(sz for _, sz in files)


def _repo_total_size(api, repo_id: str) -> int | None:
    """Effective on-disk size for a repo (see _effective_file_size). The Hub's
    list-models endpoint doesn't return sizes at all -- that requires one
    files_metadata=True call per repo, which is why this is only done when
    --sizes/--fits is requested."""
    try:
        info = api.model_info(repo_id, files_metadata=True)
        files = [(f.rfilename, f.size or 0) for f in (info.siblings or [])]
        return _effective_file_size(files)
    except Exception:
        return None


def fetch_sizes(api, repo_ids: list[str], max_workers: int = 8) -> dict[str, int | None]:
    sizes: dict[str, int | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_repo_total_size, api, r): r for r in repo_ids}
        for fut in concurrent.futures.as_completed(futures):
            sizes[futures[fut]] = fut.result()
    return sizes


# ---------------------------------------------------------------------------
# "will this run on my machine" -- a rough capacity check, not a guarantee.
#
# This only estimates whether the model's weights will fit in memory. It does
# NOT know about quantization, CPU offloading, batch size, or context length,
# all of which can let a "NO" model run anyway (or make a "YES" model slow).
# Treat it as a first-pass filter, not a promise.
# ---------------------------------------------------------------------------

USABLE_RAM_FRACTION = 0.75  # rule of thumb: leave ~25% of unified memory for the OS/other apps
LOAD_OVERHEAD_FACTOR = 1.2  # activations/runtime overhead on top of raw weight size


def system_memory_bytes() -> int | None:
    """Total physical RAM. macOS via sysctl, Linux via /proc/meminfo."""
    try:
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip().isdigit():
            return int(out.stdout.strip())
    except Exception:
        pass
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return None


def classify_fit(size_bytes: int | None, total_ram: int | None) -> str:
    """'yes' / 'tight' / 'no' / '?' -- see module note above on what this
    does and doesn't account for."""
    if size_bytes is None or total_ram is None:
        return "?"
    needed = size_bytes * LOAD_OVERHEAD_FACTOR
    usable = total_ram * USABLE_RAM_FRACTION
    if needed <= usable:
        return "yes"
    if needed <= total_ram:
        return "tight"
    return "no"


def cmd_search(args):
    cfg = Config.load()
    hub = _hf(next(iter(cfg.roots.values())))
    api = hub.HfApi()
    tag = TASK_ALIASES.get(args.task, args.task) if args.task else None
    # `library` is expressed as a plain tag filter on the Hub (e.g. "diffusers").
    models = list(api.list_models(
        search=args.query or None,
        pipeline_tag=tag,
        filter=args.library or None,
        sort="downloads",
        limit=args.limit,
    ))
    if not models:
        print("no results")
        return

    show_sizes = args.sizes or args.fits or args.fits_only
    show_fits = args.fits or args.fits_only

    sizes = {}
    if show_sizes:
        print(f"fetching sizes for {len(models)} models (one request each)...", file=sys.stderr)
        sizes = fetch_sizes(api, [m.id for m in models])

    total_ram = system_memory_bytes() if show_fits else None
    if show_fits and total_ram is None:
        print("warning: couldn't detect system RAM -- FITS will show '?' for everything", file=sys.stderr)

    rows = []
    skipped_unknown = 0
    for m in models:
        size = sizes.get(m.id) if show_sizes else None
        fit = classify_fit(size, total_ram) if show_fits else None
        if args.fits_only and fit in ("no", "?"):
            if fit == "?":
                skipped_unknown += 1
            continue
        row = [m.id, m.pipeline_tag or "-", f"{(m.downloads or 0):,}", str(m.likes or 0)]
        if show_sizes:
            row.append(human(size) if size is not None else "?")
        if show_fits:
            row.append(fit)
        rows.append(row)

    if not rows:
        print("no results fit your machine's RAM (or size/fit couldn't be determined)")
        return

    w = max(len(r[0]) for r in rows)
    t = max(len(r[1]) for r in rows)
    header = f"{'REPO'.ljust(w)}  {'TASK'.ljust(t)}  {'DOWNLOADS':>12}  LIKES"
    if show_sizes:
        header += "  SIZE"
    if show_fits:
        header += "  FITS"
    print(header)
    for r in rows:
        line = f"{r[0].ljust(w)}  {r[1].ljust(t)}  {r[2]:>12}  {r[3]}"
        idx = 4
        if show_sizes:
            line += f"  {r[idx]:>8}"
            idx += 1
        if show_fits:
            line += f"  {r[idx]:>5}"
        print(line)

    if show_fits:
        gb = lambda b: b / 1024**3
        note = f"\nFITS is a rough estimate: weight size vs. {USABLE_RAM_FRACTION:.0%} of your RAM"
        if total_ram:
            note += f" ({gb(total_ram):.0f}GB total)"
        note += ". It doesn't know about quantization, CPU offload, or context length."
        print(note)
        if args.fits_only and skipped_unknown:
            print(f"({skipped_unknown} model(s) hidden -- size couldn't be determined)")

    print("\npull with:  modelctl pull <REPO> --to external")


def cmd_info(args):
    cfg = Config.load()
    hub = _hf(next(iter(cfg.roots.values())))
    info = hub.HfApi().model_info(args.repo, files_metadata=True)
    total = 0
    files = []
    for f in info.siblings or []:
        size = f.size or 0
        total += size
        files.append((size, f.rfilename))
    print(f"{info.id}")
    print(f"  task       {info.pipeline_tag or '-'}")
    print(f"  library    {info.library_name or '-'}")
    print(f"  downloads  {(info.downloads or 0):,}")
    print(f"  gated      {info.gated or False}")
    print(f"  total size {human(total)}  ({len(files)} files)")
    print("\n  largest files:")
    for size, name in sorted(files, reverse=True)[:12]:
        print(f"    {human(size):>8}  {name}")
    loc, folder = find(cfg, args.repo)
    print(f"\n  local      {loc + ': ' + str(folder) if loc else 'not downloaded'}")


def cmd_pull(args):
    cfg = Config.load()
    name, root = cfg.root(args.to)
    if not root.exists():
        die(f"{name} root {root} is not available (drive not mounted?)")

    existing_loc, _ = find(cfg, args.repo)
    if existing_loc and existing_loc != name and not args.force:
        die(f"already present in {existing_loc!r}. Use `modelctl mv {args.repo} {name}` instead.")

    hub = _hf(root)
    if not supports_symlinks(root):
        print(f"note: {name} has no symlink support -> downloading in degraded (duplicated) mode\n")

    # Many repos ship the same weights in several formats. Skipping the
    # redundant ones roughly halves the download -- but ONLY when safetensors
    # actually exist, otherwise we'd silently fetch a model with no weights.
    info = None
    try:
        info = hub.HfApi().model_info(args.repo, revision=args.revision)
    except Exception:
        pass

    ignore = args.exclude
    if ignore is None:
        names = [f.rfilename for f in (info.siblings or [])] if info else []
        has_safetensors = any(n.endswith(".safetensors") for n in names)
        ignore = DUP_WEIGHT_FORMATS if (has_safetensors and not args.all) else []
        if ignore:
            print(f"skipping redundant weight formats ({', '.join(ignore)}); use --all to keep them\n")

    def _download():
        return hub.snapshot_download(
            repo_id=args.repo,
            revision=args.revision,
            cache_dir=str(root),
            allow_patterns=args.include or None,
            ignore_patterns=ignore or None,
            max_workers=args.workers,
        )

    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    try:
        path = _download()
    except Exception as e:  # hf_transfer is optional; retry without it
        if "hf_transfer" in str(e):
            os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
            path = _download()
        else:
            raise

    repo_folder = root / folder_for(args.repo)
    meta = {"repo": args.repo, "revision": args.revision or "main", "pulled_at": int(time.time())}
    if info is not None:
        meta["pipeline_tag"] = info.pipeline_tag
        meta["library"] = info.library_name
    try:
        (repo_folder / SIDECAR).write_text(json.dumps(meta, indent=2))
    except OSError:
        pass

    print(f"\n{args.repo}  ->  [{name}]  {human(dir_size(repo_folder))}")
    print(path)


def cmd_ls(args):
    cfg = Config.load()
    rows = []
    for name, root in cfg.roots.items():
        if not root.exists():
            print(f"[{name}] {root}  -- unavailable", file=sys.stderr)
            continue
        for d in sorted(root.iterdir()):
            if not d.name.startswith("models--") or not d.is_dir():
                continue
            repo = repo_for(d.name)
            if args.filter and args.filter.lower() not in repo.lower():
                continue
            meta = read_sidecar(d)
            task = meta.get("pipeline_tag") or "-"
            if args.task and TASK_ALIASES.get(args.task, args.task) != task:
                continue
            rows.append((repo, name, task, dir_size(d)))

    if not rows:
        print("no models")
        return
    rows.sort(key=lambda r: -r[3])
    w = max(len(r[0]) for r in rows)
    t = max(max(len(r[2]) for r in rows), 4)
    print(f"{'REPO'.ljust(w)}  {'WHERE'.ljust(8)}  {'TASK'.ljust(t)}  {'SIZE':>8}")
    for repo, loc, task, size in rows:
        print(f"{repo.ljust(w)}  {loc.ljust(8)}  {task.ljust(t)}  {human(size):>8}")
    print(f"\n{len(rows)} models, {human(sum(r[3] for r in rows))} total")


def cmd_path(args):
    cfg = Config.load()
    p = resolve(args.repo, cfg=cfg)
    if p is None:
        die(f"{args.repo} not downloaded. Run:  modelctl pull {args.repo}")
    print(p)


def _rsync(src: Path, dst: Path, dereference: bool, exclude_blobs: bool) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsync"):
        cmd = ["rsync", "-a", "--info=progress2"]
        if dereference:
            cmd.append("-L")
        if exclude_blobs:
            cmd += ["--exclude", "blobs/***"]
        cmd += [str(src) + "/", str(dst) + "/"]
        subprocess.run(cmd, check=True)
    else:
        ignore = shutil.ignore_patterns("blobs") if exclude_blobs else None
        shutil.copytree(src, dst, symlinks=not dereference, ignore=ignore, dirs_exist_ok=True)


def cmd_mv(args):
    cfg = Config.load()
    dest_name, dest_root = cfg.root(args.to)
    src_name, src_folder = find(cfg, args.repo)
    if src_name is None:
        die(f"{args.repo} not found in any root")
    if src_name == dest_name:
        print(f"already in {dest_name}")
        return
    if not dest_root.exists():
        die(f"{dest_name} root {dest_root} is not available (drive not mounted?)")

    dst_folder = dest_root / folder_for(args.repo)
    if dst_folder.exists():
        die(f"{dst_folder} already exists -- resolve manually")

    dest_symlinks = supports_symlinks(dest_root)
    size = dir_size(src_folder)
    if free_space(dest_root) < size * 1.05:
        die(f"not enough space on {dest_name}: need ~{human(size)}, have {human(free_space(dest_root))}")

    if dest_symlinks:
        print(f"{args.repo}: {src_name} -> {dest_name}  ({human(size)})")
        _rsync(src_folder, dst_folder, dereference=False, exclude_blobs=False)
    else:
        print(
            f"{args.repo}: {src_name} -> {dest_name}  ({human(size)})\n"
            f"  {dest_name} has no symlink support: materialising snapshot files, dropping blobs/"
        )
        _rsync(src_folder, dst_folder, dereference=True, exclude_blobs=True)
        (dst_folder / "blobs").mkdir(exist_ok=True)

    # Verify before deleting the source.
    src_snap, dst_snap = snapshot_dir(src_folder), snapshot_dir(dst_folder)
    if src_snap is None or dst_snap is None:
        die(f"copy looks wrong (no snapshot dir at {dst_folder}); source left intact")
    src_files = {f.relative_to(src_snap) for f in src_snap.rglob("*") if not f.is_dir()}
    dst_files = {f.relative_to(dst_snap) for f in dst_snap.rglob("*") if not f.is_dir()}
    missing = src_files - dst_files
    if missing:
        die(f"copy incomplete, {len(missing)} files missing (e.g. {sorted(missing)[0]}); source left intact")

    if args.keep:
        print(f"\ncopied, source kept at {src_folder}")
        return
    try:
        shutil.rmtree(src_folder)
    except OSError as e:
        # Copy is verified good; only cleanup failed. Never leave the user
        # thinking the move failed when their data is safely at the destination.
        print(
            f"\ncopy to {dst_folder} succeeded and was verified, but the source "
            f"could not be removed:\n  {e}\nDelete it manually:  rm -rf {src_folder!s}",
            file=sys.stderr,
        )
        return
    print(f"\ndone. now at {dst_folder}")


def cmd_rm(args):
    cfg = Config.load()
    loc, folder = find(cfg, args.repo)
    if loc is None:
        die(f"{args.repo} not found")
    size = dir_size(folder)
    if not args.yes:
        ans = input(f"delete {args.repo} from {loc} ({human(size)})? [y/N] ").strip().lower()
        if ans != "y":
            print("aborted")
            return
    shutil.rmtree(folder)
    print(f"deleted {args.repo} ({human(size)} freed on {loc})")


def _ollama_list() -> list[str]:
    """Model tags known to Ollama, if it's installed."""
    if not shutil.which("ollama"):
        return []
    try:
        out = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return []
        return [ln.split()[0] for ln in out.stdout.splitlines()[1:] if ln.strip()]
    except Exception:
        return []


def cmd_export(args):
    """Snapshot the catalog so it can be rebuilt after a reformat.

    Models are reproducible artifacts -- the *list* is the thing worth backing
    up, not the bytes. This is the cheap insurance before erasing a drive.
    """
    cfg = Config.load()
    entries = []
    for name, root in cfg.roots.items():
        if not root.exists():
            print(f"warning: {name} root {root} unavailable, skipping", file=sys.stderr)
            continue
        for d in sorted(root.iterdir()):
            if not d.name.startswith("models--") or not d.is_dir():
                continue
            meta = read_sidecar(d)
            rev = meta.get("revision")
            ref = d / "refs" / "main"
            if not rev and ref.exists():
                try:
                    rev = ref.read_text().strip()
                except OSError:
                    rev = None
            entries.append({
                "repo": repo_for(d.name),
                "location": name,
                "revision": rev or "main",
                "pipeline_tag": meta.get("pipeline_tag"),
                "size_bytes": dir_size(d),
            })
    doc = {
        "exported_at": int(time.time()),
        "hf_models": entries,
        "ollama_models": _ollama_list(),
    }
    text = json.dumps(doc, indent=2)
    if args.output:
        Path(args.output).expanduser().write_text(text)
        total = sum(e["size_bytes"] for e in entries)
        print(f"wrote {args.output}")
        print(f"  {len(entries)} HF models ({human(total)}), {len(doc['ollama_models'])} Ollama models")
        print("\nKeep this file on your INTERNAL disk, not the drive you're about to erase.")
    else:
        print(text)


def cmd_restore(args):
    cfg = Config.load()
    doc = json.loads(Path(args.manifest).expanduser().read_text())
    hf_models = doc.get("hf_models", [])
    ollama_models = doc.get("ollama_models", [])

    todo = []
    for e in hf_models:
        if find(cfg, e["repo"])[0] is not None:
            continue
        todo.append(e)

    total = sum(e.get("size_bytes") or 0 for e in todo)
    print(f"{len(todo)} HF models to re-download (~{human(total)} on disk)")
    for e in todo:
        print(f"  {e['repo']}  ->  {args.to or e['location']}")
    if ollama_models:
        print(f"\n{len(ollama_models)} Ollama models: {', '.join(ollama_models)}")
    if args.dry_run:
        print("\n(dry run, nothing downloaded)")
        return
    if not args.yes:
        if input("\nproceed? [y/N] ").strip().lower() != "y":
            print("aborted")
            return

    failed = []
    for e in todo:
        print(f"\n=== {e['repo']} ===")
        try:
            cmd_pull(argparse.Namespace(
                repo=e["repo"], to=args.to or e["location"], revision=None,
                include=None, exclude=None, all=False, workers=8, force=False,
            ))
        except SystemExit:
            failed.append(e["repo"])
        except Exception as exc:
            print(f"failed: {exc}", file=sys.stderr)
            failed.append(e["repo"])

    for tag in ollama_models:
        print(f"\n=== ollama pull {tag} ===")
        if subprocess.run(["ollama", "pull", tag]).returncode != 0:
            failed.append(f"ollama:{tag}")

    if failed:
        print(f"\n{len(failed)} failed: {', '.join(failed)}", file=sys.stderr)
    else:
        print("\nrestore complete.")


# ---------------------------------------------------------------------------
# python API -- this is what your inference scripts should use
def cmd_serve(args):
    """Serve the catalog over loopback HTTP so GUI tools can drive it.

    The implementation lives in modelctld.py, imported lazily: it is a
    transport, not part of the catalog, and nothing here should pay its import
    cost. Read operations there call the helpers in this file; pull/mv/rm are
    run back through this CLI as subprocesses, so the daemon can never drift
    from what `modelctl` actually does.
    """
    import modelctld

    modelctld.serve(host=args.host, port=args.port, token=args.token)


# ---------------------------------------------------------------------------


def resolve(repo: str, cfg: Config | None = None, auto_pull: bool = False, to: str | None = None) -> str | None:
    """Return the local snapshot directory for `repo`, wherever it lives.

    Inference scripts should call this instead of hardcoding paths, so a model
    can move between drives without touching any script:

        pipe = DiffusionPipeline.from_pretrained(resolve("org/model"))
    """
    cfg = cfg or Config.load()
    loc, folder = find(cfg, repo)
    if folder is None:
        if not auto_pull:
            return None
        name, root = cfg.root(to)
        hub = _hf(root)
        return hub.snapshot_download(repo_id=repo, cache_dir=str(root))
    snap = snapshot_dir(folder)
    return str(snap) if snap else None


# ---------------------------------------------------------------------------


def main(argv=None):
    p = argparse.ArgumentParser(prog="modelctl", description=__doc__.split("\n")[1])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="create the config file")
    s.add_argument("--internal", default="~/.cache/huggingface/hub")
    s.add_argument("--external", help="e.g. /Volumes/MYDRIVE/hf-cache")
    s.add_argument("--default", default="internal")
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("doctor", help="check both roots are usable")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("search", help="search the Hub")
    s.add_argument("query", nargs="?")
    s.add_argument("--task", help="image|video|tts|stt|text|code or a raw pipeline tag")
    s.add_argument("--library", help="e.g. diffusers, transformers")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--sizes", action="store_true",
                   help="also show total size per model (one extra request each, slower)")
    s.add_argument("--fits", action="store_true",
                   help="add a FITS column estimating whether the model fits your RAM (implies --sizes)")
    s.add_argument("--fits-only", action="store_true",
                   help="only show models likely to fit your RAM (implies --fits)")
    s.set_defaults(func=cmd_search)

    s = sub.add_parser("info", help="show remote size + file breakdown")
    s.add_argument("repo")
    s.set_defaults(func=cmd_info)

    s = sub.add_parser("pull", help="download a model to a given drive")
    s.add_argument("repo")
    s.add_argument("--to", help="internal|external (default from config)")
    s.add_argument("--revision")
    s.add_argument("--include", nargs="*", help="glob patterns to include, e.g. '*.safetensors'")
    s.add_argument("--exclude", nargs="*", help="glob patterns to skip")
    s.add_argument("--all", action="store_true",
                   help="keep redundant weight formats (.bin/.ckpt/...) instead of skipping them")
    s.add_argument("--workers", type=int, default=8)
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_pull)

    s = sub.add_parser("ls", help="list local models across all drives")
    s.add_argument("filter", nargs="?")
    s.add_argument("--task")
    s.set_defaults(func=cmd_ls)

    s = sub.add_parser("path", help="print the local snapshot dir for a repo")
    s.add_argument("repo")
    s.set_defaults(func=cmd_path)

    s = sub.add_parser("mv", help="move a model between drives")
    s.add_argument("repo")
    s.add_argument("to", help="internal|external")
    s.add_argument("--keep", action="store_true", help="copy instead of move")
    s.set_defaults(func=cmd_mv)

    s = sub.add_parser("rm", help="delete a local model")
    s.add_argument("repo")
    s.add_argument("-y", "--yes", action="store_true")
    s.set_defaults(func=cmd_rm)

    s = sub.add_parser("export", help="snapshot the catalog to JSON (do this before reformatting)")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("restore", help="re-download everything listed in an export file")
    s.add_argument("manifest")
    s.add_argument("--to", help="override target location for all models")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("-y", "--yes", action="store_true")
    s.set_defaults(func=cmd_restore)

    s = sub.add_parser("serve", help="serve the catalog over loopback HTTP (for GUI clients)")
    s.add_argument("--host", default="127.0.0.1",
                   help="bind address; leave on loopback unless you also set --token")
    s.add_argument("--port", type=int, default=8077)
    s.add_argument("--token", default=os.environ.get("MODELCTL_TOKEN", ""),
                   help="require this value in the X-Modelctl-Token header")
    s.set_defaults(func=cmd_serve)

    args = p.parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
