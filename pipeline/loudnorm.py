"""
pipeline/loudnorm.py — Two-pass EBU R128 loudness normalisation (-14 LUFS).

Pass 1: measure (loudnorm with print_format=json, parse stderr).
Pass 2: apply linear correction using measured values.

Timeout guard: if Lambda context is provided and remaining time is insufficient,
loudnorm is skipped with a WARNING. Controlled by LAMBDA_TIMEOUT_BUFFER_S env var.
"""

import json
import logging
import os
import re
import subprocess
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run, get_duration, has_audio

log = logging.getLogger(__name__)

LAMBDA_TIMEOUT_BUFFER_S = int(os.environ.get("LAMBDA_TIMEOUT_BUFFER_S", "30"))

# Target: -14 LUFS integrated, LRA 11, true peak -1 dBTP
LOUDNORM_I = -14
LOUDNORM_LRA = 11
LOUDNORM_TP = -1

# Regex to extract the JSON block from loudnorm pass-1 stderr
_JSON_RE = re.compile(r"\{[^{}]+\}", re.DOTALL)


def _parse_loudnorm_stats(stderr: str) -> dict:
    """Extract loudnorm measurement JSON from FFmpeg stderr."""
    matches = _JSON_RE.findall(stderr)
    if not matches:
        raise RuntimeError("loudnorm pass 1: no JSON stats found in stderr")
    # Take the last JSON block (loudnorm outputs its block at the end)
    return json.loads(matches[-1])


def loudnorm(video_path: Path, out_path: Path, context=None) -> Path:
    """
    Apply two-pass loudness normalisation to video_path.

    Args:
        video_path: Input video.
        out_path:   Output path.
        context:    Lambda context object (for get_remaining_time_in_millis()).
                    None in local/run_local mode — loudnorm always runs.

    Returns:
        out_path if normalised, video_path if skipped (no audio or timeout risk).
    """
    # Skip if no audio
    if not has_audio(video_path):
        log.info("[loudnorm] No audio in %s — skipping", video_path.name)
        return video_path

    # Timeout guard: estimate loudnorm runtime as ~2x real-time per pass (~4x total)
    if context is not None:
        remaining_s = context.get_remaining_time_in_millis() / 1000
        video_dur = get_duration(video_path)
        estimated_s = video_dur * 4  # conservative: 2 passes x 2x real-time
        if remaining_s - LAMBDA_TIMEOUT_BUFFER_S < estimated_s:
            log.warning(
                "[loudnorm] Skipped — insufficient Lambda time remaining "
                "(%.1fs left, need ~%.1fs, buffer=%ds)",
                remaining_s, estimated_s, LAMBDA_TIMEOUT_BUFFER_S
            )
            return video_path

    log.info("[loudnorm] Pass 1: measuring %s", video_path.name)

    # Pass 1: measure
    pass1_result = subprocess.run(
        [
            FFMPEG, "-y",
            "-i", str(video_path),
            "-af", (
                f"loudnorm=I={LOUDNORM_I}:LRA={LOUDNORM_LRA}:TP={LOUDNORM_TP}"
                ":print_format=json"
            ),
            "-f", "null", "-",
        ],
        capture_output=True, text=True
    )
    if pass1_result.returncode != 0:
        raise RuntimeError(f"loudnorm pass 1 failed:\n{pass1_result.stderr[-2000:]}")

    stats = _parse_loudnorm_stats(pass1_result.stderr)
    log.info("[loudnorm] Measured: I=%s LRA=%s TP=%s thresh=%s",
             stats.get("input_i"), stats.get("input_lra"),
             stats.get("input_tp"), stats.get("input_thresh"))

    log.info("[loudnorm] Pass 2: applying correction to %s", video_path.name)

    # Pass 2: apply linear correction
    ffmpeg_run([
        FFMPEG, "-y",
        "-i", str(video_path),
        "-af", (
            f"loudnorm=I={LOUDNORM_I}:LRA={LOUDNORM_LRA}:TP={LOUDNORM_TP}"
            f":measured_I={stats['input_i']}"
            f":measured_LRA={stats['input_lra']}"
            f":measured_TP={stats['input_tp']}"
            f":measured_thresh={stats['input_thresh']}"
            ":linear=true"
            ":print_format=summary"
        ),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        str(out_path),
    ])

    return out_path
