#!/usr/bin/env python3
"""
Persistent BLIP captioning daemon.

Reads JSON commands from stdin (one JSON object per line), produces JSON
responses on stdout (one per line). Keeps the model loaded across requests so
each call avoids ~3-5s of Python+PyTorch cold-start that we used to pay per
file when invoked as a one-shot script.

Protocol:
  Request : {"paths": ["/abs/path/to/frame1.jpg", ...]}
  Response: {"caption": "string", "captions": ["string", ...], "error": null}
  On EOF on stdin → exit cleanly.

Speed wins over the one-shot script:
  - Cold-start once, not per file (~3s × N files saved)
  - Apple Silicon Metal (MPS) device when available — 5-10× CPU
  - Batch all frames of one request through model.generate in a single call
    instead of looping (3-4× over per-frame loop)
"""

import json
import os
import sys
import traceback

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
from PIL import Image
from transformers import BlipProcessor, BlipForConditionalGeneration


MODEL_ID = "Salesforce/blip-image-captioning-base"


def pick_device():
    # Prefer Apple Metal Performance Shaders → 5-10× faster than CPU on M-series.
    if torch.backends.mps.is_available():
        return torch.device("mps"), torch.float16
    if torch.cuda.is_available():
        return torch.device("cuda"), torch.float16
    return torch.device("cpu"), torch.float32


def write_response(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        device, dtype = pick_device()
        processor = BlipProcessor.from_pretrained(MODEL_ID, local_files_only=True)
        # Try safetensors first — much faster to load and lower IO contention
        # when several daemons spawn together. Fall back to .bin if not present.
        try:
            model = BlipForConditionalGeneration.from_pretrained(
                MODEL_ID,
                local_files_only=True,
                use_safetensors=True,
                torch_dtype=dtype if device.type != "cpu" else torch.float32
            ).to(device)
        except Exception:
            model = BlipForConditionalGeneration.from_pretrained(
                MODEL_ID,
                local_files_only=True,
                use_safetensors=False,
                torch_dtype=dtype if device.type != "cpu" else torch.float32
            ).to(device)
        model.eval()
    except Exception as e:
        write_response({"caption": "", "captions": [], "error": f"BLIP init failed: {e}"})
        return 1

    # Signal "ready" so the parent process knows the daemon has loaded the model
    # and is accepting commands.
    write_response({"ready": True, "device": str(device)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            paths = [p for p in req.get("paths", []) if p]
            # Optional: groups = [n1, n2, ...] partitions paths back into per-file
            # buckets so multiple file requests can be coalesced into one big
            # GPU batch. Daemon returns {"groups": [{caption, captions}, ...]}.
            groups = req.get("groups")

            if not paths:
                if groups is not None:
                    write_response({"groups": [{"caption": "", "captions": []} for _ in groups], "error": None})
                else:
                    write_response({"caption": "", "captions": [], "error": None})
                continue

            # Open all images once. Track which paths fail so groups stay aligned.
            opened = []
            ok_flags = []
            for p in paths:
                try:
                    opened.append(Image.open(p).convert("RGB"))
                    ok_flags.append(True)
                except Exception:
                    ok_flags.append(False)

            if not opened:
                if groups is not None:
                    write_response({"groups": [{"caption": "", "captions": []} for _ in groups], "error": None})
                else:
                    write_response({"caption": "", "captions": [], "error": None})
                continue

            inputs = processor(images=opened, return_tensors="pt").to(device)
            if dtype == torch.float16 and "pixel_values" in inputs:
                inputs["pixel_values"] = inputs["pixel_values"].to(dtype)

            with torch.no_grad():
                outputs = model.generate(**inputs, max_new_tokens=24, num_beams=1)

            # Decode in original-path order, skipping the slots that failed to open.
            all_captions = []
            decoded_iter = iter(outputs)
            for ok in ok_flags:
                if ok:
                    try:
                        out = next(decoded_iter)
                        cap = processor.decode(out, skip_special_tokens=True).strip()
                    except StopIteration:
                        cap = ""
                else:
                    cap = ""
                all_captions.append(cap)

            if groups is not None:
                # Slice captions back into per-file results.
                results = []
                offset = 0
                for n in groups:
                    n = int(n)
                    chunk = [c for c in all_captions[offset:offset + n] if c]
                    primary = chunk[0] if chunk else ""
                    results.append({"caption": primary, "captions": chunk})
                    offset += n
                write_response({"groups": results, "error": None})
            else:
                non_empty = [c for c in all_captions if c]
                primary = non_empty[0] if non_empty else ""
                write_response({"caption": primary, "captions": non_empty, "error": None})
        except Exception as e:
            err = {"error": f"BLIP error: {e}\n{traceback.format_exc()[:400]}"}
            if "groups" in locals() and groups is not None:
                err["groups"] = [{"caption": "", "captions": []} for _ in groups]
            else:
                err["caption"] = ""
                err["captions"] = []
            write_response(err)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
