"""
spike/render.py — Batch 0 pipeline spike (throwaway)
Usage: python render.py clip1.mp4 clip2.mp4 clip3.mp4
Output: spike/output_draft.mp4

Tests: normalise → silencedetect → xfade concat → 360p output
Music overlay: skipped on first pass (keep source audio for sync verification)
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# FFmpeg binary resolution
# ---------------------------------------------------------------------------

WINGET_FFMPEG_BIN = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"

def _find_bin(name: str) -> str:
    """Find ffmpeg/ffprobe: PATH first, then winget install location."""
    found = shutil.which(name)
    if found:
        return found
    # Search winget packages for Gyan.FFmpeg
    if WINGET_FFMPEG_BIN.exists():
        for pkg in WINGET_FFMPEG_BIN.iterdir():
            if "Gyan.FFmpeg" in pkg.name:
                candidate = pkg / "ffmpeg-8.0.1-full_build" / "bin" / f"{name}.exe"
                if candidate.exists():
                    return str(candidate)
                # Glob for any version
                for exe in pkg.rglob(f"bin/{name}.exe"):
                    return str(exe)
    raise RuntimeError(
        f"{name} not found. Install via: winget install Gyan.FFmpeg\n"
        "Then restart your shell, or re-run this script (it will auto-discover the path)."
    )

FFMPEG = _find_bin("ffmpeg")
FFPROBE = _find_bin("ffprobe")
print(f"[info] ffmpeg:  {FFMPEG}")
print(f"[info] ffprobe: {FFPROBE}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Print and run a command, raising on failure."""
    print(f"\n[cmd] {' '.join(str(c) for c in cmd)}\n")
    return subprocess.run(cmd, check=True, **kwargs)


def ffprobe_streams(path: str) -> list[dict]:
    """Return list of stream dicts from ffprobe -show_streams."""
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_streams", "-print_format", "json", path],
        capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout).get("streams", [])


def get_duration(path: str) -> float:
    """Return duration in seconds (from format, fallback to video stream)."""
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True
    )
    val = result.stdout.strip()
    if val and val != "N/A":
        return float(val)
    # fallback: first video stream duration
    for s in ffprobe_streams(path):
        if s.get("codec_type") == "video" and s.get("duration"):
            return float(s["duration"])
    raise RuntimeError(f"Cannot determine duration for {path}")


def has_audio(path: str) -> bool:
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True
    )
    return bool(result.stdout.strip())


# ---------------------------------------------------------------------------
# Step 1: Parse args
# ---------------------------------------------------------------------------

def parse_args() -> list[str]:
    clips = sys.argv[1:]
    if not clips:
        print("Usage: python render.py clip1.mp4 clip2.mp4 [clip3.mp4 ...]")
        sys.exit(1)
    for c in clips:
        if not Path(c).exists():
            print(f"[error] File not found: {c}")
            sys.exit(1)
    print(f"\n[info] Input clips ({len(clips)}):")
    for c in clips:
        print(f"  {c}")
    return clips


# ---------------------------------------------------------------------------
# Step 2: Pre-normalise codec check
# ---------------------------------------------------------------------------

def codec_check(clips: list[str]) -> None:
    print("\n" + "="*60)
    print("STEP 2: Pre-normalise codec check")
    print("="*60)
    for clip in clips:
        streams = ffprobe_streams(clip)
        print(f"\n  {Path(clip).name}:")
        for s in streams:
            ct = s.get("codec_type", "?")
            if ct == "video":
                print(f"    video: {s.get('codec_name')} | pix_fmt={s.get('pix_fmt')} "
                      f"| {s.get('width')}x{s.get('height')} | r_frame_rate={s.get('r_frame_rate')}")
            elif ct == "audio":
                print(f"    audio: {s.get('codec_name')} | {s.get('sample_rate')}Hz | "
                      f"channels={s.get('channels')}")


# ---------------------------------------------------------------------------
# Step 3: Normalise
# ---------------------------------------------------------------------------

def normalise(clips: list[str], tmp_dir: Path) -> list[str]:
    print("\n" + "="*60)
    print("STEP 3: Normalise clips -> H.264/yuv420p/25fps CFR/1080p/AAC")
    print("="*60)
    norm_clips = []
    for i, clip in enumerate(clips):
        out = str(tmp_dir / f"norm_{i}.mp4")
        run([
            FFMPEG, "-y", "-i", clip,
            "-vf", "scale=-2:1080,format=yuv420p",
            "-r", "25",
            "-fps_mode", "cfr",
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            out
        ])
        norm_clips.append(out)
    return norm_clips


# ---------------------------------------------------------------------------
# Step 4: Silence detection
# ---------------------------------------------------------------------------

def silence_detect(norm_clips: list[str]) -> None:
    print("\n" + "="*60)
    print("STEP 4: Silence detection (informational — no trimming in spike)")
    print("="*60)
    for i, clip in enumerate(norm_clips):
        print(f"\n  norm_{i}.mp4:")
        result = subprocess.run(
            [FFMPEG, "-i", clip, "-af", "silencedetect=noise=-30dB:d=0.5",
             "-f", "null", "-"],
            capture_output=True, text=True
        )
        # silencedetect writes to stderr
        matches = re.findall(
            r"silence_(start|end): ([0-9.]+)(?:\s*\|\s*silence_duration: ([0-9.]+))?",
            result.stderr
        )
        if matches:
            for m in matches:
                event, ts, dur = m
                if event == "start":
                    print(f"    silence_start: {float(ts):.2f}s")
                else:
                    print(f"    silence_end:   {float(ts):.2f}s  (duration: {dur}s)" if dur else
                          f"    silence_end:   {float(ts):.2f}s")
        else:
            print("    (no silence detected)")


# ---------------------------------------------------------------------------
# Step 5: Concatenate with xfade + acrossfade
# ---------------------------------------------------------------------------

def build_filter_complex(norm_clips: list[str], durations: list[float],
                          audio_flags: list[bool], xfade_dur: float = 0.5) -> tuple[str, str, str]:
    """
    Build filter_complex for xfade (video) + pairwise acrossfade (audio).
    Returns (filter_complex_str, video_out_label, audio_out_label).
    audio_out_label is '' if no audio in any clip.
    """
    n = len(norm_clips)

    # --- Video: chain xfade pairwise ---
    video_parts = []
    prev_label = "[0:v]"
    cumulative = 0.0

    for i in range(1, n):
        offset = cumulative + durations[i - 1] - xfade_dur * i
        print(f"  xfade offset[{i}] = {offset:.4f}s  "
              f"(cumulative={cumulative + durations[i-1]:.4f}s - {xfade_dur * i:.4f}s)")
        out_label = f"[v{i:02d}]"
        video_parts.append(
            f"{prev_label}[{i}:v]xfade=fade:duration={xfade_dur}:offset={offset:.4f}{out_label}"
        )
        prev_label = out_label
        cumulative += durations[i - 1]

    # Append scale to final video output (must be in filter_complex, not -vf, when using -filter_complex)
    scaled_label = "[vout]"
    video_parts.append(f"{prev_label}scale=-2:360{scaled_label}")
    video_out = scaled_label

    # --- Audio ---
    all_have_audio = all(audio_flags)
    any_have_audio = any(audio_flags)

    if not any_have_audio:
        print("  [audio] No audio streams found in any clip — video-only output")
        filter_str = "; ".join(video_parts)
        return filter_str, video_out, ""

    if not all_have_audio:
        # Inject silence for clips missing audio (handled outside this function)
        print("  [audio] WARNING: some clips lack audio — silence will be injected")

    # Pairwise acrossfade
    audio_parts = []
    a_prev = "[0:a]"
    for i in range(1, n):
        a_out = f"[a{i:02d}]"
        audio_parts.append(
            f"{a_prev}[{i}:a]acrossfade=d={xfade_dur}{a_out}"
        )
        a_prev = a_out

    audio_out = a_prev
    all_parts = video_parts + audio_parts
    filter_str = "; ".join(all_parts)
    return filter_str, video_out, audio_out


def concat(norm_clips: list[str], tmp_dir: Path, output_path: str) -> None:
    print("\n" + "="*60)
    print("STEP 5: Concatenate with xfade crossfade")
    print("="*60)

    n = len(norm_clips)
    if n == 1:
        print("  Single clip — skipping xfade, copying directly")
        run([FFMPEG, "-y", "-i", norm_clips[0],
             "-vf", "scale=-2:360", "-crf", "35", "-preset", "ultrafast", output_path])
        return

    # Get durations
    durations = []
    for i, clip in enumerate(norm_clips):
        d = get_duration(clip)
        print(f"  norm_{i}.mp4 duration: {d:.4f}s")
        durations.append(d)

    # Audio flags — inject silence for missing streams
    audio_flags = [has_audio(c) for c in norm_clips]
    injected_clips = list(norm_clips)  # may be replaced per-clip below

    for i, (clip, has_a) in enumerate(zip(norm_clips, audio_flags)):
        if not has_a:
            print(f"  [audio] norm_{i}.mp4 has no audio — injecting silence")
            silent_clip = str(tmp_dir / f"norm_{i}_silent.mp4")
            dur = durations[i]
            run([
                FFMPEG, "-y",
                "-i", clip,
                "-f", "lavfi", "-i", f"aevalsrc=0:c=stereo:s=44100:d={dur:.4f}",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                "-shortest",
                silent_clip
            ])
            injected_clips[i] = silent_clip
            audio_flags[i] = True

    # Build inputs
    inputs = []
    for clip in injected_clips:
        inputs += ["-i", clip]

    # Calculate and log offsets, build filter_complex
    print(f"\n  Building filter_complex for {n} clips:")
    fc, v_out, a_out = build_filter_complex(injected_clips, durations, audio_flags)

    print(f"\n  filter_complex:\n    {fc}")
    print(f"  video_out: {v_out}  audio_out: {a_out}")

    cmd = [FFMPEG, "-y"] + inputs + ["-filter_complex", fc]
    cmd += ["-map", v_out]
    if a_out:
        cmd += ["-map", a_out]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "main",
            "-crf", "35", "-preset", "ultrafast", output_path]

    run(cmd)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    clips = parse_args()

    script_dir = Path(__file__).parent
    tmp_dir = script_dir / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    output_path = r"C:\clips\processed\output_draft.mp4"

    try:
        codec_check(clips)
        norm_clips = normalise(clips, tmp_dir)
        silence_detect(norm_clips)
        concat(norm_clips, tmp_dir, output_path)

        print("\n" + "="*60)
        print("DONE")
        print("="*60)
        print(f"  Output: {output_path}")
        print("\nVerification gates:")
        print("  [ ] File plays in VLC/browser without codec errors")
        print("  [ ] xfade crossfade visible at join points")
        print("  [ ] No audio sync drift audible")
        print("  [ ] Silence detection output looks plausible (see STEP 4 above)")
        print("\n  [PASS] pass -> proceed to Batch 1")
        print("  [FAIL] fail -> diagnose above output before continuing\n")

    finally:
        keep_tmp = "--keep-tmp" in sys.argv
        if not keep_tmp and tmp_dir.exists():
            shutil.rmtree(tmp_dir)
            print(f"[info] Cleaned up {tmp_dir}  (pass --keep-tmp to retain)")


if __name__ == "__main__":
    main()
