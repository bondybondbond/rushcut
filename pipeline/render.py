"""
pipeline/render.py -- Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1.  normalise      -> H.264/yuv420p/25fps/1080p/AAC
  2.  silence trim   -> (if config.silence_removal) trim silence from clip edges
  3.  zoom           -> (if config.zoom, final mode only)
  4.  cards          -> prepend intro, append outro (if text provided)
  5.  render         -> filter_complex xfade + scale, or single-clip shortcut
  6.  mix_music      -> (if config.music_mood != "none")

  Single-pass EBU R128 loudnorm (-14 LUFS, final mode only) is fused into the
  step 5 encode (music off) or the step 6 encode (music on) -- no separate pass.

Entry points:
  run_pipeline(job, clips, clip_paths, ...) -> Path
  run_local(clips_dir, output_dir)          -> None  (no R2/Supabase)
"""

import hashlib
import logging
import os
import re
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import subprocess

from .cards import make_card
from .detect import detect_trim_points
from .encoder import to_win_path, video_encoder_args
from .loudnorm import loudnorm_filter
from .music import mix_music
from .normalise import normalise
from .proxy import is_valid_proxy
from .transitions import (
    build_filter_complex,
    build_batch_video_fc,
    build_audio_only_fc,
    build_open_close_post_fc,
    plan_video_batches,
    resolve_cut_names,
    clamp_xfade_dur,
)
from .trim import trim
from .utils import FFMPEG, ffmpeg_run, ffprobe_json, get_duration, get_frame_size, has_audio, log_av_sync
from .zoom import apply_zoom
from .zoom_cache import acquire_or_wait, release_lock

log = logging.getLogger(__name__)


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
MAX_PARALLEL_ZOOM = min(4, os.cpu_count() or 1)

# Persistent zoom-output cache. Re-renders with unchanged zoom params reuse the
# encoded clip instead of re-running the eval=frame scale pass. Lives on
# Windows-backed NTFS (via /mnt/c) so it survives WSL --shutdown and Windows
# reboots; the previous /tmp tmpfs location lost the cache on every WSL restart
# (render-timing-log.jsonl showed zoom_cache_hits=0 on all entries).
# Path resolution: env var RUSHCUT_ZOOM_CACHE_DIR (set by run.py from
# manifest_path.parent) -> default Windows %TEMP%\rushcut\zoom-cache mapped to
# /mnt/c -> /tmp fallback for tests with no Windows env.
_ZOOM_CACHE_MAX_AGE_S = 2 * 86400  # prune entries older than 2 days


def _resolve_zoom_cache_dir() -> Path:
    env = os.environ.get("RUSHCUT_ZOOM_CACHE_DIR")
    if env:
        return Path(env)
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        user = Path(userprofile).name
        return Path(f"/mnt/c/Users/{user}/AppData/Local/Temp/rushcut/zoom-cache")
    return Path("/tmp/rushcut-zoom-cache")


def _resolve_render_work_dir(job_id: "str | object") -> Path:
    # U1g segment artifacts (per-batch segments, concat list, video/audio full)
    # live on Windows-backed NTFS (via /mnt/c) instead of /tmp tmpfs, so they
    # survive WSL memory-pressure eviction between the last batch encode and the
    # concat-manifest write -- the [Errno 2] that silently dropped the segmented
    # path back to the (exit-15-prone) monolithic render. Mirrors the zoom-cache
    # resolution order: env override -> USERPROFILE -> /tmp fallback (test envs).
    env = os.environ.get("RUSHCUT_ZOOM_CACHE_DIR")
    if env:
        return Path(env).parent / str(job_id)
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


def _prune_zoom_cache(cache_dir: Path) -> None:
    """Best-effort prune of zoom cache files older than 2 days.

    NOT strict eviction — concurrent renders may both prune harmlessly. Wrapped
    so any failure is swallowed: a cache-cleanup error must never fail a render.
    """
    try:
        cutoff = time.time() - _ZOOM_CACHE_MAX_AGE_S
        for f in cache_dir.glob("*.mp4"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass
    except Exception:
        pass


# Bump when the Ken Burns formula changes to invalidate stale cache entries.
_KENBURNS_CACHE_VER = "2"


def zoom_coord_log(who: str, event: str, key: str, clip_idx: int, resolution: str) -> None:
    """#15 Step 0 instrumentation: emit a uniform, greppable correlation line so
    warm (zoom-bg.log) and render (pipeline-*.log) activity on the SAME cache key
    can be lined up by timestamp. `key` is the FULL sha1 (not truncated) so both
    producers print identical keys. ASCII only. who="warm"|"render".
    """
    ts = datetime.now(timezone.utc).isoformat()
    log.info(
        "[zoom-coord] ts=%s who=%s event=%s clip=%d res=%s key=%s",
        ts, who, event, clip_idx, resolution, key,
    )


def _zoom_cache_key(
    src_path: Path,
    in_ms,
    out_ms,
    zoom_mode,
    focal_x,
    focal_y,
    output_resolution: str,
) -> str:
    """sha1 of every input that determines the zoomed clip's content.

    in_ms/out_ms must be the ORIGINAL user-facing offsets (clips[i]), not the
    B-0-adjusted pipeline_clips offsets — otherwise the same logical trim keys
    differently depending on whether a proxy was available. output_resolution
    is included so a 1080p render can never reuse a 4K zoom entry.
    """
    try:
        size = src_path.stat().st_size
    except OSError:
        size = 0
    raw = "|".join(str(x) for x in (
        _KENBURNS_CACHE_VER, src_path, size, in_ms, out_ms, zoom_mode, focal_x, focal_y, output_resolution
    ))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def pretrim_one_clip(i: int, src_p: Path, cm: dict, tmp: Path) -> tuple[Path, dict]:
    """B-0 pre-trim one source clip to [in_s-2s, out_s+0.5s] via fast copy-seek.

    Returns (pre_trimmed_path, pipeline_clip_meta) where the meta carries B-0-adjusted
    in_ms/out_ms (offsets relative to the pre-trim window start). Clips with no user
    trim are returned untouched. Extracted from the Step-1 _pretrim_worker closure so
    warm_zoom.py reproduces the render's per-clip prep with identical offset math
    (no copy-paste drift). See pipeline.md "B-0 trim offset mutation".
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
    clip_meta: dict, output_resolution: str, target_fps_int: int
) -> tuple[bool, str | None, str]:
    """Decide whether a clip's proxy can substitute for normalise.

    Returns (use_proxy, proxy_path_wsl, reason). A proxy qualifies only when it is
    valid, tall enough for the output resolution (>=1080p for 1080p, >=2160p for 4K),
    AND its fps matches the render target. Extracted from Step 1 so warm_zoom.py mirrors
    the render's proxy-vs-normalise partition exactly. See pipeline.md "Proxy reuse gate".
    """
    required_proxy_h = 2160 if output_resolution == "4k" else 1080
    pwsl = clip_meta.get("proxy_path_wsl")
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
    # When music is on, loudnorm fuses into the step 6 music encode; when off,
    # it fuses into the step 5 render encode. Exactly one site applies it.
    music_on = bool(music_filename or custom_music_path_wsl)

    # ANALYSIS counters -- all clips used, no motion filtering.
    clips_total = len(clip_paths)
    clips_used = clips_total
    clips_excluded = 0

    # 1. Normalise -- report per-clip so progress doesn't appear stuck.
    report_stage("Preparing clips")
    log.info("[render] Step 1: normalise")
    report(10)
    t0 = time.time()

    # Detect target fps from the first source clip.
    # target_fps_raw: passed to FFmpeg -r (preserves rational e.g. "30000/1001")
    # target_fps_int: used ONLY for proxy comparison and log messages, never passed to FFmpeg
    target_fps_raw = _probe_fps(clip_paths[0]) if clip_paths else "25"
    target_fps_int = round_to_standard_fps(target_fps_raw)
    log.info("[Q2] target_fps=%d (source %s from clip 0)", target_fps_int, target_fps_raw)

    # Pre-trim: extract only the needed segment from each source clip before normalise.
    # DJI clips can be 60-120s; user typically uses 5-30s. Normalising the full clip
    # wastes 4-10x time. Fast copy-seek to [in_s - 2s, out_s + 0.5s], then normalise
    # only the short segment. Step 2 fine-trims the normalised file with adjusted offsets.
    # Original `clips` preserved intact for ANALYSIS metrics (source duration/resolution).
    n_clips = len(clip_paths)
    pre_trimmed_paths: list = [None] * n_clips
    pipeline_clips:    list = [None] * n_clips

    def _pretrim_worker(i: int, src_p: Path, cm: dict) -> None:
        pre_trimmed_paths[i], pipeline_clips[i] = pretrim_one_clip(i, src_p, cm, tmp)

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
        futures = [pool.submit(_pretrim_worker, i, src_p, cm)
                   for i, (src_p, cm) in enumerate(zip(clip_paths, clips))]
        for f in futures:
            f.result()

    # Partition clips: use proxy as normalise substitute where available.
    # Required proxy height depends on output resolution (>=1080p for 1080p,
    # >=2160p for 4K). Background gen (Batch N) encodes at 2160p so proxies qualify
    # for both. The decision lives in decide_clip_source() so warm_zoom.py mirrors
    # the render's proxy-vs-normalise partition exactly.
    proxy_clip_indices: set[int] = set()
    norm_clip_indices:  list[int] = []

    for i, cm in enumerate(pipeline_clips):
        use_proxy, _pwsl, reason = decide_clip_source(cm, output_resolution, target_fps_int)
        if use_proxy:
            proxy_clip_indices.add(i)
            log.info("[C-proxy] clip %d: %s", i, reason)
        else:
            norm_clip_indices.append(i)
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
            report_stage(f"Preparing clip {done} of {total}")
            report(10 + int(done / total * 40))  # 10% -> 50%

        normed = normalise(
            norm_src, tmp, mode=mode,
            on_clip_done=_normalise_progress,
            output_resolution=output_resolution,
            target_fps=target_fps_raw,
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

    # 3. Zoom (per-clip, before transitions). Static crop-in or gradual Ken
    # Burns -- both are single-pass and fast (see pipeline/zoom.py); the old
    # zoompan path is gone. Skipped in draft mode to keep previews quick.
    # Per-clip zoom_mode from the Arrange screen takes precedence over global config.zoom.
    report_stage("zoom")
    report(55)
    t_zoom = time.time()
    zoom_cache_hits = 0
    zoom_proxy_input = 0  # overwritten after pool if zoom runs; safe when zoom is skipped
    # "none" (the DB default string) is truthy in Python but means no zoom.
    # Only count clips with an actual zoom mode as having per-clip zoom.
    has_per_clip_zoom = any(
        c.get("zoom_mode") and c.get("zoom_mode") != "none"
        for c in pipeline_clips
    )
    global_zoom = config.get("zoom", False) and mode == "final"

    if has_per_clip_zoom or global_zoom:
        log.info("[render] Step 3: zoom (per_clip=%s, global=%s)", has_per_clip_zoom, global_zoom)

        zoom_cache_dir = _resolve_zoom_cache_dir()
        zoom_cache_dir.mkdir(parents=True, exist_ok=True)
        log.info("[zoom-cache] dir=%s", zoom_cache_dir)
        _prune_zoom_cache(zoom_cache_dir)

        n = len(current_paths)
        zoomed: list = [None] * n
        zoom_status: list[str] = [""] * n  # "hit" | "invalid" | "miss" | "passthrough"
        zoom_proxy_inputs: list[bool] = [False] * n  # per-index, safe across threads
        # Cap each worker's threads so MAX_PARALLEL_ZOOM concurrent encoders
        # don't oversubscribe cores (mirrors normalise.py).
        threads_per_worker = max(1, (os.cpu_count() or 4) // MAX_PARALLEL_ZOOM)

        def _zoom_worker(i: int, p: Path, clip_meta: dict) -> None:
            clip_zoom = clip_meta.get("zoom_mode")
            # "none" is the DB default string — treat it the same as null (passthrough).
            if clip_zoom and clip_zoom != "none":
                effective_mode = clip_zoom
                fx = clip_meta.get("focal_x")
                fy = clip_meta.get("focal_y")
            elif global_zoom:
                # Legacy global zoom: centre focal, apply_zoom default preset.
                effective_mode = None
                fx = fy = None
            else:
                zoomed[i] = p
                zoom_status[i] = "passthrough"
                return

            # Telemetry: flag zoomed clips whose decode input is a proxy (not a normalise pass).
            if i in proxy_clip_indices:
                zoom_proxy_inputs[i] = True

            # Key on the ORIGINAL clips[i] offsets — see _zoom_cache_key docstring.
            key = _zoom_cache_key(
                clip_paths[i], clips[i].get("in_ms"), clips[i].get("out_ms"),
                effective_mode, fx, fy, output_resolution,
            )
            cache_file = zoom_cache_dir / f"{key}.mp4"

            if cache_file.exists():
                if is_valid_proxy(str(cache_file)):
                    zoomed[i] = cache_file
                    zoom_status[i] = "hit"
                    log.info("[zoom-cache] clip %d: HIT %s", i, key)
                    zoom_coord_log("render", "hit", key, i, output_resolution)
                    return
                log.info("[zoom-cache] clip %d: INVALID (re-encoding) %s", i, key)
                try:
                    cache_file.unlink()
                except OSError:
                    pass
                zoom_status[i] = "invalid"
            else:
                log.info("[zoom-cache] clip %d: MISS %s", i, key)
                zoom_coord_log("render", "miss", key, i, output_resolution)
                zoom_status[i] = "miss"

            # Coordinate with warm_zoom.py: acquire the per-key lock before encoding.
            # If the warm already holds the lock and publishes while we wait, we get
            # "served" and count it as a hit -- no double-encode. If we get "own", we
            # are the exclusive encoder for this key.
            lock_path = zoom_cache_dir / f"{key}.lock"
            lock_result = acquire_or_wait(zoom_cache_dir, key, timeout_s=300)
            if lock_result == "served":
                # Warm (or another render worker) already published this key.
                zoomed[i] = cache_file
                zoom_status[i] = "hit"
                log.info("[zoom-cache] clip %d: SERVED by warm %s", i, key)
                zoom_coord_log("render", "served", key, i, output_resolution)
                return

            # Encode to a temp file colocated in the cache dir, then publish via
            # os.replace() — an atomic rename on the same filesystem, so a
            # concurrent warm job never reads a half-written file.
            tmp_cache = zoom_cache_dir / f"{key}.tmp.{os.getpid()}.{i}.mp4"
            zoom_coord_log("render", "encode_start", key, i, output_resolution)
            try:
                apply_zoom(
                    p, tmp_cache,
                    focal_x=fx, focal_y=fy,
                    zoom_mode=effective_mode,
                    threads=threads_per_worker,
                )
                os.replace(tmp_cache, cache_file)
                zoom_coord_log("render", "publish", key, i, output_resolution)
                zoomed[i] = cache_file
            finally:
                release_lock(lock_path)

        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ZOOM) as pool:
            futures = [pool.submit(_zoom_worker, i, p, cm)
                       for i, (p, cm) in enumerate(zip(current_paths, pipeline_clips))]
            for f in futures:
                f.result()  # re-raise any worker exception

        current_paths = zoomed
        zoom_cache_hits = sum(1 for s in zoom_status if s == "hit")
        zoom_cache_invalid = sum(1 for s in zoom_status if s == "invalid")
        zoom_cache_miss = sum(1 for s in zoom_status if s == "miss")
        zoom_proxy_input = sum(zoom_proxy_inputs)
        log.info("[zoom-cache] %d hits / %d invalid / %d misses",
                 zoom_cache_hits, zoom_cache_invalid, zoom_cache_miss)
    else:
        log.info("[render] Step 3: zoom skipped (mode=%s)", mode)
    zoom_s = time.time() - t_zoom
    print(f"TIMING:zoom={zoom_s:.1f}s", flush=True)

    # Per-clip audio volume multipliers (Batch J) — aligned 1:1 with current_paths.
    # pipeline_clips is still 1:1 with current_paths here (trim/zoom preserve length+order).
    # Cards prepended/appended below get volume 1.0 (they carry no audio anyway).
    # Use explicit None-check — `or 1.0` would silently coerce 0.0 (mute) to 1.0 because
    # 0.0 is falsy in Python. A muted clip (volume=0.0) must stay 0.0, not become 1.0.
    clip_volumes = [
        float(v) if v is not None else 1.0
        for cm in pipeline_clips
        for v in (cm.get("clip_volume"),)
    ]

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
            subtitle=config.get("intro_subtitle", ""),
            target_fps=target_fps_raw,
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
            target_fps=target_fps_raw,
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

    scale_h = "480" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    log.info("[B1] render scale_h=%s (output_resolution=%s)", scale_h, output_resolution)

    # Batch Q: resolve encoder once for both paths (single-clip + multi-clip).
    win_ffmpeg = config.get("win_ffmpeg_path", "")
    use_amf = bool(config.get("use_amf", False))
    bin_argv, codec_args, is_amf = video_encoder_args(mode, output_resolution, win_ffmpeg, use_amf=use_amf)
    log.info("[Q] encoder=%s is_amf=%s", codec_args[1] if len(codec_args) > 1 else "?", is_amf)

    # Batch R Part C: surface silent fallback to the UI. Set when the user asked
    # for AMF (Fast render toggle / RUSHCUT_USE_AMF) but we ended up on libx264 --
    # either detect-time (encoder list / probe failed) or runtime (encode error,
    # libx264 retry below). Reported via ANALYSIS amf_fallback=1 -> toast in Render.tsx.
    amf_fallback_flag = [use_amf and not is_amf]

    # Contention warning: if any clip still lacks a proxy, bg gen may be running.
    if is_amf and any(c.get("proxy_status") != "done" for c in clips):
        log.warning("[encoder] WARNING: background proxy gen may be running -- AMF throughput may be reduced")

    def _run_with_amf_fallback(cmd: list, fallback_cmd_fn) -> None:
        """Run cmd; on AMF failure rebuild with libx264 and retry once."""
        try:
            ffmpeg_run(cmd)
        except RuntimeError as e:
            if is_amf:
                log.warning(
                    "[encoder] *** AMF FALLBACK (#64) *** AMF_FALLBACK=1 encode failed "
                    "-- retrying on libx264 (slow CPU encode + mixed-encoder concat risk): %s",
                    e,
                )
                amf_fallback_flag[0] = True
                ffmpeg_run(fallback_cmd_fn())
            else:
                raise

    if len(current_paths) == 1:
        # Single-clip shortcut: no filter_complex needed (CLAUDE.md).
        log.info("[render] Single clip -- using simple -vf scale")
        in_arg  = to_win_path(current_paths[0]) if is_amf else str(current_paths[0])
        out_arg = to_win_path(output)           if is_amf else str(output)

        # Per-clip volume multiplier (Batch J). volume=0 is valid — produces silence.
        # loudnorm fuses into -af when final mode + music off (with music it
        # fuses into the step 6 encode instead) — no separate pass either way.
        af_parts = []
        if audio_flags[0]:
            vol0 = clip_volumes[0] if clip_volumes else 1.0
            if abs(vol0 - 1.0) > 1e-6:
                af_parts.append(f"volume={vol0:.4f}")
                log.info("[J] single-clip volume=%.4f", vol0)
            if mode != "draft" and not music_on:
                af_parts.append(loudnorm_filter())

        def _build_single(b_argv, c_args, i_arg, o_arg, has_aud, af_p):
            c = b_argv + ["-y", "-i", i_arg, "-vf", f"scale=-2:{scale_h},format=yuv420p"] + c_args
            if has_aud:
                if af_p:
                    c += ["-af", ",".join(af_p)]
                c += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
            c.append(o_arg)
            return c

        cmd = _build_single(bin_argv, codec_args, in_arg, out_arg, audio_flags[0], af_parts)
        log.info("[render] single-clip cmd: %s", " ".join(cmd))

        def _fallback_single():
            fb_argv, fb_codec, _ = video_encoder_args(mode, output_resolution, win_ffmpeg, force_libx264=True)
            return _build_single(fb_argv, fb_codec, str(current_paths[0]), str(output), audio_flags[0], af_parts)

        _run_with_amf_fallback(cmd, _fallback_single)
    else:
        log.info("[J] clip_volumes=%s", clip_volumes)
        transition = config.get("transition", "none")
        shuffle_between = config.get("shuffle_between", False)
        opening_transition = config.get("opening_transition", "none")
        closing_transition = config.get("closing_transition", "none")
        has_open = opening_transition != "none"
        has_close = closing_transition != "none"
        has_xfade = (transition != "none") or shuffle_between

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

        def _render_segmented() -> None:
            seg_job_id = job.get("id") or job_id
            seg_tmp = _resolve_render_work_dir(seg_job_id)
            seg_tmp.mkdir(parents=True, exist_ok=True)
            log.info("[U1g] segment work dir: %s", seg_tmp)
            xf = clamp_xfade_dur(durations)
            per_cut_names = resolve_cut_names(
                len(current_paths), transition, shuffle_between, seg_job_id
            )
            # May raise ValueError if a boundary clip has no solo region.
            plan, total = plan_video_batches(durations, batch_size=BATCH_SIZE, xfade_dur=xf)
            progress["total"] = len(plan)
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
                vfc, v_out_b = build_batch_video_fc(bdurs, bnames, mode, output_resolution, xf)

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
                    "[U1g] batch %d/%d clips %s start=%.3f frames=%d (global [%.3f,%.3f])",
                    bi + 1, len(plan), idxs, start, n_frames, g_start, g_end,
                )
                _run_with_amf_fallback(cmd, _fb_batch)
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

            # Concat the segments (all identical codec/params) -> video_full.
            concat_list = seg_tmp / "u1g_concat.txt"
            concat_list.write_text("".join(f"file '{s}'\n" for s in seg_files))
            video_full = seg_tmp / "u1g_video_full.mp4"
            ffmpeg_run([
                FFMPEG, "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_list), "-c", "copy", str(video_full),
            ])

            # Single-pass audio over ALL clips (cheap; no 4K frame buffers).
            # Loudnorm fuses here only when music is off (mirrors monolithic).
            ln = loudnorm_filter() if (mode != "draft" and not music_on) else None
            afc, a_out_lbl = build_audio_only_fc(durations, audio_flags, clip_volumes, xf, ln)

            # Issue #31: when open/close-to-black is enabled, mux to an inner
            # intermediate first, then wrap it with the open/close xfade in a
            # memory-light post-pass below. Otherwise mux straight to output.
            needs_open_close = has_open or has_close
            mux_target = (seg_tmp / "u1g_inner.mp4") if needs_open_close else output

            if a_out_lbl:
                audio_full = seg_tmp / "u1g_audio_full.m4a"
                in_args = [a for p in current_paths for a in ("-i", str(p))]
                ffmpeg_run(
                    [FFMPEG, "-y"] + in_args
                    + ["-filter_complex", afc, "-map", a_out_lbl, "-vn",
                       "-c:a", "aac", "-b:a", "128k", "-ar", "48000", str(audio_full)]
                )
                # Mux video + audio -> inner/output. Two linear streams,
                # zero muxing queue. Step 6 (music) consumes this exactly as before.
                ffmpeg_run([
                    FFMPEG, "-y", "-i", str(video_full), "-i", str(audio_full),
                    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", str(mux_target),
                ])
            else:
                ffmpeg_run([FFMPEG, "-y", "-i", str(video_full), "-c", "copy", str(mux_target)])

            if needs_open_close:
                _apply_open_close_post(mux_target, output, bool(a_out_lbl), xf, fps_f)

        def _apply_open_close_post(
            inner: Path, out: Path, inner_has_audio: bool,
            xfade_dur: float, fps_f: float,
        ) -> None:
            # Issue #31: fade the (already concatenated) inner content in from /
            # out to black in one extra pass. Memory-light: 1 decoder + 1 encoder +
            # xfade ring buffer -- far under the monolithic peak that crashes (exit 15)
            # on big 4K projects. Mirrors the proven monolithic open/close xfade.
            iw, ih = get_frame_size(inner)
            inner_dur = get_duration(inner)
            pp_fc, pp_vmap, pp_amap = build_open_close_post_fc(
                inner_duration=inner_dur,
                has_audio=inner_has_audio,
                scale_w=str(iw),
                scale_h=str(ih),
                target_fps_raw=target_fps_raw,
                opening_transition=opening_transition,
                closing_transition=closing_transition,
                xfade_dur=xfade_dur,
                clip_tbn_str=_fps_to_tbn(target_fps_raw),
            )

            # Guardrail 2 (issue #31): near-lossless rate control so the second
            # encode generation does not compound compression. Draft keeps its fast
            # args (quality not critical there).
            def _pp_codec(amf: bool) -> list:
                if mode == "draft":
                    _, c, _ = video_encoder_args(
                        mode, output_resolution, win_ffmpeg,
                        force_libx264=not amf, use_amf=use_amf,
                    )
                    return c
                if amf:
                    return ["-c:v", "h264_amf", "-pix_fmt", "yuv420p", "-profile:v", "main",
                            "-rc", "vbr_peak", "-b:v", "40M", "-maxrate", "40M",
                            "-bufsize", "40M", "-quality", "quality"]
                return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "main",
                        "-crf", "16", "-preset", "medium"]

            def _build_pp(b_argv, c_args, amf):
                i_arg = to_win_path(inner) if amf else str(inner)
                o_arg = to_win_path(out) if amf else str(out)
                # Guardrail 1: NO -frames:v cap -- the filter graph defines length.
                cmd = b_argv + ["-y", "-i", i_arg, "-filter_complex", pp_fc,
                                "-map", pp_vmap, "-r", target_fps_raw]
                if pp_amap:
                    cmd += ["-map", pp_amap]
                cmd += c_args
                if pp_amap:
                    cmd += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
                cmd.append(o_arg)
                return cmd

            log.info(
                "[U1g] open/close post-pass: open=%s close=%s inner_dur=%.3fs size=%dx%d",
                opening_transition, closing_transition, inner_dur, iw, ih,
            )
            pp_cmd = _build_pp(bin_argv, _pp_codec(is_amf), is_amf)

            def _pp_fallback():
                fb_argv, _, _ = video_encoder_args(
                    mode, output_resolution, win_ffmpeg, force_libx264=True
                )
                return _build_pp(fb_argv, _pp_codec(False), False)

            _run_with_amf_fallback(pp_cmd, _pp_fallback)

            # Guardrail 1: ffprobe-validate the output length against the inner +
            # open/close delta (+/-1 frame). The only guard against silent duration
            # drift if a future FFmpeg/encoder change diverges from the graph length.
            inner_frames = _probe_frame_count(inner)
            out_frames = _probe_frame_count(out)
            delta_expected = (round(0.1 * fps_f) if has_open else 0) + \
                             (round(0.1 * fps_f) if has_close else 0)
            expected_frames = inner_frames + delta_expected
            drift_frames = abs(out_frames - expected_frames)
            log.info(
                "[U1g] post-pass open/close frames=%d inner=%d expected=%d drift=%d frame(s)",
                out_frames, inner_frames, expected_frames, drift_frames,
            )
            if drift_frames > 1:
                raise RuntimeError(
                    f"[U1g] post-pass open/close drift {drift_frames} frames -- sync risk"
                )

        # Issue #31: open/close-to-black no longer forces the monolithic fallback --
        # the inner content renders segmented and the open/close fade is applied as a
        # memory-light post-pass (_apply_open_close_post).
        use_batched = len(current_paths) > BATCH_SIZE and has_xfade
        did_batched = False
        if use_batched:
            try:
                _render_segmented()
                did_batched = True
                log.info(
                    "[U1g] segmented render complete (no fallback) batches=%s clips_total=%s mem_avail_mb=%s",
                    progress["total"], len(current_paths), _mem_available_mb(),
                )
            except Exception as e:  # noqa: BLE001 -- fall back to monolithic on any planner/encode failure
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
                seed=job.get("id"),
                opening_transition=opening_transition,
                closing_transition=closing_transition,
                target_fps_raw=target_fps_raw,
                clip_tbn_str=_fps_to_tbn(target_fps_raw),
            )
            a_map = a_out
            if a_out and mode != "draft" and not music_on:
                fc += f"; {a_out}{loudnorm_filter()}[aloud]"
                a_map = "[aloud]"
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

            _run_with_amf_fallback(cmd, _fallback_multi)

    encoder_name = codec_args[1] if len(codec_args) > 1 else "libx264"
    render_s = time.time() - t0
    print(f"TIMING:render={render_s:.1f}s encoder={encoder_name}", flush=True)

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
        music_loop = bool(config.get("music_loop", True))
        log.info("[vol] music_fade_out_s=%.1f loop=%s", fade_out_s, music_loop)
        # #62: time music to the REAL rendered duration, not the naive sum(durations).
        # The render telescopes every transition by xfade_dur, so sum(durations) over-runs
        # the actual file by ~(n-1)*1.5s; probing the just-rendered file is ground truth
        # (covers transitions, open/close-to-black, and intro/outro cards uniformly).
        rendered_dur = get_duration(output)
        log.info("[music] timing music to rendered=%.4fs (naive sum=%.4fs)", rendered_dur, sum(durations))
        output = mix_music(output, rendered_dur, music_filename, MUSIC_DIR, music_out,
                           music_volume=music_volume, movie_vol=movie_vol,
                           custom_track_path=custom_music_path_wsl,
                           fade_out_s=fade_out_s,
                           loop=music_loop,
                           apply_loudnorm=(mode != "draft"))
    else:
        log.info("[render] Step 6: music skipped")
    music_s = time.time() - t0
    print(f"TIMING:music={music_s:.1f}s", flush=True)

    # 7. Loudnorm — fused into the Step 5 (music-off) / Step 6 (music-on) encode.
    # No separate pass; single-pass loudnorm rides the encode that already runs.
    report(88)
    loudnorm_s = 0.0
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
            f",zoom_cache_hits={zoom_cache_hits}"
            f",zoom_proxy_input={zoom_proxy_input}"
            f",per_clip_zoom_clips={sum(1 for c in pipeline_clips if c.get('zoom_mode') and c.get('zoom_mode') != 'none')}"
            f",encoder={encoder_name}"
            f",amf_fallback={1 if amf_fallback_flag[0] else 0}"
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
