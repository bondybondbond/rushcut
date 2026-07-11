"""
pipeline/render.py -- Orchestrator: runs the full pipeline for a job.

Pipeline order:
  1.  normalise      -> H.264/yuv420p/25fps/1080p/AAC
  2.  silence trim   -> (if config.silence_removal) trim silence from clip edges
  3.  zoom           -> (if config.zoom, final mode only)
  4.  cards          -> prepend intro, append outro (if text provided)
  5.  render         -> filter_complex xfade + scale, or single-clip shortcut
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
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import subprocess

from .cards import make_card
from .detect import detect_trim_points
from .encoder import (
    to_win_path, video_encoder_args,
    FINAL_BITRATE_4K, AMF_MAXRATE_4K,
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
from .trim import trim  # trim_smart() (#104) built but NOT wired in -- real measurement
                          # showed a net regression under production contention, see
                          # issue #104 comment. Left in pipeline/trim.py for reference.
from .utils import FFMPEG, ffmpeg_run, ffprobe_json, get_duration, get_frame_size, has_audio, log_av_sync
from .zoom import build_zoom_vf

log = logging.getLogger(__name__)

# Step 2 trim parallelism (#99) — same cap/formula as normalise.py's MAX_PARALLEL_NORMALISE.
MAX_PARALLEL_TRIM = min(4, os.cpu_count() or 1)


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
    clip_meta: dict, output_resolution: str, target_fps_int: int
) -> tuple[bool, str | None, str]:
    """Decide whether a clip's proxy can substitute for normalise.

    Returns (use_proxy, proxy_path_wsl, reason). A proxy qualifies only when it is
    valid, tall enough for the output resolution (>=1080p for 1080p, >=2160p for 4K),
    AND its fps matches the render target. See pipeline.md "Proxy reuse gate".
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

    def _apply_audio_treatment(clean: Path) -> Path:
        """V4.1: apply music + loudnorm on top of the clean intermediate.

        The cheap, music-agnostic layer that runs on BOTH a fresh render and a
        render-cache hit. Loudnorm is applied exactly once (never doubled):
          - music on  -> loudnorm fuses into the mix_music encode
          - music off -> a dedicated -c:v copy audio-only loudnorm pass (fast)
          - draft / no audio -> passthrough (no loudnorm)
        Emits the TIMING:music line so both paths report consistently.
        """
        report_stage("Mixing music")
        report(80)
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
        return out

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
        report_stage("Preparing clips")
        report(72)
        # Copy the cached clean intermediate into the job tmp dir, then apply the
        # cheap music/loudnorm layer on top -- Steps 1-5 are skipped entirely.
        # #86: output lives on NTFS render_work (AMF write target consistency).
        output = render_work / "render.mp4"
        shutil.copy2(str(cache_file), str(output))  # /mnt/c -> tmpfs copy is safe
        output = _apply_audio_treatment(output)
        report(95)
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

            def _trim_worker(i: int, p, start: float, end: float) -> None:
                out = tmp / f"trim_{i}.mp4"
                trimmed[i] = trim(p, start, end, out, threads=threads_per_worker)

            with ThreadPoolExecutor(max_workers=MAX_PARALLEL_TRIM) as pool:
                futures = [pool.submit(_trim_worker, i, p, start, end) for i, p, start, end in jobs]
                for f in futures:
                    f.result()  # re-raise any worker exception immediately (no swallowing)

        current_paths = trimmed
    else:
        log.info("[render] Step 2: trim skipped")

    trim_s = time.time() - t0
    print(f"TIMING:trim={trim_s:.1f}s", flush=True)
    for i, p in enumerate(current_paths):
        log_av_sync(p, f"post-trim_{i}")

    # 3. Zoom (per-clip, before transitions). Static crop-in or gradual Ken Burns --
    # vf strings injected directly into filter_complex [sv{i}] nodes. No pre-encode
    # step: AMF absorbs scale=eval=frame at hardware speed with zero render-step
    # overhead (#67). Skipped in draft mode to keep previews quick.
    report_stage("zoom")
    report(55)
    t_zoom = time.time()
    zoom_proxy_input = 0
    has_per_clip_zoom = any(
        c.get("zoom_mode") and c.get("zoom_mode") != "none"
        for c in pipeline_clips
    )
    global_zoom = config.get("zoom", False) and mode == "final"

    zoom_vfs: "list[str | None] | None" = None
    if (has_per_clip_zoom or global_zoom) and mode == "final":
        log.info("[render] Step 3: zoom embed -- building per-clip vf strings")
        zoom_vfs = [None] * len(current_paths)
        built = 0
        for i, (p, cm) in enumerate(zip(current_paths, pipeline_clips)):
            cz = cm.get("zoom_mode")
            if cz and cz != "none":
                eff, fx, fy = cz, cm.get("focal_x"), cm.get("focal_y")
            elif global_zoom:
                eff, fx, fy = "gentle", None, None
            else:
                continue
            zoom_vfs[i] = build_zoom_vf(p, eff, fx, fy)
            if zoom_vfs[i]:
                built += 1
        log.info("[zoom-embed] built %d/%d vf strings", built, len(current_paths))
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
        if zoom_vfs is not None:
            zoom_vfs = [None] + zoom_vfs

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
        if zoom_vfs is not None:
            zoom_vfs = zoom_vfs + [None]

    # zoom_vfs must stay 1:1 with current_paths through card insertion (#98) --
    # a length mismatch here silently misapplies zoom to the wrong clip in the
    # monolithic path, or crashes with IndexError in the segmented path.
    assert zoom_vfs is None or len(zoom_vfs) == len(current_paths), (
        f"zoom_vfs/current_paths length mismatch: {len(zoom_vfs)} vs {len(current_paths)}"
    )

    # 5. Build filter_complex + render.
    report_stage("Rendering")
    # CRITICAL: durations must come from current_paths (post-trim), not original clips.
    report(60)
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

    def _run_with_amf_fallback(cmd: list, fallback_cmd_fn) -> bool:
        """Run cmd; on AMF failure rebuild with libx264 and retry once.

        Returns True if this call fell back to libx264, False if it stayed on
        the originally requested encoder. Used by #65 Phase A to build a
        per-batch encoder_outcome_by_idx alongside the existing shared
        amf_fallback_flag (which only tracks "did ANY call fall back").
        """
        try:
            ffmpeg_run(cmd)
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

    if len(current_paths) == 1:
        # Single-clip shortcut: no filter_complex needed (CLAUDE.md).
        log.info("[render] Single clip -- using simple -vf scale")
        in_arg  = to_win_path(current_paths[0]) if is_amf else str(current_paths[0])
        out_arg = to_win_path(output)           if is_amf else str(output)

        # Per-clip volume multiplier (Batch J). volume=0 is valid — produces silence.
        # V4.1: loudnorm is NOT applied here anymore. Step 5 produces the clean,
        # treatment-free intermediate (cacheable); loudnorm is deferred to the
        # final _apply_audio_treatment step so the cache is music-agnostic.
        af_parts = []
        if audio_flags[0]:
            vol0 = clip_volumes[0] if clip_volumes else 1.0
            if abs(vol0 - 1.0) > 1e-6:
                af_parts.append(f"volume={vol0:.4f}")
                log.info("[J] single-clip volume=%.4f", vol0)

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
        # #88: isolate boundary-reencode cost from the bundled t_render_s
        # figure. Declared here (outer scope) so _render_segmented() can
        # mutate it via closure and report_analysis() below can read it
        # regardless of which render path actually ran.
        boundary_reencode_s = [0.0]

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
                    args = ["-c:v", "h264_amf", "-pix_fmt", "yuv420p", "-profile:v", "main",
                            "-rc", "vbr_peak", "-b:v", FINAL_BITRATE_4K, "-maxrate", AMF_MAXRATE_4K,
                            "-bufsize", AMF_MAXRATE_4K, "-quality", "quality"]
                    if output_resolution == "4k":
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
                # total + the per-boundary +0.1s black-source padding. Uses
                # total_frames_expected (the exact planned base, from the
                # segment plan) rather than probing an intermediate file, since
                # there's no single "inner" file in this path.
                out_frames = _probe_frame_count(output)
                oc_delta_expected = (round(0.1 * fps_f) if has_open else 0) + \
                                     (round(0.1 * fps_f) if has_close else 0)
                expected_frames = total_frames_expected + oc_delta_expected
                oc_drift_frames = abs(out_frames - expected_frames)
                log.info(
                    "[U1g] boundary-only open/close frames=%d expected=%d "
                    "(base=%d + oc_delta=%d) drift=%d frame(s)",
                    out_frames, expected_frames, total_frames_expected,
                    oc_delta_expected, oc_drift_frames,
                )
                if oc_drift_frames > 1:
                    raise RuntimeError(
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

            _run_with_amf_fallback(cmd, _fallback_multi)

    encoder_name = codec_args[1] if len(codec_args) > 1 else "libx264"
    render_s = time.time() - t0
    print(f"TIMING:render={render_s:.1f}s encoder={encoder_name}", flush=True)

    # V4.1: Step 5 output is the clean, treatment-free intermediate. Publish it to
    # the render cache (miss path) BEFORE the music/loudnorm layer is applied, so a
    # later re-render that only changes music can reuse it.
    if use_cache:
        render_cache.write(output, cache_sig)

    # 6. Music + loudnorm -- the cheap, cache-on-top layer (shared with cache hit).
    t0 = time.time()
    output = _apply_audio_treatment(output)
    music_s = time.time() - t0

    # 7. Loudnorm is applied exactly once inside _apply_audio_treatment (music on ->
    # mix_music; music off -> dedicated -c:v copy pass). No separate pass here.
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
