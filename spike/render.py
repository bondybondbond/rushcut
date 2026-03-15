"""Batch 0 spike — validates FFmpeg pipeline with real DJI footage.
Usage: python spike/render.py clip1.mp4 clip2.mp4 clip3.mp4
"""
import sys
import os
import re
import subprocess
import shutil

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_DIR = os.path.join(SPIKE_DIR, "tmp")
OUTPUT = os.path.join(SPIKE_DIR, "output_draft.mp4")
MUSIC_PATH = os.path.join(SPIKE_DIR, "music.mp3")  # optional


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    print("\n>>> " + " ".join(cmd))
    return subprocess.run(cmd, check=True, capture_output=False)


def run_capture(cmd: list[str]) -> subprocess.CompletedProcess:
    print("\n>>> " + " ".join(cmd))
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def ffprobe_duration(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def to_ffmpeg_path(p: str) -> str:
    """Normalise Windows backslashes for FFmpeg filter_complex strings."""
    return p.replace("\\", "/")


def normalise(clips: list[str]) -> list[str]:
    """Re-encode each clip to a consistent format; returns list of norm paths."""
    norm_paths = []
    for i, clip in enumerate(clips):
        out = os.path.join(TMP_DIR, f"norm_{i}.mp4")
        run([
            "ffmpeg", "-y", "-i", clip,
            "-vf", "scale=-2:1080",
            "-r", "25",
            "-c:v", "libx264",
            "-c:a", "aac",
            "-b:a", "128k",
            "-video_track_timescale", "12800",  # force fixed timescale
            out,
        ])
        norm_paths.append(out)
    return norm_paths


def silence_detect(norm_paths: list[str]) -> None:
    """Print silence detection results — no trimming."""
    for path in norm_paths:
        print(f"\n=== Silence detection: {path} ===")
        result = subprocess.run(
            [
                "ffmpeg", "-i", path,
                "-af", "silencedetect=noise=-30dB:d=0.5",
                "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        combined = result.stdout + result.stderr
        for line in combined.splitlines():
            if "silence_start" in line or "silence_end" in line:
                print(line)


def build_xfade(norm_paths: list[str]) -> str:
    """Concatenate clips with xfade + acrossfade. Returns output path."""
    durations = [ffprobe_duration(p) for p in norm_paths]
    n = len(norm_paths)

    if n == 1:
        print("\nSingle clip — skipping xfade, copying to output.")
        return norm_paths[0]

    inputs = []
    for p in norm_paths:
        inputs += ["-i", p]

    # Build video xfade chain
    v_filter_parts = []
    a_filter_parts = []
    cumulative = 0.0
    XFADE_DUR = 0.5

    prev_v = "[0:v]"
    prev_a = "[0:a]"

    for i in range(1, n):
        offset = round(cumulative + durations[i - 1] - XFADE_DUR, 4)
        out_v = f"[v{i}]" if i < n - 1 else "[vout]"
        out_a = f"[a{i}]" if i < n - 1 else "[aout]"
        v_filter_parts.append(
            f"{prev_v}[{i}:v]xfade=transition=crossfade:duration={XFADE_DUR}:offset={offset}{out_v}"
        )
        a_filter_parts.append(
            f"{prev_a}[{i}:a]acrossfade=d={XFADE_DUR}{out_a}"
        )
        prev_v = out_v
        prev_a = out_a
        cumulative += durations[i - 1] - XFADE_DUR

    filter_complex = "; ".join(v_filter_parts + a_filter_parts)

    joined = os.path.join(TMP_DIR, "joined.mp4")
    run([
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-c:a", "aac",
        joined,
    ])
    return joined


def overlay_music(joined: str, total_dur: float) -> str:
    """Mix in music track if present; return path to use for final output."""
    if not os.path.isfile(MUSIC_PATH):
        print(f"\n[WARNING] No music file found at {MUSIC_PATH} — skipping music overlay.")
        return joined

    fade_start = max(0, total_dur - 3)
    with_music = os.path.join(TMP_DIR, "with_music.mp4")
    run([
        "ffmpeg", "-y",
        "-i", joined,
        "-i", MUSIC_PATH,
        "-filter_complex",
        f"[1:a]afade=t=out:st={fade_start}:d=3[music]; [0:a][music]amix=inputs=2:duration=first[aout]",
        "-map", "0:v", "-map", "[aout]",
        "-shortest",
        "-c:v", "copy", "-c:a", "aac",
        with_music,
    ])
    return with_music


def render_output(source: str) -> None:
    """Downscale + compress to draft output."""
    run([
        "ffmpeg", "-y",
        "-i", source,
        "-vf", "scale=-2:360",
        "-crf", "35",
        "-preset", "ultrafast",
        "-c:a", "aac",
        OUTPUT,
    ])


def main():
    clips = sys.argv[1:]
    if not clips:
        print("ERROR: provide at least 1 clip path as argument.")
        sys.exit(1)

    for c in clips:
        if not os.path.isfile(c):
            print(f"ERROR: file not found: {c}")
            sys.exit(1)

    # Setup
    os.makedirs(TMP_DIR, exist_ok=True)

    # Step 1: Normalise
    print("\n=== STEP 1: Normalise clips ===")
    norm_paths = normalise(clips)

    # Step 2: Silence detection
    print("\n=== STEP 2: Silence detection ===")
    silence_detect(norm_paths)

    # Step 3: Concatenate with xfade
    print("\n=== STEP 3: Concatenate with xfade ===")
    joined = build_xfade(norm_paths)

    # Step 4: Music overlay
    print("\n=== STEP 4: Music overlay ===")
    total_dur = ffprobe_duration(joined)
    source = overlay_music(joined, total_dur)

    # Step 5: Final output
    print("\n=== STEP 5: Render draft output ===")
    render_output(source)

    print(f"\n✅ Done — output at: {OUTPUT}")
    print("Open spike/output_draft.mp4 in VLC to verify.")


if __name__ == "__main__":
    main()
