#!/usr/bin/env python3
"""
asr - speech to text for models in the modelctl catalog.

Runs mlx-whisper or parakeet-mlx over an audio or video file and prints the
transcript, or writes it as JSON with --out, which is how modelctld runs it.
Like image_gen.py it never hardcodes a model path: `modelctl.resolve()` says
where the weights currently live, so `modelctl mv` never breaks it.

Importing this module is cheap on purpose. The capability table, validation
and markdown rendering are plain functions at the top level so modelctld can
call them in-process -- a bad request is refused before a job exists. The MLX
runtimes are imported inside the functions that need them.

Usage
-----
    .venv/bin/python asr.py memo.m4a                        # turbo, detect language
    .venv/bin/python asr.py memo.m4a --language tr
    .venv/bin/python asr.py talk.mp4 --model mlx-community/parakeet-tdt-0.6b-v3 --language en
    .venv/bin/python asr.py memo.m4a --out result.json      # what modelctld runs
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"

# The 25 European languages parakeet-tdt-0.6b-v3 was trained on. Anything else
# -- Turkish is the one that matters here -- does not error: it comes back as
# plausible, confidently wrong words. So the check runs before a job starts.
PARAKEET_V3_LANGUAGES = frozenset({
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
    "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
})

# repo -> the only languages it can transcribe, or None for "whatever Whisper
# knows". Mirrored in workbench/plugins/transcribe/src/capabilities.ts -- change
# the two together.
LANGUAGES: dict[str, frozenset[str] | None] = {
    "mlx-community/whisper-large-v3-turbo": None,
    "mlx-community/whisper-large-v3-mlx": None,
    "mlx-community/parakeet-tdt-0.6b-v3": PARAKEET_V3_LANGUAGES,
}

_FRONTMATTER_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


class AsrError(Exception):
    """A request asr.py cannot run. The message is written for the user."""


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class Transcript:
    text: str
    segments: tuple[Segment, ...]
    language: str | None
    duration: float
    model: str

    def to_json(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in self.segments],
            "language": self.language,
            "duration": self.duration,
            "model": self.model,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Transcript:
        return cls(
            text=str(d["text"]),
            segments=tuple(Segment(float(s["start"]), float(s["end"]), str(s["text"]))
                           for s in d["segments"]),
            language=None if d.get("language") is None else str(d["language"]),
            duration=float(d["duration"]),
            model=str(d["model"]),
        )


@dataclass(frozen=True)
class Probe:
    path: str
    name: str
    size: int
    duration: float | None
    has_audio: bool


# ---------------------------------------------------------------------------
# pure
# ---------------------------------------------------------------------------


def runtime_for(repo: str) -> str:
    """'whisper' or 'parakeet', by repo name -- the two families asr.py runs."""
    name = repo.lower()
    if "parakeet" in name:
        return "parakeet"
    if "whisper" in name:
        return "whisper"
    raise AsrError(f"{repo} is not a Whisper or Parakeet model, so asr.py cannot run it")


def check_language(repo: str, language: str) -> str | None:
    """Why `repo` cannot transcribe `language`, or None when it can.

    'auto' always passes: the model detects within its own set, and only the
    caller knows what the audio contains. The panel warns about that case.
    """
    if language == "auto":
        return None
    supported = LANGUAGES.get(repo)
    if supported is None or language in supported:
        return None
    return (f"{repo} cannot transcribe '{language}' -- it returns plausible wrong "
            f"words instead of failing. Use {DEFAULT_MODEL}.")


def format_timestamp(seconds: float) -> str:
    """mm:ss under an hour, h:mm:ss past it."""
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def render_markdown(
    t: Transcript,
    *,
    title: str,
    source: str,
    transcribed: date,
    timestamps: bool = True,
    extra: dict[str, Any] | None = None,
) -> str:
    """The saved note: YAML front matter, a heading, one paragraph per segment.

    Values are JSON-encoded, which is valid YAML and quotes anything a
    transcript can throw at it. Caller keys extend the fixed ones, never
    replace them.
    """
    fields: dict[str, Any] = {
        "title": title,
        "source": source,
        "model": t.model,
        "language": t.language or "unknown",
        "duration": round(t.duration),
        "transcribed": transcribed.isoformat(),
    }
    for key, value in (extra or {}).items():
        if not isinstance(key, str) or not _FRONTMATTER_KEY.match(key):
            raise AsrError(f"front matter key {key!r} must be a plain identifier")
        if not isinstance(value, (str, int, float, bool)):
            raise AsrError(f"front matter value for {key!r} must be a string, number or boolean")
        fields.setdefault(key, value)

    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fields.items()]
    lines += ["---", "", f"# {title}", ""]
    for s in t.segments:
        text = s.text.strip()
        if text:
            lines += [f"[{format_timestamp(s.start)}] {text}" if timestamps else text, ""]
    return "\n".join(lines)


def safe_filename(name: str) -> str:
    """One path component ending in .md -- separators become '-'."""
    cleaned = re.sub(r"[/\\:\x00]", "-", name).strip().lstrip(".").strip()
    if not cleaned:
        raise AsrError("filename is empty")
    return cleaned if cleaned.lower().endswith(".md") else f"{cleaned}.md"


def default_filename(source: Path, day: date) -> str:
    return safe_filename(f"{day.isoformat()} {source.stem}")


# ---------------------------------------------------------------------------
# io
# ---------------------------------------------------------------------------


def write_new(directory: Path, filename: str, text: str) -> Path:
    """Write `text` into `directory` without ever overwriting.

    A taken name gets -2, -3, ... before the extension. Exclusive create makes
    that race-free: two saves of the same job cannot land on one file.
    """
    stem, suffix = Path(filename).stem, Path(filename).suffix
    for n in range(1, 1000):
        candidate = directory / (filename if n == 1 else f"{stem}-{n}{suffix}")
        try:
            with candidate.open("x", encoding="utf-8") as f:
                f.write(text)
            return candidate
        except FileExistsError:
            continue
    raise AsrError(f"{directory} already holds 999 files named like {filename}")


def ffmpeg_missing() -> str | None:
    """Both runtimes decode through ffmpeg; say so before a job, not after."""
    missing = [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]
    if not missing:
        return None
    return f"{' and '.join(missing)} not found on PATH -- install with: brew install ffmpeg"


def probe(path: Path) -> Probe:
    """Size, duration and whether there is any audio to transcribe."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise AsrError(f"ffprobe could not read {path.name}: {e}") from e
    if out.returncode != 0:
        detail = out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "ffprobe failed"
        raise AsrError(f"{path.name} is not a readable audio or video file ({detail})")
    info = json.loads(out.stdout or "{}")
    raw = info.get("format", {}).get("duration")
    return Probe(
        path=str(path),
        name=path.name,
        size=path.stat().st_size,
        duration=float(raw) if raw not in (None, "N/A") else None,
        has_audio=any(s.get("codec_type") == "audio" for s in info.get("streams", [])),
    )


def transcribe(
    audio: Path,
    model_dir: Path,
    *,
    repo: str,
    language: str,
    on_progress: Callable[[float], None] | None = None,
) -> Transcript:
    """Run whichever runtime `repo` belongs to over `audio`.

    `on_progress(percent)` fires as audio is consumed. mlx-whisper exposes no
    callback, only its own tqdm bar, so for Whisper the bar is left on stderr
    and the caller (modelctld) parses the percentage out of it like any other.
    """
    info = probe(audio)
    if not info.has_audio:
        raise AsrError(f"{audio.name} has no audio stream")
    duration = info.duration or 0.0
    if runtime_for(repo) == "parakeet":
        return _parakeet(audio, model_dir, repo=repo, language=language,
                         duration=duration, on_progress=on_progress)
    return _whisper(audio, model_dir, repo=repo, language=language, duration=duration)


def _whisper(audio: Path, model_dir: Path, *, repo: str, language: str, duration: float) -> Transcript:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        str(audio),
        path_or_hf_repo=str(model_dir),
        verbose=False,          # False (not None) is what turns the progress bar on
        language=None if language == "auto" else language,
    )
    segments = tuple(Segment(float(s["start"]), float(s["end"]), str(s["text"]))
                     for s in result.get("segments", []))
    return Transcript(text=str(result.get("text", "")).strip(), segments=segments,
                      language=result.get("language"), duration=duration, model=repo)


def _parakeet(audio: Path, model_dir: Path, *, repo: str, language: str, duration: float,
              on_progress: Callable[[float], None] | None) -> Transcript:
    from parakeet_mlx import from_pretrained

    model = from_pretrained(str(model_dir))

    def chunk(current: float, total: float) -> None:
        if on_progress is not None and total > 0:
            on_progress(min(100.0, 100.0 * current / total))

    # Two-minute chunks with overlap keep a two-hour file at a flat memory cost.
    result = model.transcribe(str(audio), chunk_duration=120.0, overlap_duration=15.0,
                              chunk_callback=chunk)
    segments = tuple(Segment(float(s.start), float(s.end), str(s.text)) for s in result.sentences)
    # Parakeet takes no language argument; report what was asked, if anything.
    return Transcript(text=str(result.text).strip(), segments=segments,
                      language=None if language == "auto" else language,
                      duration=duration, model=repo)


# ---------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    import modelctl as mc

    p = argparse.ArgumentParser(prog="asr", description="speech to text over the modelctl catalog")
    p.add_argument("audio", type=Path, help="audio or video file")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"repo id (default {DEFAULT_MODEL})")
    p.add_argument("--language", default="auto", help="ISO code, or 'auto' to detect")
    p.add_argument("--out", type=Path, help="write the transcript as JSON here instead of printing it")
    args = p.parse_args(argv)

    def progress(percent: float) -> None:
        print(f"{percent:3.0f}%", flush=True)

    try:
        runtime_for(args.model)
        problem = check_language(args.model, args.language) or ffmpeg_missing()
        if problem:
            raise AsrError(problem)
        audio = args.audio.expanduser().resolve()
        if not audio.is_file():
            raise AsrError(f"no such file: {audio}")
        model_dir = mc.resolve(args.model)
        if model_dir is None:
            raise AsrError(f"{args.model} is not downloaded -- modelctl pull {args.model}")
        print(f"transcribing {audio.name} with {args.model}", flush=True)
        t = transcribe(audio, Path(model_dir), repo=args.model, language=args.language,
                       on_progress=progress)
    except AsrError as e:
        # The daemon surfaces a failed job's last line verbatim, so this line
        # is the error the user sees.
        print(f"error: {e}", file=sys.stderr, flush=True)
        return 1

    if args.out is not None:
        args.out.write_text(json.dumps(t.to_json(), ensure_ascii=False), encoding="utf-8")
        print(f"done: {len(t.segments)} segments, {len(t.text)} chars", flush=True)
    else:
        print(t.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
