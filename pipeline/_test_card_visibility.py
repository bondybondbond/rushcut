#!/usr/bin/env python3
"""#190 -- measure how long each title card is fully opaque in a REAL render.

Builds 4 synthetic 29.97 fps clips (real DJI footage is 30000/1001; a 30 fps fixture
trips the known xfade timebase rule and skews the run), puts solid-colour cards at the
start / middle / end (--consecutive: two back to back at the start), renders through
pipeline/run.py (the normal path: 7+ elements => segmented U1g render) and measures, per
frame at 10 fps, how long each card is FULLY opaque.

"Fully opaque" = all four quadrant-centre pixels are the card colour AND the whole-frame
mean colour matches the run's steady middle (+-4 per channel). The mean check is what makes
a wipe measurable: a wipe clears one side first, so sparse pixels alone overstate it.

Run from WSL (needs an NTFS work dir the manifest can live in):
  python3 pipeline/_test_card_visibility.py --work-dir /mnt/c/Users/<you>/AppData/Local/Temp/claude/<session>/scratch/cardtest       --res 1080p|4k --transition crossfade|wipe|none [--open-close] [--consecutive] [--keep]

Exit 0 = pass, 1 = fail. FAILS on any segmented-render fallback (a monolithic fallback must
never count as validation), a wrong run count, or a card shorter than 1.9 s fully opaque
(crossfade/wipe) / not ~3.0 s (none). Expected with a 1.5 s crossfade: a middle card is
~2.0 s opaque; a first/last card is ~3.5 s (it has only one neighbouring cut -- the uniform
rule gives every card the same length). The work dir is removed at the end unless --keep.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
G, M = "#00FF00", "#FF00FF"


def win(p: Path) -> str:
    s = str(p)
    return f"{s[5].upper()}:{s[6:]}" if s.startswith("/mnt/") else s


def klass(r, g, b):
    if r < 6 and g >= 213 and b < 6:
        return "G"
    if r >= 250 and g <= 45 and b >= 250:
        return "M"
    return None


def ffraw(path, vf):
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", vf, "-f", "rawvideo", "-"],
                          capture_output=True).stdout


def measure(out):
    quad = ffraw(out, "fps=10,scale=2:2:flags=neighbor,format=rgb24")
    mean = ffraw(out, "fps=10,scale=1:1:flags=area,format=rgb24")
    n = min(len(quad) // 12, len(mean) // 3)
    cls = []
    for f in range(n):
        ks = {klass(quad[f * 12 + k * 3], quad[f * 12 + k * 3 + 1], quad[f * 12 + k * 3 + 2]) for k in range(4)}
        cls.append(ks.pop() if len(ks) == 1 else None)
    px = [tuple(mean[f * 3:f * 3 + 3]) for f in range(n)]
    runs, f = [], 0
    while f < n:
        if cls[f] is None:
            f += 1
            continue
        e = f
        while e + 1 < n and cls[e + 1] == cls[f]:
            e += 1
        mid = (f + e) // 2
        ref = px[mid]
        lo = hi = mid
        while lo - 1 >= f and all(abs(px[lo - 1][k] - ref[k]) <= 4 for k in range(3)):
            lo -= 1
        while hi + 1 <= e and all(abs(px[hi + 1][k] - ref[k]) <= 4 for k in range(3)):
            hi += 1
        runs.append(round((hi - lo + 1) / 10, 1))
        f = e + 1
    return runs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--res", choices=["1080p", "4k"], default="1080p")
    ap.add_argument("--transition", choices=["crossfade", "wipe", "none"], default="crossfade")
    ap.add_argument("--open-close", action="store_true")
    ap.add_argument("--consecutive", action="store_true", help="two cards back to back at the start (green then magenta)")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    work = Path(a.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    W, H = (3840, 2160) if a.res == "4k" else (1920, 1080)
    clips = []
    for i in range(4):
        f = work / f"clip_{i}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
             f"color=c=0x2030A0:s={W}x{H}:r=30000/1001:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6",
             "-vf", "drawbox=x='mod(t*200,iw)':y=100:w=200:h=200:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(f)],
            check=True)
        clips.append({"id": f"c{i}", "filename": f.name, "local_path": win(f), "duration_ms": 6000,
                      "in_ms": 0, "out_ms": 6000, "include": 1, "clip_volume": 1.0,
                      "zoom_mode": "none", "width": W, "height": H, "has_audio": True})
    G, M = "#00FF00", "#FF00FF"
    spec = (("A", 0, G), ("A2", 0, M), ("B", 2, G), ("C", -1, G)) if a.consecutive else            (("A", 0, G), ("B", 2, G), ("C", -1, G))
    cards = [{"text": t, "color": c, "position": p} for t, p, c in spec]
    settings = {"transition": a.transition, "cards": cards, "output_resolution": a.res, "music_mood": "none"}
    if a.open_close:
        settings.update(opening_transition="crossfade", closing_transition="crossfade")
    out = work / "out.mp4"
    manifest = {"job_id": "cardvis", "clips": clips, "settings": settings, "output_path": win(out)}
    mp = work / "manifest.json"
    mp.write_text(json.dumps(manifest))

    r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "run.py"), "--job-id", "cardvis",
                        "--manifest-path", str(mp)], capture_output=True, text=True)
    log = r.stdout + r.stderr
    ok = r.returncode == 0 and out.exists()
    fallback = "[U1g][fallback]" in log or "falling back to monolithic" in log.lower()
    runs, dur = [], 0.0
    if ok:
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout)
        runs = measure(out)
    print(f"res={a.res} transition={a.transition} open_close={a.open_close} consecutive={a.consecutive} "
          f"film_dur={dur:.1f}s opaque_runs_s={runs} segmented_fallback={fallback}")
    passed = ok and not fallback and len(runs) == len(cards) and all(
        (abs(x - 3.0) < 0.15) if a.transition == "none" else (x >= 1.9) for x in runs)
    if not passed:
        print("FAIL", "(render error)" if not ok else "")
        print(log[-1500:])
    if not a.keep:
        shutil.rmtree(work, ignore_errors=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
