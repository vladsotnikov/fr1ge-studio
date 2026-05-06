#!/usr/bin/env python3
"""
One-shot downloader for CLIP (openai/clip-vit-base-patch32).

Pulls the model into the standard HF cache so embed_match.py can run with
HF_HUB_OFFLINE=1 (which is what the production server sets).

Usage:
    .venv-blip/bin/python tools/download_clip.py [--cache-dir PATH]

If --cache-dir is omitted we use $HF_HOME or ~/.cache/huggingface.
"""
import os
import sys
import argparse


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default=None,
                        help="Directory to use as HF_HOME / TRANSFORMERS_CACHE")
    args = parser.parse_args()

    # Disable OFFLINE flags so the download actually goes out.
    for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        if k in os.environ:
            del os.environ[k]
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    if args.cache_dir:
        os.environ["HF_HOME"] = args.cache_dir
        os.environ["TRANSFORMERS_CACHE"] = args.cache_dir

    cache = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
    print(f"[clip-download] cache: {cache}", flush=True)

    try:
        from transformers import CLIPModel, CLIPProcessor
    except Exception as e:
        print(f"[clip-download] FAIL: cannot import transformers: {e}", flush=True)
        return 2

    model_id = "openai/clip-vit-base-patch32"
    print(f"[clip-download] fetching {model_id} (~600MB)...", flush=True)
    try:
        CLIPProcessor.from_pretrained(model_id)
        CLIPModel.from_pretrained(model_id)
    except Exception as e:
        print(f"[clip-download] FAIL: {e}", flush=True)
        return 1

    print("[clip-download] OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
