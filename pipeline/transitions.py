"""
pipeline/transitions.py — Build filter_complex for xfade (video) + audio joining.

Key constraints (from CLAUDE.md + plan fixes):
- xfade transition names: "crossfade" -> transition=fade, "dip_to_black" -> transition=fadeblack
  (fadeblack is a native FFmpeg xfade transition — no custom black-fill logic needed)
- Fixed-canvas pre-scale: every input stream is scaled to an exact canvas (1920x1080 final,
  640x360 draft) with letterbox/pillarbox padding BEFORE entering concat or xfade.
  Named labels [sv0],[sv1],... applied to ALL inputs — both "none" path and xfade path.
  This prevents dimension-mismatch crashes when mixing portrait and landscape clips.
- scale=-2:{h} is NO LONGER used inside filter_complex — replaced by fixed-canvas pre-scale.
- xfade offset formula (ported verbatim from spike):
    offset = cumulative + duration[i-1] - xfade_dur * i
- Audio: pairwise chained acrossfade for ALL N>=2 clips.
         apad=whole_dur makes each clip's audio exactly durations[i] seconds, so
         acrossfade transitions align with xfade visual offsets — no hard-cut lag.
         (concat was previously used for 3+ clips but caused clip audio to start
          1.5s late at every cut after the first, accumulating each xfade_dur.)
"""

import logging
from pathlib import Path

log = logging.getLogger(__name__)

# Map JobConfig.transition values to FFmpeg xfade transition names
_TRANSITION_MAP = {
    "crossfade": "fade",
    "dip_to_black": "fadeblack",
}

XFADE_DUR = 1.5  # seconds


def build_filter_complex(
    clip_paths: list[Path],
    durations: list[float],
    audio_flags: list[bool],
    transition: str = "crossfade",
    mode: str = "draft",
    xfade_dur: float = XFADE_DUR,
    output_resolution: str = "1080p",
) -> tuple[str, str, str]:
    """
    Build filter_complex string for N clips with xfade transitions.

    Args:
        clip_paths:   Ordered list of clip Paths (used only for count).
        durations:    Duration in seconds for each clip (MUST be post-trim durations).
        audio_flags:  Whether each clip has audio (all True after inject_silence_where_needed).
        transition:   "crossfade" | "dip_to_black"
        mode:         "draft" (360p) | "final" (1080p)
        xfade_dur:    Crossfade duration in seconds.

    Returns:
        (filter_complex_str, video_out_label, audio_out_label)
        audio_out_label is "" if no clips have audio.
    """
    n = len(clip_paths)
    # scale_w/scale_h define the fixed canvas for ALL clips (portrait+landscape mixing).
    # Must use exact WxH — NOT scale=-2:h — so all inputs are the same size before concat/xfade.
    # 3840x2160 for 4K UHD (DJI Osmo Pocket 3); force_original_aspect_ratio=decrease + pad handles
    # portrait clips correctly without hardcoding aspect ratio assumptions.
    scale_h = "360" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    scale_w = "640" if mode == "draft" else ("3840" if output_resolution == "4k" else "1920")

    # Fixed-canvas filter applied to every input stream before concat or xfade.
    # Scales to fit inside canvas (preserving AR), then pads remainder black.
    # Prevents FFmpeg dimension-mismatch crash when portrait and landscape clips
    # are mixed in the same project (e.g. 540x1080 vs 1920x1080).
    canvas = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2"
    )

    v_out = "[vout]"

    # --- "none" transition: pre-scale all inputs, then straight concat ---
    if transition == "none":
        any_audio = any(audio_flags)
        # [0:v]canvas[sv0]; [1:v]canvas[sv1]; ... [sv0][sv1]...concat[vout]
        pre_scale = "; ".join(f"[{i}:v]{canvas}[sv{i}]" for i in range(n))
        scaled_inputs = "".join(f"[sv{i}]" for i in range(n))
        video_filter = f"{pre_scale}; {scaled_inputs}concat=n={n}:v=1:a=0{v_out}"
        if not any_audio:
            return video_filter, v_out, ""
        # apad=whole_dur: pad each clip's audio to its exact video duration.
        # CFR normalise produces video ~40-120ms longer than audio per clip;
        # without padding the audio concat drifts ahead of the video at every cut.
        pre_pad = "; ".join(f"[{i}:a]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n))
        padded_a = "".join(f"[pa{i}]" for i in range(n))
        a_out = "[aout]"
        audio_filter = f"{pre_pad}; {padded_a}concat=n={n}:v=0:a=1{a_out}"
        return f"{video_filter}; {audio_filter}", v_out, a_out

    xfade_name = _TRANSITION_MAP.get(transition, "fade")

    # Clamp xfade_dur so it never exceeds half the shortest clip.
    # Prevents transitions from consuming clips shorter than 2x the fade duration.
    min_dur = min(durations)
    effective_dur = min(xfade_dur, min_dur / 2.0)
    if effective_dur < xfade_dur:
        log.warning(
            "[transitions] xfade_dur clamped %.3fs -> %.3fs (shortest clip=%.3fs)",
            xfade_dur, effective_dur, min_dur,
        )
    xfade_dur = effective_dur

    # --- Video: pre-scale all inputs, then pairwise xfade chain ---
    video_parts: list[str] = []

    # Pre-scale every input to fixed canvas — [sv0],[sv1],... (both paths fixed)
    # Single-clip edge case: output directly to [vout] (no xfade chain follows).
    for i in range(n):
        out_lbl = v_out if n == 1 else f"[sv{i}]"
        video_parts.append(f"[{i}:v]{canvas}{out_lbl}")

    if n > 1:
        prev_label = "[sv0]"
        cumulative = 0.0
        for i in range(1, n):
            offset = cumulative + durations[i - 1] - xfade_dur * i
            log.info(
                "[transitions] xfade offset[%d] = %.4fs  "
                "(cumulative=%.4fs - %.4fs)",
                i, offset, cumulative + durations[i - 1], xfade_dur * i,
            )
            # Last xfade in chain outputs directly to [vout]
            out_label = v_out if i == n - 1 else f"[v{i:02d}]"
            video_parts.append(
                f"{prev_label}[sv{i}]"
                f"xfade=transition={xfade_name}:duration={xfade_dur}:offset={offset:.4f}"
                f"{out_label}"
            )
            prev_label = out_label
            cumulative += durations[i - 1]

    # --- Audio ---
    any_audio = any(audio_flags)
    if not any_audio:
        log.info("[transitions] No audio in any clip — video-only output")
        return "; ".join(video_parts), v_out, ""

    # N>=2: pad every clip to its exact video duration, then pairwise acrossfade chain.
    # apad=whole_dur makes each clip audio exactly durations[i]s so the crossfade
    # start point (durations[i] - xfade_dur) matches the xfade visual offset exactly.
    pre_pad = "; ".join(f"[{i}:a]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n))
    chain: list[str] = []
    prev = "[pa0]"
    for i in range(1, n):
        out_lbl = "[aout]" if i == n - 1 else f"[ac{i}]"
        chain.append(f"{prev}[pa{i}]acrossfade=d={xfade_dur:.4f}{out_lbl}")
        prev = out_lbl
    audio_parts = [f"{pre_pad}; " + "; ".join(chain)]

    a_out = "[aout]"
    all_parts = video_parts + audio_parts
    return "; ".join(all_parts), v_out, a_out
