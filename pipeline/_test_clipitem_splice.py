"""Standalone test for the #103 ClipItem splice/unzip logic (no WSL/render needed).

Run: wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/_test_clipitem_splice.py
"""
import sys
sys.path.insert(0, "/mnt/c/apps/rushcut")

from pathlib import Path
from pipeline.render import ClipItem, unzip_clip_items

failures = []


def check(label, cond):
    if not cond:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


# Distinguishable per-item values so an index-misalignment bug actually fails
# the test (a generic/placeholder fixture would pass even with an off-by-one).
clip_a = ClipItem(path=Path("clip_a.mp4"), volume=0.7, zoom_vf="zoom_a")
clip_b = ClipItem(path=Path("clip_b.mp4"), volume=0.0, zoom_vf=None)  # explicit mute
clip_c = ClipItem(path=Path("clip_c.mp4"), volume=1.3, zoom_vf="zoom_c")

items = [clip_a, clip_b, clip_c]

# Intro + outro splice, same shape as render.py Step 4.
intro = ClipItem(path=Path("intro_card.mp4"), volume=1.0, zoom_vf=None, kind="card")
outro = ClipItem(path=Path("end_card.mp4"), volume=1.0, zoom_vf=None, kind="card")
items = [intro] + items
items = items + [outro]

paths, volumes, zoom_vfs = unzip_clip_items(items)

check("length is clips+2 cards", len(paths) == 5 == len(volumes) == len(zoom_vfs))
check("index 0 is intro card", paths[0] == Path("intro_card.mp4"))
check("index 0 volume is 1.0", volumes[0] == 1.0)
check("index 0 zoom_vf is None", zoom_vfs[0] is None)
check("index 0 kind is 'card'", items[0].kind == "card")
check("index 1 kind defaults to 'clip'", items[1].kind == "clip")
check("index 4 kind is 'card'", items[4].kind == "card")
check("index 1 is clip_a (path)", paths[1] == Path("clip_a.mp4"))
check("index 1 volume is clip_a's 0.7, not shifted", volumes[1] == 0.7)
check("index 1 zoom_vf is clip_a's 'zoom_a', not shifted", zoom_vfs[1] == "zoom_a")
check("index 2 is clip_b (path)", paths[2] == Path("clip_b.mp4"))
check("index 2 volume stays explicit 0.0 mute, not coerced to 1.0", volumes[2] == 0.0)
check("index 3 is clip_c (path)", paths[3] == Path("clip_c.mp4"))
check("index 3 zoom_vf is clip_c's 'zoom_c', not shifted", zoom_vfs[3] == "zoom_c")
check("index 4 is outro card", paths[4] == Path("end_card.mp4"))
check("index 4 volume is 1.0", volumes[4] == 1.0)

# zoom_vfs sentinel contract: collapses to None when NO item has a zoom_vf.
no_zoom_items = [
    ClipItem(path=Path("x.mp4"), volume=1.0, zoom_vf=None),
    ClipItem(path=Path("y.mp4"), volume=1.0, zoom_vf=None),
]
_, _, no_zoom_result = unzip_clip_items(no_zoom_items)
check("zoom_vfs collapses to None when no item has a zoom vf", no_zoom_result is None)

if failures:
    print(f"\n{len(failures)} FAILURE(S)")
    sys.exit(1)
print("\nall checks passed")
