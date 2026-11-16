#!/usr/bin/env python3
"""#190 -- measure how long each title card is fully opaque in a REAL render.

Builds 4 synthetic 29.97 fps clips (real DJI footage is 30000/1001; a 30 fps fixture
trips the known xfade timebase rule and skews the run), puts a solid-green card at the
start, middle and end, renders through pipeline/run.py (the normal path: 7 elements =>
segmented U1g render) and reads the exact-green corner pixel at 10 fps.

Run from WSL (needs an NTFS work dir the manifest can live in):
  python3 pipeline/_test_card_visibility.py --work-dir /mnt/c/Users/<you>/AppData/Local/Temp/claude/<session>/scratch/cardtest \
      --res 1080p|4k --transition crossfade|none [--open-close] [--keep]

Exit 0 = pass, 1 = fail. FAILS if the log shows a segmented-render fallback (a monolithic
fallback must never count as validation) or if a card is opaque for less than 2.9 s
(crossfade) / not ~3.0 s (none). The work dir is removed at the end unless --keep.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def win(p: Path) -> str:
    s = str(p)
    return f"{s[5].upper()}:{s[6:]}" if s.startswith("/mnt/") else s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--res", choices=["1080p", "4k"], default="1080p")
    ap.add_argument("--transition", choices=["crossfade", "none"], default="crossfade")
    ap.add_argument("--open-close", action="store_true")
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
    cards = [{"text": t, "color": "#00FF00", "position": p} for t, p in (("A", 0), ("B", 2), ("C", -1))]
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
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-vf",
                              "fps=10,crop=2:2:0:0,scale=1:1,format=rgb24", "-f", "rawvideo", "-"],
                             capture_output=True).stdout
        cur = 0
        for i in range(0, len(raw) - 2, 3):
            if raw[i] < 6 and raw[i + 1] >= 213 and raw[i + 2] < 6:
                cur += 1
            elif cur:
                runs.append(cur / 10)
                cur = 0
        if cur:
            runs.append(cur / 10)
    print(f"res={a.res} transition={a.transition} open_close={a.open_close} film_dur={dur:.1f}s "
          f"opaque_runs_s={runs} segmented_fallback={fallback}")
    want = 3.0 if a.transition == "none" else 2.9
    passed = ok and not fallback and len(runs) == 3 and all(
        (abs(x - 3.0) < 0.15) if a.transition == "none" else (x >= want) for x in runs)
    if not passed:
        print("FAIL", "(render error)" if not ok else "")
        print(log[-1500:])
    if not a.keep:
        shutil.rmtree(work, ignore_errors=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
