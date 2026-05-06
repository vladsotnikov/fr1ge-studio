#!/usr/bin/env python3
"""
Embedding-based matching between transcript segments and local media assets.

Reads JSON from stdin:
{
  "segments": [{ "id": str|int, "text": str }, ...],
  "assets":   [{ "fileIndex": int, "framePaths": [str, ...], "text": str }, ...],
  "cacheDir": str  # optional path for embedding cache
}

For every (segment, asset) pair returns blended cosine-similarity:
  score = 0.55 * text<->image  +  0.45 * text<->summary-text

Writes to stdout:
{
  "ok": true,
  "scores": { "<segId>": { "<fileIndex>": float, ... }, ... },
  "diag":   { "imageEmbedded": int, "textEmbedded": int, "missingFrames": int }
}

On failure prints { "ok": false, "error": "..." } and exits 1.
"""
import json
import os
import sys
import hashlib
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# Allow first-run download of CLIP. After it's cached, OFFLINE can be flipped on.
# We don't force OFFLINE here so that fresh installs still work.

MODEL_ID = "openai/clip-vit-base-patch32"


def _err(msg: str) -> int:
    sys.stdout.write(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.stdout.write("\n")
    return 1


def _hash_path(p: str) -> str:
    try:
        st = os.stat(p)
        h = hashlib.sha1()
        h.update(p.encode("utf-8"))
        h.update(str(st.st_size).encode("utf-8"))
        h.update(str(int(st.st_mtime)).encode("utf-8"))
        return h.hexdigest()
    except Exception:
        return hashlib.sha1(p.encode("utf-8")).hexdigest()


def _hash_text(s: str) -> str:
    return hashlib.sha1(("t::" + (s or "")).encode("utf-8")).hexdigest()


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return _err("empty stdin")

    try:
        payload = json.loads(raw)
    except Exception as e:
        return _err(f"bad json: {e}")

    segments = payload.get("segments") or []
    assets = payload.get("assets") or []
    cache_dir = payload.get("cacheDir") or ""
    if cache_dir:
        Path(cache_dir).mkdir(parents=True, exist_ok=True)

    if not segments or not assets:
        sys.stdout.write(json.dumps({"ok": True, "scores": {}, "diag": {"imageEmbedded": 0, "textEmbedded": 0, "missingFrames": 0}}, ensure_ascii=False))
        return 0

    # Lazy imports — model load is the slow part.
    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import CLIPModel, CLIPProcessor
    except Exception as e:
        return _err(f"import failed: {e}")

    try:
        # Allow auto-download on first run; subsequent runs use cache.
        processor = CLIPProcessor.from_pretrained(MODEL_ID)
        model = CLIPModel.from_pretrained(MODEL_ID)
        model.eval()
    except Exception as e:
        return _err(f"clip load failed: {e}")

    device = "cpu"
    # On Apple Silicon try MPS for ~3-5x speedup.
    try:
        if torch.backends.mps.is_available():
            device = "mps"
            model = model.to(device)
    except Exception:
        device = "cpu"

    def cache_load(name: str):
        if not cache_dir:
            return None
        p = Path(cache_dir) / f"{name}.npy"
        if p.exists():
            try:
                return np.load(p)
            except Exception:
                return None
        return None

    def cache_save(name: str, arr) -> None:
        if not cache_dir:
            return
        try:
            np.save(Path(cache_dir) / f"{name}.npy", arr)
        except Exception:
            pass

    def _to_tensor(out):
        # transformers 4.x: get_*_features returns Tensor.
        # transformers 5.x: may return BaseModelOutputWithPooling — pull
        # pooler_output (or last_hidden_state[:,0] as fallback).
        if hasattr(out, "cpu"):
            return out
        if hasattr(out, "pooler_output") and out.pooler_output is not None:
            return out.pooler_output
        if hasattr(out, "last_hidden_state"):
            return out.last_hidden_state[:, 0, :]
        raise RuntimeError(f"unexpected feature type: {type(out).__name__}")

    def embed_text(s: str):
        s = (s or "").strip()
        if not s:
            return None
        key = _hash_text(s)
        cached = cache_load(f"txt_{key}")
        if cached is not None:
            return cached
        with torch.no_grad():
            inp = processor(text=[s[:480]], return_tensors="pt", padding=True, truncation=True).to(device)
            try:
                feat = model.get_text_features(**inp)
            except Exception:
                # transformers 5.x path — call submodels and project manually.
                txt_out = model.text_model(**inp)
                pooled = txt_out.pooler_output if hasattr(txt_out, "pooler_output") else txt_out[1]
                feat = model.text_projection(pooled)
            v = _to_tensor(feat).cpu().numpy()[0]
            v = v / (np.linalg.norm(v) + 1e-9)
        cache_save(f"txt_{key}", v)
        return v

    def embed_image(p: str):
        if not p or not os.path.exists(p):
            return None
        key = _hash_path(p)
        cached = cache_load(f"img_{key}")
        if cached is not None:
            return cached
        try:
            img = Image.open(p).convert("RGB")
        except Exception:
            return None
        with torch.no_grad():
            inp = processor(images=img, return_tensors="pt").to(device)
            try:
                feat = model.get_image_features(**inp)
            except Exception:
                vis_out = model.vision_model(**inp)
                pooled = vis_out.pooler_output if hasattr(vis_out, "pooler_output") else vis_out[1]
                feat = model.visual_projection(pooled)
            v = _to_tensor(feat).cpu().numpy()[0]
            v = v / (np.linalg.norm(v) + 1e-9)
        cache_save(f"img_{key}", v)
        return v

    # Embed segments (text only)
    seg_vecs = {}
    text_emb_count = 0
    for seg in segments:
        sid = seg.get("id")
        v = embed_text(seg.get("text") or "")
        if v is not None:
            seg_vecs[sid] = v
            text_emb_count += 1

    # Embed assets: average of frame embeddings + text embedding of summary/tags
    asset_img_vecs = {}
    asset_txt_vecs = {}
    img_emb_count = 0
    missing_frames = 0
    for asset in assets:
        fi = asset.get("fileIndex")
        frames = asset.get("framePaths") or []
        text = asset.get("text") or ""

        frame_vs = []
        for fp in frames[:4]:  # cap at 4 frames per asset
            v = embed_image(fp)
            if v is not None:
                frame_vs.append(v)
                img_emb_count += 1
            else:
                missing_frames += 1
        if frame_vs:
            arr = np.stack(frame_vs, axis=0)
            avg = arr.mean(axis=0)
            avg = avg / (np.linalg.norm(avg) + 1e-9)
            asset_img_vecs[fi] = avg

        tv = embed_text(text)
        if tv is not None:
            asset_txt_vecs[fi] = tv

    # Build score matrix
    scores = {}
    for seg in segments:
        sid = seg.get("id")
        sv = seg_vecs.get(sid)
        if sv is None:
            scores[str(sid)] = {}
            continue
        row = {}
        for asset in assets:
            fi = asset.get("fileIndex")
            iv = asset_img_vecs.get(fi)
            tv = asset_txt_vecs.get(fi)
            img_sim = float(np.dot(sv, iv)) if iv is not None else 0.0
            txt_sim = float(np.dot(sv, tv)) if tv is not None else 0.0
            # CLIP cosine for unrelated pairs hovers ~0.18-0.22; matching pairs ~0.28-0.40.
            # Re-center to [-1, 1]-ish by subtracting baseline so "no match" is ~0.
            img_centered = (img_sim - 0.20) * 5.0  # ~0.05 raw -> 0.25, ~0.30 raw -> 0.5
            txt_centered = (txt_sim - 0.20) * 5.0
            blended = 0.0
            weight = 0.0
            if iv is not None:
                blended += 0.55 * img_centered
                weight += 0.55
            if tv is not None:
                blended += 0.45 * txt_centered
                weight += 0.45
            if weight > 0:
                blended /= weight
            row[str(fi)] = round(blended, 4)
        scores[str(sid)] = row

    out = {
        "ok": True,
        "scores": scores,
        "diag": {
            "imageEmbedded": img_emb_count,
            "textEmbedded": text_emb_count,
            "missingFrames": missing_frames,
            "device": device
        }
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
