import sys
from pathlib import Path
# ensure project root is on sys.path so imports work when running the script directly
proj_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(proj_root))
from stat_utils.project_dataframe_utils import normalize_name
examples = [
    'Brian Thomas Jr.',
    'Brian Thomas',
    'Brian Robinson',
    'Brian Robinson Jr',
    'Brian Jr',
    'Brock Purdy',
]
for e in examples:
    print(f"{e} -> {normalize_name(e)}")
