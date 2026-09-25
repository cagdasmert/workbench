# Vault search M1 — index one folder: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `curl` can register a markdown folder with modelctld, watch an `embed` job index it
into SQLite, list it with file and chunk counts, refresh it incrementally, and delete it.

**Architecture:** `embed.py`'s top level is stdlib-only (chunker, store, change scan), so the
daemon imports it in-process for reads and folder registration. Embedding runs only in the
`embed.py index` subprocess, started through the existing `start_job` machinery, which is the
only place sentence-transformers is imported. Vectors are stored as float32 blobs through
`array('f')`, so the store itself needs no numpy.

**Tech Stack:** Python 3.12, sqlite3, sentence-transformers (LaBSE), unittest. Daemon repo:
`~/work/tools/huggingface` (not under git; commits in this plan are in the workbench repo).

**Spec:** `docs/superpowers/specs/2026-09-19-vault-search-design.md`

## Global Constraints

- The daemon (`modelctld.py`) never imports torch, numpy, or sentence_transformers.
- Store path: `~/.local/share/modelctl/vault-index.sqlite`, overridable with `MODELCTL_VAULT_INDEX`.
- Default model `sentence-transformers/LaBSE`, default `chunk_size` 512.
- Default include `**/*.md`. Exclude `.obsidian/`, `.trash/`, any dot-directory. No symlink following.
- The daemon never writes a note. No route writes inside an indexed folder.
- Tests: `cd ~/work/tools/huggingface && .venv/bin/python -m unittest discover -s tests -q`.
- Tests never load a real model: the embedder and token counter are injected.

---

### Task 1: Chunker

**Files:**
- Create: `~/work/tools/huggingface/embed.py`
- Test: `~/work/tools/huggingface/tests/test_embed_chunk.py`

**Interfaces:**
- Produces: `Chunk(ord:int, heading:str, text:str, start_line:int, embed_text:str)`,
  `Note(title:str, chunks:tuple[Chunk,...], links:tuple[str,...])`,
  `parse_note(raw:str, stem:str, max_tokens:int, count_tokens:Callable[[str],int]) -> Note`.

- [ ] **Step 1: Write the failing tests**

```python
from __future__ import annotations

import unittest

import embed as e

WORDS = lambda s: len(s.split())  # noqa: E731


class ParseNoteTest(unittest.TestCase):
    def test_short_note_is_one_chunk_with_title_prefix(self) -> None:
        note = e.parse_note("# Zettel\n\nKısa bir not.\n", "zettel", 50, WORDS)
        self.assertEqual(note.title, "Zettel")
        self.assertEqual(len(note.chunks), 1)
        c = note.chunks[0]
        self.assertEqual(c.text, "# Zettel\n\nKısa bir not.")
        self.assertEqual(c.start_line, 1)
        self.assertTrue(c.embed_text.startswith("Zettel\n\n"))

    def test_front_matter_is_stripped_and_lines_stay_true(self) -> None:
        raw = "---\ntags: [a]\n---\nBody line.\n"
        note = e.parse_note(raw, "stem", 50, WORDS)
        self.assertEqual(note.title, "stem")
        self.assertEqual(note.chunks[0].text, "Body line.")
        self.assertEqual(note.chunks[0].start_line, 4)

    def test_long_note_splits_on_headings_with_heading_path(self) -> None:
        raw = "# T\n\nintro words here\n\n## A\n\n" + "a " * 8 + "\n\n### B\n\n" + "b " * 8 + "\n"
        note = e.parse_note(raw, "t", 10, WORDS)
        heads = [c.heading for c in note.chunks]
        self.assertIn("T › A", heads)
        self.assertIn("T › A › B", heads)
        b = next(c for c in note.chunks if c.heading == "T › A › B")
        self.assertTrue(b.embed_text.startswith("T › A › B\n\n"))
        # "### B" is line 9, line 10 is blank: start_line is the passage's first non-blank line
        self.assertEqual(b.start_line, 11)
        self.assertEqual([c.ord for c in note.chunks], list(range(len(note.chunks))))

    def test_oversized_section_splits_on_paragraphs_then_words(self) -> None:
        raw = "# T\n\n" + "p1 " * 6 + "\n\n" + "p2 " * 6 + "\n\n" + "w " * 25 + "\n"
        note = e.parse_note(raw, "t", 10, WORDS)
        self.assertTrue(all(WORDS(c.text) <= 10 for c in note.chunks))
        self.assertGreaterEqual(len(note.chunks), 5)

    def test_wikilinks_are_collected(self) -> None:
        note = e.parse_note("See [[Alpha]] and [[Beta|b]] and [[Gamma#x]].", "s", 50, WORDS)
        self.assertEqual(note.links, ("Alpha", "Beta", "Gamma"))

    def test_empty_note_has_no_chunks(self) -> None:
        self.assertEqual(e.parse_note("---\na: 1\n---\n\n", "s", 50, WORDS).chunks, ())
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m unittest tests.test_embed_chunk -q`. Expected: `ModuleNotFoundError: embed`.

- [ ] **Step 3: Implement**

```python
#!/usr/bin/env python3
"""
embed - the vault index behind the workbench vault-search plugin.

Chunks markdown folders, embeds the chunks with a sentence-transformers model
from the modelctl catalog, and keeps them in one SQLite file beside the catalog.

Importing this module is cheap on purpose, like asr.py: the chunker, the store
and the change scan are stdlib-only, so modelctld reads the index in-process.
sentence-transformers is imported only by the `index` subcommand, which the
daemon runs as a job. Read-only against the notes: nothing here opens a note
for writing.

Usage
-----
    .venv/bin/python embed.py index --folder Calismalar           # what modelctld runs
    .venv/bin/python embed.py index --folder Calismalar --full
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

DEFAULT_MODEL = "sentence-transformers/LaBSE"
DEFAULT_CHUNK_SIZE = 512

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_WIKILINK = re.compile(r"\[\[([^\]|#]+)")


@dataclass(frozen=True)
class Chunk:
    ord: int
    heading: str      # "Title › H2 › H3"; "" for a whole-note chunk
    text: str         # the passage as written, shown to the user
    start_line: int   # 1-based, in the original file
    embed_text: str   # heading path (or title) + passage, what the model sees


@dataclass(frozen=True)
class Note:
    title: str
    chunks: tuple[Chunk, ...]
    links: tuple[str, ...]


def _strip_front_matter(lines: list[str]) -> int:
    """Index of the first body line."""
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in ("---", "..."):
                return i + 1
    return 0


def _paragraphs(lines: list[str], first_line: int) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    buf: list[str] = []
    start = first_line
    for i, line in enumerate(lines):
        if line.strip():
            if not buf:
                start = first_line + i
            buf.append(line)
        elif buf:
            out.append((start, "\n".join(buf).strip()))
            buf = []
    if buf:
        out.append((start, "\n".join(buf).strip()))
    return out


def _hard_split(text: str, max_tokens: int, count: Callable[[str], int]) -> list[str]:
    pieces: list[str] = []
    cur: list[str] = []
    for word in text.split():
        if cur and count(" ".join([*cur, word])) > max_tokens:
            pieces.append(" ".join(cur))
            cur = []
        cur.append(word)
    if cur:
        pieces.append(" ".join(cur))
    return pieces


def _split_section(lines: list[str], first_line: int, max_tokens: int,
                   count: Callable[[str], int]) -> list[tuple[int, str]]:
    """Paragraph-packed pieces of one section, each within max_tokens."""
    pieces: list[tuple[int, str]] = []
    cur: list[str] = []
    cur_start = first_line
    for start, para in _paragraphs(lines, first_line):
        if count(para) > max_tokens:
            if cur:
                pieces.append((cur_start, "\n\n".join(cur)))
                cur = []
            pieces.extend((start, p) for p in _hard_split(para, max_tokens, count))
            continue
        if cur and count("\n\n".join([*cur, para])) > max_tokens:
            pieces.append((cur_start, "\n\n".join(cur)))
            cur = []
        if not cur:
            cur_start = start
        cur.append(para)
    if cur:
        pieces.append((cur_start, "\n\n".join(cur)))
    return pieces


def parse_note(raw: str, stem: str, max_tokens: int, count_tokens: Callable[[str], int]) -> Note:
    lines = raw.splitlines()
    body_at = _strip_front_matter(lines)
    body = lines[body_at:]
    title = stem
    for line in body:
        m = _HEADING.match(line)
        if m and len(m.group(1)) == 1:
            title = m.group(2)
            break
    links = tuple(dict.fromkeys(t.strip() for t in _WIKILINK.findall(raw) if t.strip()))

    whole = "\n".join(body).strip()
    if not whole:
        return Note(title, (), links)
    if count_tokens(whole) <= max_tokens:
        first = next(i for i, l in enumerate(body) if l.strip())
        return Note(title, (Chunk(0, "", whole, body_at + first + 1, f"{title}\n\n{whole}"),), links)

    # Sections: (heading path, lines, 1-based line of the section's first body line)
    sections: list[tuple[str, list[str], int]] = []
    stack: list[tuple[int, str]] = []
    cur: list[str] = []
    cur_line = body_at + 1
    path = title
    for i, line in enumerate(body):
        m = _HEADING.match(line)
        if m:
            sections.append((path, cur, cur_line))
            level = len(m.group(1))
            stack = [(lv, t) for lv, t in stack if lv < level]
            if level > 1:
                stack.append((level, m.group(2)))
            path = " › ".join([title, *(t for _, t in stack)])
            cur, cur_line = [], body_at + i + 2
            continue
        cur.append(line)
    sections.append((path, cur, cur_line))

    chunks: list[Chunk] = []
    for heading, sec_lines, first_line in sections:
        for start, text in _split_section(sec_lines, first_line, max_tokens, count_tokens):
            chunks.append(Chunk(len(chunks), heading, text, start, f"{heading}\n\n{text}"))
    return Note(title, tuple(chunks), links)
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m unittest tests.test_embed_chunk -q`. Expected: `OK`.

- [ ] **Step 5: Commit** (workbench repo: nothing yet; the daemon repo is not under git)

---

### Task 2: Store and change scan

**Files:**
- Modify: `~/work/tools/huggingface/embed.py` (append)
- Test: `~/work/tools/huggingface/tests/test_embed_store.py`

**Interfaces:**
- Consumes: `Note`, `Chunk` from Task 1.
- Produces:
  - `index_path() -> Path`, `connect(path: Path | None = None) -> sqlite3.Connection`
  - `FolderSpec(name, path, model, chunk_size, include, exclude)`
  - `upsert_folder(conn, spec) -> None` (raises `EmbedError` if `name` exists with another path)
  - `get_folder(conn, name) -> FolderSpec | None`, `delete_folder(conn, name) -> bool`
  - `list_folders(conn) -> list[dict]` → `{name, path, files, chunks, indexed_at, model, chunk_size, changed}`
  - `walk(spec) -> dict[str, float]` (rel_path → mtime)
  - `plan_changes(conn, spec) -> Changes(added, modified, removed)` (lists of rel paths; modified = mtime differs)
  - `EmbedError(Exception)`

- [ ] **Step 1: Write the failing tests**

```python
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import embed as e


def _vault(root: Path) -> None:
    (root / "a.md").write_text("# A\n\nalpha\n")
    (root / "sub").mkdir()
    (root / "sub" / "b.md").write_text("beta\n")
    (root / ".obsidian").mkdir()
    (root / ".obsidian" / "x.md").write_text("ignored\n")
    (root / ".trash").mkdir()
    (root / ".trash" / "y.md").write_text("ignored\n")
    (root / "c.txt").write_text("not markdown\n")


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "vault"
        self.root.mkdir()
        _vault(self.root)
        self.conn = e.connect(Path(self.tmp.name) / "idx.sqlite")
        self.spec = e.FolderSpec("V", str(self.root), e.DEFAULT_MODEL, 512,
                                 e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def test_walk_skips_dot_dirs_and_non_markdown(self) -> None:
        self.assertEqual(sorted(e.walk(self.spec)), ["a.md", "sub/b.md"])

    def test_folder_roundtrip_and_path_conflict(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        self.assertEqual(e.get_folder(self.conn, "V"), self.spec)
        with self.assertRaises(e.EmbedError):
            e.upsert_folder(self.conn, e.FolderSpec("V", "/elsewhere", e.DEFAULT_MODEL, 512,
                                                    e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE))

    def test_unindexed_folder_lists_everything_as_changed(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        [row] = e.list_folders(self.conn)
        self.assertEqual((row["files"], row["chunks"], row["changed"], row["indexed_at"]),
                         (0, 0, 2, None))
        ch = e.plan_changes(self.conn, self.spec)
        self.assertEqual(sorted(ch.added), ["a.md", "sub/b.md"])

    def test_delete_cascades(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        self.assertTrue(e.delete_folder(self.conn, "V"))
        self.assertFalse(e.delete_folder(self.conn, "V"))
        self.assertEqual(e.list_folders(self.conn), [])

    def test_index_path_honours_env(self) -> None:
        os.environ["MODELCTL_VAULT_INDEX"] = "/tmp/x.sqlite"
        try:
            self.assertEqual(e.index_path(), Path("/tmp/x.sqlite"))
        finally:
            del os.environ["MODELCTL_VAULT_INDEX"]
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m unittest tests.test_embed_store -q`. Expected: `AttributeError`.

- [ ] **Step 3: Implement** (append to `embed.py`; add `import fnmatch, json, os, sqlite3, time`,
  `from pathlib import Path`, `from dataclasses import field` as needed at the top)

```python
DEFAULT_INCLUDE: tuple[str, ...] = ("**/*.md",)
DEFAULT_EXCLUDE: tuple[str, ...] = (".obsidian/**", ".trash/**")

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
  name TEXT PRIMARY KEY, path TEXT NOT NULL, model TEXT NOT NULL, chunk_size INTEGER NOT NULL,
  include TEXT NOT NULL, exclude TEXT NOT NULL, indexed_at REAL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, folder TEXT NOT NULL REFERENCES folders(name) ON DELETE CASCADE,
  rel_path TEXT NOT NULL, mtime REAL NOT NULL, sha256 TEXT NOT NULL, title TEXT NOT NULL,
  UNIQUE(folder, rel_path));
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, start_line INTEGER NOT NULL,
  vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, target TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS links_file ON links(file_id);
"""


class EmbedError(Exception):
    """A request the index cannot serve. The message is written for the user."""


@dataclass(frozen=True)
class FolderSpec:
    name: str
    path: str
    model: str
    chunk_size: int
    include: tuple[str, ...]
    exclude: tuple[str, ...]


@dataclass(frozen=True)
class Changes:
    added: list[str]
    modified: list[str]
    removed: list[str]

    @property
    def count(self) -> int:
        return len(self.added) + len(self.modified) + len(self.removed)


def index_path() -> Path:
    raw = os.environ.get("MODELCTL_VAULT_INDEX")
    return Path(raw).expanduser() if raw else Path.home() / ".local/share/modelctl/vault-index.sqlite"


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def bump_generation(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES('generation', '1') "
                 "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")


def _spec(row: sqlite3.Row) -> FolderSpec:
    return FolderSpec(row["name"], row["path"], row["model"], row["chunk_size"],
                      tuple(json.loads(row["include"])), tuple(json.loads(row["exclude"])))


def get_folder(conn: sqlite3.Connection, name: str) -> FolderSpec | None:
    row = conn.execute("SELECT * FROM folders WHERE name = ?", (name,)).fetchone()
    return _spec(row) if row else None


def upsert_folder(conn: sqlite3.Connection, spec: FolderSpec) -> None:
    existing = get_folder(conn, spec.name)
    if existing and existing.path != spec.path:
        raise EmbedError(f"a folder named {spec.name!r} already indexes {existing.path}")
    with conn:
        conn.execute(
            "INSERT INTO folders(name, path, model, chunk_size, include, exclude) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET model=excluded.model, chunk_size=excluded.chunk_size, "
            "include=excluded.include, exclude=excluded.exclude",
            (spec.name, spec.path, spec.model, spec.chunk_size,
             json.dumps(list(spec.include)), json.dumps(list(spec.exclude))))


def delete_folder(conn: sqlite3.Connection, name: str) -> bool:
    with conn:
        n = conn.execute("DELETE FROM folders WHERE name = ?", (name,)).rowcount
        if n:
            bump_generation(conn)
    return n > 0


def _matches(rel: str, patterns: tuple[str, ...]) -> bool:
    # fnmatch's * crosses "/", so "**/*.md" also needs the top-level form "*.md".
    return any(fnmatch.fnmatch(rel, p) or (p.startswith("**/") and fnmatch.fnmatch(rel, p[3:]))
               for p in patterns)


def walk(spec: FolderSpec) -> dict[str, float]:
    root = Path(spec.path)
    found: dict[str, float] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            full = Path(dirpath) / fn
            rel = full.relative_to(root).as_posix()
            if full.is_symlink() or not _matches(rel, spec.include) or _matches(rel, spec.exclude):
                continue
            found[rel] = full.stat().st_mtime
    return found


def plan_changes(conn: sqlite3.Connection, spec: FolderSpec) -> Changes:
    on_disk = walk(spec)
    known = {r["rel_path"]: r["mtime"] for r in
             conn.execute("SELECT rel_path, mtime FROM files WHERE folder = ?", (spec.name,))}
    return Changes(
        added=[p for p in on_disk if p not in known],
        modified=[p for p, m in on_disk.items() if p in known and known[p] != m],
        removed=[p for p in known if p not in on_disk],
    )


def list_folders(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for row in conn.execute("SELECT * FROM folders ORDER BY name").fetchall():
        spec = _spec(row)
        files, chunks = conn.execute(
            "SELECT COUNT(DISTINCT f.id), COUNT(c.id) FROM files f "
            "LEFT JOIN chunks c ON c.file_id = f.id WHERE f.folder = ?", (spec.name,)).fetchone()
        changed = plan_changes(conn, spec).count if Path(spec.path).is_dir() else None
        out.append({"name": spec.name, "path": spec.path, "files": files, "chunks": chunks,
                    "indexed_at": row["indexed_at"], "model": spec.model,
                    "chunk_size": spec.chunk_size, "changed": changed})
    return out
```

`changed` is `None` when the folder is gone (the external drive is unmounted), which reads
differently from "0 changed".

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m unittest tests.test_embed_store tests.test_embed_chunk -q`. Expected: `OK`.

---

### Task 3: Indexer and `index` subcommand

**Files:**
- Modify: `~/work/tools/huggingface/embed.py` (append `index_folder`, `_load_model`, `main`)
- Test: `~/work/tools/huggingface/tests/test_embed_index.py`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `index_folder(conn, spec, *, embed, count_tokens, full=False, progress=print, batch_files=16) -> dict`
    where `embed: Callable[[list[str]], list[list[float]]]`. Returns
    `{name, files, chunks, embedded, removed}` (embedded = files re-embedded).
  - CLI: `embed.py index --folder NAME [--folder NAME…] [--full] [--db PATH] [--out PATH]`.
    Writes `{"folders": [<index_folder result>…]}` to `--out`.

- [ ] **Step 1: Write the failing tests**

```python
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import embed as e

WORDS = lambda s: len(s.split())  # noqa: E731


class FakeEmbed:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, texts: list[str]) -> list[list[float]]:
        self.seen.extend(texts)
        return [[float(len(t)), 1.0, 0.0] for t in texts]


class IndexTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "vault"
        self.root.mkdir()
        (self.root / "a.md").write_text("# A\n\nalpha [[B]]\n")
        (self.root / "b.md").write_text("beta\n")
        self.conn = e.connect(Path(self.tmp.name) / "idx.sqlite")
        self.spec = e.FolderSpec("V", str(self.root), e.DEFAULT_MODEL, 50,
                                 e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE)
        e.upsert_folder(self.conn, self.spec)
        self.lines: list[str] = []

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def run_index(self, full: bool = False) -> tuple[dict, FakeEmbed]:
        fake = FakeEmbed()
        res = e.index_folder(self.conn, self.spec, embed=fake, count_tokens=WORDS,
                             full=full, progress=self.lines.append)
        return res, fake

    def test_first_run_embeds_everything_and_reports_progress(self) -> None:
        res, fake = self.run_index()
        self.assertEqual((res["files"], res["chunks"], res["embedded"]), (2, 2, 2))
        self.assertTrue(any("2/2" in l and "100%" in l for l in self.lines))
        [row] = e.list_folders(self.conn)
        self.assertEqual((row["changed"], row["chunks"]), (0, 2))
        self.assertIsNotNone(row["indexed_at"])
        self.assertEqual(self.conn.execute("SELECT target FROM links").fetchone()[0], "B")

    def test_second_run_embeds_nothing(self) -> None:
        self.run_index()
        res, fake = self.run_index()
        self.assertEqual((res["embedded"], fake.seen), (0, []))

    def test_touch_without_edit_updates_mtime_only(self) -> None:
        self.run_index()
        os.utime(self.root / "a.md", (1, 1))
        res, fake = self.run_index()
        self.assertEqual(res["embedded"], 0)
        self.assertEqual(e.list_folders(self.conn)[0]["changed"], 0)

    def test_edit_reembeds_one_file_and_delete_removes(self) -> None:
        self.run_index()
        (self.root / "a.md").write_text("# A\n\nalpha, edited\n")
        (self.root / "b.md").unlink()
        res, fake = self.run_index()
        self.assertEqual((res["embedded"], res["removed"], res["files"]), (1, 1, 1))
        self.assertEqual(len(fake.seen), 1)

    def test_full_reembeds_everything(self) -> None:
        self.run_index()
        res, _ = self.run_index(full=True)
        self.assertEqual(res["embedded"], 2)

    def test_vectors_roundtrip_as_float32(self) -> None:
        self.run_index()
        blob = self.conn.execute("SELECT vector FROM chunks LIMIT 1").fetchone()[0]
        self.assertEqual(len(e.unpack(blob)), 3)
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m unittest tests.test_embed_index -q`. Expected: `AttributeError: index_folder`.

- [ ] **Step 3: Implement** (append; add `import hashlib`, `from array import array`, `import sys`)

```python
def pack(vec: list[float]) -> bytes:
    return array("f", vec).tobytes()


def unpack(blob: bytes) -> list[float]:
    a = array("f")
    a.frombytes(blob)
    return a.tolist()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def index_folder(conn: sqlite3.Connection, spec: FolderSpec, *,
                 embed: Callable[[list[str]], list[list[float]]],
                 count_tokens: Callable[[str], int], full: bool = False,
                 progress: Callable[[str], object] = print, batch_files: int = 16) -> dict:
    root = Path(spec.path)
    if not root.is_dir():
        raise EmbedError(f"{spec.path} is not reachable -- is the drive mounted?")
    on_disk = walk(spec)
    known = {r["rel_path"]: (r["id"], r["mtime"], r["sha256"]) for r in
             conn.execute("SELECT id, rel_path, mtime, sha256 FROM files WHERE folder = ?",
                          (spec.name,))}

    removed = [p for p in known if p not in on_disk]
    with conn:
        for rel in removed:
            conn.execute("DELETE FROM files WHERE id = ?", (known[rel][0],))

    todo = sorted(p for p in on_disk if full or p not in known or known[p][1] != on_disk[p])
    embedded = 0
    total = len(todo)
    for start in range(0, total, batch_files):
        batch = todo[start:start + batch_files]
        work: list[tuple[str, float, str, Note | None]] = []
        for rel in batch:
            data = (root / rel).read_bytes()
            sha = _sha(data)
            if not full and rel in known and known[rel][2] == sha:
                work.append((rel, on_disk[rel], sha, None))   # touched, not edited
                continue
            note = parse_note(data.decode("utf-8", errors="replace"), Path(rel).stem,
                              spec.chunk_size, count_tokens)
            work.append((rel, on_disk[rel], sha, note))
        texts = [c.embed_text for *_, n in work if n for c in n.chunks]
        vectors = iter(embed(texts) if texts else [])
        with conn:
            for rel, mtime, sha, note in work:
                if note is None:
                    conn.execute("UPDATE files SET mtime = ? WHERE id = ?", (mtime, known[rel][0]))
                    continue
                if rel in known:
                    conn.execute("DELETE FROM files WHERE id = ?", (known[rel][0],))
                fid = conn.execute(
                    "INSERT INTO files(folder, rel_path, mtime, sha256, title) VALUES(?,?,?,?,?)",
                    (spec.name, rel, mtime, sha, note.title)).lastrowid
                conn.executemany(
                    "INSERT INTO chunks(file_id, ord, heading, text, start_line, vector) "
                    "VALUES(?,?,?,?,?,?)",
                    [(fid, c.ord, c.heading, c.text, c.start_line, pack(next(vectors)))
                     for c in note.chunks])
                conn.executemany("INSERT INTO links(file_id, target) VALUES(?,?)",
                                 [(fid, t) for t in note.links])
                embedded += 1
            bump_generation(conn)
        done = start + len(batch)
        progress(f"{spec.name}: {done}/{total} files {100 * done // max(total, 1)}%")
    if total == 0:
        progress(f"{spec.name}: 0/0 files 100%")

    with conn:
        conn.execute("UPDATE folders SET indexed_at = ? WHERE name = ?", (time.time(), spec.name))
        if removed:
            bump_generation(conn)
    files, chunks = conn.execute(
        "SELECT COUNT(DISTINCT f.id), COUNT(c.id) FROM files f "
        "LEFT JOIN chunks c ON c.file_id = f.id WHERE f.folder = ?", (spec.name,)).fetchone()
    return {"name": spec.name, "files": files, "chunks": chunks,
            "embedded": embedded, "removed": len(removed)}


def _load_model(repo: str):  # -> (embed, count_tokens, max_tokens); heavy import lives here
    import modelctl as mc
    from sentence_transformers import SentenceTransformer

    path = mc.resolve(repo)
    if path is None:
        raise EmbedError(f"{repo} is not downloaded -- modelctl pull {repo}")
    model = SentenceTransformer(path, device="mps")
    tok = model.tokenizer

    def count(text: str) -> int:
        return len(tok(text, add_special_tokens=False)["input_ids"])

    def embed(texts: list[str]) -> list[list[float]]:
        return model.encode(texts, batch_size=32, normalize_embeddings=True,
                            convert_to_numpy=True).tolist()

    return embed, count, int(model.max_seq_length)


def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="embed", description="the vault index")
    sub = p.add_subparsers(dest="cmd", required=True)
    ix = sub.add_parser("index", help="(re)index registered folders")
    ix.add_argument("--folder", action="append", required=True, help="registered folder name")
    ix.add_argument("--full", action="store_true", help="re-embed everything")
    ix.add_argument("--db", type=Path, help="index file (default: MODELCTL_VAULT_INDEX or ~/.local/share)")
    ix.add_argument("--out", type=Path, help="write the result as JSON here")
    args = p.parse_args(argv)

    try:
        conn = connect(args.db)
        specs = []
        for name in args.folder:
            spec = get_folder(conn, name)
            if spec is None:
                raise EmbedError(f"no folder named {name!r} is registered")
            specs.append(spec)
        models = {s.model for s in specs}
        if len(models) != 1:
            raise EmbedError(f"folders use different models: {', '.join(sorted(models))}")
        embed, count, max_len = _load_model(models.pop())
        results = []
        for spec in specs:
            size = min(spec.chunk_size, max_len - 2)
            if size < spec.chunk_size:
                print(f"{spec.name}: chunk_size {spec.chunk_size} exceeds the model's "
                      f"{max_len}-token window; chunking at {size}", flush=True)
            results.append(index_folder(conn, replace(spec, chunk_size=size), embed=embed,
                                        count_tokens=count, full=args.full,
                                        progress=lambda s: print(s, flush=True)))
    except EmbedError as e:
        print(f"error: {e}", file=sys.stderr, flush=True)
        return 1
    out = {"folders": results}
    if args.out:
        args.out.write_text(json.dumps(out), encoding="utf-8")
    else:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

(`from dataclasses import dataclass, replace` at the top.) The clamp is why the recorded
`chunk_size` stays what was *asked for*: the mismatch check compares the request with the
request, and the log says what was actually used. LaBSE's window is 256, so the default 512
chunks at 254 on LaBSE.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m unittest discover -s tests -q`. Expected: `OK`. That covers all
the embed tests plus the existing asr tests.

---

### Task 4: Daemon routes

**Files:**
- Modify: `~/work/tools/huggingface/modelctld.py`: import `embed`, add `EMBED_PY`, the handlers
  after the asr section, `do_DELETE`, and the `index` routes in `_route`. Update the docstring
  and the `serve()` banner.
- Test: `~/work/tools/huggingface/tests/test_modelctld_index.py`

**Interfaces:**
- Consumes: `embed.connect/upsert_folder/get_folder/delete_folder/list_folders/FolderSpec/EmbedError`,
  `start_job(kind, repo, args, script=, params=, result_path=)`.
- Produces: `h_index_add(body)`, `h_index_list()`, `h_index_refresh(body)`, `h_index_delete(name)`.

- [ ] **Step 1: Write the failing tests** (they set `MODELCTL_VAULT_INDEX` to a temp file, and
  stub `start_job` so no model loads)

```python
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import modelctld as d


class IndexRoutesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["MODELCTL_VAULT_INDEX"] = str(Path(self.tmp.name) / "idx.sqlite")
        self.vault = Path(self.tmp.name) / "Notlar"
        self.vault.mkdir()
        (self.vault / "a.md").write_text("alpha\n")
        self.started: list[tuple] = []
        self._orig = d.start_job
        self._orig_resolve = d.mc.resolve

        def fake_start(kind, repo, args, **kw):
            self.started.append((kind, repo, args, kw.get("params")))
            job = d.Job(kind, repo, args)
            job.params = kw.get("params") or {}
            return job

        d.start_job = fake_start
        d.mc.resolve = lambda repo, cfg=None: "/fake/snapshot"

    def tearDown(self) -> None:
        d.start_job = self._orig
        d.mc.resolve = self._orig_resolve
        del os.environ["MODELCTL_VAULT_INDEX"]
        self.tmp.cleanup()

    def test_add_registers_and_starts_an_embed_job(self) -> None:
        job = d.h_index_add({"path": str(self.vault)})
        self.assertEqual(job["kind"], "embed")
        kind, repo, args, params = self.started[0]
        self.assertEqual(repo, "sentence-transformers/LaBSE")
        self.assertEqual(args[:2], ["index", "--folder"])
        self.assertIn("Notlar", args)
        self.assertEqual(params, {"folders": ["Notlar"], "full": False})
        [row] = d.h_index_list()["folders"]
        self.assertEqual((row["name"], row["changed"]), ("Notlar", 1))

    def test_add_rejects_relative_and_missing_paths(self) -> None:
        for bad in ("relative/dir", str(self.vault / "nope")):
            with self.assertRaises(d.ApiError):
                d.h_index_add({"path": bad})

    def test_add_same_name_other_path_is_409(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        other = Path(self.tmp.name) / "x" / "Notlar"
        other.mkdir(parents=True)
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_add({"path": str(other)})
        self.assertEqual(cm.exception.status, 409)

    def test_model_not_downloaded_is_404(self) -> None:
        d.mc.resolve = lambda repo, cfg=None: None
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_add({"path": str(self.vault)})
        self.assertEqual(cm.exception.status, 404)

    def test_refresh_mismatch_needs_full(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_refresh({"name": "Notlar", "chunk_size": 256})
        self.assertEqual(cm.exception.status, 409)
        d.h_index_refresh({"name": "Notlar", "chunk_size": 256, "full": True})
        self.assertEqual(self.started[-1][3], {"folders": ["Notlar"], "full": True})
        self.assertEqual(d.h_index_list()["folders"][0]["chunk_size"], 256)

    def test_refresh_all_and_unknown(self) -> None:
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_refresh({})
        self.assertEqual(cm.exception.status, 404)
        d.h_index_add({"path": str(self.vault)})
        d.h_index_refresh({})
        self.assertEqual(self.started[-1][3]["folders"], ["Notlar"])
        with self.assertRaises(d.ApiError):
            d.h_index_refresh({"name": "nope"})

    def test_delete(self) -> None:
        d.h_index_add({"path": str(self.vault)})
        self.assertEqual(d.h_index_delete("Notlar"), {"ok": True})
        with self.assertRaises(d.ApiError) as cm:
            d.h_index_delete("Notlar")
        self.assertEqual(cm.exception.status, 404)
        self.assertTrue((self.vault / "a.md").exists())
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m unittest tests.test_modelctld_index -q`. Expected: `AttributeError: h_index_add`.

- [ ] **Step 3: Implement**

At the top of `modelctld.py`:

```python
import embed  # noqa: E402  -- cheap: chunker and store are stdlib; torch loads in the subprocess
EMBED_PY = str(Path(__file__).resolve().parent / "embed.py")
```

Handlers, after `h_asr_save`:

```python
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
```

In `Handler`:

```python
    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")
```

In `_route`, before the `generate` block:

```python
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
```

(`from urllib.parse import parse_qs, unquote, urlparse`.) Add `/v1/index/{folders,refresh}`
to the `serve()` banner, and a line about `embed` to the module docstring's design notes.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m unittest discover -s tests -q`. Expected: `OK`, with the asr tests
unchanged.

---

### Task 5: Real model, `curl` gate, change log

**Files:**
- Modify: `workbench/docs/m1-shell-change-log.md` (append a P2 M1 section)

- [ ] **Step 1: Install and pull**

```bash
cd ~/work/tools/huggingface
uv pip install --python .venv/bin/python sentence-transformers
.venv/bin/python -c "import modelctl" && .venv/bin/python modelctl.py pull sentence-transformers/LaBSE --to internal
```

- [ ] **Step 2: Start the daemon on a scratch index and index the vault**

```bash
MODELCTL_VAULT_INDEX=$SCRATCH/vault-index.sqlite .venv/bin/python modelctld.py &
curl -s -XPOST localhost:8077/v1/index/folders -d '{"path":"/Users/cagdasmert/work/dosyalar/obsidian/Calismalar"}'
curl -s localhost:8077/v1/jobs/<id>          # poll until state=done; result has files/chunks
curl -s localhost:8077/v1/index/folders      # files ≈ 319, changed = 0
```

- [ ] **Step 3: Restart survives, refresh is incremental**

Kill and restart the daemon. `GET /v1/index/folders` shows the same counts. `POST
/v1/index/refresh` finishes with `embedded: 0`. Touch-edit one scratch note *outside* the
vault (the vault is read-only for us, so point a second folder at a temp copy for this check),
then refresh: `embedded: 1`. Check the clamp note on LaBSE's 256-token window appears in the job
log. Check `DELETE /v1/index/folders/<name>` works and leaves the notes on disk.

- [ ] **Step 4: Append to the change log and commit**

Record the timings, counts, the LaBSE window clamp, and the decision list from the spec, in
the style of the transcribe M1 entry. Commit this plan, the log, and nothing from the daemon
repo (it is not under git).
