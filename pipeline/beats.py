"""
pipeline/beats.py -- Beat detection via librosa.

Functions:
    detect_beats(music_path)              -> list[float]  (beat times in seconds)
    snap_to_beat(cut_time_s, beat_times)  -> float        (snapped or original time)

Both functions are fully fault-tolerant: they return safe fallback values on any
failure so the pipeline never crashes if librosa is unavailable or audio is unusual.
"""

import logging
from pathlib import Path

log = logging.getLogger(__name__)


def detect_beats(music_path: "Path | str") -> list[float]:
    """
    Detect beat times in a music file using librosa.

    Returns a sorted list of beat times in seconds.
    Returns [] on any failure (librosa not installed, corrupt audio, etc.).
    An empty list signals the caller to skip beat-sync trimming.
    """
    try:
        import librosa  # type: ignore

        log.info("[beats] Detecting beats in %s", Path(music_path).name)
        y, sr = librosa.load(str(music_path), sr=None, mono=True)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times: list[float] = librosa.frames_to_time(beat_frames, sr=sr).tolist()
        log.info("[beats] %d beats detected at %.1f BPM", len(beat_times), float(tempo))
        return beat_times

    except ImportError:
        log.warning("[beats] librosa not installed -- beat-sync disabled")
        return []
    except Exception as e:
        log.warning("[beats] detect_beats failed (%s) -- beat-sync disabled", e)
        return []


def snap_to_beat(cut_time_s: float, beat_times: list[float], tolerance_s: float = 0.3) -> float:
    """
    Snap cut_time_s to the nearest beat within +/-tolerance_s.

    Returns the original cut_time_s if:
    - beat_times is empty
    - no beat falls within +/-tolerance_s of cut_time_s

    Args:
        cut_time_s:  Proposed cut point in seconds.
        beat_times:  Sorted beat times in seconds from detect_beats().
        tolerance_s: Maximum snap distance in seconds (default 0.3s).
    """
    if not beat_times:
        return cut_time_s

    nearest = min(beat_times, key=lambda b: abs(b - cut_time_s))
    delta = abs(nearest - cut_time_s)

    if delta <= tolerance_s:
        log.debug("[beats] snap %.3fs -> %.3fs (delta=%.3fs)", cut_time_s, nearest, delta)
        return nearest

    return cut_time_s
