"""pipeline/encoder.py -- Windows h264_amf encoder detection and path translation.

Provides video_encoder_args() for render.py Step 5.
All encoder-selection logic lives here so render.py (two encode sites) shares
the same detection + fallback without duplication.
"""
import logging
import os
import subprocess

log = logging.getLogger(__name__)

# Bitrate target for the final encode -- resolution-adaptive (#49/#78).
# 1080p (libx264): 20M target. 4K (AMF): 40M target / 50M peak -- 4K has 4x the
#   pixels of 1080p, so 20M spread over 3840x2160 is ~4x lower bits-per-pixel and
#   the 4K output was barely sharper than 1080p. 40M/50M lands 4K squarely in the
#   pro-editor range (~40M target / 50-60M max) and clearly ahead of 1080p.
# TV-check: watch 30s of a pan-heavy section and compare to source; tune the
#   matching tier here (1080p -> FINAL_BITRATE, 4K -> FINAL_BITRATE_4K).
# AMF: used as -b:v target; the *_MAXRATE peak cap feeds vbr_peak mode.
# libx264: used as -b:v target (bitrate-targeted, consistent high bitrate).
FINAL_BITRATE = "20M"       # 1080p (libx264)
AMF_MAXRATE = "24M"         # 1080p AMF opt-in (RUSHCUT_USE_AMF); vbr_peak needs an explicit maxrate
FINAL_BITRATE_4K = "40M"    # 4K (AMF) target
AMF_MAXRATE_4K = "50M"      # 4K AMF peak cap -- VBR headroom above the 40M target floor

# hevc_amf bitrate tiers (#110, follow-up to #85 GO) -- half of the corresponding
# h264_amf tier, per #85's benchmark: ~2.1x faster at half bitrate with no visible
# quality loss vs h264_amf at full bitrate. hevc_amf is opt-in ONLY (RUSHCUT_USE_HEVC_AMF
# or use_hevc_amf) -- unlike h264_amf, it never auto-enables for 4K, because the
# Microsoft HEVC Video Extension is not guaranteed present on every end-user
# playback machine and RushCut has no visibility into that machine from here.
HEVC_FINAL_BITRATE_4K = "20M"   # 4K hevc_amf target (half of FINAL_BITRATE_4K)
HEVC_AMF_MAXRATE_4K = "25M"     # 4K hevc_amf peak cap (half of AMF_MAXRATE_4K)
HEVC_FINAL_BITRATE = "10M"      # 1080p hevc_amf target (half of FINAL_BITRATE/AMF tier)
HEVC_AMF_MAXRATE = "12M"        # 1080p hevc_amf peak cap (half of AMF_MAXRATE)

# AMF draft constants (quick preview; draft uses CQP for speed regardless of mode)
AMF_QP_DRAFT      = 30
AMF_QUALITY_DRAFT = "speed"

_amf_available: bool | None = None       # cached after first probe; None = not yet probed
_hevc_amf_available: bool | None = None  # cached after first probe; None = not yet probed


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


def _detect_hevc_amf(win_ffmpeg_path: str) -> bool:
    """Return True if hevc_amf is available on this machine.

    hevc_amf is opt-in ONLY (RUSHCUT_USE_HEVC_AMF or use_hevc_amf) -- there is
    no auto-enable path (unlike h264_amf's 4K auto-enable), since the decode-side
    risk (Microsoft HEVC Video Extension not guaranteed on the playback machine)
    is unverifiable from the render machine. Caller must already have decided
    hevc was requested before calling this probe.
    """
    global _hevc_amf_available
    if os.environ.get("RUSHCUT_FORCE_LIBX264"):
        log.info("[encoder] RUSHCUT_FORCE_LIBX264 set -- using libx264 (WSL)")
        return False
    if not win_ffmpeg_path or win_ffmpeg_path == "ffmpeg":
        log.info("[encoder] win_ffmpeg_path not resolved -- falling back to libx264 (WSL)")
        return False
    if _hevc_amf_available is None:
        wsl_ffmpeg = _win_to_wsl(win_ffmpeg_path)
        try:
            result = subprocess.run(
                [wsl_ffmpeg, "-hide_banner", "-encoders"],
                capture_output=True, text=True, timeout=10,
            )
            _hevc_amf_available = "hevc_amf" in result.stdout
        except Exception as e:
            log.warning("[encoder] hevc_amf probe failed: %s -- using libx264/h264_amf", e)
            _hevc_amf_available = False

    if _hevc_amf_available:
        log.info("[encoder] hevc_amf available -- activating (explicit opt-in) via %s", win_ffmpeg_path)
    else:
        log.info("[encoder] hevc_amf requested but unavailable -- falling through to h264_amf/libx264")
    return bool(_hevc_amf_available)


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
    use_hevc_amf: bool = False,
) -> "tuple[list[str], list[str], bool]":
    """Return (ffmpeg_binary_argv, codec_args_list, is_amf).

    ffmpeg_binary_argv -- [wsl_path_to_ffmpeg_exe] for WSL subprocess invocation.
                          WSL Python calls the Windows ffmpeg.exe via /mnt/c/... path.
    codec_args_list    -- -c:v ... -rc/-crf ... -quality/-preset args only.
    is_amf             -- True means this is a Windows-native AMD AMF encode
                          (h264_amf OR hevc_amf) -- caller must translate file
                          paths via to_win_path() and route through the same
                          fallback-to-libx264 plumbing either way.

    AMF auto-enables for 4K (output_resolution=="4k") when hardware supports it.
    use_amf=True (from RUSHCUT_USE_AMF env) also enables it for 1080p renders.
    use_hevc_amf=True (from RUSHCUT_USE_HEVC_AMF env, #110) selects hevc_amf
    INSTEAD of h264_amf when both AMF is requested and hevc hardware support is
    confirmed -- hevc_amf is opt-in ONLY, it never auto-enables for 4K the way
    h264_amf does, because the Microsoft HEVC Video Extension is not guaranteed
    present on whatever machine eventually plays the output.
    RUSHCUT_FORCE_LIBX264=1 always wins -- dev escape hatch, handled in _detect_amf
    (and _detect_hevc_amf).
    """
    is_draft = mode == "draft"

    # #110: hevc_amf opt-in check FIRST, before the h264_amf auto/opt-in logic
    # below, so an explicit hevc opt-in can override what would otherwise be a
    # 4K-auto h264_amf render. No auto-enable path here by design (see docstring).
    hevc_opt_in = (use_hevc_amf or bool(os.environ.get("RUSHCUT_USE_HEVC_AMF"))) and not force_libx264
    if hevc_opt_in:
        log.info("[encoder] HEVC opt-in requested (hardware check follows)")
    if hevc_opt_in and _detect_hevc_amf(win_ffmpeg_path):
        if is_draft:
            codec_args = [
                "-c:v", "hevc_amf",
                "-pix_fmt", "nv12",
                "-profile:v", "main",
                "-rc", "cqp",
                "-qp_i", str(AMF_QP_DRAFT),
                "-qp_p", str(AMF_QP_DRAFT),
                "-quality", AMF_QUALITY_DRAFT,
            ]
        else:
            # -b:v MUST be explicit (AMF#514: ffmpeg >=7.1 AMD AMF SDK bug --
            # omitting it silently defaults to 20M and ignores -maxrate, which
            # would invalidate any bitrate/speed comparison against h264_amf).
            # -pix_fmt nv12 (not yuv420p, unlike h264_amf) -- AMF#273 reports
            # DXGI_ERROR_DEVICE_REMOVED/corrupted frames on some AMD cards with
            # yuv420p specifically on hevc_amf. Not independently verified on
            # this machine -- watch for corrupted/green frames on first real
            # render; if nv12 itself fails to encode, fall back to yuv420p.
            is_4k = output_resolution == "4k"
            if is_4k:
                final_b, final_max = HEVC_FINAL_BITRATE_4K, HEVC_AMF_MAXRATE_4K
            else:
                final_b, final_max = HEVC_FINAL_BITRATE, HEVC_AMF_MAXRATE
            codec_args = [
                "-c:v", "hevc_amf",
                "-pix_fmt", "nv12",
                "-profile:v", "main",
                "-rc", "vbr_peak",
                "-b:v", final_b,
                "-maxrate", final_max,
                "-bufsize", final_max,
                "-quality", "quality",
            ]
            # -vbaq/-high_motion_quality_boost_enable deliberately NOT added here
            # yet -- unverified whether the AMD AMF SDK accepts these flags on
            # hevc_amf on this ffmpeg build. Add only after confirming they don't
            # break the encode (see #110 plan).
        return [_win_to_wsl(win_ffmpeg_path)], codec_args, True

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
            # Resolution-adaptive bitrate (#49/#78): 4K gets the 40M/50M tier, 1080p
            # (AMF opt-in via RUSHCUT_USE_AMF) stays on the 20M/24M tier.
            is_4k = output_resolution == "4k"
            if is_4k:
                final_b, final_max = FINAL_BITRATE_4K, AMF_MAXRATE_4K
            else:
                final_b, final_max = FINAL_BITRATE, AMF_MAXRATE
            codec_args = [
                "-c:v", "h264_amf",
                "-pix_fmt", "yuv420p",
                "-profile:v", "main",
                "-rc", "vbr_peak",
                "-b:v", final_b,
                "-maxrate", final_max,
                "-bufsize", final_max,
                "-quality", "quality",
            ]
            if is_4k:
                # Quality knobs (#78, AMF ffmpeg 8.0.1): VBAQ redistributes bits to
                # perceptually important regions; high-motion boost targets soft
                # high-motion pans. Both hardware-side, ~zero render-time cost.
                # 4K-only -- keeps the rare 1080p AMF opt-in (RUSHCUT_USE_AMF) byte-
                # identical to pre-#78 behaviour.
                codec_args += ["-vbaq", "true", "-high_motion_quality_boost_enable", "true"]
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
