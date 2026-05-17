"""
pipeline/music.py -- Mix a background music track under the rendered video.

- No-op if track_name is None or the track file doesn't exist.
- Detects and strips leading/trailing silence from the track before tiling,
  so crossfade boundaries land on active audio rather than near-silent edges.
- Loops the trimmed track using pairwise-chained acrossfade to fill video duration.
- Fades music out over final 3 seconds.
- Mixes at lower volume so original audio remains prominent.
"""

import logging
import math
import re
import subprocess
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run, get_duration

log = logging.getLogger(__name__)

FADE_OUT_S  = 3.0   # Seconds to fade music out at end
CROSSFADE_S = 2.0   # Overlap between adjacent music tile copies


def _get_active_region(path: Path, noise_db: float = -35.0, min_silence_s: float = 0.3) -> tuple[float, float]:
    """Return (active_start, active_end) seconds by stripping leading/trailing silence.

    Falls back to (0, total_duration) if detection fails or the active region
    would be shorter than 10 seconds.
    """
    total = get_duration(path)

    result = subprocess.run(
        [FFMPEG, "-i", str(path),
         "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_s}",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    stderr = result.stderr

    silence_ends   = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)",   stderr)]
    silence_starts = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", stderr)]

    active_start = silence_ends[0]   if silence_ends   and silence_ends[0]   < total * 0.3 else 0.0
    active_end   = silence_starts[-1] if silence_starts and silence_starts[-1] > total * 0.6 else total

    if active_end - active_start < 10.0:
        log.warning("[music] active region too short (%.2fs) -- using full track", active_end - active_start)
        return 0.0, total

    log.info("[music] active region: %.2fs -- %.2fs (of %.2fs total)", active_start, active_end, total)
    return active_start, active_end


def _compute_copies(video_dur: float, active_dur: float, crossfade_s: float) -> int:
    """Return the number of track copies (of the active region) needed to cover video_dur.

    N copies chained via acrossfade(d=cf) produce: N*active_dur - (N-1)*cf seconds.
    Solve for N: N >= (video_dur - cf) / (active_dur - cf).
    """
    if active_dur <= 0:
        return 1
    effective = active_dur - crossfade_s
    if effective <= 0:
        return math.ceil(video_dur / active_dur) + 1
    return max(1, math.ceil((video_dur - crossfade_s) / effective))


def _build_filter(
    n_copies: int,
    active_start: float,
    active_end: float,
    crossfade_s: float,
    video_dur: float,
    music_volume: float,
    movie_vol: float = 1.0,
    fade_out_s: float = FADE_OUT_S,
) -> str:
    """Build filter_complex for n_copies inputs (FFmpeg indices 1..n_copies).

    Each copy is pre-trimmed to the active audio region before crossfading,
    so boundaries land on musically active content rather than silence.
    """
    eff_fade = fade_out_s if fade_out_s > 0 else 0.0
    fade_start = max(0.0, video_dur - eff_fade) if eff_fade > 0 else video_dur

    # Pre-trim string applied to every input copy
    pre = f"atrim={active_start:.4f}:{active_end:.4f},asetpts=PTS-STARTPTS"

    # Final trim + volume + optional fade + mix tail (applied after all acrossfade ops).
    # Movie audio is ducked by movie_vol so prominent music actually dominates.
    fade_filter = f",afade=t=out:st={fade_start:.4f}:d={eff_fade:.4f}" if eff_fade > 0 else ""
    tail = (
        f"atrim=0:{video_dur:.4f},asetpts=PTS-STARTPTS,"
        f"volume={music_volume:.4f}{fade_filter}[mus];"
        f"[0:a]volume={movie_vol:.4f}[movaudio];"
        f"[movaudio][mus]amix=inputs=2:duration=first:dropout_transition=3[aout]"
    )

    if n_copies == 1:
        return f"[1:a]{pre},{tail}"

    # Pre-trim all copies into named labels [t1]..[tN]
    parts = []
    for i in range(1, n_copies + 1):
        parts.append(f"[{i}:a]{pre}[t{i}]")

    # Pairwise chained acrossfade: [t1][t2]acrossfade=d=X[ac1]; [ac1][t3]acrossfade=d=X[ac2]; ...
    prev = "[t1]"
    for i in range(2, n_copies + 1):
        out = "[mus_raw]" if i == n_copies else f"[ac{i - 1}]"
        parts.append(f"{prev}[t{i}]acrossfade=d={crossfade_s:.2f}{out}")
        prev = out

    return ";".join(parts) + ";[mus_raw]" + tail


def mix_music(
    video_path: Path,
    video_duration_s: float,
    track_name: str | None,
    music_dir: Path,
    out_path: Path,
    music_volume: float = 0.4,
    movie_vol: float = 1.0,
    custom_track_path: "Path | None" = None,
    fade_out_s: float = FADE_OUT_S,
) -> Path:
    """
    Mix a background music track into video_path.

    Args:
        video_path:        Input video (with existing audio).
        video_duration_s:  Total video duration in seconds.
        track_name:        Filename of bundled track in music_dir (e.g. "cinematic.mp3").
                           None -> use custom_track_path or skip.
        music_dir:         Directory containing bundled music tracks.
        out_path:          Output path for mixed video.
        music_volume:      Float 0.0-1.0 mix level for the music track.
        custom_track_path: Full WSL path to a user-supplied audio file. Takes priority over
                           track_name when set.

    Returns:
        out_path if music was mixed, video_path if skipped.
    """
    if custom_track_path:
        track_path = custom_track_path
        log.info("[B2] custom track: %s", track_path)
    elif track_name:
        track_path = music_dir / track_name
    else:
        log.info("[music] No track specified -- skipping")
        return video_path

    if not track_path.exists():
        log.warning("[music] Track not found: %s -- skipping", track_path)
        return video_path

    active_start, active_end = _get_active_region(track_path)
    active_dur  = active_end - active_start
    crossfade_s = min(CROSSFADE_S, active_dur * 0.4)
    n_copies    = _compute_copies(video_duration_s, active_dur, crossfade_s)

    log.info(
        "[music] Mixing %s (active=%.2fs-%.2fs, video=%.2fs, copies=%d, xfade=%.2fs, vol=%.4f)",
        track_name, active_start, active_end, video_duration_s, n_copies, crossfade_s, music_volume,
    )

    fc = _build_filter(n_copies, active_start, active_end, crossfade_s, video_duration_s, music_volume, movie_vol, fade_out_s)
    log.info("[music] filter_complex: %s", fc)

    cmd = [FFMPEG, "-y", "-i", str(video_path)]
    for _ in range(n_copies):
        cmd.extend(["-i", str(track_path)])
    cmd.extend([
        "-filter_complex", fc,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        str(out_path),
    ])

    ffmpeg_run(cmd)
    return out_path
