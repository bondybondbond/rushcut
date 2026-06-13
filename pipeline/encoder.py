"""pipeline/encoder.py -- Windows h264_amf encoder detection and path translation.

Provides video_encoder_args() for render.py Step 5.
All encoder-selection logic lives here so render.py (two encode sites) shares
the same detection + fallback without duplication.
"""
import logging
import os
import subprocess

log = logging.getLogger(__name__)

# Bitrate target for the final encode (4K and 1080p).
# TV-check baseline: watch 30s of a pan-heavy section and compare to source.
#   If indistinguishable -> drop to "15M" in one edit here.
#   If noticeably softer -> stay at "20M".
# AMF: used as -b:v target; MAXRATE is the peak cap (~1.2x) for vbr_peak mode.
# libx264: used as -b:v target (bitrate-targeted, consistent high bitrate).
FINAL_BITRATE = "20M"
AMF_MAXRATE = "24M"  # vbr_peak needs explicit maxrate or AMF picks its own default

# AMF draft constants (quick preview; draft uses CQP for speed regardless of mode)
AMF_QP_DRAFT      = 30
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
    """Return True if h264_amf is available on this machine.

    AMF auto-enables for 4K renders (caller sets explicit=False, decided by resolution).
    Opt-in for 1080p via RUSHCUT_USE_AMF=1 env var.
    RUSHCUT_FORCE_LIBX264=1 overrides all paths (test seam / CI escape hatch).
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
        source = "explicit opt-in" if explicit else "4K auto / RUSHCUT_USE_AMF"
        log.info("[encoder] h264_amf available -- activating (%s) via %s", source, win_ffmpeg_path)
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
    codec_args_list    -- -c:v ... -rc/-crf ... -quality/-preset args only.
    is_amf             -- True means caller must translate file paths via to_win_path().

    AMF auto-enables for 4K (output_resolution=="4k") when hardware supports it.
    use_amf=True (from RUSHCUT_USE_AMF env) also enables it for 1080p renders.
    RUSHCUT_FORCE_LIBX264=1 always wins -- dev escape hatch, handled in _detect_amf.
    """
    is_draft = mode == "draft"

    # U4e: AMF auto-enables for 4K; also opt-in via env var.
    # Log the 4K-auto path BEFORE hardware probe so non-AMD logs read:
    #   "4K auto-AMF requested (hardware check follows)"  <-- this line
    #   "AMF requested but unavailable -- using libx264"  <-- _detect_amf result
    # instead of the misleading "AMF requested" -> "unavailable" trace that an
    # explicit opt-in would produce.
    is_4k_auto = (output_resolution == "4k") and not use_amf and not os.environ.get("RUSHCUT_USE_AMF")
    if is_4k_auto:
        log.info("[encoder] 4K auto-AMF requested (hardware check follows)")

    amf_requested = use_amf or bool(os.environ.get("RUSHCUT_USE_AMF")) or output_resolution == "4k"
    if not force_libx264 and amf_requested and _detect_amf(win_ffmpeg_path, explicit=use_amf):
        if is_draft:
            # Draft: CQP for maximum encode speed (quick preview, quality not critical).
            codec_args = [
                "-c:v", "h264_amf",
                "-pix_fmt", "yuv420p",
                "-profile:v", "main",
                "-rc", "cqp",
                "-qp_i", str(AMF_QP_DRAFT),
                "-qp_p", str(AMF_QP_DRAFT),
                "-quality", AMF_QUALITY_DRAFT,
            ]
        else:
            # Final: VBR peak-constrained -- consistent high bitrate compensates for
            # AMD's missing B-frame support (driver-level limitation; -bf is ignored).
            # -maxrate must be set explicitly; without it AMF picks its own ceiling.
            codec_args = [
                "-c:v", "h264_amf",
                "-pix_fmt", "yuv420p",
                "-profile:v", "main",
                "-rc", "vbr_peak",
                "-b:v", FINAL_BITRATE,
                "-maxrate", AMF_MAXRATE,
                "-bufsize", AMF_MAXRATE,
                "-quality", "quality",
            ]
        # Return WSL-accessible path so subprocess.run() in WSL can execute ffmpeg.exe
        return [_win_to_wsl(win_ffmpeg_path)], codec_args, True

    # libx264 fallback (WSL ffmpeg)
    from .utils import FFMPEG
    if is_draft:
        # Draft: speed over quality (CRF 35, ultrafast).
        codec_args = [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-crf", "35",
            "-preset", "ultrafast",
        ]
    else:
        # Final: FINAL_BITRATE at medium preset. Bitrate-targeted (not CRF) so the
        # master holds a consistent high bitrate regardless of content complexity.
        # TV-check: compare a pan-heavy section to source; tune FINAL_BITRATE if needed.
        codec_args = [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-b:v", FINAL_BITRATE,
            "-preset", "medium",
        ]
    return [FFMPEG], codec_args, False
