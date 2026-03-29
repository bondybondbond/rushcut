"""
pipeline/motion.py -- Motion scoring and clip intelligence.

Uses a single FFmpeg scene-change detection pass per clip to compute
a motion_score and a list of scored frames. The scored frames are
reused for peak window detection without any additional FFmpeg calls.

Functions:
    score_clip(clip_path)               -> (motion_score, scored_frames)
    filter_by_motion(paths, threshold)  -> (kept, excluded, scores_dict, frames_map)
    find_peak_window(scored_frames, ...) -> (start_s, end_s)
"""

import logging
import os
import re
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

FFMPEG = os.environ.get("FFMPEG_BIN", "/usr/bin/ffmpeg")

# Clips with motion_score below this threshold are considered boring.
# Override via MOTION_FILTER_THRESHOLD env var for testing (e.g. =0.9).
MOTION_FILTER_THRESHOLD = float(os.environ.get("MOTION_FILTER_THRESHOLD", "0.015"))


def score_clip(clip_path: Path) -> tuple[float, list[tuple[float, float]]]:
    """
    Run ONE FFmpeg scene-change detection pass on clip_path.

    Uses select='gt(scene,0)' to capture all frames with any scene change,
    and metadata=print:file=- to emit (pts_time, lavfi.scene_score) pairs
    to stdout. This is the only FFmpeg pass -- scored_frames is reused by
    find_peak_window to avoid a second pass.

    Returns:
        (motion_score, scored_frames)
        - motion_score:  mean scene score across all detected frames (0.0 if none)
        - scored_frames: list of (pts_time_s, scene_score), sorted by time
    """
    try:
        result = subprocess.run(
            [
                FFMPEG,
                "-i", str(clip_path),
                "-vf", "select='gt(scene,0)',metadata=print:file=-",
                "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=120,
        )
        output = result.stdout

        # metadata=print output format (one block per selected frame):
        #   frame:0   pts:100  pts_time:0.100000
        #   lavfi.scene_score=0.456789
        pts_times = [float(m) for m in re.findall(r"pts_time:([0-9.]+)", output)]
        scores    = [float(m) for m in re.findall(r"lavfi\.scene_score=([0-9.]+)", output)]

        n = min(len(pts_times), len(scores))
        if n == 0:
            log.debug("[motion] %s: no scene changes detected (motion_score=0.0)", clip_path.name)
            return 0.0, []

        scored_frames = sorted(zip(pts_times[:n], scores[:n]))
        motion_score = sum(s for _, s in scored_frames) / n

        log.info("[motion] %s: motion_score=%.4f frames=%d", clip_path.name, motion_score, n)
        return motion_score, list(scored_frames)

    except Exception as e:
        log.warning("[motion] score_clip failed for %s: %s -- keeping clip (score=0.0)", clip_path.name, e)
        return 0.0, []


def filter_by_motion(
    paths: list[Path],
    threshold: float | None = None,
) -> tuple[list[Path], list[Path], dict[Path, float], dict[Path, list[tuple[float, float]]]]:
    """
    Score each clip and split into kept / excluded by motion_score threshold.

    Returns:
        (kept, excluded, scores_dict, frames_map)
        - kept:        clips with motion_score >= threshold
        - excluded:    clips below threshold
        - scores_dict: {path: motion_score} for ALL clips -- used by clip-cap ranking
        - frames_map:  {path: scored_frames} for ALL clips -- used by find_peak_window

    Safety: if all clips would be excluded, returns all as kept to avoid empty render.
    """
    effective_threshold = threshold if threshold is not None else MOTION_FILTER_THRESHOLD

    kept: list[Path] = []
    excluded: list[Path] = []
    scores_dict: dict[Path, float] = {}
    frames_map: dict[Path, list[tuple[float, float]]] = {}

    for p in paths:
        score, frames = score_clip(p)
        scores_dict[p] = score
        frames_map[p] = frames

        if score >= effective_threshold:
            kept.append(p)
        else:
            log.info(
                "[motion] Excluding %s (score=%.4f < threshold=%.4f)",
                p.name, score, effective_threshold,
            )
            excluded.append(p)

    if not kept:
        log.warning(
            "[motion] All %d clips excluded by motion filter -- keeping all to avoid empty render",
            len(paths),
        )
        kept = list(paths)
        excluded = []

    log.info(
        "[motion] filter_by_motion: %d kept, %d excluded (threshold=%.4f)",
        len(kept), len(excluded), effective_threshold,
    )
    return kept, excluded, scores_dict, frames_map


def find_peak_window(
    scored_frames: list[tuple[float, float]],
    clip_duration_s: float,
    window_s: float = 5.0,
) -> tuple[float, float]:
    """
    Find the highest-motion window using pre-computed scored_frames.

    Does NOT run an additional FFmpeg pass -- uses the frames list from score_clip().

    Args:
        scored_frames:   (pts_time_s, scene_score) pairs from score_clip().
        clip_duration_s: Total clip duration in seconds.
        window_s:        Desired window length in seconds.

    Returns:
        (start_s, end_s) of the best window, clamped to [0, clip_duration_s].
        Falls back to (0, clip_duration_s) if scored_frames is empty or
        window_s >= clip_duration_s.
    """
    if clip_duration_s <= 0:
        return 0.0, max(0.0, clip_duration_s)

    window_s = min(window_s, clip_duration_s)

    if not scored_frames or window_s >= clip_duration_s:
        return 0.0, clip_duration_s

    # Build candidate window start points from each frame's pts_time,
    # clamped so the window fits within the clip.
    candidate_starts = sorted({
        max(0.0, min(t, clip_duration_s - window_s))
        for t, _ in scored_frames
    } | {0.0})

    best_start = 0.0
    best_score = -1.0

    for start in candidate_starts:
        end = start + window_s
        window_score = sum(
            s for t, s in scored_frames
            if start <= t < end
        )
        if window_score > best_score:
            best_score = window_score
            best_start = start

    best_end = min(best_start + window_s, clip_duration_s)
    log.debug("[motion] find_peak_window: start=%.2fs end=%.2fs score=%.4f", best_start, best_end, best_score)
    return best_start, best_end


if __name__ == "__main__":
    """Smoke test: python3 pipeline/motion.py /path/to/clip.mp4"""
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from pipeline.utils import get_duration as _get_duration  # type: ignore

    logging.basicConfig(level=logging.DEBUG, format="[%(levelname)s] %(message)s")
    if len(sys.argv) < 2:
        print("Usage: python3 pipeline/motion.py <clip.mp4>")
        sys.exit(1)

    p = Path(sys.argv[1])
    score, frames = score_clip(p)
    print(f"motion_score:  {score:.4f}")
    print(f"scored_frames: {len(frames)} frames")
    if frames:
        dur = _get_duration(p)
        start, end = find_peak_window(frames, dur)
        print(f"peak_window:   {start:.2f}s -> {end:.2f}s")
