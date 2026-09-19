# Transcribe M1 — the wire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/v1/generate/asr` answers instead of 501: probe a file, transcribe it as a polled job, save the result as markdown — verified with `curl` on a Turkish memo.

**Architecture:** A new flat runtime script `asr.py` beside `modelctl.py` owns the capability table, validation, markdown rendering and the two MLX runtimes (imported lazily, so the daemon can import the module in-process for validation). `modelctld.py` stays transport: its job runner learns to run a script other than `modelctl.py` and to load a result file on exit 0, and three routes are added.

**Tech Stack:** Python 3.12 (stdlib `http.server`, `unittest`), `mlx-whisper`, `parakeet-mlx`, `ffmpeg`/`ffprobe` (Homebrew).

**Spec:** `docs/superpowers/specs/2026-09-11-transcribe-design.md` (deltas over the vault PRD `02_Projects/Huggingface/PRD/P1-transcribe.md`).

## Global Constraints

- Daemon repo: `~/work/tools/huggingface/` — flat scripts, **not** a git repo; no commits there.
- `asr.py` stays one file importing `modelctl` (MANUAL § *Adding the next runtime script*). House Python rules apply inside it: frozen dataclasses out, no `print` outside `main`, raise `AsrError` instead of exiting, no module-level side effects, MLX imported inside functions.
- Tests are stdlib `unittest` under `tests/` — no new dependency. Run: `.venv/bin/python -m unittest discover -s tests -t . -v`.
- Default model: `mlx-community/whisper-large-v3-turbo`.
- Every generation runs as a subprocess; the daemon only validates, spawns, and renders/writes saves.
- Refuse to overwrite: `name.md`, `name-2.md`, … via exclusive create.
- Loopback guard, token check and error shape (`{error, hint?}`) are unchanged.

## Files

| File | Change | Responsibility |
|---|---|---|
| `asr.py` | create | capability table, validation, markdown, probe, runtimes, CLI |
| `modelctld.py` | modify | `Job.params/result`, `start_job(script=, result_path=)`, 3 routes |
| `tests/__init__.py` | create | makes `tests` importable for `-t .` |
| `tests/test_asr.py` | create | pure functions of `asr.py` |
| `tests/test_modelctld_asr.py` | create | result channel + route validation, no weights |
| workbench `docs/m1-shell-change-log.md` | append | entry 32 |

---

### Task 1: `asr.py` pure core

**Files:** Create `asr.py`, `tests/__init__.py`, `tests/test_asr.py`

**Interfaces — Produces:**
- `DEFAULT_MODEL: str`, `LANGUAGES: dict[str, frozenset[str] | None]`, `PARAKEET_V3_LANGUAGES`
- `class AsrError(Exception)`
- `Segment(start: float, end: float, text: str)`, `Transcript(text, segments: tuple[Segment, ...], language: str | None, duration: float, model: str)` with `to_json() -> dict` / `Transcript.from_json(d) -> Transcript`
- `runtime_for(repo) -> 'whisper' | 'parakeet'` (raises `AsrError`)
- `check_language(repo, language) -> str | None`
- `format_timestamp(seconds) -> str`
- `render_markdown(t, *, title, source, transcribed: date, timestamps=True, extra=None) -> str` (raises `AsrError` on a bad extra key/value)
- `safe_filename(name) -> str`, `default_filename(source: Path, day: date) -> str`
- `write_new(directory: Path, filename: str, text: str) -> Path`

- [ ] **Step 1: Write the failing tests** — `tests/__init__.py` empty; `tests/test_asr.py`:

```python
from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

import asr

TURBO = "mlx-community/whisper-large-v3-turbo"
PARAKEET = "mlx-community/parakeet-tdt-0.6b-v3"


def _t(*segments: tuple[float, float, str], language: str | None = "tr") -> asr.Transcript:
    segs = tuple(asr.Segment(s, e, x) for s, e, x in segments)
    return asr.Transcript(text=" ".join(s.text for s in segs), segments=segs,
                          language=language, duration=segs[-1].end if segs else 0.0, model=TURBO)


class RuntimeTest(unittest.TestCase):
    def test_families_by_name(self) -> None:
        self.assertEqual(asr.runtime_for(TURBO), "whisper")
        self.assertEqual(asr.runtime_for(PARAKEET), "parakeet")

    def test_unknown_family_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            asr.runtime_for("black-forest-labs/FLUX.1-schnell")


class LanguageTest(unittest.TestCase):
    def test_parakeet_refuses_turkish_and_names_the_fix(self) -> None:
        problem = asr.check_language(PARAKEET, "tr")
        self.assertIsNotNone(problem)
        assert problem is not None
        self.assertIn(asr.DEFAULT_MODEL, problem)

    def test_parakeet_accepts_its_own_languages(self) -> None:
        self.assertIsNone(asr.check_language(PARAKEET, "en"))
        self.assertIsNone(asr.check_language(PARAKEET, "de"))

    def test_auto_always_passes(self) -> None:
        self.assertIsNone(asr.check_language(PARAKEET, "auto"))

    def test_whisper_takes_anything(self) -> None:
        self.assertIsNone(asr.check_language(TURBO, "tr"))

    def test_unlisted_repo_is_not_second_guessed(self) -> None:
        self.assertIsNone(asr.check_language("someone/whisper-small-mlx", "tr"))


class TimestampTest(unittest.TestCase):
    def test_under_an_hour(self) -> None:
        self.assertEqual(asr.format_timestamp(0), "00:00")
        self.assertEqual(asr.format_timestamp(83.9), "01:23")

    def test_past_an_hour(self) -> None:
        self.assertEqual(asr.format_timestamp(3725), "1:02:05")

    def test_negative_clamps(self) -> None:
        self.assertEqual(asr.format_timestamp(-1), "00:00")


class TranscriptJsonTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        t = _t((0, 1.5, " Merhaba"), (1.5, 3.0, " dünya"))
        self.assertEqual(asr.Transcript.from_json(t.to_json()), t)


class MarkdownTest(unittest.TestCase):
    def _render(self, **kw: object) -> str:
        t = _t((0, 2, " Merhaba dünya. "), (65, 70, "İkinci cümle."), (70, 71, "   "))
        return asr.render_markdown(t, title="memo", source="/a/memo.m4a",
                                   transcribed=date(2026, 9, 11), **kw)  # type: ignore[arg-type]

    def test_front_matter_is_json_quoted_yaml(self) -> None:
        md = self._render()
        head = md.split("---")[1]
        self.assertIn('title: "memo"', head)
        self.assertIn('source: "/a/memo.m4a"', head)
        self.assertIn('language: "tr"', head)
        self.assertIn("duration: 71", head)
        self.assertIn('transcribed: "2026-09-11"', head)
        self.assertTrue(md.startswith("---\n"))

    def test_timestamps_on(self) -> None:
        md = self._render()
        self.assertIn("# memo", md)
        self.assertIn("[00:00] Merhaba dünya.", md)
        self.assertIn("[01:05] İkinci cümle.", md)

    def test_blank_segments_are_dropped(self) -> None:
        self.assertEqual(self._render().count("["), 2)

    def test_timestamps_off(self) -> None:
        md = self._render(timestamps=False)
        self.assertIn("\nMerhaba dünya.\n", md)
        self.assertNotIn("[00:00]", md)

    def test_extra_keys_cannot_override_fixed_ones(self) -> None:
        md = self._render(extra={"model": "evil", "tags": "voice-memo"})
        self.assertIn(f'model: "{TURBO}"', md)
        self.assertNotIn("evil", md)
        self.assertIn('tags: "voice-memo"', md)

    def test_bad_extra_key_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            self._render(extra={"a: b\nc": "x"})

    def test_non_scalar_extra_value_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            self._render(extra={"tags": ["a", "b"]})


class FilenameTest(unittest.TestCase):
    def test_default_is_dated_stem(self) -> None:
        self.assertEqual(asr.default_filename(Path("/x/Voice 012.m4a"), date(2026, 9, 11)),
                         "2026-09-11 Voice 012.md")

    def test_separators_and_leading_dots_are_neutralised(self) -> None:
        self.assertEqual(asr.safe_filename("../a/b:c"), "-a-b-c.md")

    def test_md_suffix_is_not_doubled(self) -> None:
        self.assertEqual(asr.safe_filename("notes.MD"), "notes.MD")

    def test_empty_is_refused(self) -> None:
        with self.assertRaises(asr.AsrError):
            asr.safe_filename(" .. ")


class WriteNewTest(unittest.TestCase):
    def test_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            first = asr.write_new(Path(d), "memo.md", "one")
            second = asr.write_new(Path(d), "memo.md", "two")
            third = asr.write_new(Path(d), "memo.md", "three")
            self.assertEqual([first.name, second.name, third.name], ["memo.md", "memo-2.md", "memo-3.md"])
            self.assertEqual(first.read_text(encoding="utf-8"), "one")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/work/tools/huggingface && .venv/bin/python -m unittest discover -s tests -t . -v`
Expected: `ModuleNotFoundError: No module named 'asr'`

- [ ] **Step 3: Implement** — create `asr.py` with the module docstring, constants, `AsrError`, the three dataclasses (`Segment`, `Transcript`, `Probe`) and the pure functions listed above. Exact code:

```python
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
```

- [ ] **Step 4: Run to verify pass** — same command. Expected: all `test_asr` tests OK.

---

### Task 2: `asr.py` runtimes, probe and CLI

**Files:** Modify `asr.py` (append after `write_new`)

**Interfaces — Consumes:** Task 1. **Produces:**
- `ffmpeg_missing() -> str | None`
- `probe(path: Path) -> Probe` (raises `AsrError`)
- `transcribe(audio: Path, model_dir: Path, *, repo: str, language: str, on_progress: Callable[[float], None] | None = None) -> Transcript` — `on_progress(percent)`
- CLI `asr.py AUDIO [--model REPO] [--language CODE|auto] [--out FILE]`; prints `NN%` progress lines; exits 1 with `error: <message>` as its last line.

- [ ] **Step 1: Confirm the runtime APIs** before writing against them:

Run:
```bash
cd ~/work/tools/huggingface && .venv/bin/python - <<'EOF'
import inspect, mlx_whisper, parakeet_mlx
print(inspect.signature(mlx_whisper.transcribe))
print(inspect.signature(parakeet_mlx.from_pretrained))
m = inspect.getsource(parakeet_mlx)  # locate transcribe + chunk callback
import parakeet_mlx.parakeet as p; print([n for n in dir(p) if 'ranscri' in n or 'Result' in n])
EOF
grep -n "tqdm" .venv/lib/python3.12/site-packages/mlx_whisper/transcribe.py
```
Expected: `mlx_whisper.transcribe(audio, *, path_or_hf_repo, verbose, ..., **decode_options)` with a `tqdm` bar disabled unless `verbose is False`; `parakeet_mlx.from_pretrained(hf_id_or_path, ...)`; a `transcribe(path, *, chunk_duration, overlap_duration, chunk_callback)` on the model returning an object with `.text` and `.sentences` (`start`, `end`, `text`). **If any of these differ, adapt `_whisper` / `_parakeet` below and note the difference in the change log entry.**

- [ ] **Step 2: Implement** — append:

```python
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
```

- [ ] **Step 3: Make a Turkish test memo** (macOS `Yelda` voice):

```bash
mkdir -p ~/work/tools/huggingface/samples && cd ~/work/tools/huggingface/samples
say -v Yelda -o memo-tr.aiff "Merhaba. Bu bir deneme kaydıdır. Yarın sabah saat dokuzda toplantımız var, lütfen raporu getirmeyi unutma."
ffmpeg -loglevel error -y -i memo-tr.aiff memo-tr.m4a
```

- [ ] **Step 4: Run the CLI end to end**

Run: `cd ~/work/tools/huggingface && .venv/bin/python asr.py samples/memo-tr.m4a --language tr`
Expected: Turkish text close to the spoken sentence, exit 0. Then `--out /tmp/r.json` → JSON with `segments`, `language: "tr"`, `model`.

Run: `.venv/bin/python asr.py samples/memo-tr.m4a --model mlx-community/parakeet-tdt-0.6b-v3 --language tr; echo $?`
Expected: `error: mlx-community/parakeet-tdt-0.6b-v3 cannot transcribe 'tr' …`, exit 1.

- [ ] **Step 5: Tests still green** — unittest command from Task 1.

---

### Task 3: `modelctld.py` — result channel and routes

**Files:** Modify `modelctld.py` (docstring, imports, `Job`, `start_job`, new handlers, `_route`, banner); create `tests/test_modelctld_asr.py`

**Interfaces — Consumes:** `asr.*` from Tasks 1–2. **Produces:** routes per spec § Wire contract; `start_job(kind, repo, args, *, script=MODELCTL_PY, params=None, result_path=None) -> Job`; `Job.params: dict`, `Job.result: dict | None`.

- [ ] **Step 1: Write the failing tests** — `tests/test_modelctld_asr.py`:

```python
from __future__ import annotations

import json
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
```

- [ ] **Step 2: Run to verify failure** — expected: `AttributeError: module 'modelctld' has no attribute 'h_asr'` / `start_job() got an unexpected keyword argument 'script'`.

- [ ] **Step 3: Implement.**

Imports — add `import tempfile` and `from datetime import date`; after `import modelctl as mc`:
```python
import asr  # noqa: E402  -- cheap: validation and rendering only, MLX loads in the subprocess
```
and `ASR_PY = str(Path(__file__).resolve().parent / "asr.py")` beside `MODELCTL_PY`.

`Job.__init__` gains `self.params: dict = {}` and `self.result: dict | None = None`. `as_dict` adds `"params": self.params` always, and `d["result"] = self.result` inside `if include_log:`.

`start_job` signature and body changes:
```python
def start_job(kind: str, repo: str, args: list[str], *, script: str = MODELCTL_PY,
              params: dict | None = None, result_path: Path | None = None) -> Job:
    """Run `<script> <args>` in the background, streaming output into a Job.

    One job per repo at a time: two concurrent pulls of the same model into
    different roots is the one way to corrupt a cache folder, and it is far
    easier to refuse it here than to unpick it afterwards. For generation the
    repo is the model, so the same rule stops two runs thrashing one model's
    memory -- and stops a run while that model is being moved.

    `result_path`, when given, is a file the script writes its structured
    result to. It is loaded into `job.result` on exit 0 and always deleted:
    a transcript is too big, and too structured, to scrape out of the log.
    """
    ...
    argv = [sys.executable, script, *args]
    job = Job(kind, repo, argv)
    job.params = params or {}
```
and after `code = proc.wait()` replace the state block with:
```python
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
```
The `OSError` branch from `Popen` also unlinks `result_path` before returning.

Handlers — new section after `h_rm`:
```python
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
```

`_route` — before the existing `if rest[:1] == ["generate"]:` block:
```python
        if rest[:2] == ["generate", "asr"]:
            leaf = rest[2:]
            if method == "GET" and leaf == ["probe"]:
                return h_asr_probe(q)
            if method == "POST" and leaf == []:
                return h_asr(body)
            if method == "POST" and leaf == ["save"]:
                return h_asr_save(body)
```
and the 501's message becomes `"no runtime is wired up for this /v1/generate route yet"` with hint `"asr is live; image, tts and the rest mount under /v1/generate/* as their scripts land"`.

Docstring bullet `/v1/generate/* is reserved and answers 501` becomes: "`/v1/generate/*` is where runtime scripts mount. `asr` is live (asr.py, validated in-process, run as a subprocess); the rest answer 501 until their scripts exist." Banner gains a line: `print("           /v1/generate/asr[/probe|/save]")`.

- [ ] **Step 4: Run to verify pass** — unittest command. Expected: all tests in both files OK.

---

### Task 4: M1 gate — curl, then the change log

- [ ] **Step 1: Start the daemon** (background): `cd ~/work/tools/huggingface && .venv/bin/python modelctld.py`

- [ ] **Step 2: Probe, run, poll, save**

```bash
M=~/work/tools/huggingface/samples/memo-tr.m4a
curl -s "http://127.0.0.1:8077/v1/generate/asr/probe?path=$M"
curl -s -XPOST localhost:8077/v1/generate/asr -H 'content-type: application/json' \
  -d "{\"path\":\"$M\",\"language\":\"tr\"}"                     # → job dict, note "id"
curl -s localhost:8077/v1/jobs/<id>                             # repeat until state=done
curl -s -XPOST localhost:8077/v1/generate/asr/save -H 'content-type: application/json' \
  -d '{"job_id":"<id>","dir":"<scratch dir>"}'                  # → {"path": ...}
```
Expected: probe has `has_audio: true` and a duration; the job reaches `done` with `result.language == "tr"` and Turkish text; save returns a path whose file has front matter and `[00:00]` lines. Also check: Parakeet+`tr` POST → 400 before any job; a second POST while the first runs → 409.

- [ ] **Step 3: Change log** — append entry 32 to workbench `docs/m1-shell-change-log.md`: the result channel, `asr.py` importable-for-validation, 409-not-queue, video via ffmpeg, the probe route, any runtime-API differences found in Task 2 Step 1. Contract impact: none (no workbench code yet).

- [ ] **Step 4: Stop at the gate.** Report the curl results to the user; M2 gets its own plan.
