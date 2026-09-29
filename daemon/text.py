#!/usr/bin/env python3
"""
text - chat completion with an MLX model from the modelctl catalog.

The fallback behind the workbench vault-search plugin's answer mode, for when
LM Studio is not running, and the start of P6's /v1/generate/text. One model,
one conversation, one reply: no streaming, no fan-out yet.

Importing this module is cheap on purpose, like asr.py: validation and the
<think> stripper are plain functions, so modelctld refuses a bad request before
a job exists. mlx_lm is imported inside `generate()`.

Usage
-----
    .venv/bin/python text.py --model mlx-community/Qwen3-0.6B-4bit --messages msgs.json
    .venv/bin/python text.py --model R --messages msgs.json --out result.json   # what modelctld runs
"""

from __future__ import annotations

import json
import re
from pathlib import Path

DEFAULT_MODEL = "mlx-community/Qwen3-0.6B-4bit"
DEFAULT_MAX_TOKENS = 1024
MAX_MESSAGES = 50
MAX_CHARS = 200_000
ROLES = frozenset({"system", "user", "assistant"})

_THINK = re.compile(r"<think>.*?</think>", re.S)


class TextError(Exception):
    """A request text.py cannot run. The message is written for the user."""


def validate_messages(raw: object) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise TextError("messages must be a non-empty list")
    if len(raw) > MAX_MESSAGES:
        raise TextError(f"at most {MAX_MESSAGES} messages")
    out: list[dict] = []
    total = 0
    for i, m in enumerate(raw):
        if not isinstance(m, dict) or m.get("role") not in ROLES or not isinstance(m.get("content"), str):
            raise TextError(f"message {i} must be {{role: system|user|assistant, content: string}}")
        total += len(m["content"])
        out.append({"role": m["role"], "content": m["content"]})
    if total > MAX_CHARS:
        raise TextError(f"messages total {total} characters; the limit is {MAX_CHARS}")
    return out


def strip_think(s: str) -> str:
    """Drop reasoning blocks. An unclosed leading block means the budget ran out
    mid-thought, so there is no answer; an orphan close tag means the template
    opened the block in the prompt."""
    s = _THINK.sub("", s)
    if "</think>" in s:
        s = s.rsplit("</think>", 1)[1]
    if s.lstrip().startswith("<think>"):
        return ""
    return s.strip()


def generate(messages: list[dict], model_dir: Path, *, repo: str, max_tokens: int,
             on_progress=None) -> dict:
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(str(model_dir))
    # enable_thinking is Qwen3's switch; templates that do not know it ignore it.
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False,
                                           enable_thinking=False)
    parts: list[str] = []
    last = -1
    for i, resp in enumerate(stream_generate(model, tokenizer, prompt, max_tokens=max_tokens,
                                             sampler=make_sampler(temp=0.2)), start=1):
        parts.append(resp.text)
        pct = 100 * i // max_tokens
        if on_progress is not None and pct >= last + 5:
            on_progress(pct)
            last = pct
    return {"text": strip_think("".join(parts)), "model": repo}


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    import modelctl as mc

    p = argparse.ArgumentParser(prog="text", description="chat completion over the modelctl catalog")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"repo id (default {DEFAULT_MODEL})")
    p.add_argument("--messages", type=Path, required=True, help="JSON file: [{role, content}, ...]")
    p.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    p.add_argument("--out", type=Path, help="write {text, model} as JSON here instead of printing")
    p.add_argument("--consume", action="store_true", help="delete the --messages file once read")
    args = p.parse_args(argv)

    try:
        raw = args.messages.read_text(encoding="utf-8")
        if args.consume:
            args.messages.unlink(missing_ok=True)   # a prompt quotes private notes; do not leave it in /tmp
        messages = validate_messages(json.loads(raw))
        model_dir = mc.resolve(args.model)
        if model_dir is None:
            raise TextError(f"{args.model} is not downloaded -- modelctl pull {args.model}")
        print(f"loading {args.model}", flush=True)
        result = generate(messages, Path(model_dir), repo=args.model, max_tokens=args.max_tokens,
                          on_progress=lambda pct: print(f"generating {pct:3d}%", flush=True))
    except (TextError, OSError, ValueError) as e:
        # The daemon surfaces a failed job's last line verbatim: this is the error the user sees.
        print(f"error: {e}", file=sys.stderr, flush=True)
        return 1

    if args.out is not None:
        args.out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"done: {len(result['text'])} chars", flush=True)
    else:
        print(result["text"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
