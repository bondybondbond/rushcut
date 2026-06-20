"""
pipeline/zoom_cache.py -- Cross-process coordination for the zoom cache.

Used by both render.py (_zoom_worker) and warm_zoom.py (_warm_one) so that a
background warm and a foreground render never double-encode the same cache key.

acquire_or_wait() uses O_CREAT|O_EXCL for atomic lock creation (POSIX-safe on
tmpfs/NTFS via WSL). Stale-lock reclaim uses an atomic os.replace() rename --
never a bare unlink -- to avoid the check-then-delete TOCTTOU race.

Single-host only (WSL2 on this machine). NFS semantics not required.
"""

import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)

# How long to wait for an in-flight encode before declaring the lock stale (s).
_STALE_GUARD_S = 900

# Poll interval while waiting for another process to publish the cache file (s).
_POLL_S = 0.5


def acquire_or_wait(cache_dir: Path, key: str, timeout_s: int = 300) -> str:
    """Atomically acquire the encode lock for *key* or wait for it to be served.

    Returns:
        "own"    -- caller created the lock and owns the encode.
        "served" -- another process published the cache file while we waited;
                    caller can use the existing mp4 directly.

    If the lock is held and the timeout expires without a valid mp4 appearing,
    stale-lock reclaim is attempted via atomic os.replace(). The process whose
    rename succeeds takes ownership ("own"); losers fall back to "own" as well
    (safe fallback: encode rather than block forever) -- duplicating the encode
    is far less bad than hanging indefinitely.
    """
    lock_path = cache_dir / f"{key}.lock"
    mp4_path = cache_dir / f"{key}.mp4"

    # Fast path: already cached (e.g. render completed before we even tried).
    from pipeline.proxy import is_valid_proxy
    if mp4_path.exists() and is_valid_proxy(str(mp4_path)):
        log.info("[zoom-lock] key=%s already cached, no lock needed", key[:16])
        return "served"

    # Attempt atomic lock creation.
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        meta = {
            "pid": os.getpid(),
            "hostname": os.uname().nodename,
            "started_at": time.time(),
            "key": key,
        }
        os.write(fd, json.dumps(meta).encode("ascii"))
        os.close(fd)
        log.info("[zoom-lock] key=%s acquired (pid=%d)", key[:16], os.getpid())
        return "own"
    except (FileExistsError, OSError):
        pass  # Lock held by another process; fall through to wait.

    # Wait path: poll for the mp4 to appear within timeout_s.
    log.info("[zoom-lock] key=%s lock held, waiting up to %ds", key[:16], timeout_s)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if mp4_path.exists() and is_valid_proxy(str(mp4_path)):
            log.info("[zoom-lock] key=%s served by other process", key[:16])
            return "served"
        time.sleep(_POLL_S)

    # Timeout reached without a valid mp4 -- attempt stale-lock reclaim.
    # Use os.replace() (atomic rename) so only ONE process wins the reclaim;
    # the others fall through to "own" (safe: encode rather than deadlock).
    log.warning("[zoom-lock] key=%s timeout -- attempting stale-lock reclaim", key[:16])
    reclaim_path = cache_dir / f"{key}.lock.reclaim.{os.getpid()}"
    try:
        os.replace(str(lock_path), str(reclaim_path))
        # Rename succeeded -- we now own the lock slot. Write new lock.
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            meta = {
                "pid": os.getpid(),
                "hostname": os.uname().nodename,
                "started_at": time.time(),
                "key": key,
                "reclaimed": True,
            }
            os.write(fd, json.dumps(meta).encode("ascii"))
            os.close(fd)
        except (FileExistsError, OSError):
            # Another process snuck in -- still safe to encode (loose ownership).
            pass
        try:
            reclaim_path.unlink(missing_ok=True)
        except OSError:
            pass
        log.warning("[zoom-lock] key=%s stale lock reclaimed (pid=%d)", key[:16], os.getpid())
    except OSError:
        # Rename failed -- another process beat us to the reclaim. Safe to encode.
        log.warning("[zoom-lock] key=%s reclaim lost race, encoding anyway", key[:16])

    return "own"


def release_lock(lock_path: Path) -> None:
    """Unlink the lock file after the mp4 has already been published via os.replace()."""
    try:
        lock_path.unlink(missing_ok=True)
        log.info("[zoom-lock] lock released: %s", lock_path.name[:20])
    except OSError as exc:
        log.warning("[zoom-lock] could not release lock %s: %s", lock_path.name[:20], exc)
