#!/usr/bin/env python3
"""
embed - the vault index behind the workbench vault-search plugin.

Chunks markdown folders, embeds the chunks with a sentence-transformers model
from the modelctl catalog, and keeps them in one SQLite file beside the catalog.

Importing this module is cheap on purpose, like asr.py: the chunker, the store
and the change scan are stdlib-only, so modelctld reads the index in-process.
sentence-transformers and numpy are imported only by the `index` subcommand,
which the daemon runs as a job, and by `serve`, the persistent search worker
the daemon supervises. Read-only against the notes: nothing here opens a note
for writing.

Usage
-----
    .venv/bin/python embed.py index --folder Calismalar           # what modelctld runs
    .venv/bin/python embed.py index --folder Calismalar --full
    .venv/bin/python embed.py serve                               # the search worker; JSON lines
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from array import array
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable

DEFAULT_MODEL = "sentence-transformers/LaBSE"
DEFAULT_CHUNK_SIZE = 512
DEFAULT_INCLUDE: tuple[str, ...] = ("**/*.md",)
DEFAULT_EXCLUDE: tuple[str, ...] = (".obsidian/**", ".trash/**")

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_WIKILINK = re.compile(r"\[\[([^\]|#]+)")


class EmbedError(Exception):
    """A request the index cannot serve. The message is written for the user."""


# ---------------------------------------------------------------------------
# chunking
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    ord: int
    heading: str      # "Title › H2 › H3"; "" for a whole-note chunk
    text: str         # the passage as written, shown to the user
    start_line: int   # 1-based, in the original file: the passage's first non-blank line
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
    """A whole note is one chunk when it fits; otherwise heading sections, then paragraphs."""
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
        first = next(i for i, line in enumerate(body) if line.strip())
        return Note(title, (Chunk(0, "", whole, body_at + first + 1, f"{title}\n\n{whole}"),), links)

    # (heading path, section lines, 1-based line number of the section's first line)
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


# ---------------------------------------------------------------------------
# store
# ---------------------------------------------------------------------------

# `links` is filled but not yet ranked on: link-graph weighting can arrive
# later without a re-index. `meta.generation` moves on every committed write,
# which is how a long-lived reader knows to reload its matrix.
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
    modified: list[str]   # mtime differs; the hash decides whether it is re-embedded
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
    # fnmatch's * crosses "/", so "**/*.md" also needs its top-level form "*.md".
    return any(fnmatch.fnmatch(rel, p) or (p.startswith("**/") and fnmatch.fnmatch(rel, p[3:]))
               for p in patterns)


def walk(spec: FolderSpec) -> dict[str, float]:
    """rel_path -> mtime for every file the folder's patterns select. Dot-dirs are never entered."""
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


def _counts(conn: sqlite3.Connection, name: str) -> tuple[int, int]:
    files, chunks = conn.execute(
        "SELECT COUNT(DISTINCT f.id), COUNT(c.id) FROM files f "
        "LEFT JOIN chunks c ON c.file_id = f.id WHERE f.folder = ?", (name,)).fetchone()
    return files, chunks


def list_folders(conn: sqlite3.Connection) -> list[dict]:
    """`changed` is None when the folder is unreachable -- an unmounted drive is not "0 changed"."""
    out = []
    for row in conn.execute("SELECT * FROM folders ORDER BY name").fetchall():
        spec = _spec(row)
        files, chunks = _counts(conn, spec.name)
        changed = plan_changes(conn, spec).count if Path(spec.path).is_dir() else None
        out.append({"name": spec.name, "path": spec.path, "files": files, "chunks": chunks,
                    "indexed_at": row["indexed_at"], "model": spec.model,
                    "chunk_size": spec.chunk_size, "changed": changed})
    return out


# ---------------------------------------------------------------------------
# indexing
# ---------------------------------------------------------------------------


def pack(vec: list[float]) -> bytes:
    return array("f", vec).tobytes()


def unpack(blob: bytes) -> list[float]:
    a = array("f")
    a.frombytes(blob)
    return a.tolist()


def index_folder(conn: sqlite3.Connection, spec: FolderSpec, *,
                 embed: Callable[[list[str]], list[list[float]]],
                 count_tokens: Callable[[str], int], full: bool = False,
                 progress: Callable[[str], object] = print, batch_files: int = 16) -> dict:
    """Bring one folder's index up to date. A file is re-embedded when its mtime
    moved *and* its hash changed; a touch alone only updates the mtime. Each
    batch commits on its own, so a cancelled job keeps what it finished."""
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
            sha = hashlib.sha256(data).hexdigest()
            if not full and rel in known and known[rel][2] == sha:
                work.append((rel, on_disk[rel], sha, None))   # touched, not edited
                continue
            note = parse_note(data.decode("utf-8", errors="replace"), Path(rel).stem,
                              spec.chunk_size, count_tokens)
            work.append((rel, on_disk[rel], sha, note))
        texts = [c.embed_text for *_, note in work if note for c in note.chunks]
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
        progress(f"{spec.name}: {done}/{total} files {100 * done // total}%")
    if total == 0:
        progress(f"{spec.name}: 0/0 files 100%")

    with conn:
        conn.execute("UPDATE folders SET indexed_at = ? WHERE name = ?", (time.time(), spec.name))
        if removed:
            bump_generation(conn)
    files, chunks = _counts(conn, spec.name)
    return {"name": spec.name, "files": files, "chunks": chunks,
            "embedded": embedded, "removed": len(removed)}


# ---------------------------------------------------------------------------
# search -- only ever runs inside `embed.py serve`
# ---------------------------------------------------------------------------


class Searcher:
    """Every vector of one model's folders as one float32 matrix, rebuilt when
    the store's generation moves. numpy is imported here, not at module level,
    so the daemon can keep importing this file for free."""

    def __init__(self, conn: sqlite3.Connection,
                 embed_fn: Callable[[list[str]], list[list[float]]], model: str) -> None:
        import numpy as np
        self._np = np
        self.conn, self.embed_fn, self.model = conn, embed_fn, model
        self._generation: str | None = None
        self._ids = np.zeros(0, dtype=np.int64)
        self._file_ids = np.zeros(0, dtype=np.int64)
        self._folders: list[str] = []
        self._matrix = np.zeros((0, 0), dtype=np.float32)

    def _refresh(self) -> None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = 'generation'").fetchone()
        gen = row[0] if row else "0"
        if gen == self._generation:
            return
        np = self._np
        rows = self.conn.execute(
            "SELECT c.id, c.file_id, f.folder, c.vector FROM chunks c "
            "JOIN files f ON f.id = c.file_id JOIN folders d ON d.name = f.folder "
            "WHERE d.model = ? ORDER BY c.id", (self.model,)).fetchall()
        self._ids = np.array([r[0] for r in rows], dtype=np.int64)
        self._file_ids = np.array([r[1] for r in rows], dtype=np.int64)
        self._folders = [r[2] for r in rows]
        self._matrix = (np.frombuffer(b"".join(r[3] for r in rows), dtype=np.float32)
                        .reshape(len(rows), -1) if rows else np.zeros((0, 0), dtype=np.float32))
        self._generation = gen

    def search(self, query: str, limit: int, folders: list[str] | None, per_note: int = 1) -> dict:
        """The top `limit` notes, ranked by their best chunk: a card is a note, not a
        passage. Each hit also carries up to `per_note` of that note's best
        passages -- answer mode needs more than the one most *like* the
        question, which is often not the one that answers it. Which notes come
        back does not depend on `per_note`."""
        np = self._np
        t0 = time.perf_counter()
        self._refresh()
        if len(self._ids) == 0:
            return {"hits": [], "model": self.model, "took_ms": 0}
        q = np.asarray(self.embed_fn([query])[0], dtype=np.float32)
        q /= max(float(np.linalg.norm(q)), 1e-12)
        scores = self._matrix @ q
        if folders is not None:
            mask = np.fromiter((f in folders for f in self._folders), dtype=bool,
                               count=len(self._folders))
            scores = np.where(mask, scores, -np.inf)
        # Notes in rank order, each with its chunks in rank order. The scan goes
        # on past `limit` notes only to fill the chosen notes' extra passages.
        best: dict[int, list[tuple[float, int]]] = {}
        wanted = limit * per_note
        taken = 0
        for i in np.argsort(-scores):
            if taken >= wanted or not np.isfinite(scores[i]):
                break
            fid = int(self._file_ids[i])
            if fid not in best:
                if len(best) >= limit:
                    if per_note == 1:
                        break
                    continue
                best[fid] = []
            if len(best[fid]) < per_note:
                best[fid].append((float(scores[i]), int(self._ids[i])))
                taken += 1
        hits = []
        for ranked in best.values():
            passages = []
            head = None
            for score, cid in ranked:
                r = self.conn.execute(
                    "SELECT d.name, d.path, f.rel_path, f.title, c.heading, c.text, c.start_line "
                    "FROM chunks c JOIN files f ON f.id = c.file_id JOIN folders d ON d.name = f.folder "
                    "WHERE c.id = ?", (cid,)).fetchone()
                if r is None:   # deleted between the matrix load and now
                    continue
                head = head or r
                passages.append({"heading": r[4], "chunk": r[5], "start_line": r[6],
                                 "score": round(score, 4)})
            if head is None:
                continue
            top = passages[0]
            hits.append({"folder": head[0], "path": str(Path(head[1]) / head[2]), "rel_path": head[2],
                         "title": head[3], "heading": top["heading"], "chunk": top["chunk"],
                         "score": top["score"], "start_line": top["start_line"], "passages": passages})
        return {"hits": hits, "model": self.model,
                "took_ms": int((time.perf_counter() - t0) * 1000)}


def _fail(status: int, error: str, hint: str | None = None) -> dict:
    return {"ok": False, "status": status, "error": error, **({"hint": hint} if hint else {})}


def handle_request(conn: sqlite3.Connection, req: dict,
                   get_searcher: Callable[[str], Searcher],
                   get_embed: Callable[[str], Callable[[list[str]], list[list[float]]]]) -> dict:
    """One worker request. Validation the daemon already did is repeated: the
    worker is also a CLI, and a reply is cheaper than a crash."""
    op = req.get("op")
    try:
        if op == "search":
            query = req.get("query")
            if not isinstance(query, str) or not query.strip():
                return _fail(400, "query must be a non-empty string")
            limit = max(1, min(50, int(req.get("limit") or 8)))
            per_note = max(1, min(5, int(req.get("per_note") or 1)))
            models = dict(conn.execute("SELECT name, model FROM folders").fetchall())
            if not models:
                return _fail(404, "no folders are indexed", "POST /v1/index/folders with a path first")
            wanted = req.get("folders") or None
            if wanted is not None:
                unknown = [f for f in wanted if f not in models]
                if unknown:
                    return _fail(404, f"no indexed folder named {', '.join(map(repr, unknown))}")
            used = {models[f] for f in (wanted or models)}
            if len(used) > 1:
                return _fail(409, f"these folders were indexed with different models: "
                             f"{', '.join(sorted(used))}", "search one model's folders at a time")
            return {"ok": True, **get_searcher(used.pop()).search(query, limit, wanted, per_note)}
        if op == "embed":
            texts = req.get("texts")
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                return _fail(400, "texts must be a list of strings")
            model = str(req.get("model") or DEFAULT_MODEL)
            return {"ok": True, "vectors": get_embed(model)(texts), "model": model}
    except EmbedError as e:
        return _fail(404, str(e))
    return _fail(400, f"unknown op {op!r}")


def serve_loop(lines: Iterable[str], write: Callable[[str], object],
               handle: Callable[[dict], dict]) -> None:
    for line in lines:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be an object")
            reply = handle(req)
        except Exception as e:  # noqa: BLE001 -- a bad request must not end the worker
            reply = _fail(500, f"{type(e).__name__}: {e}")
        write(json.dumps(reply) + "\n")


def _serve(db: Path | None) -> int:
    """The persistent search worker. One JSON request per stdin line, one reply
    per stdout line; exits after MODELCTL_EMBED_IDLE seconds (default 600) of
    silence, and the daemon respawns it on the next search."""
    import select

    # The protocol keeps the real stdout; fd 1 becomes stderr, so a library
    # that prints cannot corrupt a reply.
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    conn = connect(db)
    loaded: dict[str, tuple[Callable[[list[str]], list[list[float]]], Callable[[str], int], int]] = {}
    searchers: dict[str, Searcher] = {}

    def fns(repo: str):
        if repo not in loaded:      # one model resident at a time
            loaded.clear()
            searchers.clear()
            loaded[repo] = _load_model(repo)
        return loaded[repo]

    def get_searcher(repo: str) -> Searcher:
        embed_fn = fns(repo)[0]
        if repo not in searchers:
            searchers[repo] = Searcher(conn, embed_fn, repo)
        return searchers[repo]

    idle = float(os.environ.get("MODELCTL_EMBED_IDLE", "600"))

    def lines():
        while True:
            ready, _, _ = select.select([sys.stdin], [], [], idle)
            if not ready:
                return
            line = sys.stdin.readline()
            if not line:
                return
            yield line

    serve_loop(lines(), proto.write,
               lambda req: handle_request(conn, req, get_searcher, lambda m: fns(m)[0]))
    return 0


def _load_model(repo: str) -> tuple[Callable[[list[str]], list[list[float]]], Callable[[str], int], int]:
    """(embed, count_tokens, max_seq_length). The only place torch is imported."""
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
    sv = sub.add_parser("serve", help="the persistent search worker modelctld talks to")
    sv.add_argument("--db", type=Path, help="index file (default: MODELCTL_VAULT_INDEX or ~/.local/share)")
    args = p.parse_args(argv)
    if args.cmd == "serve":
        return _serve(args.db)

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
            # The folder keeps the size it asked for, so the settings-mismatch
            # check compares request with request; the log says what was used.
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
