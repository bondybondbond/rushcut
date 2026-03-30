"""
pipeline/render.py -- Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1.  normalise      -> H.264/yuv420p/25fps/1080p/AAC
  2.  silence trim   -> (if config.silence_removal) trim silence from clip edges
  3.  zoom           -> (if config.zoom, final mode only)
  4.  cards          -> prepend intro, append outro (if text provided)
  5.  render         -> filter_complex xfade + scale, or single-clip shortcut
  6.  mix_music      -> (if config.music_mood != "none")
  7.  loudnorm       -> two-pass EBU R128 (final mode only)

Entry points:
  run_pipeline(job, clips, clip_paths, ...) -> Path
  run_local(clips_dir, output_dir)          -> None  (no R2/Supabase)
"""

import logging
import shutil
import time
from pathlib import Path

from .cards import make_card
from .detect import detect_trim_points
from .loudnorm import loudnorm
from .music import mix_music
from .normalise import normalise
from .transitions import build_filter_complex
from .trim import trim
from .utils import FFMPEG, ffmpeg_run, get_duration, get_frame_size, has_audio, log_av_sync
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

    Returns updated (clip_paths, audio_flags) -- all audio_flags will be True.
    """
    updated = list(clip_paths)
    updated_flags = list(audio_flags)

    for i, (p, has_a, dur) in enumerate(zip(clip_paths, audio_flags, durations)):
        if not has_a:
            log.info("[render] %s has no audio -- injecting silence (%.4fs)", p.name, dur)
            silent = tmp / f"silent_{i}.mp4"
            ffmpeg_run([
                FFMPEG, "-y",
                "-i", str(p),
                "-f", "lavfi", "-i", f"aevalsrc=0:c=stereo:s=44100:d={dur:.4f}",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
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
    on_analysis=None,
) -> Path:
    """
    Run the full render pipeline for a job.

    Args:
        job:         Job row dict (id, mode, config).
        clips:       Clip row dicts (metadata, unused in pipeline body).
        clip_paths:  Ordered list of downloaded clip Paths.
        context:     Lambda context (loudnorm timeout guard). None in local mode.
        on_progress: Callback(pct: int) -- progress 0-100.
        on_stage:    Callback(stage: str) -- human-readable stage label.
        on_analysis: Callback(data: str) -- ANALYSIS stats string for Rust to store.

    Returns:
        Path to the final output file (in /tmp/{job_id}/).
    """
    job_id = job["id"]
    mode = job.get("mode", "draft")     # "draft" | "final"
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

    def report_analysis(data: str) -> None:
        if on_analysis:
            try:
                on_analysis(data)
            except Exception:
                pass

    tmp = TMP_BASE / str(job_id)
    tmp.mkdir(parents=True, exist_ok=True)
    log.info("[render] Job %s | mode=%s | %d clips", job_id, mode, len(clip_paths))

    # Compute music path early -- needed for beat detection before Step 5.
    music_mood = config.get("music_mood", "none")
    music_filename = f"{music_mood}.mp3" if music_mood and music_mood != "none" else None
    music_path = MUSIC_DIR / music_filename if music_filename else None

    # ANALYSIS counters -- all clips used, no motion filtering.
    clips_total = len(clip_paths)
    clips_used = clips_total
    clips_excluded = 0

    # 1. Normalise -- report per-clip so progress doesn't appear stuck.
    report_stage("Normalising clips")
    log.info("[render] Step 1: normalise")
    report(10)
    t0 = time.time()

    def _normalise_progress(done: int, total: int) -> None:
        report(10 + int(done / total * 15))  # 10% -> 25%

    current_paths = normalise(clip_paths, tmp, mode=mode, on_clip_done=_normalise_progress)
    print(f"TIMING:normalise={time.time()-t0:.1f}s", flush=True)

    # Emit ANALYSIS line.
    report_analysis(f"clips_used={clips_used},clips_total={clips_total},clips_excluded={clips_excluded}")

    # 2. Silence trim.
    report_stage("Trimming clips")
    report(25)
    t0 = time.time()

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
        log.info("[render] Step 2: trim skipped")

    print(f"TIMING:trim={time.time()-t0:.1f}s", flush=True)
    for i, p in enumerate(current_paths):
        log_av_sync(p, f"post-trim_{i}")

    # 3. Zoom (per-clip, before transitions).
    # Skipped in draft mode -- zoompan is CPU-intensive and can exceed timeout.
    report_stage("zoom")
    report(35)
    if config.get("zoom", False) and mode == "final":
        log.info("[render] Step 3: zoom")
        current_paths = [
            apply_zoom(p, tmp / f"zoom_{i}.mp4")
            for i, p in enumerate(current_paths)
        ]
    else:
        log.info("[render] Step 3: zoom skipped (mode=%s)", mode)

    # 4. Cards (pre-render as video segments, prepend/append).
    report_stage("cards")
    # Use actual clip dimensions so xfade size matches -- clips may not be 16:9.
    clip_w, clip_h = get_frame_size(current_paths[0])
    card_size = f"{clip_w}x{clip_h}"

    # Phase 2 format: intro_text / intro_color / outro_text / outro_color.
    # Legacy Phase 1 format intro_card/end_card also handled as fallback.
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

    # 5. Build filter_complex + render.
    report_stage("Rendering")
    # CRITICAL: durations must come from current_paths (post-trim), not original clips.
    report(50)
    log.info("[render] Step 5: render with xfade")
    output = tmp / "render.mp4"
    durations = [get_duration(p) for p in current_paths]
    audio_flags = [has_audio(p) for p in current_paths]
    t0 = time.time()

    # Inject silence for any clips lacking audio (cards have no audio).
    current_paths, audio_flags = inject_silence_where_needed(
        current_paths, durations, audio_flags, tmp
    )

    crf, preset = (35, "ultrafast") if mode == "draft" else (22, "slow")
    scale_h = "360" if mode == "draft" else "1080"

    if len(current_paths) == 1:
        # Single-clip shortcut: no filter_complex needed (CLAUDE.md).
        log.info("[render] Single clip -- using simple -vf scale")
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
            cmd += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
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
            ]
            + (["-c:a", "aac", "-b:a", "128k", "-ar", "48000"] if a_out else [])
            + [str(output)]
        )
        ffmpeg_run(cmd)

    print(f"TIMING:render={time.time()-t0:.1f}s", flush=True)

    # 6. Mix music.
    report_stage("Mixing music")
    report(75)
    t0 = time.time()
    if music_filename:
        log.info("[render] Step 6: mix music (%s)", music_mood)
        music_out = tmp / "with_music.mp4"
        music_volume = float(config.get("music_volume", 0.4))
        output = mix_music(output, sum(durations), music_filename, MUSIC_DIR, music_out, music_volume=music_volume)
    else:
        log.info("[render] Step 6: music skipped")
    print(f"TIMING:music={time.time()-t0:.1f}s", flush=True)

    # 7. Loudnorm (final only -- two-pass is too slow for draft).
    report_stage("Loudnorm")
    report(85)
    t0 = time.time()
    if mode != "draft":
        log.info("[render] Step 7: loudnorm")
        final_out = tmp / "final.mp4"
        output = loudnorm(output, final_out, context=context)
    else:
        log.info("[render] Step 7: loudnorm skipped (draft mode)")
    print(f"TIMING:loudnorm={time.time()-t0:.1f}s", flush=True)

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

    No R2 or Supabase calls -- safe for local testing.
    """
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    clips_dir_path = Path(clips_dir)
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    clip_paths = sorted(clips_dir_path.glob("*.mp4"))
    if not clip_paths:
        raise RuntimeError(f"No .mp4 files found in {clips_dir}")

    log.info("[run_local] Found %d clips: %s", len(clip_paths), [p.name for p in clip_paths])

    # Synthetic job -- all boolean config flags default to False to avoid KeyError.
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
