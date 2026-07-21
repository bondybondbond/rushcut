"""
pipeline/render.py -- Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1.  normalise      -> H.264/yuv420p/25fps/1080p/AAC
  2.  silence trim   -> (if config.silence_removal) trim silence from clip edges
  3.  zoom           -> (if config.zoom, final mode only)
  4.  cards          -> prepend intro, append outro (if text provided)
  5.  render         -> filter_complex xfade + scale (uniform for any clip count, #136)
                        == the clean, treatment-free intermediate (V4.1 cache point)
  6.  audio treatment-> music mix and/or loudnorm applied on top of the clean
                        intermediate (_apply_audio_treatment)

  V4.1 render cache (#19): Step 5 produces a clean merged intermediate (video +
  transitions + zoom + cards + clean clip audio, NO music, NO loudnorm) that is
  cached keyed by a signature over the video-affecting inputs only. A re-render
  changing only music/audio hits the cache and skips Steps 1-5. Single-pass EBU
  R128 loudnorm (-14 LUFS, final mode only) is applied exactly once in step 6 --
  fused into the music mix when music is on, or a dedicated -c:v copy audio pass
  when music is off.

Entry points:
  run_pipeline(job, clips, clip_paths, ...) -> Path
  run_local(clips_dir, output_dir)          -> None  (no R2/Supabase)
"""

import logging
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import subprocess

from .cards import make_card
from .detect import detect_trim_points
from .encoder import (
    to_win_path, video_encoder_args,
    FINAL_BITRATE, AMF_MAXRATE,
    HEVC_FINAL_BITRATE_4K, HEVC_AMF_MAXRATE_4K,
)
from .loudnorm import loudnorm_filter
from .music import mix_music
from .normalise import normalise
from .proxy import is_valid_proxy
from . import render_cache
from .transitions import (
    build_filter_complex,
    build_batch_video_fc,
    build_audio_only_fc,
    build_open_close_post_fc,
    build_open_close_audio_fc,
    plan_video_batches,
    resolve_cut_names,
    clamp_xfade_dur,
)
from .trim import trim  # partial-GOP trim_smart() (#104) explored and removed --
                          # 19-31% real-render regression under contention, see #104
from .utils import FFMPEG, ffmpeg_run, ffmpeg_run_progress, ffprobe_json, get_duration, get_frame_size, has_audio, log_av_sync
from .zoom import build_zoom_vf

log = logging.getLogger(__name__)

# Step 2 trim parallelism (#99) — same cap/formula as normalise.py's MAX_PARALLEL_NORMALISE.
MAX_PARALLEL_TRIM = min(4, os.cpu_count() or 1)


@dataclass
class ClipItem:
    """One item in the post-zoom, pre-render clip sequence (#103).

    Replaces the old current_paths/clip_volumes/zoom_vfs parallel-array pattern:
    Step 4 card insertion prepends/appends ONE ClipItem per card instead of
    mutating 3 separate lists in lockstep -- structurally impossible to drift,
    since there's only one list to splice. See the module docstring's Step 4.
    A future card-insertion site (mid-roll, #148) splices into this one list
    too -- never add a new parallel array; extend ClipItem instead.

    `kind` distinguishes a real clip from a card in the SAME ordered list
    (default "clip"; card insertion passes kind="card") -- matching the
    cross-editor pattern confirmed via real Perplexity competitor research on
    #103 (OpenTimelineIO's Composable/Clip/Gap, MLT's playlist <blank>,
    Resolve/Premiere effect-on-clip model): an inserted non-clip item is the
    same item type in the same list, tagged by kind, never a special-cased
    parallel structure. Not yet consumed by any code path -- #148 (positioned
    card data model) is what will branch on it; carrying it now costs nothing
    and avoids re-discovering this exact distinction there.
    """
    path: Path
    volume: float
    zoom_vf: "str | None"
    kind: str = "clip"


def unzip_clip_items(items: "list[ClipItem]") -> "tuple[list, list[float], list | None]":
    """Flatten a ClipItem list back to (paths, volumes, zoom_vfs) for the
    downstream transitions.py call signatures, which take flat lists by
    position and are deliberately left untouched by #103.

    zoom_vfs collapses to None (not a list of Nones) when no item carries a
    zoom vf, preserving the pre-#103 sentinel contract some call sites rely on
    (e.g. `if zoom_vfs else None` at the U1g batch site in run_pipeline).
    """
    paths = [it.path for it in items]
    volumes = [it.volume for it in items]
    zoom_vfs = [it.zoom_vf for it in items] if any(it.zoom_vf for it in items) else None
    return paths, volumes, zoom_vfs

# Progress bar stage weights (#12) — empirical buckets from render-timing-log.jsonl,
# NOT live-derived from a single render (would overfit to one project's clip count/
# resolution). "trim" is 20 (not negligible) because of the #96 re-encode fix; if a
# future optimisation makes trim cheap again, retune here — it's a one-line change.
# "render" and "audio" are never zero-weighted: they always run (even as a fast
# passthrough), so they always absorb the weight any skipped stage would have used.
STAGE_WEIGHTS = {
    "normalise": 10,
    "trim":      20,
    "zoom":       3,
    "cards":      2,
    "render":    60,
    "audio":      5,
}


def _compute_checkpoints(
    normalise_active: bool, trim_active: bool, zoom_active: bool, cards_active: bool
) -> dict:
    """Cumulative progress % at the END of each stage.

    Weights of inactive (skipped) stages are excluded, and the remaining active
    stages' weights are re-normalised to fill 0->98 (100 is set by the frontend on
    pipeline-done). See issue #12.
    """
    active = {
        "normalise": STAGE_WEIGHTS["normalise"] if normalise_active else 0,
        "trim":      STAGE_WEIGHTS["trim"] if trim_active else 0,
        "zoom":      STAGE_WEIGHTS["zoom"] if zoom_active else 0,
        "cards":     STAGE_WEIGHTS["cards"] if cards_active else 0,
        "render":    STAGE_WEIGHTS["render"],
        "audio":     STAGE_WEIGHTS["audio"],
    }
    total = sum(active.values()) or 1
    cum, out = 0.0, {}
    for stage in ("normalise", "trim", "zoom", "cards", "render", "audio"):
        cum += active[stage] / total * 98
        out[stage] = int(round(cum))
    out["audio"] = 98  # pin — float accumulation across 6 stages can drift to 97/99
    return out


def _fps_to_tbn(fps_raw: str) -> str:
    """Derive the libx264 container time_base string from the fps rational.

    libx264 sets tbn = fps_numerator (e.g. 30000/1001 -> 1/30000, 25 -> 1/25).
    Inline color sources for xfade must use settb matching this value or FFmpeg
    6.1.1 rejects the filter with 'timebase mismatch' (exit 234).
    """
    return f"1/{fps_raw.split('/')[0]}"


def round_to_standard_fps(r_frame_rate: str) -> int:
    """Round ffprobe r_frame_rate string to nearest standard fps.

    Returns an int for proxy comparison and log messages ONLY.
    Never pass this to FFmpeg -r; use the raw rational string instead.
    """
    try:
        num, den = map(int, r_frame_rate.split("/"))
        fps = num / den
        for standard in [24, 25, 30, 50, 60]:
            if abs(fps - standard) < 0.5:
                return standard
    except Exception:
        pass
    return 25  # fallback


def _probe_fps(path: Path) -> str:
    """Return raw r_frame_rate string from first video stream (e.g. '30000/1001').

    This is what gets passed directly to FFmpeg -r so the rational is preserved.
    Returns '25' on any failure so the pipeline degrades to existing behaviour.
    """
    try:
        r = subprocess.run(
            [
                "/usr/bin/ffprobe", "-v", "quiet",
                "-select_streams", "v:0",
                "-show_entries", "stream=r_frame_rate",
                "-of", "csv=p=0",
                str(path),
            ],
            capture_output=True,
            timeout=10,
        )
        val = r.stdout.decode().strip()
        if val and "/" in val:
            return val
    except Exception:
        pass
    return "25"


def _proxy_meta(proxy_wsl: str) -> tuple[int, int]:
    """Return (height, fps_int) of proxy file, or (0, 0) on error.

    height: used to gate proxy reuse (must meet required_proxy_h).
    fps_int: rounded standard fps, compared against target_fps_int to detect
             legacy 25fps proxies that need regeneration.
    """
    try:
        r = subprocess.run(
            [
                "/usr/bin/ffprobe", "-v", "quiet",
                "-select_streams", "v:0",
                "-show_entries", "stream=height,r_frame_rate",
                "-of", "csv=p=0",
                proxy_wsl,
            ],
            capture_output=True,
            timeout=10,
        )
        lines = r.stdout.decode().strip().splitlines()
        # ffprobe csv output: one line per selected entry field, two fields selected
        # Typical output for one stream: "2160,30000/1001"
        if lines:
            parts = lines[0].split(",")
            height = int(parts[0]) if parts else 0
            fps_raw = parts[1].strip() if len(parts) > 1 else "25"
            fps_int = round_to_standard_fps(fps_raw)
            return height, fps_int
    except Exception:
        pass
    return 0, 0

MUSIC_DIR = Path(__file__).parent.parent / "music"
TMP_BASE = Path("/tmp")

# Movie audio ducking per music_volume preset (0.2=subtle, 0.4=balanced, 0.7=prominent).
# As music gets louder, movie audio is ducked proportionally so music actually dominates.
_MOVIE_VOL = {0.2: 1.0, 0.4: 0.4, 0.7: 0.3}

# Zoom step parallelism. Each clip's zoom is an independent FFmpeg pass; running
# up to 4 concurrently turns the serial zoom loop into ~cores/4 wall time.
def _resolve_render_work_dir(job_id: "str | object", base: "str | None" = None) -> Path:
    # NTFS-backed scratch dir for Windows ffmpeg.exe (AMF) output targets AND U1g
    # segment artifacts (which must survive WSL memory-pressure eviction between the
    # last batch encode and the concat-manifest write). Windows ffmpeg.exe can write
    # a /mnt/c -> C:\ path but NOT a /tmp -> \\wsl.localhost UNC path (Permission
    # denied on the 9p server); see #86.
    #
    # Resolution order:
    #   1. explicit `base` (run.py passes manifest_path.parent, always a /mnt/c path
    #      that already exists) -- authoritative, no env dependency. Preferred.
    #   2. USERPROFILE-derived /mnt/c path -- legacy; NOT inherited into the WSL env
    #      from the bare `wsl -- python3` spawn, so this silently missed and fell to (3)
    #      (the #86 root cause).
    #   3. /tmp fallback -- test envs only. Windows ffmpeg.exe CANNOT write here.
    if base:
        return Path(base) / str(job_id)
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        user = Path(userprofile).name
        return Path(f"/mnt/c/Users/{user}/AppData/Local/Temp/rushcut/{job_id}")
    return Path(f"/tmp/rushcut-render/{job_id}")


def _mem_available_mb() -> "int | None":
    # Read MemAvailable from /proc/meminfo for U1g fallback diagnostics. MUST NEVER
    # raise: this only feeds a log line, and a failure here must never fail a render.
    # /proc/meminfo may be missing/unreadable/malformed in some environments -- a
    # None return is a valid, expected outcome that callers format as "%s".
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    # "MemAvailable:   12345678 kB"
                    return int(line.split()[1]) // 1024
    except Exception:
        return None
    return None


def _probe_frame_count(path: Path) -> int:
    """Video frame count of an encoded file (issue #31 post-pass drift assert).

    Prefers the stream nb_frames metadata (written by libx264 / h264_amf); falls
    back to a full -count_frames decode only when metadata is absent. Both inner
    and output are freshly encoded by us, so metadata is normally present.
    """
    try:
        data = ffprobe_json(["-select_streams", "v:0",
                             "-show_entries", "stream=nb_frames", str(path)])
        streams = data.get("streams", [])
        if streams and streams[0].get("nb_frames") not in (None, "N/A"):
            return int(streams[0]["nb_frames"])
    except Exception:
        pass
    data = ffprobe_json(["-select_streams", "v:0", "-count_frames",
                         "-show_entries", "stream=nb_read_frames", str(path)])
    streams = data.get("streams", [])
    if streams and streams[0].get("nb_read_frames") not in (None, "N/A"):
        return int(streams[0]["nb_read_frames"])
    raise RuntimeError(f"cannot probe frame count for {path}")


class _BoundaryDriftError(RuntimeError):
    """#114 Fix 2: distinguishes the U1g open/close frame-drift correctness check
    from real ffmpeg crashes / planner rejections, so the segmented-render except
    block can skip the (OOM-prone at this scale) monolithic fallback for this
    class specifically. Module-level by design -- must not be nested inside
    _render_segmented() or any inner function, or isinstance() checks against it
    could fail to match a re-evaluated nested class across calls.
    """


def _classify_segmented_failure(exc: Exception) -> "tuple[str, int | None]":
    # Collapsed taxonomy (logs-first): the only decision that matters next is
    # whether monolithic is the legit fallback. ValueError from plan_video_batches
    # means the project cannot be segmented (no solo region) -> "planner". Anything
    # else is "other"; we still parse the FFmpeg exit code as a concrete signal
    # (e.g. 15 = SIGTERM/OOM) when the message carries it.
    if isinstance(exc, ValueError):
        return ("planner", None)
    m = re.search(r"FFmpeg failed \(exit (-?\d+)\)", str(exc))
    return ("other", int(m.group(1)) if m else None)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def pretrim_one_clip(i: int, src_p: Path, cm: dict, tmp: Path) -> tuple[Path, dict]:
    """B-0 pre-trim one source clip to [in_s-2s, out_s+0.5s] via fast copy-seek.

    Returns (pre_trimmed_path, pipeline_clip_meta) where the meta carries B-0-adjusted
    in_ms/out_ms (offsets relative to the pre-trim window start). Clips with no user
    trim are returned untouched. See pipeline.md "B-0 trim offset mutation".
    """
    u_in = cm.get("in_ms")
    u_out = cm.get("out_ms")
    if u_in is not None or u_out is not None:
        in_s = (u_in / 1000.0) if u_in is not None else 0.0
        out_s = (u_out / 1000.0) if u_out is not None else None
        a_start = max(0.0, in_s - 2.0)   # 2s pre-roll for keyframe alignment
        out_path = tmp / f"pretrim_{i}.mp4"
        cmd = [FFMPEG, "-y", "-ss", f"{a_start:.4f}"]
        if out_s is not None:
            cmd += ["-to", f"{out_s + 0.5:.4f}"]
        cmd += ["-i", str(src_p), "-c", "copy", str(out_path)]
        end_label = f"{out_s + 0.5:.2f}s" if out_s is not None else "EOF"
        log.info("[B0] clip %d: pre-trim %.2fs -> %s (src=%s)", i, a_start, end_label, src_p.name)
        ffmpeg_run(cmd)
        adj_in = int((in_s - a_start) * 1000) if u_in is not None else None
        adj_out = int((out_s - a_start) * 1000) if out_s is not None else None
        return out_path, {**cm, "in_ms": adj_in, "out_ms": adj_out}
    return src_p, cm


def decide_clip_source(
    clip_meta: dict, output_resolution: str, target_fps_int: int,
    force_normalise: bool = False,
) -> tuple[bool, str | None, str]:
    """Decide whether a clip's proxy can substitute for normalise.

    Returns (use_proxy, proxy_path_wsl, reason). A proxy qualifies only when it is
    valid, tall enough for the output resolution (>=1080p for 1080p, >=2160p for 4K),
    AND its fps matches the render target. See pipeline.md "Proxy reuse gate".

    force_normalise (#120): debug-only override, set via manifest settings.
    When True, always normalise regardless of proxy state -- diagnostic lever
    for A/B testing proxy-vs-normalise quality (see #118).

    #124 (shipped 2026-07-14, REVERTED same day): briefly added a zoom_mode
    early-return here to bypass proxy reuse for zoomed clips, per #118's TV-check
    finding. A second TV check on the real shipped code path (not just the debug
    force_normalise flag) found no visible quality improvement, while the real
    measured cost was +93s/2 zoomed clips (~46.5s/clip) at 4K -- unacceptable
    against the already-1.7-2.35x-over-target speed ceiling for zero confirmed
    benefit. Reverted. Do not re-add a zoom-scoped bypass here without a TV check
    on the actual shipped code path (not the debug flag) CONFIRMING benefit first,
    on both a small sample AND the realistic full-project scale -- see #116/#124.
    """
    pwsl = clip_meta.get("proxy_path_wsl")
    if force_normalise:
        return False, pwsl, "force_normalise flag set"
    required_proxy_h = 2160 if output_resolution == "4k" else 1080
    valid = bool(pwsl and is_valid_proxy(pwsl))
    height, proxy_fps_int = _proxy_meta(pwsl) if valid else (0, 0)
    fps_ok = (proxy_fps_int == target_fps_int)
    if valid and height >= required_proxy_h and fps_ok:
        return True, pwsl, f"using {height}p {proxy_fps_int}fps proxy, skipping normalise"
    if not pwsl:
        reason = "no proxy"
    elif not valid:
        reason = "invalid"
    elif height < required_proxy_h:
        reason = f"proxy-{height}p < required-{required_proxy_h}p"
    else:
        reason = f"proxy FPS mismatch: proxy-{proxy_fps_int}fps != target-{target_fps_int}fps"
    return False, pwsl, reason


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
        context:     Legacy Lambda context. Unused in local mode (always None).
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
    # #86: NTFS scratch dir for AMF (Windows ffmpeg.exe) output targets. `tmp` (tmpfs)
    # stays fast for normalise/pre-trim/inject-silence intermediates (read by AMF over
    # UNC, which works); only the final render.mp4 + U1g segment files must land here.
    render_work = _resolve_render_work_dir(job_id, config.get("ntfs_tmp_base"))
    render_work.mkdir(parents=True, exist_ok=True)
    log.info("[render] tmp(tmpfs)=%s  render_work(NTFS/AMF-out)=%s", tmp, render_work)
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
    # V4.1: loudnorm no longer fuses into Step 5. Step 5 produces the clean,
    # cacheable intermediate; loudnorm is applied exactly once in the final
    # audio-treatment step below (music on -> inside mix_music; music off ->
    # a dedicated -c:v copy pass). music_on still selects which branch runs.
    music_on = bool(music_filename or custom_music_path_wsl)

    # #12: cheap, config/clip-metadata-only active-stage flags -- hoisted early so
    # both the cache-hit and cache-miss paths can compute dynamic progress-bar
    # checkpoints before Steps 2-4 run. None of these touch the filesystem, so
    # hoisting them adds zero I/O to the fast cache-hit path. Reused verbatim at
    # each stage's original call site below (no duplicate recomputation).
    has_user_trims = any(c.get("in_ms") is not None or c.get("out_ms") is not None for c in clips)
    trim_active = has_user_trims or config.get("silence_removal", False)

    has_per_clip_zoom = any(
        c.get("zoom_mode") and c.get("zoom_mode") != "none"
        for c in clips
    )
    global_zoom = config.get("zoom", False) and mode == "final"
    zoom_active = (has_per_clip_zoom or global_zoom) and mode == "final"

    # Phase 2 format: intro_text / intro_color / outro_text / outro_color.
    # Legacy Phase 1 format intro_card/end_card also handled as fallback.
    intro_text = config.get("intro_text") or (config.get("intro_card") or {}).get("text", "")
    intro_color = (
        config.get("intro_color")
        or (config.get("intro_card") or {}).get("color", "#000000")
    )
    outro_text = config.get("outro_text") or (config.get("end_card") or {}).get("text", "")
    outro_color = (
        config.get("outro_color")
        or (config.get("end_card") or {}).get("color", "#000000")
    )
    cards_active = bool(intro_text) or bool(outro_text)

    def _apply_audio_treatment(clean: Path, checkpoints: dict) -> Path:
        """V4.1: apply music + loudnorm on top of the clean intermediate.

        The cheap, music-agnostic layer that runs on BOTH a fresh render and a
        render-cache hit. Loudnorm is applied exactly once (never doubled):
          - music on  -> loudnorm fuses into the mix_music encode
          - music off -> a dedicated -c:v copy audio-only loudnorm pass (fast)
          - draft / no audio -> passthrough (no loudnorm)
        Emits the TIMING:music line so both paths report consistently.
        """
        report_stage("Mixing music")
        report(checkpoints["render"])
        t_audio = time.time()
        if music_filename or custom_music_path_wsl:
            log.info("[render] Step 6: mix music (mood=%s)", music_mood)
            music_out = tmp / "with_music.mp4"
            music_volume = float(config.get("music_volume", 0.4))
            movie_vol = _MOVIE_VOL.get(round(music_volume, 1), 0.7)
            log.info("[vol] music_vol=%.2f movie_vol=%.2f", music_volume, movie_vol)
            fade_out_s = float(config.get("music_fade_out_s", 3.0))
            music_loop = bool(config.get("music_loop", True))
            log.info("[vol] music_fade_out_s=%.1f loop=%s", fade_out_s, music_loop)
            # #62: time music to the REAL rendered duration (probe = ground truth;
            # covers transitions, open/close-to-black, and cards uniformly).
            rendered_dur = get_duration(clean)
            log.info("[music] timing music to rendered=%.4fs", rendered_dur)
            out = mix_music(clean, rendered_dur, music_filename, MUSIC_DIR, music_out,
                            music_volume=music_volume, movie_vol=movie_vol,
                            custom_track_path=custom_music_path_wsl,
                            fade_out_s=fade_out_s,
                            loop=music_loop,
                            apply_loudnorm=(mode != "draft"))
        elif mode != "draft" and has_audio(str(clean)):
            # Music off: loudnorm was deferred out of Step 5 -> apply it now as an
            # audio-only pass. -c:v copy keeps the (cached) video bit-identical, so
            # this is a fast remux rather than a full re-encode.
            log.info("[render] Step 6: loudnorm-only pass (music off)")
            ln_out = tmp / "loudnorm.mp4"
            ffmpeg_run([
                FFMPEG, "-y", "-i", str(clean),
                "-map", "0:v:0", "-map", "0:a:0?",
                "-c:v", "copy",
                "-af", loudnorm_filter(),
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
                str(ln_out),
            ])
            out = ln_out
        else:
            log.info("[render] Step 6: audio treatment skipped (draft or no audio)")
            out = clean
        print(f"TIMING:music={time.time() - t_audio:.1f}s", flush=True)
        report(checkpoints["audio"])
        return out

    # ANALYSIS counters -- all clips used, no motion filtering.
    clips_total = len(clip_paths)
    clips_used = clips_total
    clips_excluded = 0

    # 1. Normalise -- report per-clip so progress doesn't appear stuck.
    report_stage("Preparing clips")
    log.info("[render] Step 1: normalise")
    t0 = time.time()

    # Detect target fps from the first source clip.
    # target_fps_raw: passed to FFmpeg -r (preserves rational e.g. "30000/1001")
    # target_fps_int: used ONLY for proxy comparison and log messages, never passed to FFmpeg
    target_fps_raw = _probe_fps(clip_paths[0]) if clip_paths else "25"
    target_fps_int = round_to_standard_fps(target_fps_raw)
    log.info("[Q2] target_fps=%d (source %s from clip 0)", target_fps_int, target_fps_raw)

    # V4.1 render cache (#19): the clean merged intermediate depends only on
    # video-affecting inputs (clip trim/order/zoom/volume, transitions, cards,
    # resolution, fps) -- never on music. Compute the signature from the ORIGINAL
    # manifest `clips` (absolute in_ms/out_ms); pipeline_clips is mutated by the
    # B-0 pre-trim below and would drift the signature between identical renders.
    # #83: shuffle's xfade RNG is seeded from this same cache_sig (not job.id),
    # so shuffle_between renders are now reproducible across identical
    # clip-set+settings and can safely hit the cache like any other render.
    cache_sig = render_cache.signature(clips, config, output_resolution, mode, target_fps_raw)
    log.info("[cache] sig=%s (shuffle_between=%s)", cache_sig, config.get("shuffle_between", False))
    use_cache = mode == "final"
    if use_cache and render_cache.is_valid(render_cache.cache_path(cache_sig)):
        cache_file = render_cache.cache_path(cache_sig)
        log.info("[cache] HIT %s -> %s", cache_sig, cache_file.name)
        print("TIMING:cache=hit", flush=True)
        # #12: normalise_active defaults True here -- precision doesn't matter for a
        # cache hit (the whole point is one instant jump straight to checkpoints["render"],
        # skipping the real per-clip proxy check that would cost real I/O on this fast path).
        checkpoints = _compute_checkpoints(True, trim_active, zoom_active, cards_active)
        report_stage("Preparing clips")
        report(checkpoints["render"])
        # Copy the cached clean intermediate into the job tmp dir, then apply the
        # cheap music/loudnorm layer on top -- Steps 1-5 are skipped entirely.
        # #86: output lives on NTFS render_work (AMF write target consistency).
        output = render_work / "render.mp4"
        shutil.copy2(str(cache_file), str(output))  # /mnt/c -> tmpfs copy is safe
        output = _apply_audio_treatment(output, checkpoints)
        log.info("[render] Pipeline complete (cache hit): %s", output)
        try:
            total_s = time.time() - t_wall_start
            output_duration_s = get_duration(output)
            music_on_a = 0 if config.get("music_mood", "none") == "none" else 1
            report_analysis(
                f"clips_used={clips_used}"
                f",clips_total={clips_total}"
                f",clips_excluded={clips_excluded}"
                f",output_duration_s={output_duration_s:.1f}"
                f",normalise_s=0"
                f",render_s=0"
                f",total_s={total_s:.0f}"
                f",music={music_on_a}"
                f",transition={config.get('transition', 'none')}"
                f",output_resolution={output_resolution}"
                f",render_cache=hit"
            )
        except Exception as e:
            log.warning("[render] ANALYSIS emit failed (cache hit): %s", e)
            report_analysis(
                f"clips_used={clips_used},clips_total={clips_total},render_cache=hit"
            )
        return output
    cache_status = "miss" if use_cache else "off"
    if use_cache:
        log.info("[cache] MISS %s", cache_sig)
    print(f"TIMING:cache={cache_status}", flush=True)

    # Partition clips: use proxy as normalise substitute where available. Computed
    # from the ORIGINAL `clips` (not B-0-mutated) BEFORE B-0 runs (#135) --
    # decide_clip_source() only reads proxy_path_wsl, which B-0's pretrim never
    # touches (it only rewrites in_ms/out_ms), so this partition is unaffected by
    # B-0 either way. Doing it first lets B-0 skip proxy-eligible clips entirely
    # instead of pre-trimming them and immediately discarding the result (the
    # #135 root cause: in the reported proxy_skip=4/4 case, 100% of the 9.1s B-0
    # stall was pretrim work thrown away because the proxy was used instead).
    # Required proxy height depends on output resolution (>=1080p for 1080p,
    # >=2160p for 4K). Background gen (Batch N) encodes at 2160p so proxies qualify
    # for both. The decision lives in decide_clip_source() -- render.py is
    # currently its only caller (warm_zoom.py, referenced here previously, no
    # longer exists per the embed-zoom-in-filter_complex refactor, #67/#79).
    n_clips = len(clip_paths)
    proxy_clip_indices: set[int] = set()
    norm_clip_indices:  list[int] = []

    for i, cm in enumerate(clips):
        use_proxy, _pwsl, reason = decide_clip_source(
            cm, output_resolution, target_fps_int,
            force_normalise=config.get("force_normalise", False),
        )
        if use_proxy:
            proxy_clip_indices.add(i)
            log.info("[C-proxy] clip %d: %s", i, reason)
        else:
            norm_clip_indices.append(i)
            log.info("[C-proxy] clip %d: %s, normalising from source", i, reason)

    log.info("[C-proxy] %d proxy-skip / %d normalise", len(proxy_clip_indices), len(norm_clip_indices))

    # #12: the real proxy-vs-normalise partition is now known -- compute the actual
    # dynamic checkpoints for the rest of this (cache-miss) pipeline run.
    normalise_active = bool(norm_clip_indices)
    checkpoints = _compute_checkpoints(normalise_active, trim_active, zoom_active, cards_active)

    # Initialise merged output array
    current_paths: list = [None] * n_clips

    # Pre-trim: extract only the needed segment from each NORMALISE-BOUND source
    # clip before normalise. DJI clips can be 60-120s; user typically uses 5-30s.
    # Normalising the full clip wastes 4-10x time. Fast copy-seek to
    # [in_s - 2s, out_s + 0.5s], then normalise only the short segment. Step 2
    # fine-trims the normalised file with adjusted offsets. Proxy-eligible clips
    # (#135) skip this entirely -- their B-0 output would be discarded anyway
    # since the proxy already covers the full clip at the required resolution.
    pre_trimmed_paths: list = [None] * n_clips
    pipeline_clips:    list = list(clips)  # proxy indices stay byte-identical to `clips`
    t_pretrim = time.time()

    # #135: B-0 and the real normalise() call below share ONE combined per-clip
    # tick budget spanning [0, checkpoints["normalise"]] -- 2 units per norm-bound
    # clip (1 for its B-0 pretrim, 1 for its normalise encode) -- instead of
    # reserving a fixed percentage sub-slice for B-0. A fixed % slice would be too
    # narrow to survive int() rounding (B-0 is fast; normalise dominates the real
    # wall time), silently reproducing the exact "flat window" bug this fix is
    # for. as_completed (not submission-order) so a tick fires as soon as ANY
    # clip's pretrim finishes, same pattern as Step 2 trim (#129).
    total_units = 2 * len(norm_clip_indices)
    units_done = 0

    if norm_clip_indices:
        def _pretrim_worker(i: int, src_p: Path, cm: dict) -> tuple:
            return pretrim_one_clip(i, src_p, cm, tmp)

        with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
            futures = {pool.submit(_pretrim_worker, i, clip_paths[i], clips[i]): i
                       for i in norm_clip_indices}
            for f in as_completed(futures):
                i = futures[f]
                pre_trimmed_paths[i], pipeline_clips[i] = f.result()
                units_done += 1
                report_stage(f"Preparing clip {units_done} of {len(norm_clip_indices)}")
                report(int(units_done / total_units * checkpoints["normalise"]))

    print(f"TIMING:pretrim={time.time() - t_pretrim:.1f}s (jobs={len(norm_clip_indices)})", flush=True)

    # Proxy clips: proxy IS the normalised intermediate — point directly at it.
    # pipeline_clips[i] for these indices is still the original `clips[i]` (never
    # touched by B-0 above), so no offset restore is needed -- unlike the old
    # code path, there is nothing here to undo.
    for i in proxy_clip_indices:
        current_paths[i] = Path(clips[i]["proxy_path_wsl"])

    # Non-proxy clips: normalise from pre-trimmed source (existing B-0 path)
    if norm_clip_indices:
        norm_src = [pre_trimmed_paths[i] for i in norm_clip_indices]

        def _normalise_progress(done: int, total: int) -> None:
            report_stage(f"Preparing clip {done} of {total}")
            report(int((units_done + done) / total_units * checkpoints["normalise"]))

        normed = normalise(
            norm_src, tmp, mode=mode,
            on_clip_done=_normalise_progress,
            output_resolution=output_resolution,
            target_fps=target_fps_raw,
        )
        for j, i in enumerate(norm_clip_indices):
            current_paths[i] = normed[j]
    else:
        report(checkpoints["normalise"])  # all proxy -- weight already collapsed to ~0

    normalise_s = time.time() - t0
    print(
        f"TIMING:normalise={normalise_s:.1f}s"
        f" (proxy_skip={len(proxy_clip_indices)}/{n_clips})",
        flush=True,
    )

    # 2. Silence trim.
    report_stage("Trimming clips")
    t0 = time.time()

    if trim_active:
        log.info("[render] Step 2: trim (user overrides: %s, silence_removal: %s)",
                 has_user_trims, config.get("silence_removal", False))
        trimmed = list(current_paths)  # default: passthrough (overwritten below for trim jobs)
        jobs = []  # (index, path, start_s, end_s)
        for i, (p, clip_meta) in enumerate(zip(current_paths, pipeline_clips)):
            user_in = clip_meta.get("in_ms")
            user_out = clip_meta.get("out_ms")
            if user_in is not None or user_out is not None:
                # User-set trim points override silence detection (ms -> seconds)
                dur = get_duration(p)
                start = (user_in / 1000.0) if user_in is not None else 0.0
                end = (user_out / 1000.0) if user_out is not None else dur
                log.info("[render] Clip %d: user trim %.3fs -> %.3fs", i, start, end)
                jobs.append((i, p, start, end))
            elif config.get("silence_removal", False):
                dur = get_duration(p)
                start, end = detect_trim_points(p, dur)
                jobs.append((i, p, start, end))
            # else: passthrough, trimmed[i] already holds the original path.

        if jobs:
            threads_per_worker = max(1, (os.cpu_count() or 4) // MAX_PARALLEL_TRIM)
            total_jobs = len(jobs)
            trim_lo, trim_hi = checkpoints["normalise"], checkpoints["trim"]

            # #140: a per-job-START stage label (fired from the worker thread, below)
            # gives fresh status text during the ~40s all-proxy flat window instead of
            # nothing until the first completion. This is the first time report_stage/
            # report get called from a worker thread for this stage -- report_lock
            # covers BOTH this new start-call AND the pre-existing completion-calls in
            # the main thread's as_completed loop below, since both now write to the
            # same stdout stream concurrently. The old "no lock needed" reasoning (done
            # only mutated on the main thread) no longer holds once a worker thread also
            # calls report()/report_stage() for this stage.
            report_lock = threading.Lock()

            def _trim_worker(job_num: int, i: int, p, start: float, end: float) -> None:
                with report_lock:
                    report_stage(f"Trimming clip {job_num} of {total_jobs}...")
                out = tmp / f"trim_{i}.mp4"
                trimmed[i] = trim(p, start, end, out, threads=threads_per_worker)

            with ThreadPoolExecutor(max_workers=MAX_PARALLEL_TRIM) as pool:
                futures = [
                    pool.submit(_trim_worker, job_num, i, p, start, end)
                    for job_num, (i, p, start, end) in enumerate(jobs, start=1)
                ]
                # as_completed (not submission-order iteration) so a tick fires as soon as
                # ANY clip finishes -- report per-clip so this stage doesn't appear stuck,
                # same pattern as Step 1's _normalise_progress.
                done = 0
                for f in as_completed(futures):
                    f.result()  # re-raise any worker exception immediately (no swallowing)
                    done += 1
                    with report_lock:
                        report_stage(f"Trimming clip {done} of {total_jobs}")
                        report(int(trim_lo + done / total_jobs * (trim_hi - trim_lo)))

        current_paths = trimmed
    else:
        log.info("[render] Step 2: trim skipped")

    trim_s = time.time() - t0
    print(f"TIMING:trim={trim_s:.1f}s", flush=True)
    for i, p in enumerate(current_paths):
        log_av_sync(p, f"post-trim_{i}")
    report(checkpoints["trim"])

    # 3. Zoom (per-clip, before transitions). Static crop-in or gradual Ken Burns --
    # vf strings injected directly into filter_complex [sv{i}] nodes. No pre-encode
    # step: AMF absorbs scale=eval=frame at hardware speed with zero render-step
    # overhead (#67). Skipped in draft mode to keep previews quick.
    report_stage("zoom")
    t_zoom = time.time()
    zoom_proxy_input = 0

    zoom_vf_by_index: "list[str | None]" = [None] * len(current_paths)
    if zoom_active:
        log.info("[render] Step 3: zoom embed -- building per-clip vf strings")
        built = 0
        for i, (p, cm) in enumerate(zip(current_paths, pipeline_clips)):
            cz = cm.get("zoom_mode")
            if cz and cz != "none":
                eff, fx, fy = cz, cm.get("focal_x"), cm.get("focal_y")
            elif global_zoom:
                eff, fx, fy = "gentle", None, None
            else:
                continue
            zoom_vf_by_index[i] = build_zoom_vf(p, eff, fx, fy)
            if zoom_vf_by_index[i]:
                built += 1
        log.info("[zoom-embed] built %d/%d vf strings", built, len(current_paths))
    else:
        log.info("[render] Step 3: zoom skipped (mode=%s)", mode)
    zoom_s = time.time() - t_zoom
    print(f"TIMING:zoom={zoom_s:.1f}s", flush=True)
    report(checkpoints["zoom"])

    # Per-clip audio volume multipliers (Batch J) — aligned 1:1 with current_paths.
    # pipeline_clips is still 1:1 with current_paths here (trim/zoom preserve length+order).
    # Use explicit None-check — `or 1.0` would silently coerce 0.0 (mute) to 1.0 because
    # 0.0 is falsy in Python. A muted clip (volume=0.0) must stay 0.0, not become 1.0.
    volume_by_index = [
        float(v) if v is not None else 1.0
        for cm in pipeline_clips
        for v in (cm.get("clip_volume"),)
    ]

    # #103: single per-clip item list replaces the old current_paths/clip_volumes/
    # zoom_vfs parallel arrays. Card insertion below prepends/appends ONE ClipItem
    # per card -- structurally impossible for path/volume/zoom to drift out of
    # sync, since there's only one list to splice instead of three to keep in
    # lockstep. Cards get volume=1.0 (they carry no audio) and zoom_vf=None
    # (never zoomed).
    items: "list[ClipItem]" = [
        ClipItem(path=p, volume=v, zoom_vf=z)
        for p, v, z in zip(current_paths, volume_by_index, zoom_vf_by_index)
    ]

    # 4. Cards (pre-render as video segments, prepend/append).
    report_stage("cards")
    # Use actual clip dimensions so xfade size matches -- clips may not be 16:9.
    clip_w, clip_h = get_frame_size(current_paths[0])
    card_size = f"{clip_w}x{clip_h}"

    # intro_text/intro_color/outro_text/outro_color resolved early (hoisted, see #12).
    if intro_text:
        log.info("[render] Step 4: intro card")
        card = make_card(
            text=intro_text,
            color=intro_color,
            duration_s=3.0,
            out_path=tmp / "intro_card.mp4",
            size=card_size,
            subtitle=config.get("intro_subtitle", ""),
            target_fps=target_fps_raw,
        )
        items = [ClipItem(path=card, volume=1.0, zoom_vf=None, kind="card")] + items

    if outro_text:
        log.info("[render] Step 4: outro card")
        card = make_card(
            text=outro_text,
            color=outro_color,
            duration_s=3.0,
            out_path=tmp / "end_card.mp4",
            size=card_size,
            target_fps=target_fps_raw,
        )
        items = items + [ClipItem(path=card, volume=1.0, zoom_vf=None, kind="card")]

    # Unzip back to flat lists right where they're needed -- the only place
    # current_paths/clip_volumes/zoom_vfs are (re)constructed from here on.
    current_paths, clip_volumes, zoom_vfs = unzip_clip_items(items)

    # Tripwire (#98/#103): even though a single-list splice makes drift
    # structurally impossible today, keep a cheap assert in case a future code
    # path ever reconstructs these flat lists a different way.
    assert len(current_paths) == len(clip_volumes) == len(items), (
        f"current_paths/clip_volumes/items length mismatch: "
        f"{len(current_paths)}/{len(clip_volumes)}/{len(items)}"
    )
    assert zoom_vfs is None or len(zoom_vfs) == len(current_paths), (
        f"zoom_vfs/current_paths length mismatch: {len(zoom_vfs)} vs {len(current_paths)}"
    )
    report(checkpoints["cards"])

    # 5. Build filter_complex + render.
    report_stage("Rendering")
    # CRITICAL: durations must come from current_paths (post-trim), not original clips.
    report(checkpoints["cards"])
    log.info("[render] Step 5: render with xfade")
    # #86: output on NTFS render_work so Windows ffmpeg.exe (AMF) can write it (single-
    # clip, monolithic, and the U1g open/close post-pass all target this path).
    output = render_work / "render.mp4"
    durations = [get_duration(p) for p in current_paths]
    audio_flags = [has_audio(p) for p in current_paths]
    t0 = time.time()

    # Inject silence for any clips lacking audio (cards have no audio).
    current_paths, audio_flags = inject_silence_where_needed(
        current_paths, durations, audio_flags, tmp
    )

    scale_h = "480" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    log.info("[B1] render scale_h=%s (output_resolution=%s)", scale_h, output_resolution)

    # Batch Q: resolve encoder once for both paths (single-clip + multi-clip).
    win_ffmpeg = config.get("win_ffmpeg_path", "")
    use_amf = bool(config.get("use_amf", False))
    use_hevc_amf = bool(config.get("use_hevc_amf", False))  # #110, opt-in only
    bin_argv, codec_args, is_amf = video_encoder_args(
        mode, output_resolution, win_ffmpeg, use_amf=use_amf, use_hevc_amf=use_hevc_amf
    )
    log.info("[Q] encoder=%s is_amf=%s", codec_args[1] if len(codec_args) > 1 else "?", is_amf)
    # #110: which AMF family this render started on -- codec_args/is_amf are
    # computed once above and reused for every U1g batch (one encoder family
    # per render), so this is stable for the whole render, including the
    # boundary re-encode below.
    main_is_hevc = is_amf and len(codec_args) > 1 and codec_args[1] == "hevc_amf"

    # Batch R Part C: surface silent fallback to the UI. Set when the user asked
    # for AMF (Fast render toggle / RUSHCUT_USE_AMF) but we ended up on libx264 --
    # either detect-time (encoder list / probe failed) or runtime (encode error,
    # libx264 retry below). Reported via ANALYSIS amf_fallback=1 -> toast in Render.tsx.
    amf_fallback_flag = [use_amf and not is_amf]

    # Contention warning: if any clip still lacks a proxy, bg gen may be running.
    if is_amf and any(c.get("proxy_status") != "done" for c in clips):
        log.warning("[encoder] WARNING: background proxy gen may be running -- AMF throughput may be reduced")

    def _run_with_amf_fallback(cmd: list, fallback_cmd_fn, on_tick=None, total_duration_s=None) -> bool:
        """Run cmd; on AMF failure rebuild with libx264 and retry once.

        Returns True if this call fell back to libx264, False if it stayed on
        the originally requested encoder. Used by #65 Phase A to build a
        per-batch encoder_outcome_by_idx alongside the existing shared
        amf_fallback_flag (which only tracks "did ANY call fall back").

        #119: on_tick/total_duration_s (optional) enable interior progress
        ticks during the PRIMARY encode attempt via ffmpeg_run_progress. The
        rare libx264 retry-on-AMF-failure below stays on plain ffmpeg_run --
        uncommon secondary path, not worth the added complexity.
        """
        try:
            ffmpeg_run_progress(cmd, on_tick, total_duration_s)
            return False
        except RuntimeError as e:
            if is_amf:
                # This handler fires for ANY AMF encode failure, not just the
                # documented #64 (yuv420p->yuv444p swscaler negotiation) case --
                # e.g. #86 is a "Permission denied" opening the segment output
                # over a WSL UNC path, a distinct root cause. Do not assume #64
                # from this log line alone; read the actual ffmpeg stderr above.
                log.warning(
                    "[encoder] *** AMF FALLBACK *** AMF_FALLBACK=1 encode failed "
                    "-- retrying on libx264 (slow CPU encode + mixed-encoder concat risk): %s",
                    e,
                )
                amf_fallback_flag[0] = True
                ffmpeg_run(fallback_cmd_fn())
                return True
            else:
                raise

    # #121/#122: ANALYSIS emit below reads these -- computed once, ahead of
    # the render path, so open/close transitions apply uniformly regardless
    # of clip count (#136).
    transition = config.get("transition", "none")
    opening_transition = config.get("opening_transition", "none")
    closing_transition = config.get("closing_transition", "none")
    has_open = opening_transition != "none"
    has_close = closing_transition != "none"
    boundary_reencode_s = [0.0]
    # #119: estimated total duration fed to ffmpeg_run_progress's fraction
    # calc, stashed so it can be compared against the REAL output duration
    # after Step 5 -- lets drift between the estimate and reality show up in
    # the log instead of silently causing a tail mini-freeze/jump.
    progress_est_duration_s = [None]

    # #136: single-clip renders used to take a separate hand-built -vf
    # shortcut here (deleted). build_filter_complex() already handles n==1
    # generically (native-AR canvas, inline open/close, per-clip zoom/volume)
    # so every clip count now goes through the same code below -- a future
    # per-clip effect can no longer be added to the multi-clip path while
    # silently skipping single-clip (the #122/#123 bug class).
    log.info("[J] clip_volumes=%s", clip_volumes)
    shuffle_between = config.get("shuffle_between", False)
    has_xfade = (transition != "none") or shuffle_between
    # #88: boundary_reencode_s is already declared above (outer scope, so
    # _render_segmented() can mutate it via closure and report_analysis()
    # below can read it regardless of which render path ran) -- no need to
    # redeclare it here.
    # #114 Fix 1->fix: real per-boundary frame deltas (measured via the
    # pre/post _probe_frame_count() calls in _boundary_reencode() below),
    # summed here so the drift guardrail can compare the final concat
    # against ACTUAL measured segment growth instead of a theoretical
    # per-boundary formula. Root cause (2026-07-11 instrumented render,
    # Stagecoach 2025): the open boundary's xfade uses offset=0, which per
    # ffmpeg xfade semantics (output_duration = offset + second_stream_duration)
    # adds ZERO frames beyond the inner segment's own length -- the old
    # `total_after_open = inner_duration + 0.1` assumption in
    # transitions.py was wrong for the offset=0 case. Measured: open
    # delta=0 (not the assumed +3), close delta=4 (not the assumed +3).
    # Tying the guardrail to real measured deltas sidesteps re-deriving a
    # fragile xfade-duration formula and instead verifies concat integrity,
    # which is what actually matters for sync risk.
    oc_actual_frame_delta = [0]

    # Localise all /mnt/* inputs to WSL tmpfs before any FFmpeg encode.
    # Opening 17+ Windows-filesystem files concurrently via the 9P driver
    # floods the WSL kernel page-cache allocator and restarts the VM (exit 15).
    # Sequential copy to tmpfs takes ~2s for ~400 MB; FFmpeg then reads from
    # RAM-backed tmpfs with no 9P pressure.
    def _localise_inputs(paths: list, dest: Path) -> list:
        out = []
        for i, p in enumerate(paths):
            ps = str(p)
            if ps.startswith("/mnt/"):
                local = dest / f"render_in_{i}.mp4"
                if not local.exists():
                    log.info("[render] localise input %d: %s", i, Path(ps).name)
                    shutil.copyfile(ps, str(local))
                out.append(local)
            else:
                out.append(p)
        return out

    current_paths = _localise_inputs(current_paths, tmp)
    log.info("[render] all inputs localised to tmpfs")

    # ---------------------------------------------------------------
    # U1g: segmented (memory-bounded) xfade render.
    # A monolithic N-input 4K xfade graph buffers decoded 12.4 MB frames
    # at every chained stage; on big projects peak RAM overflows the WSL
    # VM and it is balloon-killed (exit 15). Fix: render the video xfade
    # in overlap-by-one batches of BATCH_SIZE (chain depth stays small),
    # join the segments with a lossless concat in each shared clip's solo
    # region, render the (cheap) audio acrossfade in a single pass, and
    # mux. See docs/batch-plan-u1-subbatches.md "Batch U1g".
    # ---------------------------------------------------------------
    BATCH_SIZE = 4

    # Mutable progress holder so the outer fallback handler can report which
    # batch was in flight (and its input size) when a failure occurred.
    progress = {"batch": 0, "total": 0, "batch_len": 0}

    # #65: per-batch encoder outcome, keyed by batch index. True = this
    # batch's segment encoded on the originally requested encoder (AMF when
    # is_amf); False = it fell back to libx264. Unlike the single shared
    # amf_fallback_flag above (any-call-fell-back), this lets the boundary
    # segment re-encode (seg_files[0]/seg_files[-1]) match the SAME encoder
    # its segment actually used, avoiding a mixed-encoder concat (#64).
    encoder_outcome_by_idx: dict[int, bool] = {}

    def _render_segmented() -> None:
        # #86: reuse the outer NTFS render_work (same job_id/base) so U1g segment
        # outputs are AMF-writable /mnt/c paths, never /tmp -> UNC.
        seg_tmp = render_work
        seg_tmp.mkdir(parents=True, exist_ok=True)
        log.info("[U1g] segment work dir: %s", seg_tmp)
        xf = clamp_xfade_dur(durations)
        per_cut_names = resolve_cut_names(
            len(current_paths), transition, shuffle_between, cache_sig
        )
        # May raise ValueError if a boundary clip has no solo region.
        plan, total = plan_video_batches(durations, batch_size=BATCH_SIZE, xfade_dur=xf)
        progress["total"] = len(plan)
        progress_est_duration_s[0] = total
        log.info(
            "[U1g] segmented render: %d batches total=%.3fs xfade_dur=%.3f",
            len(plan), total, xf,
        )

        # FPS for exact frame-count segmentation. Using -frames:v with counts
        # derived from the GLOBAL frame grid makes the per-segment counts
        # telescope to exactly round(total*fps) -- so boundary rounding cannot
        # accumulate into progressive A/V drift across batches.
        def _fps_float(raw: str) -> float:
            if "/" in raw:
                a, c = raw.split("/")
                return float(a) / float(c)
            return float(raw)
        fps_f = _fps_float(target_fps_raw)
        total_frames_expected = round(total * fps_f)

        seg_files: list[Path] = []
        covered_frames = 0
        for bi, b in enumerate(plan):
            idxs = b["clip_indices"]
            progress["batch"] = bi + 1
            progress["batch_len"] = len(idxs)
            bdurs = b["local_durations"]
            bpaths = [current_paths[k] for k in idxs]
            # Global cut between clip k and k+1 == per_cut_names[k]; this
            # batch's cuts are the global cuts idxs[0]..idxs[-2].
            bnames = [per_cut_names[k] for k in idxs[:-1]]
            bzoom = [zoom_vfs[k] for k in idxs] if zoom_vfs else None
            vfc, v_out_b = build_batch_video_fc(bdurs, bnames, mode, output_resolution, xf, zoom_vfs=bzoom)

            # Drop the leading (pre-window) part INSIDE the filter graph -- a
            # "-c copy" trim snaps to GOP keyframes and drifts whole seconds
            # (caught in U1g smoke test). setpts=0 resets each segment to PTS 0
            # so the final concat -c copy joins cleanly.
            start = b["seg_start_local"]
            if start > 0.01:
                vfc = (
                    vfc.replace(v_out_b, "[vpre]")
                    + f"; [vpre]trim=start={start:.4f},setpts=PTS-STARTPTS{v_out_b}"
                )

            # Exact end via integer frame count from the GLOBAL grid (telescopes).
            g_start = b["seg_start_global"]
            g_end = total if b["seg_end_local"] is None else b["seg_end_global"]
            n_frames = round(g_end * fps_f) - round(g_start * fps_f)
            covered_frames += n_frames

            seg = seg_tmp / f"u1g_seg_{bi}.mp4"

            def _build_batch(b_argv, c_args, paths, out_path, graph, vmap, nfr):
                if is_amf:
                    in_args = [a for p in paths for a in ("-i", to_win_path(p))]
                    o = to_win_path(out_path)
                else:
                    in_args = [a for p in paths for a in ("-i", str(p))]
                    o = str(out_path)
                return (
                    b_argv + ["-y"] + in_args
                    + ["-filter_complex", graph, "-map", vmap, "-an"]
                    + ["-r", target_fps_raw, "-frames:v", str(nfr)]
                    + c_args + [o]
                )

            cmd = _build_batch(bin_argv, codec_args, bpaths, seg, vfc, v_out_b, n_frames)

            def _fb_batch(_paths=bpaths, _graph=vfc, _vmap=v_out_b, _seg=seg, _nfr=n_frames):
                fb_argv, fb_codec, _ = video_encoder_args(
                    mode, output_resolution, win_ffmpeg, force_libx264=True
                )
                in_args = [a for p in _paths for a in ("-i", str(p))]
                return (
                    fb_argv + ["-y"] + in_args
                    + ["-filter_complex", _graph, "-map", _vmap, "-an"]
                    + ["-r", target_fps_raw, "-frames:v", str(_nfr)]
                    + fb_codec + [str(_seg)]
                )

            log.info(
                "[U1g] batch %d/%d clips %s start=%.3f frames=%d (global [%.3f,%.3f]) "
                "mem_avail_mb=%s",
                bi + 1, len(plan), idxs, start, n_frames, g_start, g_end,
                _mem_available_mb(),
            )
            fell_back = _run_with_amf_fallback(cmd, _fb_batch)
            encoder_outcome_by_idx[bi] = not fell_back
            # #119: tick once per completed batch -- real progress, not a
            # fake timer. Batches are the natural granularity for U1g; no
            # frame-level tracking needed on top of this.
            _lo, _hi = checkpoints["cards"], checkpoints["render"]
            report(int(_lo + (bi + 1) / progress["total"] * (_hi - _lo)))
            is_boundary = bi == 0 or bi == len(plan) - 1
            log.info(
                "[U1g] batch %d encoder_outcome amf_ok=%s boundary=%s",
                bi, encoder_outcome_by_idx[bi], is_boundary,
            )
            seg_files.append(seg)

        # Sync assertion: total frames must telescope to round(total*fps).
        drift_frames = abs(covered_frames - total_frames_expected)
        log.info(
            "[U1g] segment frames=%d expected=%d drift=%d frame(s) (%.1fms)",
            covered_frames, total_frames_expected, drift_frames,
            drift_frames / fps_f * 1000.0,
        )
        if drift_frames > 1:
            raise RuntimeError(
                f"[U1g] frame-count drift {drift_frames} frames -- sync risk"
            )

        # #65: boundary-segment-only open/close re-encode. Replaces the old
        # whole-film open/close post-pass (issue #31's _apply_open_close_post,
        # deleted once this path was proven -- see git history) which
        # re-encoded the ENTIRE inner film a second time just to apply a
        # ~1.5s fade to/from black. Only the boundary segment(s) get a
        # second-generation encode now.
        def _boundary_codec_args(amf: bool) -> list:
            if mode == "draft":
                _, c, _ = video_encoder_args(
                    mode, output_resolution, win_ffmpeg,
                    force_libx264=not amf, use_amf=use_amf, use_hevc_amf=use_hevc_amf,
                )
                return c
            if amf and main_is_hevc:
                # #110: match the render's own hevc_amf family -- same
                # nv12/-b:v-explicit reasoning as the main encode branch
                # in encoder.py (AMF#514, AMF#273; see video_encoder_args).
                args = ["-c:v", "hevc_amf", "-pix_fmt", "nv12", "-profile:v", "main",
                        "-rc", "vbr_peak", "-b:v", HEVC_FINAL_BITRATE_4K, "-maxrate", HEVC_AMF_MAXRATE_4K,
                        "-bufsize", HEVC_AMF_MAXRATE_4K, "-quality", "quality"]
                return args
            if amf:
                # CQP for 4K mirrors encoder.py's video_encoder_args 4K branch
                # (launch plan #1.1) -- boundary segments are the open/close
                # transitions, same pan/motion quality concern applies there.
                is_4k = output_resolution == "4k"
                if is_4k:
                    args = ["-c:v", "h264_amf", "-pix_fmt", "yuv420p", "-profile:v", "main",
                            "-rc", "cqp", "-qp_i", "18", "-qp_p", "20", "-quality", "quality"]
                else:
                    # Bug fix: this branch previously always used the 4K
                    # bitrate tier even for a 1080p AMF-opt-in boundary
                    # re-encode -- now correctly uses the 1080p tier,
                    # matching encoder.py's video_encoder_args.
                    args = ["-c:v", "h264_amf", "-pix_fmt", "yuv420p", "-profile:v", "main",
                            "-rc", "vbr_peak", "-b:v", FINAL_BITRATE, "-maxrate", AMF_MAXRATE,
                            "-bufsize", AMF_MAXRATE, "-quality", "quality"]
                # Extended to 1080p AMF opt-in too (launch plan #1.2) -- previously 4K-only.
                args += ["-vbaq", "true", "-high_motion_quality_boost_enable", "true"]
                return args
            return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "main",
                    "-crf", "16", "-preset", "medium"]

        def _first_frame_is_keyframe(path: Path) -> bool:
            # Confirm a boundary re-encode starts on a keyframe -- should
            # always hold for a fresh encode from a solo-region source; a
            # missing leading keyframe would glitch playback/seek at the
            # lossless concat boundary. One ffprobe call, no extra encode work.
            data = ffprobe_json([
                "-select_streams", "v:0", "-show_entries", "frame=pict_type",
                "-read_intervals", "%+#1", str(path),
            ])
            frames = data.get("frames", [])
            return bool(frames) and frames[0].get("pict_type") == "I"

        def _boundary_reencode(idx: int, is_open: bool, is_close: bool) -> Path:
            # Re-encode ONLY this boundary segment (video-only -- seg_files
            # are already "-an") with the open/close xfade-to-black baked in.
            # Writes a sibling file -- never overwrites seg_files[idx] in place.
            seg = seg_files[idx]
            iw, ih = get_frame_size(seg)
            seg_dur = get_duration(seg)
            # #114 Fix 1 (logs-first): `seg` is the already-completed, fully-flushed
            # batch segment written by the U1g batch loop above -- this function only
            # runs after ALL batches finish, so it's a stable, closed file at probe
            # time (not a partial/in-progress write). Baseline probe before the
            # boundary re-encode; paired with the post-probe below to isolate the
            # per-boundary frame delta (open vs. close), since only the combined
            # final-output check exists today.
            pre_frames = _probe_frame_count(seg)
            pp_fc, pp_vmap, _ = build_open_close_post_fc(
                inner_duration=seg_dur,
                has_audio=False,
                scale_w=str(iw),
                scale_h=str(ih),
                target_fps_raw=target_fps_raw,
                opening_transition=opening_transition if is_open else "none",
                closing_transition=closing_transition if is_close else "none",
                xfade_dur=xf,
                clip_tbn_str=_fps_to_tbn(target_fps_raw),
            )
            tag = "_".join(t for t, on in (("open", is_open), ("close", is_close)) if on)
            out_seg = seg.with_name(f"{seg.stem}_{tag}.mp4")

            # Encoder-consistency guard (#64 mixed-encoder concat): match the
            # SAME encoder this segment's own batch already used
            # (encoder_outcome_by_idx), so the lossless concat never mixes
            # AMF/libx264 SPS/PPS across segments.
            force_libx264 = (not is_amf) or (not encoder_outcome_by_idx.get(idx, False))
            amf_for_this = not force_libx264

            def _build(b_argv, c_args, amf):
                i_arg = to_win_path(seg) if amf else str(seg)
                o_arg = to_win_path(out_seg) if amf else str(out_seg)
                return (b_argv + ["-y", "-i", i_arg, "-filter_complex", pp_fc,
                                   "-map", pp_vmap, "-r", target_fps_raw]
                        + c_args + [o_arg])

            pp_cmd = _build(bin_argv, _boundary_codec_args(amf_for_this), amf_for_this)

            def _fb():
                fb_argv, _, _ = video_encoder_args(
                    mode, output_resolution, win_ffmpeg, force_libx264=True
                )
                return _build(fb_argv, _boundary_codec_args(False), False)

            log.info(
                "[U1g] boundary re-encode: idx=%d seg=%s open=%s close=%s "
                "inner_dur=%.3fs size=%dx%d force_libx264=%s",
                idx, seg.name, is_open, is_close, seg_dur, iw, ih, force_libx264,
            )
            fell_back = _run_with_amf_fallback(pp_cmd, _fb)

            # Belt-and-braces: we requested this segment's OWN prior encoder
            # choice (force_libx264=False because encoder_outcome_by_idx said
            # AMF succeeded there) but this re-encode fell back anyway --
            # stale/mismatched outcome, flag it before it silently produces a
            # mixed-encoder concat.
            if not force_libx264 and fell_back:
                log.warning(
                    "[U1g] boundary re-encode encoder MISMATCH idx=%d: requested AMF "
                    "(matching original segment) but this re-encode fell back to "
                    "libx264 -- mixed-encoder concat risk (#64)", idx,
                )

            if not _first_frame_is_keyframe(out_seg):
                log.warning(
                    "[U1g] boundary re-encode idx=%d (%s) does NOT start on a "
                    "keyframe -- lossless concat may glitch at this boundary",
                    idx, out_seg.name,
                )

            # #114 Fix 1 (logs-first): per-boundary frame delta, separate from the
            # combined final-output check further down. Compare against
            # oc_delta_expected's per-boundary assumption (round(0.1*fps_f)) to
            # isolate whether the drift is per-boundary or a compounding artifact.
            post_frames = _probe_frame_count(out_seg)
            this_delta = post_frames - pre_frames
            oc_actual_frame_delta[0] += this_delta
            log.info(
                "[U1g][#114] boundary frame delta idx=%d open=%s close=%s "
                "pre=%d post=%d delta=%d",
                idx, is_open, is_close, pre_frames, post_frames, this_delta,
            )

            return out_seg

        needs_open_close = has_open or has_close
        # #88: timed at the call sites (not inside _boundary_reencode)
        # since the 3 sites below are mutually exclusive -- only 1 or 2
        # fire per render, so accumulating across them can't double-count.
        # boundary_reencode_s itself is declared in the outer run_pipeline
        # scope (near has_open/has_close) so report_analysis() can read it.

        if needs_open_close:
            # #65: bake the open/close fade into ONLY the boundary segment(s),
            # before the lossless concat below.
            #
            # QA-reviewer-caught edge case: if open and close ever land on
            # the SAME index (single-batch), two separate calls would have
            # the second overwrite the first, silently dropping the opening
            # fade. Structurally unreachable today -- plan_video_batches
            # with BATCH_SIZE=4 always produces >=2 batches whenever this
            # path runs (use_batched requires len(current_paths) >
            # BATCH_SIZE) -- but handled explicitly rather than left as an
            # implicit invariant that a future BATCH_SIZE/gate change could
            # silently break.
            last_idx = len(seg_files) - 1
            if has_open and has_close and last_idx == 0:
                _t0_br = time.time()
                seg_files[0] = _boundary_reencode(0, is_open=True, is_close=True)
                boundary_reencode_s[0] += time.time() - _t0_br
            else:
                if has_open:
                    _t0_br = time.time()
                    seg_files[0] = _boundary_reencode(0, is_open=True, is_close=False)
                    boundary_reencode_s[0] += time.time() - _t0_br
                if has_close:
                    _t0_br = time.time()
                    seg_files[last_idx] = _boundary_reencode(last_idx, is_open=False, is_close=True)
                    boundary_reencode_s[0] += time.time() - _t0_br

        # Concat the segments (all identical codec/params) -> video_full.
        concat_list = seg_tmp / "u1g_concat.txt"
        concat_list.write_text("".join(f"file '{s}'\n" for s in seg_files))
        video_full = seg_tmp / "u1g_video_full.mp4"
        ffmpeg_run([
            FFMPEG, "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_list), "-c", "copy", str(video_full),
        ])

        # Single-pass audio over ALL clips (cheap; no 4K frame buffers).
        # V4.1: no loudnorm here -- Step 5 is the clean, cacheable intermediate;
        # loudnorm is deferred to the final _apply_audio_treatment step.
        ln = None
        afc, a_out_lbl = build_audio_only_fc(durations, audio_flags, clip_volumes, xf, ln)

        # Video already carries the open/close fade (baked into the boundary
        # segment(s) above, pre-concat when needs_open_close) -- mux straight
        # to output, no whole-film video post-pass. Audio: apply the SAME
        # acrossfade-to-silence fade issue #31 originally used, but only on
        # the (already cheap) whole-project audio_full track, fully decoupled
        # from video.
        mux_target = output
        if a_out_lbl:
            audio_full = seg_tmp / "u1g_audio_full.m4a"
            in_args = [a for p in current_paths for a in ("-i", str(p))]
            ffmpeg_run(
                [FFMPEG, "-y"] + in_args
                + ["-filter_complex", afc, "-map", a_out_lbl, "-vn",
                   "-c:a", "aac", "-b:a", "128k", "-ar", "48000", str(audio_full)]
            )
            if needs_open_close:
                oc_afc, oc_amap = build_open_close_audio_fc(
                    opening_transition, closing_transition, xf
                )
                audio_full_oc = seg_tmp / "u1g_audio_full_oc.m4a"
                ffmpeg_run([
                    FFMPEG, "-y", "-i", str(audio_full),
                    "-filter_complex", oc_afc, "-map", oc_amap,
                    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", str(audio_full_oc),
                ])
                audio_full = audio_full_oc
            ffmpeg_run([
                FFMPEG, "-y", "-i", str(video_full), "-i", str(audio_full),
                "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", str(mux_target),
            ])
        else:
            ffmpeg_run([FFMPEG, "-y", "-i", str(video_full), "-c", "copy", str(mux_target)])

        if needs_open_close:
            log.info(
                "[U1g] boundary-only open/close: video baked into boundary "
                "segment(s) pre-concat, audio treated on whole-project track "
                "-- no whole-film video re-encode this render"
            )

            # Validate final frame count against the pre-open/close planned
            # total + the REAL measured per-boundary delta (oc_actual_frame_delta,
            # summed from the pre/post probes in _boundary_reencode() above).
            # Uses total_frames_expected (the exact planned base, from the
            # segment plan) rather than probing an intermediate file, since
            # there's no single "inner" file in this path.
            #
            # #114 fix: this used to assume a symmetric round(0.1*fps_f) per
            # active boundary (3+3=6 for both-on). Real instrumented data
            # (2026-07-11, Stagecoach 2025, 20 clips/4K) showed that's wrong:
            # the OPEN boundary's xfade uses offset=0, and per ffmpeg xfade
            # semantics (output_duration = offset + second_stream_duration)
            # that adds ZERO frames beyond the inner segment's own length --
            # confirmed by a clean delta=0 measurement, not the assumed +3.
            # The CLOSE boundary measured delta=4 (also not the assumed +3).
            # Deriving "expected" from a duration-based formula was the root
            # bug; using the actual measured per-boundary deltas instead ties
            # this guardrail to ground truth and makes it check what actually
            # matters -- concat integrity -- rather than re-deriving a
            # fragile xfade-duration formula that doesn't hold for offset=0.
            out_frames = _probe_frame_count(output)
            oc_delta_expected = oc_actual_frame_delta[0]
            expected_frames = total_frames_expected + oc_delta_expected
            oc_drift_frames = abs(out_frames - expected_frames)
            log.info(
                "[U1g] boundary-only open/close frames=%d expected=%d "
                "(base=%d + oc_delta=%d) drift=%d frame(s)",
                out_frames, expected_frames, total_frames_expected,
                oc_delta_expected, oc_drift_frames,
            )
            if oc_drift_frames > 1:
                raise _BoundaryDriftError(
                    f"[U1g] boundary-only open/close drift {oc_drift_frames} "
                    "frames -- sync risk"
                )

    # #65: open/close-to-black no longer forces the monolithic fallback --
    # the inner content renders segmented and the open/close fade is baked
    # into the boundary segment(s) before the lossless concat.
    use_batched = len(current_paths) > BATCH_SIZE and has_xfade
    did_batched = False
    if use_batched:
        try:
            _render_segmented()
            did_batched = True
            fallback_label = "with fallback" if amf_fallback_flag[0] else "no fallback"
            log.info(
                "[U1g] segmented render complete (%s) batches=%s clips_total=%s mem_avail_mb=%s",
                fallback_label, progress["total"], len(current_paths), _mem_available_mb(),
            )
        except Exception as e:  # noqa: BLE001 -- fall back to monolithic on any planner/encode failure
            # #114 Fix 2: a drift-check failure is a correctness assertion, not a real
            # ffmpeg crash -- falling back to monolithic here is exactly the OOM-prone
            # path U1g batching exists to avoid at this scale (confirmed: monolithic
            # OOM'd on AMF, OOM'd again on the libx264 retry, took WSL down hard enough
            # to need `wsl --shutdown`). isinstance check inside this single except
            # block (NOT a separate `except _BoundaryDriftError:` clause -- a
            # more-specific clause ordered after this general one would never be
            # reached, silently swallowed by it first). Do not fall back here --
            # propagate a clean, user-facing error instead. Technical detail
            # (per-boundary/final frame counts) is already in the log above via the
            # drift check itself.
            if isinstance(e, _BoundaryDriftError):
                log.error(
                    "[U1g][#114] boundary drift check failed -- aborting render "
                    "instead of falling back to monolithic (known OOM risk at this "
                    "scale): %s", e,
                )
                raise RuntimeError(
                    "Render failed: transition boundary sync check failed "
                    "(open/close fade drift). Please retry, or disable one of the "
                    "opening/closing transitions and try again."
                ) from e
            # Logs-first instrumentation (issue #7): capture full diagnostics on
            # the (exit-15-prone) monolithic fallback so the next in-the-wild
            # failure can be designed against without re-running. Behaviour
            # unchanged -- still falls back to monolithic this session.
            cls, ffmpeg_exit = _classify_segmented_failure(e)
            log.warning(
                "[U1g][fallback] class=%s exc_type=%s ffmpeg_exit=%s mem_avail_mb=%s batch=%s/%s "
                "batch_len=%s clips_total=%s exc=%r -- falling back to monolithic",
                cls, e.__class__.__name__, ffmpeg_exit, _mem_available_mb(), progress["batch"],
                progress["total"], progress["batch_len"], len(current_paths), e,
                exc_info=True,
            )
            did_batched = False

    if not did_batched:
        # Monolithic single-graph path: small projects (<= BATCH_SIZE), the
        # "none"/concat path, or a segmented fallback.
        fc, v_out, a_out = build_filter_complex(
            current_paths, durations, audio_flags,
            transition=transition,
            mode=mode,
            output_resolution=output_resolution,
            clip_volumes=clip_volumes,
            shuffle_between=shuffle_between,
            seed=cache_sig,
            opening_transition=opening_transition,
            closing_transition=closing_transition,
            target_fps_raw=target_fps_raw,
            clip_tbn_str=_fps_to_tbn(target_fps_raw),
            zoom_vfs=zoom_vfs,
        )
        # V4.1: no loudnorm fused here -- Step 5 output is the clean, cacheable
        # intermediate; loudnorm is deferred to the final _apply_audio_treatment.
        a_map = a_out
        log.info("[render] filter_complex:\n  %s", fc)

        def _build_multi(b_argv, c_args, paths, out_path):
            if is_amf:
                in_args = [arg for p in paths for arg in ("-i", to_win_path(p))]
                o = to_win_path(out_path)
            else:
                in_args = [arg for p in paths for arg in ("-i", str(p))]
                o = str(out_path)
            return (
                b_argv + ["-y"] + in_args
                + ["-filter_complex", fc, "-map", v_out]
                + (["-map", a_map] if a_map else [])
                + c_args
                + (["-c:a", "aac", "-b:a", "128k", "-ar", "48000"] if a_map else [])
                + [o]
            )

        cmd = _build_multi(bin_argv, codec_args, current_paths, output)

        def _fallback_multi():
            fb_argv, fb_codec, _ = video_encoder_args(mode, output_resolution, win_ffmpeg, force_libx264=True)
            in_args = [arg for p in current_paths for arg in ("-i", str(p))]
            return (
                fb_argv + ["-y"] + in_args
                + ["-filter_complex", fc, "-map", v_out]
                + (["-map", a_map] if a_map else [])
                + fb_codec
                + (["-c:a", "aac", "-b:a", "128k", "-ar", "48000"] if a_map else [])
                + [str(output)]
            )

        # #119: interior progress ticks during the monolithic multi-clip
        # encode. total_duration_s mirrors the same overlap-subtraction
        # plan_video_batches() uses for U1g (xfade shortens the joined
        # output by xfade_dur per cut).
        _multi_total_s = (
            sum(durations) - (len(current_paths) - 1) * clamp_xfade_dur(durations)
            if has_xfade else sum(durations)
        )
        progress_est_duration_s[0] = _multi_total_s
        _multi_lo, _multi_hi = checkpoints["cards"], checkpoints["render"]

        def _multi_tick(frac: float, _lo=_multi_lo, _hi=_multi_hi) -> None:
            report(int(_lo + frac * (_hi - _lo)))

        _run_with_amf_fallback(
            cmd, _fallback_multi, on_tick=_multi_tick, total_duration_s=_multi_total_s
        )

    encoder_name = codec_args[1] if len(codec_args) > 1 else "libx264"
    render_s = time.time() - t0
    # #119: log estimate-vs-actual duration drift for the progress-tick fraction
    # calc. The monolithic estimate (sum(durations) minus xfade overlap) is an
    # approximation, not a probe of the real encoded output -- if it drifts
    # significantly from actual on real-world footage, the progress fraction
    # would reach 100% early/late, causing a mini-freeze/jump at the tail. This
    # makes that drift visible in the log without affecting behavior.
    if progress_est_duration_s[0] is not None:
        try:
            _actual_dur = get_duration(output)
            _est_dur = progress_est_duration_s[0]
            _drift_pct = (_actual_dur - _est_dur) / _est_dur * 100.0 if _est_dur else 0.0
            log.info(
                "[render][#119] progress duration estimate=%.3fs actual=%.3fs drift=%.3fs (%.1f%%)",
                _est_dur, _actual_dur, _actual_dur - _est_dur, _drift_pct,
            )
        except Exception:
            pass  # diagnostic only -- never let this affect the render
    print(f"TIMING:render={render_s:.1f}s encoder={encoder_name}", flush=True)

    # V4.1: Step 5 output is the clean, treatment-free intermediate. Publish it to
    # the render cache (miss path) BEFORE the music/loudnorm layer is applied, so a
    # later re-render that only changes music can reuse it.
    if use_cache:
        render_cache.write(output, cache_sig)

    # 6. Music + loudnorm -- the cheap, cache-on-top layer (shared with cache hit).
    t0 = time.time()
    output = _apply_audio_treatment(output, checkpoints)
    music_s = time.time() - t0

    # 7. Loudnorm is applied exactly once inside _apply_audio_treatment (music on ->
    # mix_music; music off -> dedicated -c:v copy pass). No separate pass here.
    # #12: tail progress tick (checkpoints["audio"]) is now emitted inside
    # _apply_audio_treatment itself -- shared by both the cache-hit and cache-miss
    # paths, so no separate report() call is needed here.
    loudnorm_s = 0.0
    print(f"TIMING:loudnorm={loudnorm_s:.1f}s", flush=True)

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
        zoom_on       = 1 if (config.get("zoom") or has_per_clip_zoom) else 0
        transition    = config.get("transition", "none")

        volume_custom = int(any(
            abs((float(v) if v is not None else 1.0) - 1.0) > 1e-6
            for cm in pipeline_clips
            for v in (cm.get("clip_volume"),)
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
            f",zoom_proxy_input={zoom_proxy_input}"
            f",per_clip_zoom_clips={sum(1 for c in pipeline_clips if c.get('zoom_mode') and c.get('zoom_mode') != 'none')}"
            f",encoder={encoder_name}"
            f",amf_fallback={1 if amf_fallback_flag[0] else 0}"
            f",render_cache={cache_status}"
            f",opening_transition_on={1 if has_open else 0}"
            f",closing_transition_on={1 if has_close else 0}"
            f",boundary_reencode_s={boundary_reencode_s[0]:.1f}"
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
