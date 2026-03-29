"""
pipeline/render.py -- Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1.  normalise      -> H.264/yuv420p/25fps/1080p/AAC
  1b. motion filter  -> (if config.filter_boring) score clips, exclude boring,
                        cap at max_clips by motion_score * sqrt(duration)
  2.  peak trim      -> best-motion window per clip (reuses scored_frames from 1b);
                        falls back to silence trim if motion data unavailable
  3.  zoom           -> (if config.zoom, final mode only)
  4.  cards          -> prepend intro, append outro (if text provided)
  5.  render         -> filter_complex xfade + scale, or single-clip shortcut
  5a. beat-sync      -> re-trim clip durations to align cut points with music beats
  6.  mix_music      -> (if config.music_mood != "none")
  7.  loudnorm       -> two-pass EBU R128 (final mode only)

Entry points:
  run_pipeline(job, clips, clip_paths, ...) -> Path
  run_local(clips_dir, output_dir)          -> None  (no R2/Supabase)
"""

import logging
import shutil
from math import sqrt
from pathlib import Path

from .beats import detect_beats, snap_to_beat
from .cards import make_card
from .detect import detect_trim_points
from .loudnorm import loudnorm
from .motion import filter_by_motion, find_peak_window
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

    # Motion scoring state -- populated in Step 1b, consumed in Steps 2 and 5a.
    clips_total = len(clip_paths)
    clips_used = clips_total
    clips_excluded = 0
    scored_frames_map: dict[Path, list[tuple[float, float]]] = {}
    scores_dict: dict[Path, float] = {}

    # 1. Normalise -- report per-clip so progress doesn't appear stuck.
    report_stage("normalise")
    log.info("[render] Step 1: normalise")
    report(10)

    def _normalise_progress(done: int, total: int) -> None:
        report(10 + int(done / total * 15))  # 10% -> 25%

    current_paths = normalise(clip_paths, tmp, mode=mode, on_clip_done=_normalise_progress)

    # 1b. Motion scoring: boring filter (13a) + clip cap (13b).
    # Runs on normalised clips for consistent format. Populates scored_frames_map
    # for reuse in peak window trim (Step 2) -- no extra FFmpeg pass there.
    if config.get("filter_boring", False) and len(current_paths) > 1:
        report_stage("motion_analysis")
        log.info("[render] Step 1b: motion scoring (%d clips)", len(current_paths))

        kept, excluded, scores_dict, scored_frames_map = filter_by_motion(current_paths)
        clips_excluded = len(excluded)
        current_paths = kept

        # Clip cap (13b): if too many clips remain, keep top N by motion_score * sqrt(duration).
        MAX_CLIPS = int(config.get("max_clips", 20))
        if len(current_paths) > MAX_CLIPS:
            scored = [
                (scores_dict.get(p, 0.0) * sqrt(max(0.01, get_duration(p))), p)
                for p in current_paths
            ]
            current_paths = [p for _, p in sorted(scored)[-MAX_CLIPS:]]
            extra_excluded = clips_total - clips_excluded - len(current_paths)
            clips_excluded += extra_excluded
            log.info("[render] Clip cap: kept top %d (cap=%d)", len(current_paths), MAX_CLIPS)

        clips_used = len(current_paths)
        report_stage(f"Motion analysis: {clips_used} of {clips_total} clips selected")
        log.info("[render] %d clips used, %d excluded", clips_used, clips_excluded)

    # Emit ANALYSIS line -- always, even when filter_boring=False (all 0 excluded).
    report_analysis(f"clips_used={clips_used},clips_total={clips_total},clips_excluded={clips_excluded}")

    # 2. Trim -- peak window (13c) if motion data available, silence trim otherwise.
    report_stage("trim")
    report(25)

    if scored_frames_map:
        # Peak window trim: reuses scored_frames from Step 1b -- zero extra FFmpeg passes.
        TARGET_DUR = float(config.get("target_clip_dur", 5.0))
        log.info("[render] Step 2: peak window trim (target=%.1fs per clip)", TARGET_DUR)
        trimmed = []
        for i, p in enumerate(current_paths):
            dur = get_duration(p)
            frames = scored_frames_map.get(p, [])
            start, end = find_peak_window(frames, dur, window_s=TARGET_DUR)
            # Guard: skip trim if window is essentially the full clip or too short.
            if end - start >= 0.5 and not (abs(start) < 0.01 and abs(end - dur) < 0.01):
                log.info("[render] Clip %d peak trim: %.2fs->%.2fs (%.2fs)", i, start, end, end - start)
                out = tmp / f"peak_{i}.mp4"
                trimmed.append(trim(p, start, end, out))
            else:
                log.info("[render] Clip %d peak trim: full clip kept (%.2fs)", i, dur)
                trimmed.append(p)
        current_paths = trimmed

    elif config.get("silence_removal", False):
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
    report_stage("render")
    # CRITICAL: durations must come from current_paths (post-trim), not original clips.
    report(50)
    log.info("[render] Step 5: render with xfade")
    output = tmp / "render.mp4"
    durations = [get_duration(p) for p in current_paths]
    audio_flags = [has_audio(p) for p in current_paths]

    # 5a. Beat-sync (13d): snap cut points to music beats, re-trim to beat-aligned durations.
    # Runs before inject_silence and build_filter_complex so durations are already final.
    # Note: durations list is mutated in-place where clips are re-trimmed.
    beat_times = detect_beats(music_path) if music_path else []
    if beat_times:
        log.info("[render] Step 5a: beat-sync (%d beats)", len(beat_times))
        cumulative = 0.0
        adjusted_paths = []
        for i, (p, dur) in enumerate(zip(list(current_paths), list(durations))):
            cut_time = cumulative + dur
            snapped = snap_to_beat(cut_time, beat_times)
            # Never trim a clip shorter than 0.5s.
            new_dur = max(0.5, snapped - cumulative)
            delta = abs(new_dur - dur)
            log.info(
                "[render] Beat-sync clip %d: %.3fs -> %.3fs (delta=%.3fs)",
                i, dur, new_dur, delta,
            )
            if delta > 0.05:
                beat_out = tmp / f"beat_{i}.mp4"
                adjusted_paths.append(trim(p, 0.0, new_dur, beat_out))
                durations[i] = new_dur
            else:
                adjusted_paths.append(p)
            cumulative = snapped
        current_paths = adjusted_paths
    else:
        log.info("[render] Step 5a: beat-sync skipped (no beats or no music)")

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

    # 6. Mix music.
    report_stage("music")
    report(75)
    if music_filename:
        log.info("[render] Step 6: mix music (%s)", music_mood)
        music_out = tmp / "with_music.mp4"
        music_volume = float(config.get("music_volume", 0.4))
        output = mix_music(output, sum(durations), music_filename, MUSIC_DIR, music_out, music_volume=music_volume)
    else:
        log.info("[render] Step 6: music skipped")

    # 7. Loudnorm (final only -- two-pass is too slow for draft).
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
