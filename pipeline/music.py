"""
pipeline/music.py — Mix a background music track under the rendered video.

- No-op if track_name is None or the track file doesn't exist.
- Trims track to video duration.
- Fades music out over final 3 seconds.
- Mixes at lower volume so original audio remains prominent.
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)

FADE_OUT_S = 3.0        # Seconds to fade music out at end


def mix_music(
    video_path: Path,
    video_duration_s: float,
    track_name: str | None,
    music_dir: Path,
    out_path: Path,
    music_volume: float = 0.4,
) -> Path:
    """
    Mix a background music track into video_path.

    Args:
        video_path:       Input video (with existing audio).
        video_duration_s: Total video duration in seconds.
        track_name:       Filename of music track in music_dir (e.g. "track_01.mp3").
                          None or missing file -> return video_path unchanged.
        music_dir:        Directory containing music tracks.
        out_path:         Output path for mixed video.

    Returns:
        out_path if music was mixed, video_path if skipped.
    """
    if not track_name:
        log.info("[music] No track specified — skipping")
        return video_path

    track_path = music_dir / track_name
    if not track_path.exists():
        log.warning("[music] Track not found: %s — skipping", track_path)
        return video_path

    fade_start = max(0.0, video_duration_s - FADE_OUT_S)

    log.info("[music] Mixing %s (fade out at %.2fs)", track_name, fade_start)

    # filter_complex:
    #   [1:a] = music track
    #   atrim  -> trim to video duration
    #   volume -> lower music level
    #   afade  -> fade out last FADE_OUT_S seconds
    #   amix   -> mix with original audio, keep original duration
    fc = (
        f"[1:a]atrim=0:{video_duration_s:.4f},"
        f"volume={music_volume:.4f},"
        f"afade=t=out:st={fade_start:.4f}:d={FADE_OUT_S}[mus];"
        f"[0:a][mus]amix=inputs=2:duration=first:dropout_transition=3[aout]"
    )

    ffmpeg_run([
        FFMPEG, "-y",
        "-i", str(video_path),
        "-i", str(track_path),
        "-filter_complex", fc,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        str(out_path),
    ])

    return out_path
