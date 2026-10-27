#!/usr/bin/env python3
"""Convert WhisperX JSON output to SyncReader's word-timing JSON format.

Usage:
  python scripts/convert_whisperx.py whisperx-output.json aligned-words.json

Expected WhisperX shape: {"segments": [{"words": [{"word": "Hello", "start": 0.1, "end": 0.4}, ...]}]}
"""
import json
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("Usage: python scripts/convert_whisperx.py whisperx-output.json aligned-words.json")
source, destination = map(Path, sys.argv[1:])
data = json.loads(source.read_text(encoding="utf-8"))
words = []
for segment in data.get("segments", []):
    for item in segment.get("words", []):
        text = str(item.get("word", item.get("text", ""))).strip()
        start, end = item.get("start"), item.get("end")
        if text and start is not None and end is not None:
            words.append({"text": text, "start": float(start), "end": float(end)})
if not words:
    raise SystemExit("No word timestamps found. Make sure WhisperX output includes aligned segment words.")
destination.write_text(json.dumps({"words": words}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Wrote {len(words)} word timestamps to {destination}")
