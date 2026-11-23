"""#287: run.py removes /tmp/<job_id> and the NTFS work dir on EVERY exit path.

Run in WSL from the repo root:  python3 pipeline/_test_run_cleanup.py
Uses a scratch base dir and a uuid job id only; touches nothing else.
"""
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

CANCEL_SKIPPED = False
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.run import cleanup_job_scratch  # noqa: E402
from pipeline.render import _resolve_render_work_dir  # noqa: E402


def _seed(job_id, base):
    t = Path("/tmp") / job_id
    t.mkdir(parents=True)
    (t / "x.bin").write_bytes(b"x" * 10)
    w = _resolve_render_work_dir(job_id, base)
    w.mkdir(parents=True, exist_ok=True)
    (w / "render.mp4").write_bytes(b"y" * 10)
    return t, w


def test_helper():
    with tempfile.TemporaryDirectory() as base:
        job = str(uuid.uuid4())
        t, w = _seed(job, base)
        cleanup_job_scratch(job, base)
        assert not t.exists(), "/tmp/<job_id> must be gone"
        assert not w.exists(), "work dir must be gone"
        assert Path(base).exists(), "base dir itself must survive"


def test_guard_refuses_bad_ids():
    with tempfile.TemporaryDirectory() as base:
        keep = Path("/tmp") / f"keep-{uuid.uuid4()}"
        keep.mkdir()
        try:
            for bad in ("", ".", "..", "a/b", "..\\x"):
                cleanup_job_scratch(bad, base)
            assert keep.exists()
        finally:
            keep.rmdir()


def test_failure_path_end_to_end():
    """Real run.py, forced exception inside run_pipeline (empty clip list)."""
    with tempfile.TemporaryDirectory() as base:
        job = str(uuid.uuid4())
        t, w = _seed(job, base)
        manifest = Path(base) / f"{job}.json"
        manifest.write_text(json.dumps({
            "job_id": job, "clips": [{"local_path": "C:\\nonexistent\\a.mp4"}],
            "settings": {}, "output_path": f"{base}/out-{job}.mp4",  # scratch, never C:
        }))
        r = subprocess.run(
            [sys.executable, str(REPO / "pipeline" / "run.py"),
             "--job-id", job, "--manifest-path", str(manifest)],
            capture_output=True, text=True,
        )
        assert r.returncode != 0 or "ERROR:" in r.stdout, (r.returncode, r.stdout, r.stderr)
        assert not t.exists(), "failed render left /tmp/<job_id>"
        assert not w.exists(), "failed render left the work dir"


def _first_clip():
    return next((p for p in sorted(Path("/mnt/c/clips").glob("*")) if p.suffix.lower() == ".mp4"), None) \
        if Path("/mnt/c/clips").exists() else None


def test_real_forced_failure_after_scratch_exists():
    """A REAL render that fails mid-run: a truncated copy of a real clip makes ffmpeg fail
    after the pipeline has created its scratch dirs. Both must be gone afterwards."""
    clip = _first_clip()
    if clip is None:
        global CANCEL_SKIPPED
        CANCEL_SKIPPED = True
        print("SKIP real-failure test: no clip in /mnt/c/clips")
        return
    with tempfile.TemporaryDirectory() as base:
        bad = Path(base) / "truncated.mp4"
        with open(clip, "rb") as src, open(bad, "wb") as dst:
            dst.write(src.read(300_000))  # head only: no moov / cut mid-stream
        job = str(uuid.uuid4())
        manifest = Path(base) / f"{job}.json"
        manifest.write_text(json.dumps({
            "job_id": job, "mode": "final",
            "clips": [{"local_path": "C:\\" + str(bad)[len("/mnt/c/"):].replace("/", "\\")
                       if str(bad).startswith("/mnt/c/") else str(bad),
                       "duration_ms": 20000, "in_ms": 0, "out_ms": 8000, "include": 1,
                       "clip_volume": 1.0, "zoom_mode": "none"}],
            "settings": {"output_resolution": "1080p"}, "output_path": f"{base}/out.mp4",
        }))
        r = subprocess.run([sys.executable, str(REPO / "pipeline" / "run.py"),
                            "--job-id", job, "--manifest-path", str(manifest)],
                           capture_output=True, text=True)
        assert r.returncode != 0 and "ERROR:" in r.stdout, (r.returncode, r.stdout[-300:])
        # proof the failure happened AFTER the pipeline set up its scratch dirs
        log = (Path(base) / f"pipeline-{job}.log").read_text()
        assert "tmp(tmpfs)=" in log, "failed before scratch existed: not a real mid-run failure"
        assert not (Path("/tmp") / job).exists(), "real failure left /tmp/<job_id>"
        assert not (Path(base) / job).exists(), "real failure left the work dir"
        assert not (Path(base) / "out.mp4").exists()


def test_cancel_mid_render_leaves_nothing_and_no_orphans(repeat=5):
    """SIGTERM the process group of a real render (as cancel_render_cmd does), `repeat`
    times in a row. Needs one real clip under /mnt/c/clips (read-only use)."""
    import os, signal, time
    clips = sorted(p for p in Path("/mnt/c/clips").glob("*") if p.suffix.lower() == ".mp4") \
        if Path("/mnt/c/clips").exists() else []
    if not clips:
        global CANCEL_SKIPPED
        CANCEL_SKIPPED = True
        print("SKIP cancel test: no clip in /mnt/c/clips")
        return
    c = str(clips[0])
    win_clip = "C:\\" + c[len("/mnt/c/"):].replace("/", "\\")
    for _ in range(repeat):
        _cancel_once(win_clip)


def _cancel_once(win_clip):
    import os, signal, time
    with tempfile.TemporaryDirectory() as base:
        job = str(uuid.uuid4())
        manifest = Path(base) / f"{job}.json"
        manifest.write_text(json.dumps({
            "job_id": job, "mode": "final",
            "clips": [{"local_path": win_clip, "duration_ms": 20000, "in_ms": 0, "out_ms": 8000,
                       "include": 1, "clip_volume": 1.0, "zoom_mode": "none"}],
            "settings": {"output_resolution": "1080p"}, "output_path": f"{base}/out.mp4",
        }))
        p = subprocess.Popen([sys.executable, str(REPO / "pipeline" / "run.py"),
                              "--job-id", job, "--manifest-path", str(manifest)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tmp = Path("/tmp") / job
        t0 = time.time()
        while not tmp.exists() and time.time() - t0 < 120 and p.poll() is None:
            time.sleep(0.2)
        assert tmp.exists(), "render never created its scratch (cannot test cancel)"
        time.sleep(2)
        pidf = Path(base) / f"{job}.pid"
        os.killpg(int(pidf.read_text()), signal.SIGTERM)
        p.wait(timeout=60)
        time.sleep(3)  # the detached rm finishes
        assert not tmp.exists(), "cancel left /tmp/<job_id>"
        assert not (Path(base) / job).exists(), "cancel left the work dir"
        left = subprocess.run(["pgrep", "-f", job], capture_output=True, text=True).stdout.split()
        left = [x for x in left if x != str(os.getpid())]
        assert not left, f"orphan processes still reference the job: {left}"


if __name__ == "__main__":
    test_helper()
    test_guard_refuses_bad_ids()
    test_failure_path_end_to_end()
    test_real_forced_failure_after_scratch_exists()
    test_cancel_mid_render_leaves_nothing_and_no_orphans()
    if CANCEL_SKIPPED:
        print("PARTIAL: cancel test was SKIPPED (no source clip); other tests passed")
    else:
        print("OK: run.py cleanup tests passed (incl. cancel)")
