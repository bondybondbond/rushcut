"""Quick import check for Batch 13 modules."""
import sys
sys.path.insert(0, "/mnt/c/apps/rushcut")
from pipeline.motion import score_clip, filter_by_motion, find_peak_window
from pipeline.beats import detect_beats, snap_to_beat
print("imports OK")
print(f"  motion: score_clip, filter_by_motion, find_peak_window")
print(f"  beats:  detect_beats, snap_to_beat")
