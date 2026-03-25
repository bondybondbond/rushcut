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
import re
import shutil
import subprocess
from pathlib import Path

from .cards import make_card
from .detect import detect_trim_points
from .loudnorm import loudnorm
from .music import mix_music
from .normalise import normalise
from .transitions import build_filter_complex
from .trim import trim
from .utils import FFMPEG, ffmpeg_run, get_duration, get_frame_size, has_audio
from .zoom import apply_zoom

log = logging.getLogger(__name__)

MUSIC_DIR = Path(__file__).parent.parent / "music"
TMP_BASE = Path("/tmp")


# ---------------------------------------------------------------------------
# Boring clip detection
# ---------------------------------------------------------------------------

BORING_FREEZE_RATIO = 0.7  # clips where >= 70% of duration is frozen -> boring


def is_boring_clip(clip_path: Path, duration_s: float) -> bool:
    """
    Return True if the clip is mostly static (frozen frames).
    Uses ffmpeg freezedetect: clips where >= BORING_FREEZE_RATIO of duration
    is frozen are considered boring and should be filtered out.
    """
    if duration_s <= 0:
        return False
    try:
        result = subprocess.run(
            [
                FFMPEG, "-i", str(clip_path),
                "-vf", "freezedetect=n=-60dB:d=0.5",
                "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=60,
        )
        freeze_starts = [float(m) for m in re.findall(r"freeze_start: ([0-9.]+)", result.stderr)]
        freeze_ends   = [float(m) for m in re.findall(r"freeze_end: ([0-9.]+)", result.stderr)]
        frozen_time = sum(e - s for s, e in zip(freeze_starts, freeze_ends))
        return (frozen_time / duration_s) >= BORING_FREEZE_RATIO
    except Exception:
        return False  # on error, keep the clip


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
    on_progress=None,
    on_stage=None,
) -> Path:
    """
    Run the full render pipeline for a job.

    Args:
        job:         Job row dict (id, mode, config).
        clips:       Clip row dicts (used for metadata if needed).
        clip_paths:  Ordered list of downloaded clip Paths.
        context:     Lambda context (for loudnorm timeout guard). None in local mode.
        on_progress: Callback(pct: int) to report progress (0-100). None in local mode.

    Returns:
        Path to the final output file (in /tmp/{job_id}/).
    """
    job_id = job["id"]
    mode = job.get("mode", "draft")            # "draft" | "final"
    config = job.get("config") or {}

    def report(pct: int) -> None:
        if on_progress:
            try:
                on_progress(pct)
            except Exception:
                log.warning("[render] Failed to report progress %d%%", pct)

    def report_stage(stage: str) -> None:
        if on_stage:
            try:
                on_stage(stage)
            except Exception:
                pass

    tmp = TMP_BASE / str(job_id)
    tmp.mkdir(parents=True, exist_ok=True)
    log.info("[render] Job %s | mode=%s | %d clips", job_id, mode, len(clip_paths))

    # 1. Normalise — report per-clip so progress doesn't appear stuck
    report_stage("normalise")
    log.info("[render] Step 1: normalise")
    report(10)
    n_clips = len(clip_paths)
    def _normalise_progress(done: int, total: int) -> None:
        report(10 + int(done / total * 15))  # 10% -> 25%
    current_paths = normalise(clip_paths, tmp, mode=mode, on_clip_done=_normalise_progress)

    # 1b. Boring clip filter (after normalise so we have consistent format for freezedetect)
    if config.get("filter_boring", False) and len(current_paths) > 1:
        report_stage("filter_boring")
        log.info("[render] Step 1b: boring clip filter")
        kept = []
        for p in current_paths:
            dur = get_duration(p)
            if is_boring_clip(p, dur):
                log.info("[render] Dropping boring clip: %s (%.1fs)", p.name, dur)
            else:
                kept.append(p)
        if kept:
            current_paths = kept
            log.info("[render] Kept %d/%d clips after boring filter", len(kept), len(clip_paths))
        else:
            log.warning("[render] All clips were boring — keeping all to avoid empty render")
            # current_paths unchanged

    # 2. Silence detect + trim (IMPORTANT: get_duration() is called on trimmed paths below)
    report_stage("silence_trim")
    report(25)
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
    report_stage("zoom")
    # Skipped in draft mode — zoompan is CPU-intensive (frame-by-frame) and
    # easily exceeds the 900s Lambda timeout on multi-clip drafts.
    report(35)
    if config.get("zoom", False) and mode == "final":
        log.info("[render] Step 3: zoom")
        current_paths = [
            apply_zoom(p, tmp / f"zoom_{i}.mp4")
            for i, p in enumerate(current_paths)
        ]
    else:
        log.info("[render] Step 3: zoom skipped (mode=%s)", mode)

    # 4. Cards (pre-render as video segments, prepend/append)
    report_stage("cards")
    # Use actual clip dimensions so xfade size matches — clips may not be 16:9
    clip_w, clip_h = get_frame_size(current_paths[0])
    card_size = f"{clip_w}x{clip_h}"

    # Phase 2 format: intro_text / intro_color / outro_text / outro_color
    # (Legacy Phase 1 format intro_card/end_card also handled as fallback)
    intro_text = config.get("intro_text") or (config.get("intro_card") or {}).get("text", "")
    intro_color = (
        config.get("intro_color")
        or (config.get("intro_card") or {}).get("color", "#000000")
    )
    if intro_text:
        log.info("[render] Step 4: intro card")
        card = make_card(
            text=intro_text,
            color=intro_color,
            duration_s=3.0,
            out_path=tmp / "intro_card.mp4",
            size=card_size,
        )
        current_paths = [card] + current_paths

    outro_text = config.get("outro_text") or (config.get("end_card") or {}).get("text", "")
    outro_color = (
        config.get("outro_color")
        or (config.get("end_card") or {}).get("color", "#000000")
    )
    if outro_text:
        log.info("[render] Step 4: outro card")
        card = make_card(
            text=outro_text,
            color=outro_color,
            duration_s=3.0,
            out_path=tmp / "end_card.mp4",
            size=card_size,
        )
        current_paths = current_paths + [card]

    # 5. Build filter_complex + render
    report_stage("render")
    # CRITICAL: durations from current_paths (post-trim), NOT original clip durations
    report(50)
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
    report_stage("music")
    report(75)
    music_mood = config.get("music_mood", "none")
    music_filename = f"{music_mood}.mp3" if music_mood and music_mood != "none" else None
    if music_filename:
        log.info("[render] Step 6: mix music (%s)", music_mood)
        music_out = tmp / "with_music.mp4"
        output = mix_music(output, sum(durations), music_filename, MUSIC_DIR, music_out)
    else:
        log.info("[render] Step 6: music skipped")

    # 7. Loudnorm (final only — two-pass is too slow for draft on Lambda)
    report_stage("loudnorm")
    report(85)
    if mode != "draft":
        log.info("[render] Step 7: loudnorm")
        final_out = tmp / "final.mp4"
        output = loudnorm(output, final_out, context=context)
    else:
        log.info("[render] Step 7: loudnorm skipped (draft mode)")

    report(95)
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
