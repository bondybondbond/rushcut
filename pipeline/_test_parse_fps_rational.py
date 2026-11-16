"""#238: parse_fps_rational handles the DJI trailing-comma probe output. Run in WSL:
python3 pipeline/_test_parse_fps_rational.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.render import parse_fps_rational as p

cases = {
    "30000/1001,\r\n": "30000/1001",  # the #238 case
    "30000/1001\n": "30000/1001",
    "25/1": "25/1",
    "0/0": None, "30/0": None, "": None, "N/A": None, "30": None, "x,": None,
}
for raw, want in cases.items():
    assert p(raw) == want, (raw, p(raw), want)
print("ok", len(cases))
