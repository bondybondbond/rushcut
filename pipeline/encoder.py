"""pipeline/encoder.py -- Windows h264_amf encoder detection and path translation.

Provides video_encoder_args() for render.py Step 5.
All encoder-selection logic lives here so render.py (two encode sites) shares
the same detection + fallback without duplication.
"""
import logging
import os
import subprocess

log = logging.getLogger(__name__)

# AMF quality constants -- adjust AMF_QP if A/B eyeball shows banding.
# Lower QP = higher quality / larger file. Benchmarked on 30s 4K DJI:
#   QP 20 = 96 MB (53% larger than libx264 CRF 22 at 63 MB)
#   QP 23 = 67 MB ( 6% larger than libx264 CRF 22)  <-- shipped default
# TODO: profile yuv420p vs nv12 pixel format -- nv12 is AMF-native and skips
# a CPU conversion step; revisit if encode CPU shows up in profiling.
AMF_QP       = 23
AMF_QP_DRAFT = 30
AMF_QUALITY       = "quality"
AMF_QUALITY_DRAFT = "speed"

_amf_available: bool | None = None  # cached after first probe; None = not yet probed


def _win_to_wsl(win_path: str) -> str:
    """Translate a Windows path to a WSL-accessible /mnt/... path.

    C:\\Users\\foo\\ffmpeg.exe -> /mnt/c/Users/foo/ffmpeg.exe
    Already-WSL paths passed through unchanged.
    """
    p = win_path.replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        rest = p[2:].lstrip("/")
        return f"/mnt/{drive}/{rest}"
    return p  # already a WSL/POSIX path


def _detect_amf(win_ffmpeg_path: str, explicit: bool = False) -> bool:
    """Return True if h264_amf is available.

    AMF is NOT the default. h264_amf on AMD hardware lacks B-frame support (driver-level
    limitation, confirmed: -bf ignored in both CQP and VBR modes), producing subtly
    choppier motion on pans vs libx264 -preset fast (has_b_frames=2). libx264 is the
    default final encode for quality.

    Opt-in paths (either suffices):
      - RUSHCUT_USE_AMF=1 env var (developer/power-user)
      - explicit=True (passed when UI "Fast render" toggle is on)

    RUSHCUT_FORCE_LIBX264=1 overrides both opt-in paths (test seam).
    """
    global _amf_available
    if os.environ.get("RUSHCUT_FORCE_LIBX264"):
        log.info("[encoder] RUSHCUT_FORCE_LIBX264 set -- using libx264 (WSL)")
        return False
    if not win_ffmpeg_path or win_ffmpeg_path == "ffmpeg":
        log.info("[encoder] win_ffmpeg_path not resolved -- falling back to libx264 (WSL)")
        return False
    # Probe once and cache
    if _amf_available is None:
        wsl_ffmpeg = _win_to_wsl(win_ffmpeg_path)
        try:
            result = subprocess.run(
                [wsl_ffmpeg, "-hide_banner", "-encoders"],
                capture_output=True, text=True, timeout=10,
            )
            _amf_available = "h264_amf" in result.stdout
        except Exception as e:
            log.warning("[encoder] AMF probe failed: %s -- using libx264", e)
            _amf_available = False

    if _amf_available:
        source = "UI toggle" if explicit else "RUSHCUT_USE_AMF=1"
        log.info("[encoder] %s -- using h264_amf via %s", source, win_ffmpeg_path)
    else:
        log.info("[encoder] AMF requested but unavailable -- using libx264 (WSL)")
    return bool(_amf_available)


def to_win_path(p: "str | object") -> str:
    """Translate a WSL path to a Windows path for Windows-native ffmpeg arguments.

    /mnt/c/foo.mp4           -> C:\\foo.mp4
    /tmp/abc/render.mp4      -> \\\\wsl.localhost\\Ubuntu-24.04\\tmp\\abc\\render.mp4
    C:\\already\\windows.mp4 -> C:\\already\\windows.mp4  (pass-through)
    """
    s = str(p)
    if s.startswith("/mnt/") and len(s) > 6:
        drive = s[5].upper()
        rest = s[6:].replace("/", "\\")
        return f"{drive}:{rest}"
    if s.startswith("/"):
        rest = s.replace("/", "\\")
        return f"\\\\wsl.localhost\\Ubuntu-24.04{rest}"
    return s  # already a Windows path


def video_encoder_args(
    mode: str,
    output_resolution: str,
    win_ffmpeg_path: str,
    force_libx264: bool = False,
    use_amf: bool = False,
) -> "tuple[list[str], list[str], bool]":
    """Return (ffmpeg_binary_argv, codec_args_list, is_amf).

    ffmpeg_binary_argv -- [wsl_path_to_ffmpeg_exe] for WSL subprocess invocation.
                          WSL Python calls the Windows ffmpeg.exe via /mnt/c/... path.
    codec_args_list    -- -c:v ... -qp/-crf ... -quality/-preset args only.
    is_amf             -- True means caller must translate file paths via to_win_path().

    use_amf=True overrides the RUSHCUT_USE_AMF env var check, allowing the UI toggle
    to enable AMF without requiring a system env var to be set.
    """
    is_draft = mode == "draft"

    amf_requested = use_amf or bool(os.environ.get("RUSHCUT_USE_AMF"))
    if not force_libx264 and amf_requested and _detect_amf(win_ffmpeg_path, explicit=use_amf):
        qp      = AMF_QP_DRAFT if is_draft else AMF_QP
        quality = AMF_QUALITY_DRAFT if is_draft else AMF_QUALITY
        codec_args = [
            "-c:v", "h264_amf",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-rc", "cqp",
            "-qp_i", str(qp),
            "-qp_p", str(qp),
            "-quality", quality,
        ]
        # Return WSL-accessible path so subprocess.run() in WSL can execute ffmpeg.exe
        return [_win_to_wsl(win_ffmpeg_path)], codec_args, True

    # libx264 fallback (WSL ffmpeg)
    from .utils import FFMPEG
    crf    = 35 if is_draft else 22
    preset = "ultrafast" if is_draft else "fast"
    codec_args = [
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-crf", str(crf),
        "-preset", preset,
    ]
    return [FFMPEG], codec_args, False
