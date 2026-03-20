"""
pipeline/render.py — Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1. normalise       -> H.264/yuv420p/25fps/1080p/AAC
  2. detect + trim   -> (if config.silence_removal)
  3. zoom            -> (if config.zoom, per-clip)
  4. cards           -> prepend intro, append end card (if enabled)
  5. render          -> filter_complex xfade + scale, or single-clip shortcut
  6. mix_music       -> (if config.music_track)
  7. loudnorm        -> two-pass EBU R128 (with Lambda timeout guard)

Entry points:
  run_pipeline(job, clips, clip_paths, context=None) -> Path
  run_local(clips_dir, output_dir)                   -> None  (no R2/Supabase)
"""

import logging
import shutil
from pathlib import Path

from .cards import make_card
from .detect import detect_trim_points
from .loudnorm import loudnorm
from .music import mix_music
from .normalise import normalise
from .transitions import build_filter_complex
from .trim import trim
from .utils import FFMPEG, ffmpeg_run, get_duration, has_audio
from .zoom import apply_zoom

log = logging.getLogger(__name__)

MUSIC_DIR = Path(__file__).parent.parent / "music"
TMP_BASE = Path("/tmp")


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def inject_silence_where_needed(
    clip_paths: list[Path],
    durations: list[float],
    audio_flags: list[bool],
    tmp: Path,
) -> tuple[list[Path], list[bool]]:
    """
    For any clip without audio, create a copy with a silent audio stream.
    Ported from spike/render.py.

    Returns updated (clip_paths, audio_flags) — all audio_flags will be True.
    """
    updated = list(clip_paths)
    updated_flags = list(audio_flags)

    for i, (p, has_a, dur) in enumerate(zip(clip_paths, audio_flags, durations)):
        if not has_a:
            log.info("[render] %s has no audio — injecting silence (%.4fs)", p.name, dur)
            silent = tmp / f"silent_{i}.mp4"
            ffmpeg_run([
                FFMPEG, "-y",
                "-i", str(p),
                "-f", "lavfi", "-i", f"aevalsrc=0:c=stereo:s=44100:d={dur:.4f}",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "128k",
                "-shortest",
                str(silent),
            ])
            updated[i] = silent
            updated_flags[i] = True

    return updated, updated_flags


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_pipeline(
    job: dict,
    clips: list[dict],
    clip_paths: list[Path],
    context=None,
) -> Path:
    """
    Run the full render pipeline for a job.

    Args:
        job:        Job row dict (id, mode, config).
        clips:      Clip row dicts (used for metadata if needed).
        clip_paths: Ordered list of downloaded clip Paths.
        context:    Lambda context (for loudnorm timeout guard). None in local mode.

    Returns:
        Path to the final output file (in /tmp/{job_id}/).
    """
    job_id = job["id"]
    mode = job.get("mode", "draft")            # "draft" | "final"
    config = job.get("config") or {}

    tmp = TMP_BASE / str(job_id)
    tmp.mkdir(parents=True, exist_ok=True)
    log.info("[render] Job %s | mode=%s | %d clips", job_id, mode, len(clip_paths))

    # 1. Normalise
    log.info("[render] Step 1: normalise")
    current_paths = normalise(clip_paths, tmp)

    # 2. Silence detect + trim (IMPORTANT: get_duration() is called on trimmed paths below)
    if config.get("silence_removal", False):
        log.info("[render] Step 2: silence trim")
        trimmed = []
        for i, p in enumerate(current_paths):
            dur = get_duration(p)
            start, end = detect_trim_points(p, dur)
            out = tmp / f"trim_{i}.mp4"
            trimmed.append(trim(p, start, end, out))
        current_paths = trimmed
    else:
        log.info("[render] Step 2: silence trim skipped")

    # 3. Zoom (per-clip, before transitions)
    if config.get("zoom", False):
        log.info("[render] Step 3: zoom")
        current_paths = [
            apply_zoom(p, tmp / f"zoom_{i}.mp4")
            for i, p in enumerate(current_paths)
        ]
    else:
        log.info("[render] Step 3: zoom skipped")

    # 4. Cards (pre-render as video segments, prepend/append)
    card_size = "1920x1080" if mode == "final" else "640x360"

    intro_cfg = config.get("intro_card") or {}
    if intro_cfg.get("enabled"):
        log.info("[render] Step 4: intro card")
        card = make_card(
            text=intro_cfg.get("text", ""),
            color=intro_cfg.get("color", "black"),
            duration_s=3.0,
            out_path=tmp / "intro_card.mp4",
            size=card_size,
        )
        current_paths = [card] + current_paths

    end_cfg = config.get("end_card") or {}
    if end_cfg.get("enabled"):
        log.info("[render] Step 4: end card")
        card = make_card(
            text=end_cfg.get("text", ""),
            color=end_cfg.get("color", "black"),
            duration_s=3.0,
            out_path=tmp / "end_card.mp4",
            size=card_size,
        )
        current_paths = current_paths + [card]

    # 5. Build filter_complex + render
    # CRITICAL: durations from current_paths (post-trim), NOT original clip durations
    log.info("[render] Step 5: render with xfade")
    output = tmp / "render.mp4"
    durations = [get_duration(p) for p in current_paths]
    audio_flags = [has_audio(p) for p in current_paths]

    # Inject silence for any clips lacking audio (cards have no audio)
    current_paths, audio_flags = inject_silence_where_needed(
        current_paths, durations, audio_flags, tmp
    )

    crf, preset = (35, "ultrafast") if mode == "draft" else (22, "slow")
    scale_h = "360" if mode == "draft" else "1080"

    if len(current_paths) == 1:
        # Single-clip shortcut: no filter_complex needed (CLAUDE.md)
        log.info("[render] Single clip — using simple -vf scale")
        cmd = [
            FFMPEG, "-y",
            "-i", str(current_paths[0]),
            "-vf", f"scale=-2:{scale_h}",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-crf", str(crf),
            "-preset", preset,
        ]
        if audio_flags[0]:
            cmd += ["-c:a", "aac", "-b:a", "128k"]
        cmd.append(str(output))
        ffmpeg_run(cmd)
    else:
        fc, v_out, a_out = build_filter_complex(
            current_paths, durations, audio_flags,
            transition=config.get("transition", "crossfade"),
            mode=mode,
        )
        log.info("[render] filter_complex:\n  %s", fc)

        inputs = [arg for p in current_paths for arg in ("-i", str(p))]
        cmd = (
            [FFMPEG, "-y"]
            + inputs
            + ["-filter_complex", fc, "-map", v_out]
            + (["-map", a_out] if a_out else [])
            + [
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-profile:v", "main",
                "-crf", str(crf),
                "-preset", preset,
                str(output),
            ]
        )
        ffmpeg_run(cmd)

    # 6. Mix music
    music_mood = config.get("music_mood", "none")
    music_filename = f"{music_mood}.mp3" if music_mood and music_mood != "none" else None
    if music_filename:
        log.info("[render] Step 6: mix music (%s)", music_mood)
        music_out = tmp / "with_music.mp4"
        output = mix_music(output, sum(durations), music_filename, MUSIC_DIR, music_out)
    else:
        log.info("[render] Step 6: music skipped")

    # 7. Loudnorm
    log.info("[render] Step 7: loudnorm")
    final_out = tmp / "final.mp4"
    output = loudnorm(output, final_out, context=context)

    log.info("[render] Pipeline complete: %s", output)
    return output


# ---------------------------------------------------------------------------
# Local test entry point (no R2 / Supabase)
# ---------------------------------------------------------------------------

def run_local(clips_dir: str, output_dir: str) -> None:
    """
    Run the draft pipeline on local .mp4 files.

    Scans clips_dir for *.mp4 (sorted by name), runs draft pipeline,
    writes output to output_dir/draft.mp4.

    No R2 or Supabase calls — safe for Docker local testing.
    """
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    clips_dir_path = Path(clips_dir)
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    clip_paths = sorted(clips_dir_path.glob("*.mp4"))
    if not clip_paths:
        raise RuntimeError(f"No .mp4 files found in {clips_dir}")

    log.info("[run_local] Found %d clips: %s", len(clip_paths), [p.name for p in clip_paths])

    # Synthetic job — all boolean config flags default to False to avoid KeyError
    job: dict = {
        "id": "local_test",
        "mode": "draft",
        "config": {
            "transition": "crossfade",
            "music_mood": "none",
            "silence_removal": False,
            "zoom": False,
            "intro_card": {"enabled": False, "text": "", "color": "black"},
            "end_card": {"enabled": False, "text": "", "color": "black"},
        },
    }

    clips = [
        {"id": f"clip_{i}", "filename": p.name}
        for i, p in enumerate(clip_paths)
    ]

    output = run_pipeline(job, clips, clip_paths, context=None)

    dest = output_dir_path / "draft.mp4"
    shutil.copy2(str(output), str(dest))
    log.info("[run_local] [PASS] Output: %s", dest)
