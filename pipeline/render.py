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
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import subprocess

from .cards import make_card
from .detect import detect_trim_points
from .loudnorm import loudnorm
from .music import mix_music
from .normalise import normalise
from .proxy import is_valid_proxy
from .transitions import build_filter_complex
from .trim import trim
from .utils import FFMPEG, ffmpeg_run, get_duration, get_frame_size, has_audio, log_av_sync
from .zoom import apply_zoom

log = logging.getLogger(__name__)


def _proxy_height(proxy_wsl: str) -> int:
    """Return video stream height of proxy file, or 0 on error.

    Used to detect legacy 480p proxies — those cannot substitute for a 1080p
    normalised intermediate and must fall back to the normalise path.
    """
    try:
        r = subprocess.run(
            [
                "/usr/bin/ffprobe", "-v", "quiet",
                "-select_streams", "v:0",
                "-show_entries", "stream=height",
                "-of", "csv=p=0",
                proxy_wsl,
            ],
            capture_output=True,
            timeout=10,
        )
        return int(r.stdout.decode().strip())
    except Exception:
        return 0

MUSIC_DIR = Path(__file__).parent.parent / "music"
TMP_BASE = Path("/tmp")

# Movie audio ducking per music_volume preset (0.2=subtle, 0.4=balanced, 0.7=prominent).
# As music gets louder, movie audio is ducked proportionally so music actually dominates.
_MOVIE_VOL = {0.2: 1.0, 0.4: 0.4, 0.7: 0.3}


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
    output_resolution = config.get("output_resolution", "1080p")  # "1080p" | "4k"

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
    t_wall_start = time.time()
    log.info("[render] Job %s | mode=%s | %d clips", job_id, mode, len(clip_paths))

    # Compute music path early -- needed for beat detection before Step 5.
    music_mood = config.get("music_mood", "none")
    # "custom" mood uses a user-supplied file path, not a bundled track
    music_filename = (
        f"{music_mood}.mp3" if music_mood and music_mood not in ("none", "custom") else None
    )
    music_path = MUSIC_DIR / music_filename if music_filename else None
    custom_music_path_wsl = (
        Path(config["custom_music_path"])
        if music_mood == "custom" and config.get("custom_music_path") else None
    )

    # ANALYSIS counters -- all clips used, no motion filtering.
    clips_total = len(clip_paths)
    clips_used = clips_total
    clips_excluded = 0

    # 1. Normalise -- report per-clip so progress doesn't appear stuck.
    report_stage("Normalising clips")
    log.info("[render] Step 1: normalise")
    report(10)
    t0 = time.time()

    # Pre-trim: extract only the needed segment from each source clip before normalise.
    # DJI clips can be 60-120s; user typically uses 5-30s. Normalising the full clip
    # wastes 4-10x time. Fast copy-seek to [in_s - 2s, out_s + 0.5s], then normalise
    # only the short segment. Step 2 fine-trims the normalised file with adjusted offsets.
    # Original `clips` preserved intact for ANALYSIS metrics (source duration/resolution).
    n_clips = len(clip_paths)
    pre_trimmed_paths: list = [None] * n_clips
    pipeline_clips:    list = [None] * n_clips

    def _pretrim_worker(i: int, src_p: Path, cm: dict) -> None:
        u_in  = cm.get("in_ms")
        u_out = cm.get("out_ms")
        if u_in is not None or u_out is not None:
            in_s    = (u_in  / 1000.0) if u_in  is not None else 0.0
            out_s   = (u_out / 1000.0) if u_out is not None else None
            a_start = max(0.0, in_s - 2.0)   # 2s pre-roll for keyframe alignment
            out_path = tmp / f"pretrim_{i}.mp4"
            cmd = [FFMPEG, "-y", "-ss", f"{a_start:.4f}"]
            if out_s is not None:
                cmd += ["-to", f"{out_s + 0.5:.4f}"]
            cmd += ["-i", str(src_p), "-c", "copy", str(out_path)]
            end_label = f"{out_s + 0.5:.2f}s" if out_s is not None else "EOF"
            log.info("[B0] clip %d: pre-trim %.2fs -> %s (src=%s)", i, a_start, end_label, src_p.name)
            ffmpeg_run(cmd)
            adj_in  = int((in_s  - a_start) * 1000) if u_in  is not None else None
            adj_out = int((out_s - a_start) * 1000) if out_s is not None else None
            pre_trimmed_paths[i] = out_path
            pipeline_clips[i]    = {**cm, "in_ms": adj_in, "out_ms": adj_out}
        else:
            pre_trimmed_paths[i] = src_p
            pipeline_clips[i]    = cm

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
        futures = [pool.submit(_pretrim_worker, i, src_p, cm)
                   for i, (src_p, cm) in enumerate(zip(clip_paths, clips))]
        for f in futures:
            f.result()

    # Partition clips: use 1080p proxy as normalise substitute where available.
    # A proxy qualifies only if it is valid (moov atom present) AND height >= 1080
    # (height < 1080 means it is a legacy 480p proxy from before Batch C — reject it).
    proxy_clip_indices: set[int] = set()
    norm_clip_indices:  list[int] = []

    for i, cm in enumerate(pipeline_clips):
        pwsl = cm.get("proxy_path_wsl")
        # Cache both checks to avoid two ffprobe calls per clip
        valid = bool(pwsl and is_valid_proxy(pwsl))
        height = _proxy_height(pwsl) if valid else 0
        if valid and height >= 1080:
            proxy_clip_indices.add(i)
            log.info("[C-proxy] clip %d: using 1080p proxy, skipping normalise", i)
        else:
            norm_clip_indices.append(i)
            reason = (
                "no proxy" if not pwsl
                else ("invalid" if not valid else f"<1080p (h={height})")
            )
            log.info("[C-proxy] clip %d: %s, normalising from source", i, reason)

    log.info("[C-proxy] %d proxy-skip / %d normalise", len(proxy_clip_indices), len(norm_clip_indices))

    # Initialise merged output array
    current_paths: list = [None] * n_clips

    # Proxy clips: proxy IS the normalised intermediate — point directly at it.
    # _pretrim_worker already ran for all clips and wrote B-0-adjusted in_ms/out_ms into
    # pipeline_clips[i] (offsets relative to the pretrim window start). Proxy covers the
    # FULL clip so those adjusted offsets are wrong — restore the original in_ms/out_ms
    # from `clips` so Step 2 applies the correct absolute offsets to the proxy.
    for i in proxy_clip_indices:
        current_paths[i] = Path(pipeline_clips[i]["proxy_path_wsl"])
        pipeline_clips[i] = {
            **pipeline_clips[i],
            "in_ms": clips[i].get("in_ms"),
            "out_ms": clips[i].get("out_ms"),
        }

    # Non-proxy clips: normalise from pre-trimmed source (existing B-0 path)
    if norm_clip_indices:
        norm_src = [pre_trimmed_paths[i] for i in norm_clip_indices]

        def _normalise_progress(done: int, total: int) -> None:
            report_stage(f"Normalising clip {done} of {total}")
            report(10 + int(done / total * 40))  # 10% -> 50%

        normed = normalise(
            norm_src, tmp, mode=mode,
            on_clip_done=_normalise_progress,
            output_resolution=output_resolution,
        )
        for j, i in enumerate(norm_clip_indices):
            current_paths[i] = normed[j]
    else:
        report(50)  # all proxy — skip normalise progress arc

    normalise_s = time.time() - t0
    print(
        f"TIMING:normalise={normalise_s:.1f}s"
        f" (proxy_skip={len(proxy_clip_indices)}/{n_clips})",
        flush=True,
    )

    # 2. Silence trim.
    report_stage("Trimming clips")
    report(52)
    t0 = time.time()

    # Check if any clip has user-set trim points (in_ms/out_ms from Review screen).
    has_user_trims = any(c.get("in_ms") is not None or c.get("out_ms") is not None for c in pipeline_clips)

    if has_user_trims or config.get("silence_removal", False):
        log.info("[render] Step 2: trim (user overrides: %s, silence_removal: %s)",
                 has_user_trims, config.get("silence_removal", False))
        trimmed = []
        for i, (p, clip_meta) in enumerate(zip(current_paths, pipeline_clips)):
            user_in = clip_meta.get("in_ms")
            user_out = clip_meta.get("out_ms")
            if user_in is not None or user_out is not None:
                # User-set trim points override silence detection (ms -> seconds)
                dur = get_duration(p)
                start = (user_in / 1000.0) if user_in is not None else 0.0
                end = (user_out / 1000.0) if user_out is not None else dur
                log.info("[render] Clip %d: user trim %.3fs -> %.3fs", i, start, end)
                out = tmp / f"trim_{i}.mp4"
                trimmed.append(trim(p, start, end, out))
            elif config.get("silence_removal", False):
                dur = get_duration(p)
                start, end = detect_trim_points(p, dur)
                out = tmp / f"trim_{i}.mp4"
                trimmed.append(trim(p, start, end, out))
            else:
                trimmed.append(p)
        current_paths = trimmed
    else:
        log.info("[render] Step 2: trim skipped")

    trim_s = time.time() - t0
    print(f"TIMING:trim={trim_s:.1f}s", flush=True)
    for i, p in enumerate(current_paths):
        log_av_sync(p, f"post-trim_{i}")

    # 3. Zoom (per-clip, before transitions).
    # Skipped in draft mode -- zoompan is CPU-intensive and can exceed timeout.
    # Per-clip zoom_mode from Review screen takes precedence over global config.zoom.
    report_stage("zoom")
    report(55)
    t_zoom = time.time()
    has_per_clip_zoom = any(c.get("zoom_mode") for c in pipeline_clips)
    global_zoom = config.get("zoom", False) and mode == "final"

    if has_per_clip_zoom or global_zoom:
        log.info("[render] Step 3: zoom (per_clip=%s, global=%s)", has_per_clip_zoom, global_zoom)
        zoomed = []
        for i, (p, clip_meta) in enumerate(zip(current_paths, pipeline_clips)):
            clip_zoom = clip_meta.get("zoom_mode")
            if clip_zoom:
                # Per-clip zoom with focal point
                zoomed.append(apply_zoom(
                    p, tmp / f"zoom_{i}.mp4",
                    focal_x=clip_meta.get("focal_x"),
                    focal_y=clip_meta.get("focal_y"),
                    zoom_mode=clip_zoom,
                ))
            elif global_zoom:
                # Global zoom (legacy: centre, tight)
                zoomed.append(apply_zoom(p, tmp / f"zoom_{i}.mp4"))
            else:
                zoomed.append(p)
        current_paths = zoomed
    else:
        log.info("[render] Step 3: zoom skipped (mode=%s)", mode)
    zoom_s = time.time() - t_zoom
    print(f"TIMING:zoom={zoom_s:.1f}s", flush=True)

    # Per-clip audio volume multipliers (Batch J) — aligned 1:1 with current_paths.
    # pipeline_clips is still 1:1 with current_paths here (trim/zoom preserve length+order).
    # Cards prepended/appended below get volume 1.0 (they carry no audio anyway).
    clip_volumes = [float(cm.get("clip_volume", 1.0) or 1.0) for cm in pipeline_clips]

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
        clip_volumes = [1.0] + clip_volumes

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
        clip_volumes = clip_volumes + [1.0]

    # 5. Build filter_complex + render.
    report_stage("Rendering")
    # CRITICAL: durations must come from current_paths (post-trim), not original clips.
    report(60)
    log.info("[render] Step 5: render with xfade")
    output = tmp / "render.mp4"
    durations = [get_duration(p) for p in current_paths]
    audio_flags = [has_audio(p) for p in current_paths]
    t0 = time.time()

    # Inject silence for any clips lacking audio (cards have no audio).
    current_paths, audio_flags = inject_silence_where_needed(
        current_paths, durations, audio_flags, tmp
    )

    crf, preset = (35, "ultrafast") if mode == "draft" else (22, "medium")
    scale_h = "360" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    log.info("[B1] render scale_h=%s (output_resolution=%s)", scale_h, output_resolution)

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
            # Per-clip volume multiplier (Batch J). volume=0 is valid — produces silence.
            vol0 = clip_volumes[0] if clip_volumes else 1.0
            if abs(vol0 - 1.0) > 1e-6:
                cmd += ["-af", f"volume={vol0:.4f}"]
                log.info("[J] single-clip volume=%.4f", vol0)
            cmd += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
        cmd.append(str(output))
        ffmpeg_run(cmd)
    else:
        log.info("[J] clip_volumes=%s", clip_volumes)
        fc, v_out, a_out = build_filter_complex(
            current_paths, durations, audio_flags,
            transition=config.get("transition", "crossfade"),
            mode=mode,
            output_resolution=output_resolution,
            clip_volumes=clip_volumes,
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

    render_s = time.time() - t0
    print(f"TIMING:render={render_s:.1f}s", flush=True)

    # 6. Mix music.
    report_stage("Mixing music")
    report(80)
    t0 = time.time()
    if music_filename or custom_music_path_wsl:
        log.info("[render] Step 6: mix music (mood=%s)", music_mood)
        music_out = tmp / "with_music.mp4"
        music_volume = float(config.get("music_volume", 0.4))
        movie_vol = _MOVIE_VOL.get(round(music_volume, 1), 0.7)
        log.info("[vol] music_vol=%.2f movie_vol=%.2f", music_volume, movie_vol)
        fade_out_s = float(config.get("music_fade_out_s", 3.0))
        log.info("[vol] music_fade_out_s=%.1f", fade_out_s)
        output = mix_music(output, sum(durations), music_filename, MUSIC_DIR, music_out,
                           music_volume=music_volume, movie_vol=movie_vol,
                           custom_track_path=custom_music_path_wsl,
                           fade_out_s=fade_out_s)
    else:
        log.info("[render] Step 6: music skipped")
    music_s = time.time() - t0
    print(f"TIMING:music={music_s:.1f}s", flush=True)

    # 7. Loudnorm (final only -- two-pass is too slow for draft).
    report_stage("Loudnorm")
    report(88)
    t0 = time.time()
    if mode != "draft":
        log.info("[render] Step 7: loudnorm")
        final_out = tmp / "final.mp4"
        output = loudnorm(output, final_out, context=context)
    else:
        log.info("[render] Step 7: loudnorm skipped (draft mode)")
    loudnorm_s = time.time() - t0
    print(f"TIMING:loudnorm={loudnorm_s:.1f}s", flush=True)

    report(95)
    log.info("[render] Pipeline complete: %s", output)

    # Emit rich ANALYSIS line — stored in jobs.analysis_summary for benchmarking.
    try:
        total_s = time.time() - t_wall_start
        output_duration_s = get_duration(output)

        # Source file sizes — direct stat on WSL paths (cross-filesystem, but only N files)
        total_raw_bytes = sum(p.stat().st_size for p in clip_paths if p.exists())
        total_raw_mb = total_raw_bytes / (1024 * 1024)

        # Resolutions from clip metadata dicts
        widths  = [c.get("width", 0)  for c in clips]
        heights = [c.get("height", 0) for c in clips]
        max_w   = max(widths,  default=0)
        max_h   = max(heights, default=0)
        has_4k  = 1 if (max_w >= 3840 or max_h >= 2160) else 0

        # Audio
        audio_clip_count = sum(1 for c in clips if c.get("has_audio"))

        # Raw footage duration (user-trimmed clips use duration_ms of original source)
        raw_duration_s = sum(c.get("duration_ms", 0) for c in clips) / 1000.0

        # Settings used
        music_on      = 0 if config.get("music_mood", "none") == "none" else 1
        cards_on      = 1 if (config.get("intro_text") or config.get("outro_text")) else 0
        zoom_on       = 1 if config.get("zoom") else 0
        transition    = config.get("transition", "none")

        volume_custom = int(any(
            abs(float(cm.get("clip_volume", 1.0) or 1.0) - 1.0) > 1e-6
            for cm in pipeline_clips
        ))
        report_analysis(
            f"clips_used={clips_used}"
            f",clips_total={clips_total}"
            f",clips_excluded={clips_excluded}"
            f",raw_duration_s={raw_duration_s:.1f}"
            f",output_duration_s={output_duration_s:.1f}"
            f",total_raw_mb={total_raw_mb:.1f}"
            f",max_resolution={max_w}x{max_h}"
            f",has_4k={has_4k}"
            f",audio_clip_count={audio_clip_count}"
            f",normalise_s={normalise_s:.0f}"
            f",trim_s={trim_s:.0f}"
            f",zoom_s={zoom_s:.0f}"
            f",render_s={render_s:.0f}"
            f",music_s={music_s:.0f}"
            f",loudnorm_s={loudnorm_s:.0f}"
            f",total_s={total_s:.0f}"
            f",music={music_on}"
            f",cards={cards_on}"
            f",zoom={zoom_on}"
            f",transition={transition}"
            f",proxy_used={len(proxy_clip_indices)}"
            f",proxy_skipped={len(norm_clip_indices)}"
            f",output_resolution={output_resolution}"
            f",volume_custom={volume_custom}"
        )
    except Exception as e:
        log.warning("[render] ANALYSIS emit failed: %s", e)
        report_analysis(f"clips_used={clips_used},clips_total={clips_total},clips_excluded={clips_excluded}")

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
