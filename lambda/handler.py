"""
handler.py — AWS Lambda entry point for RushCut render jobs.

Event shape:  { "job_id": "uuid-string" }
Returns:      { "status": "ok", "r2_key": "projects/..." }

Pipeline:
  1. Fetch job + clips from Supabase REST API
  2. Download clips from Cloudflare R2 to /tmp
  3. Run render pipeline (pipeline/render.py)
  4. Upload output to R2
  5. Update job status in Supabase

Uses requests (not supabase-py) for Supabase REST calls.
Uses boto3 for R2 (S3-compatible, endpoint_url required).
"""

import logging
import os
from pathlib import Path

import boto3
import requests
from botocore.exceptions import ClientError

from pipeline.render import run_pipeline

log = logging.getLogger()
log.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_BUCKET = os.environ["R2_BUCKET_NAME"]
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_KEY = os.environ["R2_SECRET_ACCESS_KEY"]

TMP_CLIPS = Path("/tmp/clips")


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------

def _supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def _r2_client():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
    )


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def fetch_job_and_clips(job_id: str) -> tuple[dict, list[dict]]:
    """Fetch job row and its ordered clips from Supabase REST."""
    # Fetch job
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/jobs",
        params={"id": f"eq.{job_id}", "select": "*"},
        headers=_supabase_headers(),
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise RuntimeError(f"Job not found: {job_id}")
    job = rows[0]

    project_id = job["project_id"]
    job_created = job["created_at"]  # ISO 8601 timestamp

    # Fetch clips ordered by `order` column.
    # Filter: only clips created before the job was created (excludes orphans
    # from later sessions that reuse the same project_id).
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/clips",
        params={
            "project_id": f"eq.{project_id}",
            "created_at": f"lte.{job_created}",
            "order": "order.asc",
            "select": "*",
        },
        headers=_supabase_headers(),
        timeout=10,
    )
    resp.raise_for_status()
    clips = resp.json()
    if not clips:
        raise RuntimeError(f"No clips found for project: {project_id}")

    log.info("Fetched job %s with %d clips", job_id, len(clips))
    return job, clips


def update_job(job_id: str, **fields) -> None:
    """PATCH job row with arbitrary fields."""
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/jobs",
        params={"id": f"eq.{job_id}"},
        headers={**_supabase_headers(), "Prefer": "return=minimal"},
        json=fields,
        timeout=10,
    )
    resp.raise_for_status()
    log.info("Updated job %s: %s", job_id, fields)


# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------

def download_clips(clips: list[dict]) -> list[Path]:
    """
    Download each clip from R2 to /tmp/clips/{clip_id}.mp4.
    Returns ordered list of local Paths.
    """
    s3 = _r2_client()
    TMP_CLIPS.mkdir(parents=True, exist_ok=True)

    clip_paths: list[Path] = []
    for clip in clips:
        clip_id = clip["id"]
        r2_key = clip["r2_key"]
        dest = TMP_CLIPS / f"{clip_id}.mp4"

        log.info("Downloading clip %s from R2: %s", clip_id, r2_key)
        try:
            s3.download_file(R2_BUCKET, r2_key, str(dest))
            clip_paths.append(dest)
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in ("404", "NoSuchKey"):
                log.warning("Clip %s not found in R2 (skipping): %s", clip_id, r2_key)
            else:
                raise

    if not clip_paths:
        raise RuntimeError("No clips could be downloaded — all files missing from R2")

    return clip_paths


def upload_output(job: dict, output_path: Path) -> str:
    """
    Upload rendered output to R2.
    Returns the R2 key of the uploaded file.
    """
    s3 = _r2_client()
    project_id = job["project_id"]
    mode = job.get("mode", "draft")

    r2_key = f"projects/{project_id}/{mode}.mp4"

    log.info("Uploading %s to R2: %s", output_path.name, r2_key)
    s3.upload_file(
        str(output_path),
        R2_BUCKET,
        r2_key,
        ExtraArgs={"ContentType": "video/mp4"},
    )
    return r2_key


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def lambda_handler(event: dict, context) -> dict:
    """
    Main Lambda entry point.

    Event: { "job_id": "uuid" }
    """
    job_id = event.get("job_id")
    if not job_id:
        raise ValueError("Missing required event field: job_id")

    log.info("Starting render for job: %s", job_id)

    # Mark as processing immediately
    update_job(job_id, status="processing")

    try:
        # 1. Fetch job + clips
        job, clips = fetch_job_and_clips(job_id)

        # 2. Download clips from R2
        clip_paths = download_clips(clips)
        update_job(job_id, progress_pct=5)

        # 3. Run pipeline (context passed for loudnorm timeout guard)
        def on_progress(pct: int) -> None:
            update_job(job_id, progress_pct=pct)

        output_path = run_pipeline(job, clips, clip_paths, context=context, on_progress=on_progress)

        # 4. Upload to R2
        r2_key = upload_output(job, output_path)

        # 5. Update job status
        mode = job.get("mode", "draft")
        status = "draft_ready" if mode == "draft" else "final_ready"
        key_field = "draft_r2_key" if mode == "draft" else "final_r2_key"
        update_job(job_id, status=status, **{key_field: r2_key})

        log.info("Job %s complete: %s", job_id, r2_key)
        return {"status": "ok", "r2_key": r2_key}

    except Exception as exc:
        log.exception("Job %s failed: %s", job_id, exc)
        update_job(job_id, status="failed", error=str(exc))
        raise
