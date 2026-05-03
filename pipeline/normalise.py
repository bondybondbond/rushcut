"""
pipeline/normalise.py — Normalise input clips to H.264/yuv420p/25fps CFR/AAC.

Key constraints (from CLAUDE.md):
- -map 0:v:0          : DJI OsmoPocket3 embeds an MJPEG thumbnail as a second video
                         stream — always pin to the first (hevc) stream.
- -map 0:a:0?         : Pin to first audio stream, optional (? = don't fail if absent).
                         NOT -map 0:a? which would map ALL audio streams.
- scale=-2:HEIGHT     : Maintain aspect ratio, even width. 360 for draft, 1080 for final.
- -fps_mode cfr       : Constant frame rate (required for xfade timing).
"""

import logging
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run, log_av_sync

log = logging.getLogger(__name__)

# Max parallel FFmpeg normalise workers. After B-0 pre-trim, input files are in
# WSL2 tmpfs (RAM) so HEVC decode is CPU-bound, not I/O-bound — parallelism helps.
# 4 workers ≈ 4-8 cores used concurrently; safe on 8+ core machines.
MAX_PARALLEL_NORMALISE = min(4, os.cpu_count() or 1)


def normalise(
    clip_paths: list[Path],
    tmp_dir: Path,
    mode: str = "draft",
    on_clip_done: "Callable[[int, int], None] | None" = None,
    output_resolution: str = "1080p",
) -> list[Path]:
    """
    Normalise each clip to H.264/yuv420p/25fps/AAC 128k.
    draft mode: 360p + ultrafast preset (fast Lambda turnaround).
    final mode: 1080p + fast preset (quality output).
    Returns list of normalised clip Paths in tmp_dir (norm_0.mp4, norm_1.mp4, ...).
    """
    # TODO(landscape): add layout param ("portrait" | "landscape_blur" | "landscape_crop")
    # landscape_blur requires -filter_complex (not -vf) because it references [0:v] twice:
    #   [0:v]scale=-2:{h},setsar=1[fg];[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,
    #   crop={w}:{h},boxblur=20:5[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2
    # transitions.py must also receive layout and use scale={w}:{h} (exact) for landscape
    # modes to prevent the -2:height re-scaling from re-introducing portrait dimensions.
    # detect.py: confirm it handles DJI rotation metadata (ffprobe 'rotate' tag) for portrait.
    if mode == "draft":
        scale_filter = "scale=-2:360,format=yuv420p"
        preset = "ultrafast"
    else:
        h = "2160" if output_resolution == "4k" else "1080"
        scale_filter = f"scale=-2:{h},format=yuv420p"
        preset = "ultrafast"  # intermediates — re-encoded by render step, quality irrelevant
        # BATCH-C: keep normalise at 1080p even for 4K output; upscale only in render.py / transitions.py.
        # Intermediates are discarded after the render encode — 4K intermediates save ~0 quality but add
        # ~20-30s encode time per clip. Moot once proxy reuse lands (H.264 proxies bypass HEVC decode
        # entirely, eliminating the real bottleneck). Don't touch until Batch C proxy reuse ships.
        log.info("[B1] normalise scale_h=%s (output_resolution=%s)", h, output_resolution)

    # -hwaccel auto probed 2026-03-30: /dev/dxg present but Vulkan video decode extension
    # not supported; CUDA/VDPAU absent. All hw paths fall back to software. Skip hwaccel.

    total = len(clip_paths)
    norm_paths: list[Path] = [tmp_dir / f"norm_{i}.mp4" for i in range(total)]
    done_count = 0
    lock = threading.Lock()

    def _worker(i: int, src: Path) -> None:
        nonlocal done_count
        out = norm_paths[i]
        log.info("[normalise] %s -> %s (mode=%s)", src.name, out.name, mode)
        # Cap threads per worker so N parallel workers don't oversubscribe.
        # Default: libx264 grabs all nproc (16) threads. With 4 workers:
        # 4 × 16 = 64 threads on 16 cores → thrash. Cap to cores / workers.
        threads_per_worker = max(1, (os.cpu_count() or 4) // MAX_PARALLEL_NORMALISE)
        ffmpeg_run([
            FFMPEG, "-y",
            "-threads", str(threads_per_worker),  # global: caps both HEVC decode + x264 encode
            "-i", str(src),
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-vf", scale_filter,
            "-r", "25",
            "-fps_mode", "cfr",
            "-c:v", "libx264",
            "-preset", preset,
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "48000",
            str(out),
        ])
        log_av_sync(out, f"norm_{i}")
        with lock:
            done_count += 1
            n = done_count
        if on_clip_done:
            on_clip_done(n, total)

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_NORMALISE) as pool:
        futures = [pool.submit(_worker, i, src) for i, src in enumerate(clip_paths)]
        for f in futures:
            f.result()  # re-raise any worker exception

    log.info("[normalise] Done -- %d clips normalised", len(norm_paths))
    return norm_paths
