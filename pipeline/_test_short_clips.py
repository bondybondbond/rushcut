#!/usr/bin/env python3
"""#284 -- measure, in REAL renders through pipeline/run.py, how long every clip is on screen alone.

Synthetic 29.97 fps solid-colour clips. "Own screen time" = frames where the four quadrant
centres AND the whole-frame mean are the clip's colour (any fade or wipe touching the frame
fails that). Each case fails on: a render error, any segmented-render fallback, frame drift,
a clip under min(1.5 s, half itself) of own time, a frame count that does not match the logged
cut plan, or audio and video lengths more than 0.15 s apart.

Run from WSL (needs an NTFS work dir for the manifest):
  python3 pipeline/_test_short_clips.py --work-dir /mnt/c/.../scratch/short [--res draft|1080p|4k]
      [--only name,name] [--old <checkout of the previous pipeline's parent dir>]

--old runs the long-clip control film through BOTH pipelines and requires identical decoded
video and audio, and shows the old pipeline failing the reported case (negative control).
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FPS = 30000 / 1001
COL = {"card": (255, 39, 255), "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255),
       "yellow": (255, 255, 0), "cyan": (0, 255, 255), "white": (255, 255, 255), "grey": (128, 128, 128),
       "orange": (255, 128, 0), "violet": (128, 0, 255)}
ORDER = ["red", "green", "blue", "yellow", "cyan", "white", "grey", "orange", "violet"]
TOL = 12  # colour tolerance: a second-generation encode drifts ~9 levels; 12 admits < 5 % of a fade
SIZES = {"draft": (640, 360), "1080p": (1920, 1080), "4k": (3840, 2160)}


def win(p: Path) -> str:
    s = str(p)
    return f"{s[5].upper()}:{s[6:]}" if s.startswith("/mnt/") else s


def film(lengths, cards=(), zoom=None, **settings):
    """lengths = clip seconds in order (colour assigned by position); cards = element positions;
    zoom = {clip index: zoom_mode} (zoom is skipped in draft, so those cases need 1080p or 4k)."""
    return {"clips": [(ORDER[i % len(ORDER)], s) for i, s in enumerate(lengths)], "cards": list(cards),
            "zoom": zoom or {}, "settings": {"transition": "crossfade", **settings}}


OC = {"opening_transition": "crossfade", "closing_transition": "dip_to_black"}
CASES = {
    "reported": film([2.302, 6, 6, 6], cards=[0]),
    "mid": film([6, 2.302, 6, 6, 6]),
    "first": film([2.302, 6, 6, 6, 6]),
    "last": film([6, 6, 6, 6, 2.302]),
    "adjacent": film([6, 2.302, 1.0, 6, 6]),
    "one_second": film([6, 1.0, 6]),
    "few_frame": film([6, 0.2, 6, 6, 6]),
    "openclose_23": film([2.302, 6, 6, 6, 2.302], **OC),
    "openclose_1": film([1.0, 6, 6, 6, 1.0], **OC),
    "openclose_mono": film([1.0, 6, 2.302], **OC),
    "openclose_tiny": film([0.3, 6, 6, 6, 0.3], **OC),
    "none_openclose": film([2.0, 6, 3.0], transition="none", **OC),
    "boundary_3": film([6, 6, 6, 2.0, 6, 6, 6, 6]),
    "boundary_6": film([6, 6, 6, 6, 6, 6, 1.0, 6]),
    "boundary_tiny": film([6, 6, 6, 0.2, 6, 6, 0.7, 6, 6]),
    "boundary_card": film([6, 6, 2.302, 6, 6, 2.0], cards=[0, 3]),
    "wipe": film([6, 2.302, 6, 6, 6], transition="wipe"),
    "dip": film([6, 2.302, 6, 6, 6], transition="dip_to_black"),
    "shuffle": film([6, 2.302, 1.0, 6, 6, 0.4, 6], shuffle_between=True),
    # lengths just either side of the hard-cut floor and the 4.5 s full-fade threshold
    "near_floor": film([6, 0.80, 6, 0.77, 6, 0.76, 6, 4.47, 6, 4.49, 6, 0.81, 0.9]),
    # a zoom chain next to a hard cut and feeding the following fade (#137 timebase class)
    "zoom_hard_mono": film([6, 0.4, 6, 6], zoom={0: "medium", 2: "kb_in_1.5_slow", 3: "kb_out_1.5_fast"}),
    "zoom_hard_seg": film([6, 0.4, 6, 2.302, 6, 0.4, 6, 6],
                          zoom={0: "kb_in_1.5_slow", 2: "medium", 3: "kb_in_2.0_fast", 4: "kb_out_1.5_med", 6: "tight"}, **OC),
}
# Every element >= 4.5 s: must render exactly as the previous pipeline did.
CONTROL = film([6, 4.5, 6, 6, 4.5], cards=[0, 3], **OC)


def make_clip(path: Path, colour: str, w: int, h: int) -> None:
    hexc = "0x%02X%02X%02X" % COL[colour]
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={hexc}:s={w}x{h}:r=30000/1001:d=8",
         "-f", "lavfi", "-i", "sine=f=440:d=8", "-vf", "scale=out_color_matrix=bt709,format=yuv420p",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", str(path)], check=True)


def render(root: Path, work: Path, name: str, spec: dict, res: str):
    w, h = SIZES[res]
    clips = []
    for i, (colour, secs) in enumerate(spec["clips"]):
        f = work / f"{colour}_{w}.mp4"
        if not f.exists():
            make_clip(f, colour, w, h)
        clips.append({"id": f"c{i}", "filename": f.name, "local_path": win(f), "duration_ms": 8000,
                      "in_ms": 0, "out_ms": int(round(secs * 1000)), "include": 1, "clip_volume": 1.0,
                      "zoom_mode": spec.get("zoom", {}).get(i, "none"), "width": w, "height": h,
                      "has_audio": True})
    cards = []
    for pos in spec["cards"]:  # element position -> clip-list position
        cards.append({"text": "T", "color": "#FF00FF", "position": pos - len(cards)})
    settings = {**spec["settings"], "output_resolution": "4k" if res == "4k" else "1080p",
                "music_mood": "none", "cards": cards}
    run_dir = work / f"run_{name}"
    shutil.rmtree(run_dir, ignore_errors=True)
    run_dir.mkdir(parents=True)
    out = run_dir / "out.mp4"
    job = f"rc284-{name}-{res}"
    mp = run_dir / "manifest.json"
    mp.write_text(json.dumps({"job_id": job, "mode": "draft" if res == "draft" else "final",
                              "clips": clips, "settings": settings, "output_path": win(out)}))
    r = subprocess.run([sys.executable, str(root / "pipeline" / "run.py"), "--job-id", job,
                        "--manifest-path", str(mp)], capture_output=True, text=True)
    log_file = run_dir / f"pipeline-{job}.log"
    log = r.stdout + r.stderr + (log_file.read_text() if log_file.exists() else "")
    return r.returncode, out, log, run_dir


def own_times(out: Path, colours: "list[str]"):
    """A frame belongs to a clip when ALL 16x16 point samples are its colour (a fade tints them,
    a wipe changes some of them); to a card when the four quadrant centres are (text mid-frame).
    Always decoded as bt709 (what the clips were made in): films with an opening/closing fade
    come out without colour tags, which ffmpeg would otherwise read as bt601."""
    def raw(n_side: int) -> bytes:
        return subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-vf",
                               f"scale={n_side}:{n_side}:flags=neighbor:in_color_matrix=bt709,format=rgb24",
                               "-f", "rawvideo", "-"],
                              capture_output=True).stdout
    grid, quad = raw(16), raw(2)
    n = min(len(grid) // 768, len(quad) // 12)
    own = {c: 0 for c in colours}
    for f in range(n):
        for c in own:
            data, size = (quad, 12) if c == "card" else (grid, 768)
            px = data[f * size: (f + 1) * size]
            if all(abs(px[j] - COL[c][j % 3]) <= TOL for j in range(size)):
                own[c] += 1
    last = tuple(max(grid[(n - 1) * 768 + k: n * 768: 3]) for k in range(3)) if n else ()
    return n, {c: v / FPS for c, v in own.items()}, last


def stream_len(out: Path, sel: str) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", sel, "-show_entries", "stream=duration",
                        "-of", "csv=p=0", str(out)], capture_output=True, text=True)
    return float(r.stdout.strip() or 0)


def decoded_md5(out: Path, kind: str) -> str:
    args = ["-map", "0:v:0", "-f", "framemd5"] if kind == "v" else ["-map", "0:a:0", "-f", "md5"]
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), *args, "-"], capture_output=True)
    return hashlib.md5(r.stdout).hexdigest()


def run_case(name: str, spec: dict, work: Path, res: str, root: Path = ROOT, keep=False):
    code, out, log, run_dir = render(root, work, name, spec, res)
    problems = []
    if code != 0 or not out.exists():
        print(f"{name}: RENDER FAILED\n{log[-2500:]}")
        return ["render failed"], None
    if "[U1g][fallback]" in log or "falling back to monolithic" in log.lower():
        problems.append("segmented render fell back")
    drifts = [int(x) for x in re.findall(r"drift=(\d+) frame", log)]
    if any(d > 0 for d in drifts):
        problems.append(f"drift {drifts}")
    # A film with transitions and more than 4 elements MUST have taken the segmented path and
    # reported drift: a renamed log line or a quiet single-graph render is not a pass.
    elements = len(spec["clips"]) + len(spec["cards"])
    s = spec["settings"]
    if elements > 4 and (s["transition"] != "none" or s.get("shuffle_between")):
        # "(no fallback)" / "(with fallback)" in that line is about the ENCODER, not segmentation
        if "[U1g] segmented render complete (" not in log or not drifts:
            problems.append("expected a segmented render with a drift report and no fallback")
    if spec.get("zoom") and res != "draft" and "crop=" not in log:
        problems.append("zoom case rendered without a zoom filter in any graph")
    # distinct colours only (a repeated colour would add two clips' time together)
    colours = [c for c, _ in spec["clips"]]
    n, own, last = own_times(out, colours + (["card"] if spec["cards"] else []))
    report = []
    for colour, secs in spec["clips"]:
        if colours.count(colour) > 1:
            continue
        need = min(1.5, secs / 2)
        report.append(f"{colour}({secs})={own[colour]:.2f}")
        if own[colour] < need - 2.5 / FPS:
            problems.append(f"{colour} {secs}s has {own[colour]:.2f}s of its own, needs {need:.2f}s")
    if spec["cards"] and own["card"] / len(spec["cards"]) < 1.5 - 3 / FPS:
        problems.append(f"cards average {own['card'] / len(spec['cards']):.2f}s fully visible")
    if spec["settings"].get("closing_transition", "none") != "none" and "close=0.000" not in log:
        if not all(v <= 40 for v in last):
            problems.append(f"closing fade does not end near black: last frame {last}")
    v_len, a_len = stream_len(out, "v:0"), stream_len(out, "a:0")
    if abs(v_len - a_len) > 0.15:
        problems.append(f"audio {a_len:.3f}s vs video {v_len:.3f}s")
    plan = re.search(r"cut plan: (.*)", log)
    if not plan:
        problems.append("no cut plan line in the log")
    segmented = "[U1g] segmented render:" in log
    print(f"{name}: {'ok ' if not problems else 'FAIL'} frames={n} video={v_len:.2f}s audio={a_len:.2f}s "
          f"segmented={segmented} drift={drifts}\n    own: {' '.join(report)}"
          + (f"\n    plan: {plan.group(1)}" if plan else ""))
    for p in problems:
        print("    PROBLEM", p)
    sig = (decoded_md5(out, "v"), decoded_md5(out, "a"), n)
    if not keep:
        shutil.rmtree(run_dir, ignore_errors=True)
    return problems, sig


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--res", choices=list(SIZES), default="draft")
    ap.add_argument("--only", default="")
    ap.add_argument("--old", default="", help="parent dir holding the previous pipeline/ (and fonts/)")
    a = ap.parse_args()
    work = Path(a.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    names = [x for x in a.only.split(",") if x] or [k for k, v in CASES.items() if a.res != "draft" or not v["zoom"]]
    failed = []
    for name in names:
        if run_case(name, CASES[name], work, a.res)[0]:
            failed.append(name)

    # determinism: the same project renders the same decoded film twice
    if a.res == "draft":
        s1 = run_case("repeat_a", CASES["shuffle"], work, a.res)[1]
        s2 = run_case("repeat_b", CASES["shuffle"], work, a.res)[1]
        # shuffle is seeded from the render signature, which does not depend on the job id
        print(f"determinism: video identical={s1[0] == s2[0]} audio identical={s1[1] == s2[1]}")
        if s1[:2] != s2[:2]:
            failed.append("determinism")

    control_problems, new_sig = run_case("control_new", CONTROL, work, a.res)
    if control_problems:
        failed.append("control")
    if a.old:
        old_problems, old_sig = run_case("control_old", CONTROL, work, a.res, root=Path(a.old))
        if old_sig is None:
            print("control: the previous pipeline did not render (is fonts/ next to its pipeline/?)")
            return 1
        same = new_sig == old_sig
        print(f"control (all >= 4.5 s) vs previous pipeline: frames {new_sig[2]} vs {old_sig[2]}, "
              f"video identical={new_sig[0] == old_sig[0]} audio identical={new_sig[1] == old_sig[1]}")
        if not same:
            failed.append("control differs from the previous pipeline")
        neg = run_case("negative_control_old", CASES["reported"], work, a.res, root=Path(a.old))[0]
        print(f"negative control: previous pipeline on the reported case failed as expected={bool(neg)}")
        if not neg:
            failed.append("negative control did not fail")
    shutil.rmtree(work, ignore_errors=True)
    print("PASS" if not failed else f"FAIL: {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
