#!/usr/bin/env python3
import json
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from PIL import Image
from transformers import BlipProcessor, BlipForConditionalGeneration


MODEL_ID = "Salesforce/blip-image-captioning-base"


def main() -> int:
    image_paths = [arg for arg in sys.argv[1:] if arg.strip()]
    if not image_paths:
      print(json.dumps({"caption": "", "captions": []}, ensure_ascii=False))
      return 0

    # The app must work offline after the first model download. Without this,
    # transformers tries a network HEAD request on every run and the cutter falls
    # back to useless titles when DNS/network is blocked.
    processor = BlipProcessor.from_pretrained(MODEL_ID, local_files_only=True)
    model = BlipForConditionalGeneration.from_pretrained(
        MODEL_ID,
        local_files_only=True,
        use_safetensors=False,
    )

    captions = []
    for path in image_paths:
        image = Image.open(path).convert("RGB")
        inputs = processor(images=image, return_tensors="pt")
        output = model.generate(**inputs, max_new_tokens=24)
        caption = processor.decode(output[0], skip_special_tokens=True).strip()
        if caption:
            captions.append(caption)

    primary = captions[0] if captions else ""
    print(json.dumps({"caption": primary, "captions": captions}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
