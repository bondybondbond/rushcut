#!/usr/bin/env python3
"""
pipeline/warm_zoom.py -- Background zoom cache warmer.

CLI (invoked by Rust warm_zoom_cache_cmd at NORMAL priority -- #50):
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/warm_zoom.py \\
      --manifest-path <wsl_path>

Manifest JSON (written by Rust warm_zoom_cache_cmd):
  {
    "job_id": "warm-<uuid>",
    "clips": [
      {
        "local_path": "C:\\\\path\\\\to\\\\source.mp4",
        "proxy_path": "C:\\\\path\\\\to\\\\proxy.mp4",  // null if not ready
        "in_ms": 1000,       // null if no user trim
        "out_ms": 6000,      // null if no user trim
        "focal_x": 0.5,
        "focal_y": 0.5,
        "zoom_mode": "kb_in_2.0_fast"  // clips with null/"none" are skipped
      }
    ]
  }

For each clip with a real zoom_mode, reproduces the render's per-clip prep chain
(proxy-substitute or pretrim+normalise+trim) then runs apply_zoom, publishing
atomically to the zoom cache. Entries already in the cache are skipped.

Resolution scope: warms BOTH "1080p" and "4k" -- different cache keys, same video
content (zoom operates at source resolution via the proxy). Guarantees a cache HIT
regardless of which resolution the user chooses at render time.

Parallel clip processing: ThreadPoolExecutor(max_workers=2). Two concurrent FFmpeg
encodes run simultaneously so warm time drops from sum(all encodes) to roughly
max(longest pair). Conservative 2-worker cap keeps background warm from starving a
concurrent render or UI. Raise to 4 only once logs confirm stable timing (#50 phase 2).
"""

import argparse
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)


def win_to_wsl(path: str) -> str:
    p = path.replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        rest = p[2:].lstrip("/")
        return f"/mnt/{drive}/{rest}"
    return p


# TODO: keep in sync with Render-screen resolution options -- a new resolution
# added to the UI must be added here or warm entries will be silently absent.
WARM_RESOLUTIONS = ["1080p", "4k"]

TMP_BASE = Path("/tmp")


def _warm_one(
    clip_idx: int,
    src_path: Path,
    clip_meta: dict,
    zoom_mode: str,
    focal_x,
    focal_y,
    resolution: str,
    cache_dir: Path,
    tmp: Path,
    target_fps_raw: str,
    target_fps_int: int,
) -> str:
    """Warm one clip at one resolution. Returns 'hit', 'encoded', or 'error'."""
    # Absolute imports (not relative): warm_zoom.py is invoked as a direct script
    # (`python3 .../warm_zoom.py`), so __package__ is empty and `from .render` fails
    # with "attempted relative import with no known parent package". main() inserts the
    # parent of pipeline/ into sys.path before this runs, so `from pipeline.x` resolves.
    from pipeline.render import (
        _zoom_cache_key,
        decide_clip_source,
        pretrim_one_clip,
        zoom_coord_log,
    )
    from pipeline.proxy import is_valid_proxy
    from pipeline.normalise import normalise
    from pipeline.trim import trim
    from pipeline.zoom import apply_zoom
    from pipeline.utils import get_duration
    from pipeline.zoom_cache import acquire_or_wait, release_lock

    orig_in_ms = clip_meta.get("in_ms")
    orig_out_ms = clip_meta.get("out_ms")

    key = _zoom_cache_key(src_path, orig_in_ms, orig_out_ms, zoom_mode, focal_x, focal_y, resolution)
    cache_file = cache_dir / f"{key}.mp4"
    zoom_coord_log("warm", "start", key, clip_idx, resolution)

    # Coordinate with render.py _zoom_worker via per-key filesystem lock so the two
    # processes never double-encode the same key. acquire_or_wait() returns:
    #   "served" -> render already published it (or it was already cached) -- skip.
    #   "own"    -> we hold the lock; encode and publish, then release.
    lock_path = cache_dir / f"{key}.lock"
    lock_result = acquire_or_wait(cache_dir, key, timeout_s=300)
    if lock_result == "served":
        log.info("[warm-zoom] clip %d @ %s: HIT (served by render) key=%s", clip_idx, resolution, key[:16])
        zoom_coord_log("warm", "served", key, clip_idx, resolution)
        return "hit"

    use_proxy, proxy_wsl, reason = decide_clip_source(clip_meta, resolution, target_fps_int)
    log.info("[warm-zoom] clip %d @ %s: %s", clip_idx, resolution, reason)

    tmp_cache = cache_dir / f"{key}.tmp.{os.getpid()}.{clip_idx}.{resolution}.mp4"

    try:
        if use_proxy:
            prepped = Path(proxy_wsl)
            in_ms = clip_meta.get("in_ms")
            out_ms = clip_meta.get("out_ms")
            if in_ms is not None or out_ms is not None:
                dur = get_duration(prepped)
                start = (in_ms / 1000.0) if in_ms is not None else 0.0
                end = (out_ms / 1000.0) if out_ms is not None else dur
                trim_out = tmp / f"warm_trim_{clip_idx}_{resolution}.mp4"
                prepped = trim(prepped, start, end, trim_out)
        else:
            pretrimmed, adjusted_cm = pretrim_one_clip(clip_idx, src_path, clip_meta, tmp)
            normed_list = normalise(
                [pretrimmed], tmp,
                mode="final",
                output_resolution=resolution,
                target_fps=target_fps_raw,
            )
            normed = normed_list[0]
            adj_in = adjusted_cm.get("in_ms")
            adj_out = adjusted_cm.get("out_ms")
            if adj_in is not None or adj_out is not None:
                dur = get_duration(normed)
                start = (adj_in / 1000.0) if adj_in is not None else 0.0
                end = (adj_out / 1000.0) if adj_out is not None else dur
                trim_out = tmp / f"warm_ntrim_{clip_idx}_{resolution}.mp4"
                prepped = trim(normed, start, end, trim_out)
            else:
                prepped = normed

        zoom_coord_log("warm", "encode_start", key, clip_idx, resolution)
        apply_zoom(prepped, tmp_cache, focal_x=focal_x, focal_y=focal_y, zoom_mode=zoom_mode)
        os.replace(tmp_cache, cache_file)
        zoom_coord_log("warm", "publish", key, clip_idx, resolution)
        log.info("[warm-zoom] clip %d @ %s: ENCODED key=%s", clip_idx, resolution, key[:16])
        release_lock(lock_path)
        return "encoded"

    except Exception as exc:
        log.error("[warm-zoom] clip %d @ %s: ERROR %s", clip_idx, resolution, exc)
        try:
            tmp_cache.unlink(missing_ok=True)
        except OSError:
            pass
        release_lock(lock_path)
        return "error"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-path", required=True, help="WSL path to warm-zoom manifest JSON")
    args = parser.parse_args()

    manifest_path = Path(args.manifest_path)
    if not manifest_path.exists():
        log.error("[warm-zoom] manifest not found: %s", manifest_path)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    job_id = manifest.get("job_id", "warm-unknown")

    os.environ["RUSHCUT_ZOOM_CACHE_DIR"] = str(manifest_path.parent / "zoom-cache")

    sys.path.insert(0, str(Path(__file__).parent.parent))

    from pipeline.render import _probe_fps, round_to_standard_fps

    clips_raw = manifest.get("clips", [])

    # Enrich with WSL proxy path (same as run.py)
    for c in clips_raw:
        c["proxy_path_wsl"] = win_to_wsl(c["proxy_path"]) if c.get("proxy_path") else None

    # Filter to clips with a real zoom_mode
    zoom_clips = [
        (i, c) for i, c in enumerate(clips_raw)
        if c.get("zoom_mode") and c.get("zoom_mode") != "none"
    ]

    if not zoom_clips:
        log.info("[warm-zoom] job=%s: no zoom clips -- nothing to warm", job_id)
        return

    log.info("[warm-zoom] job=%s: warming %d zoom clip(s) x %d resolution(s)",
             job_id, len(zoom_clips), len(WARM_RESOLUTIONS))

    # Probe FPS from first source clip (mirrors render.py Step 1)
    first_src = Path(win_to_wsl(zoom_clips[0][1]["local_path"]))
    target_fps_raw = _probe_fps(first_src)
    target_fps_int = round_to_standard_fps(target_fps_raw)
    log.info("[warm-zoom] target_fps=%d (from %s)", target_fps_int, first_src.name)

    from pipeline.render import _resolve_zoom_cache_dir

    cache_dir = _resolve_zoom_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    log.info("[warm-zoom] cache dir: %s", cache_dir)

    tmp = TMP_BASE / job_id
    tmp.mkdir(parents=True, exist_ok=True)

    # Flatten (clip_idx, clip, resolution) into a single work queue so all pairs
    # can be dispatched in one executor pass. Temp file names include clip_idx and
    # resolution so concurrent workers never collide on the same tmp path.
    work_items = [
        (clip_idx, clip, resolution)
        for clip_idx, clip in zoom_clips
        for resolution in WARM_RESOLUTIONS
    ]

    hits = encoded = errors = 0

    # max_workers=2: conservative cap. Two concurrent FFmpeg libx264 encodes at NORMAL
    # priority sit comfortably on this machine without starving a concurrent render.
    # Raise to 4 only after confirming stable timing under load (#50 phase 2).
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {
            executor.submit(
                _warm_one,
                clip_idx=clip_idx,
                src_path=Path(win_to_wsl(clip["local_path"])),
                clip_meta=clip,
                zoom_mode=clip["zoom_mode"],
                focal_x=clip.get("focal_x"),
                focal_y=clip.get("focal_y"),
                resolution=resolution,
                cache_dir=cache_dir,
                tmp=tmp,
                target_fps_raw=target_fps_raw,
                target_fps_int=target_fps_int,
            ): (clip_idx, resolution)
            for clip_idx, clip, resolution in work_items
        }
        for future in as_completed(futures):
            result = future.result()
            if result == "hit":
                hits += 1
            elif result == "encoded":
                encoded += 1
            else:
                errors += 1

    log.info("[warm-zoom] done: %d hits / %d encoded / %d errors", hits, encoded, errors)


if __name__ == "__main__":
    main()
