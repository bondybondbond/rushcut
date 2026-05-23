"""
pipeline/loudnorm.py — EBU R128 loudness target (-14 LUFS).

Single-pass `loudnorm` is fused directly into the render encode (music-off) and
the music-mix encode (music-on) — there is no separate normalisation pass. This
module owns the loudness targets and the filter string used by both call sites.
"""

# Target: -14 LUFS integrated, LRA 11, true peak -1 dBTP
LOUDNORM_I = -14
LOUDNORM_LRA = 11
LOUDNORM_TP = -1


def loudnorm_filter() -> str:
    """Single-pass `loudnorm` filter string to fuse into an existing encode."""
    return f"loudnorm=I={LOUDNORM_I}:LRA={LOUDNORM_LRA}:TP={LOUDNORM_TP}"
