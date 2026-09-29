# daemon — `modelctl` and the runtimes behind the plugins

The Python side of Workbench: the model catalog (`modelctl.py`), its loopback HTTP transport
(`modelctld.py`, served on `127.0.0.1:8077`), and the runtime scripts the `/v1/generate/*`
routes run as job subprocesses.

| File | Owns | Used by |
|---|---|---|
| `modelctl.py` | the catalog: `pull`, `mv`, `rm`, `ls`, `resolve()` | everything |
| `modelctld.py` | HTTP routes, jobs, the embed worker | every daemon-backed plugin |
| `asr.py` | mlx-whisper, parakeet-mlx | `transcribe` |
| `embed.py` | chunker, SQLite index, search worker | `vault-search` |
| `text.py` | mlx-lm | `vault-search` (answer fallback) |
| `image.py` | mflux: generate, edit, upscale | `image-gen` |
| `image_gen.py` | diffusers: a standalone CLI, not wired to the daemon | — |

The full reference, including flags, routes and troubleshooting, is `MANUAL.md` in the vault at
`02_Projects/Huggingface/`.

## Where things live

Only the source is here. The environment and personal data are not in the repo:

- **venv**: `~/work/tools/huggingface/.venv` (Python 3.12, managed with `uv`).
  `requirements.txt` is its `uv pip freeze`. Refresh it whenever a runtime adds a dependency.
- **`modelctl` on PATH**: `~/bin/modelctl`, a shim that runs this folder's `modelctl.py` with that
  venv's Python.
- **Test audio**: `~/work/tools/huggingface/samples/`. It holds personal recordings and is never
  committed.

The daemon runs whatever is checked out here. Restart `modelctl serve` after switching branches.

## Tests

stdlib `unittest`. Weights are never loaded, because the runtimes are injected or faked:

```bash
cd daemon && ~/work/tools/huggingface/.venv/bin/python -m unittest discover -s tests
```
