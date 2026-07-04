"""
pipeline/render_cache.py -- DaVinci-style render cache (#19 / Batch V4.1).

Caches the "clean merged intermediate": the fully rendered timeline
(video + transitions + zoom + cards + clean clip audio) BEFORE music and
loudnorm are applied. A re-render that changes only music/audio settings
re-applies that cheap layer on top of the cache instead of re-encoding the
whole timeline.

The cache is keyed by signature() over every input that affects the
intermediate (clip trim/order/zoom/volume, transitions, cards, resolution,
fps). Music settings (mood/volume/custom track/fade/loop) are deliberately
NOT part of the signature -- they are the cheap layer applied on top.

Python-only proof (Batch V4.1): the cache dir is self-derived here; there is
no Rust manifest wiring or DB column yet. prune() bounds the dir because no
Rust vacuum backstop exists during the proof period.
"""

import hashlib
import json
import logging
import os
import shutil
import time
from pathlib import Path

from .proxy import is_valid_proxy

log = logging.getLogger(__name__)

# Bump when the intermediate's semantics change (e.g. loudnorm placement or
# canvas math) so stale entries from an older pipeline are never reused.
_CACHE_VER = 1

_PRUNE_KEEP = 20
_PRUNE_MAX_AGE_DAYS = 7


def cache_dir() -> Path:
    """Persistent render-cache dir on NTFS (sibling of proxies/).

    USERPROFILE-derived /mnt/c/... path (mirrors _resolve_render_work_dir in
    render.py) so the os.replace() in write() stays within one filesystem.
    Falls back to /tmp in test envs without USERPROFILE.
    """
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        user = Path(userprofile).name
        d = Path(f"/mnt/c/Users/{user}/AppData/Roaming/rushcut/render-cache")
    else:
        d = Path("/tmp/rushcut-render-cache")
    d.mkdir(parents=True, exist_ok=True)
    return d


def signature(clips, config, output_resolution, mode, target_fps_raw) -> str:
    """Stable hex signature of every input that affects the clean intermediate.

    MUST be called with the ORIGINAL manifest `clips` (absolute in_ms/out_ms),
    NEVER the B-0-mutated pipeline_clips -- hashing pretrim-relative offsets
    would drift the signature between otherwise-identical renders so the cache
    never hits.

    Music settings are intentionally excluded (the cheap layer). Encoder choice
    (use_amf) is also excluded: a cached intermediate is a valid video whatever
    encoder produced it, so a re-render with a different encoder can still reuse
    it.
    """
    def _num(v):
        # None stays None; numeric values round so 0/0.0 and float jitter hash stably.
        return None if v is None else round(float(v), 6)

    clip_sig = [
        {
            "path": (c.get("local_path") or "").lower(),
            "in_ms": c.get("in_ms"),
            "out_ms": c.get("out_ms"),
            "zoom_mode": c.get("zoom_mode") or "none",
            "focal_x": _num(c.get("focal_x")),
            "focal_y": _num(c.get("focal_y")),
            "clip_volume": _num(c.get("clip_volume")),
        }
        for c in clips
    ]
    payload = {
        "ver": _CACHE_VER,
        "mode": mode,
        "resolution": output_resolution,
        "fps": str(target_fps_raw),
        "transition": config.get("transition", "none"),
        "opening_transition": config.get("opening_transition", "none"),
        "closing_transition": config.get("closing_transition", "none"),
        "shuffle_between": bool(config.get("shuffle_between", False)),
        "silence_removal": bool(config.get("silence_removal", False)),
        "zoom": bool(config.get("zoom", False)),
        "intro_text": config.get("intro_text", "") or "",
        "intro_subtitle": config.get("intro_subtitle", "") or "",
        "intro_color": config.get("intro_color", "#000000"),
        "outro_text": config.get("outro_text", "") or "",
        "outro_color": config.get("outro_color", "#000000"),
        "clips": clip_sig,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def cache_path(sig: str) -> Path:
    return cache_dir() / f"{sig}.mp4"


def is_valid(path: Path) -> bool:
    """True if the cache file exists and is a complete MP4 (moov atom present).

    Path.exists() alone is insufficient -- a file killed mid-write has no moov
    atom and is unplayable, so delegate the real check to is_valid_proxy (the
    same ffprobe -show_format gate proxies use).
    """
    return path.exists() and is_valid_proxy(str(path))


def write(clean_output: Path, sig: str) -> Path:
    """Atomically publish the clean intermediate into the cache; return its path.

    The .tmp is written INSIDE the cache dir so os.replace() stays within one
    filesystem. clean_output lives in tmpfs (/tmp) or the NTFS work dir; a
    shutil.move()/os.rename() from there across to /mnt/c/ would raise
    OSError: Invalid cross-device link. shutil.copy2 (a real copy) is safe
    across filesystems; the atomic swap is the in-dir os.replace().

    On any failure the cache is simply not populated -- returns clean_output so
    the caller proceeds normally.
    """
    dst = cache_path(sig)
    tmp = dst.with_suffix(".tmp.mp4")
    try:
        shutil.copy2(str(clean_output), str(tmp))   # copy: safe across filesystems
        os.replace(str(tmp), str(dst))              # atomic: same NTFS dir
        log.info("[cache] wrote %s (%.1f MB)", dst.name, dst.stat().st_size / 1048576)
    except Exception as e:
        log.warning("[cache] write failed for %s: %s", sig, e)
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        return clean_output
    prune(skip=dst.name)
    return dst


def prune(keep: int = _PRUNE_KEEP, max_age_days: int = _PRUNE_MAX_AGE_DAYS,
          skip: "str | None" = None) -> None:
    """Bound the cache dir. Runs on every write (no Rust vacuum backstop yet).

    Two combined bounds: delete entries older than max_age_days, then if still
    over `keep`, drop oldest-mtime first. Never raises (a file locked by a
    concurrent render must not crash the prune), never deletes the just-written
    `skip` file, and ignores in-flight .tmp files from other renders.
    """
    try:
        d = cache_dir()
        entries = []
        for p in d.glob("*.mp4"):
            if ".tmp." in p.name:       # in-flight write from another render
                continue
            if skip and p.name == skip:
                continue
            try:
                entries.append((p, p.stat().st_mtime))
            except Exception:
                continue
    except Exception:
        return

    cutoff = time.time() - max_age_days * 86400
    survivors = []
    for p, mtime in entries:
        if mtime < cutoff:
            _safe_unlink(p)
        else:
            survivors.append((p, mtime))

    if len(survivors) > keep:
        survivors.sort(key=lambda t: t[1])  # oldest first
        for p, _ in survivors[: len(survivors) - keep]:
            _safe_unlink(p)


def _safe_unlink(p: Path) -> None:
    try:
        p.unlink()
        log.info("[cache] pruned %s", p.name)
    except Exception as e:
        log.info("[cache] prune skip %s (%s)", p.name, e)
