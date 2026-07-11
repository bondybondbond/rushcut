"""
pipeline/trim.py — Trim a normalised clip to [start_s, end_s].

Re-encodes for frame-accurate trim (relies on FFmpeg's default accurate_seek
during transcode; stream copy was removed — see #96, it silently included
extra pre-in-point footage on non-keyframe-aligned trims). Uses -t (duration)
not -to (end position) to avoid timestamp-base ambiguity with input-side seek
+ transcode. Fallback if frame accuracy ever regresses: move -ss after -i
(output/accurate seek) — slower but guaranteed exact.
"""

import json
import logging
import subprocess
from pathlib import Path

from .utils import FFMPEG, FFPROBE, ffmpeg_run, get_duration

log = logging.getLogger(__name__)

# #104: minimum copyable-tail duration for trim_smart() to bother with the
# partial-GOP path over a plain full re-encode. Set once from the Gate 2
# diagnostic (2026-07-11): concat-only cost averages ~0.4s/job under 4-way
# ThreadPoolExecutor contention (comfortably under the 1s bar), and the copied
# tail itself costs well under 1s regardless of duration -- so the partial-GOP
# path's fixed overhead is cheap and roughly duration-independent, and any real
# copyable tail is worth taking. 1.0s only excludes degenerate near-zero tails
# (a keyframe landing right before end_s). Do not tune this value elsewhere --
# if it turns out wrong, that's a follow-up issue, not a knob to touch
# mid-implementation.
MIN_TAIL_S = 1.0


def trim(clip_path: Path, start_s: float, end_s: float, out_path: Path, threads: int | None = None) -> Path:
    """
    Trim clip_path to [start_s, end_s], frame-accurate (re-encode, not stream copy).
    threads: optional -threads cap (used when running multiple trims in parallel,
    e.g. render.py Step 2, to prevent CPU oversubscription — see normalise.py).
    Returns out_path.
    """
    log.info("[trim] %s -> %.2fs–%.2fs", clip_path.name, start_s, end_s)
    duration_s = end_s - start_s

    cmd = [FFMPEG, "-y"]
    if threads is not None:
        cmd += ["-threads", str(threads)]
    cmd += [
        "-ss", f"{start_s:.4f}",
        "-t", f"{duration_s:.4f}",
        "-i", str(clip_path),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        str(out_path),
    ]
    ffmpeg_run(cmd)

    return out_path


def _keyframe_times_within(clip_path: Path, start_s: float, end_s: float) -> list[float]:
    """
    Keyframe pts_time values strictly inside (start_s, end_s), read by field name
    from JSON output. ffprobe's -of csv ignores the requested -show_entries field
    order (confirmed on #104's own scoping pass -- an initial "0 keyframes" result
    was a column-order misread, not a real zero); JSON is mandatory here, not a
    style preference. -read_intervals scopes the probe to the window instead of
    decoding the whole file.
    """
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-read_intervals", f"{start_s}%{end_s}",
         "-show_entries", "frame=key_frame,pts_time",
         "-of", "json", str(clip_path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(result.stdout)
    frames = data.get("frames", [])
    return [
        float(f["pts_time"]) for f in frames
        if int(f.get("key_frame", 0)) == 1 and start_s < float(f["pts_time"]) < end_s
    ]


def _copy_segment(clip_path: Path, start_s: float, end_s: float, out_path: Path) -> None:
    """Stream-copy [start_s, end_s]. Frame-accurate ONLY because start_s here is
    always an actual keyframe timestamp (never an arbitrary user cut point) --
    see trim_smart(). Copying from a non-keyframe seek is exactly the #96 bug."""
    dur = end_s - start_s
    cmd = [FFMPEG, "-y", "-ss", f"{start_s:.4f}", "-t", f"{dur:.4f}",
           "-i", str(clip_path), "-c", "copy", str(out_path)]
    ffmpeg_run(cmd)


def trim_smart(clip_path: Path, start_s: float, end_s: float, out_path: Path,
                threads: int | None = None) -> Path:
    """
    Frame-accurate trim (#104). Only the LEADING edge needs a keyframe-aligned
    re-encode: -c copy with -ss before -i snaps the START backward to the
    nearest preceding keyframe (the #96 bug -- silently includes extra
    pre-in-point footage), but -c copy with -t on the END just truncates
    output at that timestamp, no snapping, no equivalent bug. So: re-encode
    [start_s, kf] up to the first keyframe strictly after start_s (via trim(),
    so codec params live in exactly one place), then -c copy straight through
    from kf to end_s -- no second boundary re-encode, no second keyframe
    needed. Falls back to a full trim() re-encode when no keyframe exists
    inside the window, the copyable tail is below MIN_TAIL_S, or any step
    below fails a guardrail -- trim_smart() must never ship output it hasn't
    verified.

    NOT WIRED IN -- kept for reference only (#104, closed NO-GO 2026-07-11).
    render.py Step 2 calls trim() directly, not this function. All three
    pre-implementation gates passed (IDR confirmed at every keyframe on both
    libx264 and h264_amf output; concat-only cost ~0.4s/job, well under the 1s
    bar; same-GOP fallback verified on a real 7.27s clip) and frame-accuracy
    held on every real test. But the real end-to-end measurement (old trim()
    vs this function, identical clips/windows/4-way contention) was 19-31%
    SLOWER, not faster, across two separate runs. Isolating the cause: the
    head-reencode alone genuinely is faster than a full-window reencode
    (4.16s vs 5.52s avg, a real 1.36s/job saving under contention) -- but the
    extra ffprobe keyframe-probe + copy + concat calls needed to realize that
    shortening cost more than the saving in practice. Individually-cheap
    pieces (each gate passed in isolation) did not compose into a net win.
    Do not re-wire this without new evidence the composed overhead has
    changed -- see issue #104 for full numbers.
    """
    try:
        inside = _keyframe_times_within(clip_path, start_s, end_s)
    except Exception as exc:
        log.warning("[trim_smart] keyframe probe failed (%s) -- falling back to full re-encode", exc)
        return trim(clip_path, start_s, end_s, out_path, threads=threads)

    if not inside:
        log.info("[trim_smart] no internal keyframe in [%.3f, %.3f] -- full re-encode", start_s, end_s)
        return trim(clip_path, start_s, end_s, out_path, threads=threads)

    kf = inside[0]  # earliest keyframe after start_s -- maximizes the copyable tail
    tail_s = end_s - kf
    if tail_s < MIN_TAIL_S:
        log.info("[trim_smart] copyable tail too short (%.3fs < %.1fs) -- full re-encode",
                  tail_s, MIN_TAIL_S)
        return trim(clip_path, start_s, end_s, out_path, threads=threads)

    work_dir = out_path.parent
    stem = out_path.stem
    head = work_dir / f"{stem}_head.mp4"
    tail = work_dir / f"{stem}_tail.mp4"
    list_file = work_dir / f"{stem}_concat.txt"

    try:
        trim(clip_path, start_s, kf, head, threads=threads)
        _copy_segment(clip_path, kf, end_s, tail)

        list_file.write_text(f"file '{head}'\nfile '{tail}'\n")
        cmd = [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
               "-c", "copy", "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
               str(out_path)]
        ffmpeg_run(cmd)

        expected_dur = end_s - start_s
        actual_dur = get_duration(out_path)
        if abs(actual_dur - expected_dur) > 0.3:
            log.warning(
                "[trim_smart] duration mismatch after concat (expected %.3fs, got %.3fs) "
                "-- discarding and falling back to full re-encode", expected_dur, actual_dur)
            return trim(clip_path, start_s, end_s, out_path, threads=threads)
    except Exception as exc:
        log.warning("[trim_smart] partial-GOP path failed (%s) -- falling back to full re-encode", exc)
        return trim(clip_path, start_s, end_s, out_path, threads=threads)
    finally:
        for f in (head, tail, list_file):
            f.unlink(missing_ok=True)

    log.info("[trim_smart] %s -> %.2fs-%.2fs via partial-GOP (head %.2fs re-encoded, tail %.2fs copied)",
              clip_path.name, start_s, end_s, kf - start_s, tail_s)
    return out_path
