#!/usr/bin/env python3
"""
modelctld - an HTTP transport in front of `modelctl`.

Why this exists
---------------
The Workbench app hosts utilities as plugins, and a plugin there may not import
Node builtins or spawn a process -- every privileged capability is brokered by
the host. The one broker that already exists and already reaches a local server
is `net.fetch` (that is how the `ai-provider` plugin talks to LM Studio and
Ollama). So the cheapest possible seam between a GUI and this catalog is a
loopback HTTP server, and no change to Workbench's frozen plugin contract.

Design notes
------------
* **This file is transport, not logic.** Read operations call modelctl's own
  helpers in-process. Everything that mutates the catalog -- pull, mv, rm -- is
  run as `python modelctl.py ...` in a subprocess and its output streamed into a
  job record. That is deliberate: the CLI stays the single implementation, the
  daemon cannot drift from it, and a download that dies takes a subprocess with
  it rather than the server.
* **Long operations are jobs, not requests.** The plugin SDK has no streaming
  primitive, so a pull returns a job id immediately and the client polls
  `/v1/jobs/<id>`. Progress is parsed out of the CLI's own output.
* **Loopback only, and no browser may reach it.** Bound to 127.0.0.1, and any
  request carrying `Origin` or `Referer` is refused -- those headers are exactly
  what a browser adds and what Electron's main process does not, which makes a
  drive-by POST from a web page fail without needing CORS to be understood
  correctly. `--token` adds a shared secret on top when you want one.
* **`/v1/index/*` is the vault index.** embed.py is imported in-process for
  the store and change scan (stdlib only); embedding runs as an `embed` job,
  one per model, like a pull. The daemon never imports torch.
* **`/v1/generate/*` is where runtime scripts mount.** `asr`, `text` and `image` are
  live. Each script is imported in-process to validate a request (cheap -- MLX
  loads only in the subprocess), then run as a job like a pull. `image` jobs run
  one at a time, whatever the model. The rest answer 501 until their scripts
  exist; the namespace was claimed early so clients never reshaped.

Usage
-----
    modelctl serve                        # 127.0.0.1:8077
    modelctl serve --port 9000 --token s3cret
    .venv/bin/python modelctld.py         # equivalent, no CLI indirection
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import asr  # noqa: E402  -- cheap: validation and rendering only, MLX loads in the subprocess
import text as textgen  # noqa: E402  -- cheap: validation only, mlx_lm loads in the subprocess
import embed  # noqa: E402  -- cheap: chunker and store are stdlib; torch loads in the subprocess
import image as imagegen  # noqa: E402  -- cheap: families and validation; mflux loads in the subprocess
import modelctl as mc  # noqa: E402

DEFAULT_PORT = 8077
MAX_JOB_LINES = 400
JOB_RETENTION = 50          # finished jobs kept before the oldest is dropped
MODELCTL_PY = str(Path(__file__).resolve().parent / "modelctl.py")
ASR_PY = str(Path(__file__).resolve().parent / "asr.py")
EMBED_PY = str(Path(__file__).resolve().parent / "embed.py")
TEXT_PY = str(Path(__file__).resolve().parent / "text.py")
IMAGE_PY = str(Path(__file__).resolve().parent / "image.py")
IMAGE_FILE_MAX = 50 * 1024 * 1024   # the full image travels as base64 in JSON (C3)

VERSION = "1.0.0"


class ApiError(Exception):
    """Anything the client did wrong, or the catalog couldn't do."""

    def __init__(self, message: str, status: int = 400, hint: str | None = None):
        super().__init__(message)
        self.status = status
        self.hint = hint


# ---------------------------------------------------------------------------
# jobs
# ---------------------------------------------------------------------------

# tqdm/hf_transfer emit "42%|####  |" and rsync "  1,234,567  42%  1.2MB/s"; one
# pattern covers both because all we want is the last percentage printed.
PERCENT_RE = re.compile(r"(\d{1,3})%")


class Job:
    def __init__(self, kind: str, repo: str, argv: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.repo = repo
        self.argv = argv
        self.state = "running"
        self.started = time.time()
        self.finished: float | None = None
        self.exit_code: int | None = None
        self.percent: float | None = None
        self.error: str | None = None
        self.params: dict = {}              # what the job was asked to do, for a panel re-attaching
        self.result: dict | None = None     # structured output, for kinds that produce one
        self.lines: deque[str] = deque(maxlen=MAX_JOB_LINES)
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    def as_dict(self, include_log: bool = True) -> dict:
        with self._lock:
            d = {
                "id": self.id,
                "kind": self.kind,
                "repo": self.repo,
                "state": self.state,
                "started": self.started,
                "finished": self.finished,
                "elapsed": (self.finished or time.time()) - self.started,
                "exit_code": self.exit_code,
                "percent": self.percent,
                "error": self.error,
                "params": self.params,
            }
            if include_log:
                # The list view stays light: a two-hour transcript is only
                # sent when one job is asked for by id.
                d["log"] = list(self.lines)
                d["result"] = self.result
            else:
                d["last_line"] = self.lines[-1] if self.lines else ""
            return d

    def cancel(self) -> bool:
        with self._lock:
            proc, running = self._proc, self.state == "running"
        if proc is None or not running:
            return False
        proc.terminate()
        return True


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: deque[str] = deque()
        self._lock = threading.Lock()

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

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise ApiError(f"no job {job_id}", status=404)
        return job

    def all(self) -> list[Job]:
        with self._lock:
            return [self._jobs[i] for i in reversed(self._order)]

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


JOBS = JobStore()


def start_job(kind: str, repo: str, args: list[str], *, script: str = MODELCTL_PY,
              params: dict | None = None, result_path: Path | None = None,
              exclusive_kind: bool = False) -> Job:
    """Run `<script> <args>` in the background, streaming output into a Job.

    One job per repo at a time: two concurrent pulls of the same model into
    different roots is the one way to corrupt a cache folder, and it is far
    easier to refuse it here than to unpick it afterwards. For generation the
    repo is the model, so the same rule stops two runs thrashing one model's
    memory -- and stops a run while that model is being moved.

    `result_path`, when given, is a file the script writes its structured
    result to. It is loaded into `job.result` on exit 0 and always deleted:
    a transcript is too big, and too structured, to scrape out of the log.

    `exclusive_kind` also refuses the job while any job of the same kind runs,
    whatever its repo. Image generation needs this: two different image models
    resident together swap on 48 GB, which the per-repo rule alone allows.
    """
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

    def run() -> None:
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        try:
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            )
        except (OSError, ValueError) as e:
            # ValueError is Popen's own response to a NUL byte in argv
            # ("embedded null byte") -- validation should have caught it
            # earlier, but a job must still fail cleanly rather than wedge in
            # 'running' forever if one slips through (F1).
            if result_path is not None:
                result_path.unlink(missing_ok=True)
            with job._lock:
                job.state, job.error, job.finished = "failed", str(e), time.time()
            return

        with job._lock:
            job._proc = proc

        assert proc.stdout is not None
        for raw in _iter_progress_lines(proc.stdout):
            line = raw.rstrip()
            if not line:
                continue
            with job._lock:
                job.lines.append(line)
                m = PERCENT_RE.findall(line)
                if m:
                    job.percent = min(100.0, float(m[-1]))
        code = proc.wait()
        result, result_error = None, None
        if code == 0 and result_path is not None:
            try:
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                result_error = f"{Path(script).name} exited 0 but left no result ({e})"
        if result_path is not None:
            result_path.unlink(missing_ok=True)
        with job._lock:
            job.exit_code = code
            job.finished = time.time()
            if code == 0 and result_error is None:
                job.state, job.percent, job.result = "done", 100.0, result
            elif code < 0:
                job.state, job.error = "cancelled", "cancelled"
            else:
                job.state = "failed"
                # The script's own last words are a far better error than
                # "exit code 1" -- surface them verbatim.
                job.error = result_error or (job.lines[-1] if job.lines else f"exit code {code}")

    threading.Thread(target=run, daemon=True).start()
    return job


def _iter_progress_lines(stream):
    """Split on \\r as well as \\n.

    Progress bars rewrite one line with carriage returns; iterating the stream
    normally yields nothing until the bar finishes, which makes a 40-minute
    download look frozen.
    """
    buf = ""
    while True:
        chunk = stream.read(1)
        if not chunk:
            break
        if chunk in ("\r", "\n"):
            if buf:
                yield buf
            buf = ""
        else:
            buf += chunk
    if buf:
        yield buf


# ---------------------------------------------------------------------------
# read handlers -- these call modelctl in-process
# ---------------------------------------------------------------------------


def _cfg() -> mc.Config:
    try:
        return mc.Config.load()
    except SystemExit as e:
        raise ApiError(
            f"modelctl is not configured ({mc.CONFIG_PATH})",
            status=503,
            hint="run `modelctl init` once",
        ) from e


def h_health() -> dict:
    try:
        cfg = _cfg()
        roots = {k: str(v) for k, v in cfg.roots.items()}
        default = cfg.default
        configured = True
    except ApiError:
        roots, default, configured = {}, None, False
    return {
        "ok": True,
        "service": "modelctld",
        "version": VERSION,
        "configured": configured,
        "config_path": str(mc.CONFIG_PATH),
        "roots": roots,
        "default": default,
    }


def h_models(q: dict) -> dict:
    cfg = _cfg()
    name_filter = _one(q, "filter", "").lower()
    task = _one(q, "task", "")
    tag = mc.TASK_ALIASES.get(task, task) if task else None

    models, unavailable = [], []
    for name, root in cfg.roots.items():
        if not root.exists():
            unavailable.append(name)
            continue
        for d in sorted(root.iterdir()):
            if not d.name.startswith("models--") or not d.is_dir():
                continue
            repo = mc.repo_for(d.name)
            if name_filter and name_filter not in repo.lower():
                continue
            meta = mc.read_sidecar(d)
            model_task = meta.get("pipeline_tag") or None
            if tag and model_task != tag:
                continue
            size = mc.dir_size(d)
            models.append({
                "repo": repo,
                "location": name,
                "task": model_task,
                "library": meta.get("library"),
                "revision": meta.get("revision"),
                "pulled_at": meta.get("pulled_at"),
                "size": size,
                "size_human": mc.human(size),
                "path": str(d),
            })
    models.sort(key=lambda m: -m["size"])
    return {
        "models": models,
        "total_size": sum(m["size"] for m in models),
        "unavailable_roots": unavailable,
    }


def h_doctor() -> dict:
    cfg = _cfg()
    roots, problems = [], []
    for name, root in cfg.roots.items():
        if not root.exists():
            roots.append({"name": name, "path": str(root), "mounted": False})
            problems.append(f"{name}: {root} does not exist (drive not mounted?)")
            continue
        fst = mc.fs_type(root)
        syms = mc.supports_symlinks(root)
        free = mc.free_space(root)
        count = len([d for d in root.iterdir() if d.name.startswith("models--")])
        roots.append({
            "name": name,
            "path": str(root),
            "mounted": True,
            "filesystem": fst,
            "symlinks": syms,
            "free": free,
            "free_human": mc.human(free),
            "models": count,
            "is_default": name == cfg.default,
        })
        if not syms:
            problems.append(
                f"{name}: no symlink support -> HF cache runs degraded "
                f"(files duplicated, no dedup). Reformat as APFS to fix."
            )
        if fst.upper().startswith("MSDOS") or fst.upper() == "FAT32":
            problems.append(
                f"{name}: FAT32 has a 4GB per-file limit. Most model weights "
                f"exceed this and downloads fail outright."
            )
    ram = mc.system_memory_bytes()
    return {
        "config_path": str(mc.CONFIG_PATH),
        "roots": roots,
        "problems": problems,
        "system_ram": ram,
        "system_ram_human": mc.human(ram) if ram else None,
    }


def h_search(q: dict) -> dict:
    cfg = _cfg()
    query = _one(q, "q", "")
    task = _one(q, "task", "")
    library = _one(q, "library", "")
    limit = _int(q, "limit", 20, lo=1, hi=100)
    want_sizes = _bool(q, "sizes") or _bool(q, "fits")
    want_fits = _bool(q, "fits")

    hub = mc._hf(next(iter(cfg.roots.values())))
    api = hub.HfApi()
    tag = mc.TASK_ALIASES.get(task, task) if task else None
    try:
        found = list(api.list_models(
            search=query or None,
            pipeline_tag=tag,
            filter=library or None,
            sort="downloads",
            limit=limit,
        ))
    except Exception as e:
        raise ApiError(f"Hub search failed: {e}", status=502,
                       hint="check the network, or `hf auth login` for gated repos") from e

    sizes = mc.fetch_sizes(api, [m.id for m in found]) if want_sizes else {}
    ram = mc.system_memory_bytes() if want_fits else None
    local = {m["repo"]: m["location"] for m in h_models({})["models"]}

    results = []
    for m in found:
        size = sizes.get(m.id) if want_sizes else None
        results.append({
            "repo": m.id,
            "task": m.pipeline_tag,
            "downloads": m.downloads or 0,
            "likes": m.likes or 0,
            "size": size,
            "size_human": mc.human(size) if size is not None else None,
            "fits": mc.classify_fit(size, ram) if want_fits else None,
            "local": local.get(m.id),
        })
    return {
        "results": results,
        "system_ram": ram,
        # Repeat the caveat the CLI prints. A GUI makes a green "yes" look far
        # more authoritative than it is.
        "fits_note": (
            "Rough estimate: weight size x1.2 against 75% of system RAM. Knows "
            "nothing about quantization, CPU offload, or context length."
        ) if want_fits else None,
    }


def h_info(q: dict) -> dict:
    cfg = _cfg()
    repo = _required(q, "repo")
    hub = mc._hf(next(iter(cfg.roots.values())))
    try:
        info = hub.HfApi().model_info(repo, files_metadata=True)
    except Exception as e:
        raise ApiError(f"{repo}: {e}", status=502) from e

    files = [{"name": f.rfilename, "size": f.size or 0} for f in (info.siblings or [])]
    files.sort(key=lambda f: -f["size"])
    total = sum(f["size"] for f in files)
    effective = mc._effective_file_size([(f["name"], f["size"]) for f in files])
    loc, folder = mc.find(cfg, repo)
    ram = mc.system_memory_bytes()
    return {
        "repo": info.id,
        "task": info.pipeline_tag,
        "library": info.library_name,
        "downloads": info.downloads or 0,
        "gated": bool(info.gated),
        "total_size": total,
        "total_size_human": mc.human(total),
        # What `pull` would actually fetch, once redundant weight formats are
        # skipped. Usually the number the user cares about.
        "effective_size": effective,
        "effective_size_human": mc.human(effective),
        "fits": mc.classify_fit(effective, ram),
        "file_count": len(files),
        "largest_files": files[:12],
        "local": {"location": loc, "path": str(folder)} if loc else None,
    }


def h_path(q: dict) -> dict:
    cfg = _cfg()
    repo = _required(q, "repo")
    p = mc.resolve(repo, cfg=cfg)
    if p is None:
        raise ApiError(f"{repo} is not downloaded", status=404,
                       hint=f"POST /v1/catalog/pull with {{\"repo\": \"{repo}\"}}")
    return {"repo": repo, "path": p}


# ---------------------------------------------------------------------------
# write handlers -- these shell out to the CLI
# ---------------------------------------------------------------------------


def h_pull(body: dict) -> dict:
    repo = _required(body, "repo")
    args = ["pull", repo]
    if body.get("to"):
        args += ["--to", str(body["to"])]
    if body.get("revision"):
        args += ["--revision", str(body["revision"])]
    if body.get("all"):
        args.append("--all")
    if body.get("force"):
        args.append("--force")
    return start_job("pull", repo, args).as_dict()


def h_mv(body: dict) -> dict:
    repo = _required(body, "repo")
    to = _required(body, "to")
    args = ["mv", repo, str(to)]
    if body.get("keep"):
        args.append("--keep")
    return start_job("mv", repo, args).as_dict()


def h_rm(body: dict) -> dict:
    repo = _required(body, "repo")
    # -y always: the confirmation belongs in the UI, where the user can see the
    # size, not on a stdin the daemon has no way to answer.
    return start_job("rm", repo, ["rm", repo, "-y"]).as_dict()


# ---------------------------------------------------------------------------
# generate/asr -- validated in-process, run as an asr.py subprocess
# ---------------------------------------------------------------------------


def _abs_file(raw: str) -> Path:
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise ApiError(f"path must be absolute, got {raw!r}")
    if not p.is_file():
        raise ApiError(f"no such file: {p}")
    return p


def _need_ffmpeg() -> None:
    problem = asr.ffmpeg_missing()
    if problem:
        raise ApiError(problem, status=503, hint="brew install ffmpeg, then restart modelctl serve")


def h_asr_probe(q: dict) -> dict:
    path = _abs_file(_required(q, "path"))
    _need_ffmpeg()
    try:
        info = asr.probe(path)
    except asr.AsrError as e:
        raise ApiError(str(e)) from None
    return {"path": info.path, "name": info.name, "size": info.size,
            "duration": info.duration, "has_audio": info.has_audio}


def h_asr(body: dict) -> dict:
    path = _abs_file(_required(body, "path"))
    repo = str(body.get("model") or asr.DEFAULT_MODEL)
    language = str(body.get("language") or "auto")
    try:
        asr.runtime_for(repo)
    except asr.AsrError as e:
        raise ApiError(str(e)) from None
    problem = asr.check_language(repo, language)
    if problem:
        raise ApiError(problem, hint=f'send "model": "{asr.DEFAULT_MODEL}"')
    _need_ffmpeg()
    if mc.resolve(repo, cfg=_cfg()) is None:
        raise ApiError(f"{repo} is not downloaded", status=404,
                       hint=f"POST /v1/catalog/pull with {{\"repo\": \"{repo}\"}}")

    fd, out = tempfile.mkstemp(prefix="modelctld-asr-", suffix=".json")
    os.close(fd)
    try:
        job = start_job("asr", repo,
                        [str(path), "--model", repo, "--language", language, "--out", out],
                        script=ASR_PY, params={"path": str(path), "language": language},
                        result_path=Path(out))
    except ApiError:
        Path(out).unlink(missing_ok=True)   # 409: nothing will ever read it
        raise
    return job.as_dict()


def h_asr_save(body: dict) -> dict:
    job = JOBS.get(_required(body, "job_id"))
    if job.kind != "asr" or job.state != "done" or job.result is None:
        raise ApiError(f"job {job.id} is not a finished transcription ({job.kind}, {job.state})",
                       status=409)
    folder = Path(_required(body, "dir")).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise ApiError(f"dir must be an existing absolute folder, got {str(folder)!r}")
    extra = body.get("frontmatter") or {}
    if not isinstance(extra, dict):
        raise ApiError("frontmatter must be an object")

    source = Path(str(job.params.get("path", "transcript")))
    today = date.today()
    try:
        if body.get("filename"):
            filename = asr.safe_filename(str(body["filename"]))
            title = Path(filename).stem
        else:
            filename, title = asr.default_filename(source, today), source.stem
        text = asr.render_markdown(
            asr.Transcript.from_json(job.result), title=title, source=str(source),
            transcribed=today, timestamps=body.get("timestamps", True) is not False, extra=extra,
        )
        written = asr.write_new(folder, filename, text)
    except asr.AsrError as e:
        raise ApiError(str(e)) from None
    return {"path": str(written)}


# ---------------------------------------------------------------------------
# generate/text -- validated in-process, run as a text.py subprocess
# ---------------------------------------------------------------------------


def h_text(body: dict) -> dict:
    try:
        messages = textgen.validate_messages(body.get("messages"))
    except textgen.TextError as e:
        raise ApiError(str(e)) from None
    repo = str(body.get("model") or textgen.DEFAULT_MODEL)
    max_tokens = body.get("max_tokens", textgen.DEFAULT_MAX_TOKENS)
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or not 1 <= max_tokens <= 8192:
        raise ApiError(f"max_tokens must be an integer between 1 and 8192, got {max_tokens!r}")
    if mc.resolve(repo, cfg=_cfg()) is None:
        raise ApiError(f"{repo} is not downloaded", status=404,
                       hint=f"POST /v1/catalog/pull with {{\"repo\": \"{repo}\"}}")

    # Messages go through a file: a prompt with six passages is too long for argv.
    fd, msgs = tempfile.mkstemp(prefix="modelctld-text-in-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False)
    fd, out = tempfile.mkstemp(prefix="modelctld-text-", suffix=".json")
    os.close(fd)
    try:
        job = start_job("text", repo,
                        ["--model", repo, "--messages", msgs, "--consume", "--max-tokens", str(max_tokens),
                         "--out", out],
                        script=TEXT_PY, params={"model": repo, "max_tokens": max_tokens},
                        result_path=Path(out))
    except ApiError:
        Path(out).unlink(missing_ok=True)
        Path(msgs).unlink(missing_ok=True)
        raise
    # text.py deletes the messages file once read (--consume): the prompt quotes
    # private notes, and the daemon has no hook for when the subprocess starts.
    return job.as_dict()


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
    if imagegen.model_dir(req.model, lambda repo: mc.resolve(repo, cfg=_cfg())) is None:
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


def h_image_file(q: dict) -> dict:
    """The full-resolution image, for Send to viewer and the before/after view."""
    raw = _required(q, "path")
    try:
        path = imagegen.expand_path(raw)
    except imagegen.ImageError as e:
        raise ApiError(str(e)) from None
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
    try:
        source = imagegen.expand_path(raw)
        folder = imagegen.expand_path(_required(body, "dir"))
    except imagegen.ImageError as e:
        raise ApiError(str(e)) from None
    if not source.is_absolute() or source.suffix.lower() not in imagegen.MIME_TYPES:
        raise ApiError(f"path must be an absolute PNG, JPEG or WebP file, got {raw!r}")
    if not source.is_file():
        raise ApiError(f"no such file: {source}", status=404)
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


# ---------------------------------------------------------------------------
# index -- the vault index; reads in-process, embedding as an embed.py job
# ---------------------------------------------------------------------------


def _abs_dir(raw: str) -> Path:
    p = Path(raw).expanduser()
    if not p.is_absolute() or not p.is_dir():
        raise ApiError(f"path must be an existing absolute folder, got {raw!r}")
    return p


def _patterns(body: dict, key: str, default: tuple[str, ...]) -> tuple[str, ...]:
    v = body.get(key)
    if v is None:
        return default
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise ApiError(f"{key} must be a list of glob strings")
    return tuple(v)


def _chunk_size(body: dict, default: int) -> int:
    v = body.get("chunk_size", default)
    if not isinstance(v, int) or isinstance(v, bool) or not 32 <= v <= 8192:
        raise ApiError(f"chunk_size must be an integer between 32 and 8192, got {v!r}")
    return v


def _start_index(names: list[str], model: str, full: bool) -> dict:
    if mc.resolve(model, cfg=_cfg()) is None:
        raise ApiError(f"{model} is not downloaded", status=404,
                       hint=f"POST /v1/catalog/pull with {{\"repo\": \"{model}\"}}")
    fd, out = tempfile.mkstemp(prefix="modelctld-embed-", suffix=".json")
    os.close(fd)
    args = ["index", *(a for n in names for a in ("--folder", n)), "--db", str(embed.index_path()),
            "--out", out, *(["--full"] if full else [])]
    try:
        job = start_job("embed", model, args, script=EMBED_PY,
                        params={"folders": names, "full": full}, result_path=Path(out))
    except ApiError:
        Path(out).unlink(missing_ok=True)
        raise
    return job.as_dict()


def h_index_add(body: dict) -> dict:
    path = _abs_dir(_required(body, "path"))
    spec = embed.FolderSpec(
        name=str(body.get("name") or path.name), path=str(path),
        model=str(body.get("model") or embed.DEFAULT_MODEL),
        chunk_size=_chunk_size(body, embed.DEFAULT_CHUNK_SIZE),
        include=_patterns(body, "include", embed.DEFAULT_INCLUDE),
        exclude=_patterns(body, "exclude", embed.DEFAULT_EXCLUDE))
    if mc.resolve(spec.model, cfg=_cfg()) is None:
        raise ApiError(f"{spec.model} is not downloaded", status=404,
                       hint=f"POST /v1/catalog/pull with {{\"repo\": \"{spec.model}\"}}")
    conn = embed.connect()
    try:
        existing = embed.get_folder(conn, spec.name)
        if existing and existing.path != spec.path:
            raise ApiError(f"a folder named {spec.name!r} already indexes {existing.path}",
                           status=409, hint='send a different "name"')
        if existing and (existing.model, existing.chunk_size) != (spec.model, spec.chunk_size):
            raise ApiError(f"{spec.name} is indexed with {existing.model} at {existing.chunk_size} "
                           "tokens", status=409,
                           hint="POST /v1/index/refresh with full: true to rebuild it")
        embed.upsert_folder(conn, spec)
    finally:
        conn.close()
    return _start_index([spec.name], spec.model, full=False)


def h_index_list() -> dict:
    conn = embed.connect()
    try:
        return {"folders": embed.list_folders(conn)}
    finally:
        conn.close()


def h_index_refresh(body: dict) -> dict:
    full = body.get("full") is True
    conn = embed.connect()
    try:
        if body.get("name"):
            spec = embed.get_folder(conn, str(body["name"]))
            if spec is None:
                raise ApiError(f"no indexed folder named {body['name']!r}", status=404)
            specs = [spec]
        else:
            specs = [embed.get_folder(conn, r["name"]) for r in
                     conn.execute("SELECT name FROM folders ORDER BY name")]
            specs = [s for s in specs if s is not None]
            if not specs:
                raise ApiError("no folders are indexed", status=404,
                               hint="POST /v1/index/folders with a path first")
        model = str(body.get("model") or specs[0].model)
        wanted = [(s, model, _chunk_size(body, s.chunk_size)) for s in specs]
        stale = [s.name for s, m, c in wanted if (s.model, s.chunk_size) != (m, c)]
        if stale and not full:
            raise ApiError(f"{', '.join(stale)} was indexed with other settings", status=409,
                           hint="send full: true to re-embed everything with the new ones")
        for s, m, c in wanted:
            if (s.model, s.chunk_size) != (m, c):
                embed.upsert_folder(conn, embed.FolderSpec(s.name, s.path, m, c, s.include, s.exclude))
    finally:
        conn.close()
    return _start_index([s.name for s in specs], model, full=full)


def h_index_delete(name: str) -> dict:
    for job in JOBS.all():
        if job.kind == "embed" and job.state == "running" and name in job.params.get("folders", []):
            raise ApiError(f"{name} is being indexed", status=409,
                           hint=f"cancel job {job.id} first")
    conn = embed.connect()
    try:
        if not embed.delete_folder(conn, name):
            raise ApiError(f"no indexed folder named {name!r}", status=404)
    finally:
        conn.close()
    return {"ok": True}


# ---------------------------------------------------------------------------
# search -- a persistent embed.py worker, so a query does not pay a model load
# ---------------------------------------------------------------------------


class EmbedWorker:
    """One long-lived `embed.py serve` subprocess speaking JSON lines.

    Started on the first call, respawned on the call after it dies, and never
    imported: torch lives in the worker, so a crash costs one failed search,
    not the server. The worker exits on its own after idling, which reads here
    as an ordinary death and is healed by the next call. Calls are serialized
    -- the model is one resource, and a search takes milliseconds."""

    def __init__(self, argv: list[str]) -> None:
        self.argv = argv
        self._proc: subprocess.Popen[str] | None = None
        self._stderr: deque[str] = deque(maxlen=50)
        self._lock = threading.Lock()

    def _spawn(self) -> subprocess.Popen[str]:
        proc = subprocess.Popen(
            self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env={**os.environ, "PYTHONUNBUFFERED": "1"})
        stderr = self._stderr

        def drain() -> None:
            assert proc.stderr is not None
            with proc.stderr:
                for line in proc.stderr:
                    if line.strip():
                        stderr.append(line.rstrip())

        threading.Thread(target=drain, daemon=True).start()
        return proc

    @staticmethod
    def _close(proc: subprocess.Popen[str]) -> None:
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def call(self, req: dict) -> dict:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._stderr.clear()
                self._proc = self._spawn()
            proc = self._proc
            assert proc.stdin is not None and proc.stdout is not None
            try:
                proc.stdin.write(json.dumps(req) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
            except (BrokenPipeError, OSError):
                line = ""
            if not line:
                proc.wait(timeout=5)
                self._close(proc)
                self._proc = None
                time.sleep(0.05)   # let the drain thread catch the last words
                last = self._stderr[-1] if self._stderr else f"exit code {proc.returncode}"
                raise ApiError(f"the search worker exited: {last}", status=503,
                               hint="retry -- it restarts on the next request")
            return json.loads(line)

    def stop(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
            if self._proc is not None:
                self._close(self._proc)
            self._proc = None


_WORKER: EmbedWorker | None = None


def _worker() -> EmbedWorker:
    # Built on first use, so the index path is read after any env override.
    global _WORKER
    if _WORKER is None:
        _WORKER = EmbedWorker([sys.executable, EMBED_PY, "serve", "--db", str(embed.index_path())])
    return _WORKER


def _ask_worker(req: dict) -> dict:
    reply = _worker().call(req)
    if not reply.get("ok"):
        raise ApiError(str(reply.get("error") or "the search worker refused the request"),
                       status=int(reply.get("status") or 500), hint=reply.get("hint"))
    reply.pop("ok", None)
    return reply


def _str_list(body: dict, key: str) -> list[str] | None:
    v = body.get(key)
    if v is None:
        return None
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise ApiError(f"{key} must be a list of strings")
    return v


def h_search(body: dict) -> dict:
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ApiError("query must be a non-empty string")
    limit = body.get("limit", 8)
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ApiError(f"limit must be an integer, got {limit!r}")
    req: dict = {"op": "search", "query": query, "limit": limit}
    per_note = body.get("per_note")
    if per_note is not None:
        if not isinstance(per_note, int) or isinstance(per_note, bool):
            raise ApiError(f"per_note must be an integer, got {per_note!r}")
        req["per_note"] = per_note
    folders = _str_list(body, "folders")
    if folders is not None:
        req["folders"] = folders
    return _ask_worker(req)


def h_embed(body: dict) -> dict:
    texts = _str_list(body, "texts")
    if not texts or len(texts) > 256:
        raise ApiError("texts must be a list of 1 to 256 strings")
    req: dict = {"op": "embed", "texts": texts}
    if body.get("model"):
        req["model"] = str(body["model"])
    return _ask_worker(req)


# ---------------------------------------------------------------------------
# tiny param helpers
# ---------------------------------------------------------------------------


def _one(q: dict, key: str, default: str = "") -> str:
    v = q.get(key)
    if isinstance(v, list):
        return v[0] if v else default
    return default if v is None else str(v)


def _required(q: dict, key: str) -> str:
    v = _one(q, key)
    if not v:
        raise ApiError(f"missing required parameter {key!r}")
    return v


def _int(q: dict, key: str, default: int, lo: int, hi: int) -> int:
    raw = _one(q, key)
    if not raw:
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError:
        raise ApiError(f"{key} must be a number, got {raw!r}") from None


def _bool(q: dict, key: str) -> bool:
    return _one(q, key).lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# server
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = f"modelctld/{VERSION}"
    token = ""

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:  # noqa: N802
        # Deliberately no CORS headers. Nothing that should reach this server
        # is a browser, so a preflight failing is the system working.
        self._send(204, None)

    def _dispatch(self, method: str) -> None:
        try:
            self._guard()
            url = urlparse(self.path)
            parts = [p for p in url.path.strip("/").split("/") if p]
            query = parse_qs(url.query)
            body = self._read_body() if method == "POST" else {}
            payload = self._route(method, parts, query, body)
            self._send(200, payload)
        except ApiError as e:
            self._send(e.status, {"error": str(e), **({"hint": e.hint} if e.hint else {})})
        except SystemExit as e:
            # modelctl's `die()` raises SystemExit. In a CLI that is correct; in
            # a request handler it would silently kill the thread, so it becomes
            # an error response instead.
            self._send(500, {"error": str(e) or "modelctl exited"})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def _guard(self) -> None:
        if self.headers.get("Origin") or self.headers.get("Referer"):
            raise ApiError(
                "requests carrying Origin/Referer are refused",
                status=403,
                hint="this daemon is for local tools, not web pages",
            )
        if Handler.token and self.headers.get("X-Modelctl-Token") != Handler.token:
            raise ApiError("bad or missing X-Modelctl-Token", status=401)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ApiError(f"body is not valid JSON: {e}") from None
        if not isinstance(parsed, dict):
            raise ApiError("body must be a JSON object")
        return parsed

    def _route(self, method: str, parts: list[str], q: dict, body: dict):
        if not parts or parts[0] != "v1":
            raise ApiError("unknown route -- everything lives under /v1", status=404)
        rest = parts[1:]

        if method == "GET" and rest == ["health"]:
            return h_health()

        if rest[:1] == ["catalog"]:
            leaf = rest[1:]
            if method == "GET":
                if leaf == ["models"]:
                    return h_models(q)
                if leaf == ["doctor"]:
                    return h_doctor()
                if leaf == ["search"]:
                    return h_search(q)
                if leaf == ["info"]:
                    return h_info(q)
                if leaf == ["path"]:
                    return h_path(q)
            if method == "POST":
                if leaf == ["pull"]:
                    return h_pull(body)
                if leaf == ["mv"]:
                    return h_mv(body)
                if leaf == ["rm"]:
                    return h_rm(body)

        if rest[:1] == ["jobs"]:
            if method == "GET" and len(rest) == 1:
                return {"jobs": [j.as_dict(include_log=False) for j in JOBS.all()]}
            if method == "GET" and len(rest) == 2:
                return JOBS.get(rest[1]).as_dict()
            if method == "POST" and len(rest) == 3 and rest[2] == "cancel":
                job = JOBS.get(rest[1])
                if not job.cancel():
                    raise ApiError(f"job {job.id} is not running", status=409)
                return {"cancelling": job.id}

        if method == "POST" and rest == ["search"]:
            return h_search(body)
        if method == "POST" and rest == ["embed"]:
            return h_embed(body)

        if rest[:1] == ["index"]:
            leaf = rest[1:]
            if leaf == ["folders"] and method == "GET":
                return h_index_list()
            if leaf == ["folders"] and method == "POST":
                return h_index_add(body)
            if leaf == ["refresh"] and method == "POST":
                return h_index_refresh(body)
            if len(leaf) == 2 and leaf[0] == "folders" and method == "DELETE":
                return h_index_delete(unquote(leaf[1]))
            # net.fetch has no DELETE, so the plugin removes through this.
            if len(leaf) == 3 and leaf[0] == "folders" and leaf[2] == "remove" and method == "POST":
                return h_index_delete(unquote(leaf[1]))

        if rest[:2] == ["generate", "asr"]:
            leaf = rest[2:]
            if method == "GET" and leaf == ["probe"]:
                return h_asr_probe(q)
            if method == "POST" and leaf == []:
                return h_asr(body)
            if method == "POST" and leaf == ["save"]:
                return h_asr_save(body)

        if rest[:2] == ["generate", "image"]:
            leaf = rest[2:]
            if method == "GET" and leaf == ["models"]:
                return h_image_models()
            if method == "GET" and leaf == ["file"]:
                return h_image_file(q)
            if method == "POST" and leaf == []:
                return h_image("generate", body)
            if method == "POST" and leaf in (["edit"], ["upscale"]):
                return h_image(leaf[0], body)
            if method == "POST" and leaf == ["save"]:
                return h_image_save(body)

        if method == "POST" and rest == ["generate", "text"]:
            return h_text(body)

        if rest[:1] == ["generate"]:
            raise ApiError(
                "no runtime is wired up for this /v1/generate route yet",
                status=501,
                hint=("asr, text and image are live; tts and the rest mount under "
                      "/v1/generate/* as their scripts land"),
            )

        raise ApiError(f"unknown route {method} /{'/'.join(parts)}", status=404)

    def _send(self, status: int, payload: dict | None) -> None:
        data = b"" if payload is None else json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        if os.environ.get("MODELCTLD_QUIET"):
            return
        sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")


def serve(host: str = "127.0.0.1", port: int = DEFAULT_PORT, token: str = "") -> None:
    Handler.token = token
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"modelctld {VERSION} on http://{host}:{port}")
    print(f"  config   {mc.CONFIG_PATH}")
    print(f"  token    {'required' if token else 'none (loopback only)'}")
    print("  routes   /v1/health  /v1/catalog/{models,doctor,search,info,path}")
    print("           /v1/catalog/{pull,mv,rm} (POST)  /v1/jobs[/<id>]")
    print("           /v1/generate/asr (POST)  /v1/generate/asr/probe  /v1/generate/asr/save (POST)")
    print("           /v1/generate/image[/edit|/upscale] (POST)  /v1/generate/image/models")
    print("           /v1/generate/image/file  /v1/generate/image/save (POST)")
    print("           /v1/index/folders[/<name>] (GET, POST, DELETE)  /v1/index/folders/<name>/remove (POST)")
    print("           /v1/index/refresh (POST)")
    print("           /v1/search (POST)  /v1/embed (POST)")
    print("\nCtrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        httpd.server_close()
        if _WORKER is not None:
            _WORKER.stop()


def main(argv=None) -> None:
    import argparse

    p = argparse.ArgumentParser(prog="modelctld", description="HTTP transport for modelctl")
    p.add_argument("--host", default="127.0.0.1",
                   help="bind address (default 127.0.0.1 -- do not widen without a token)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--token", default=os.environ.get("MODELCTL_TOKEN", ""),
                   help="require this value in X-Modelctl-Token")
    args = p.parse_args(argv)
    serve(args.host, args.port, args.token)


if __name__ == "__main__":
    main()
