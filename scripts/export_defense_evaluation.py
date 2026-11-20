"""Prepare strictly validated corrected archives for retrospective evaluation."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.game_stats import encoded, read_json
from app.ranking_inputs import defense_game

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--season', type=int, default=2025)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
now = datetime.now(timezone.utc)
games = [defense_game(read_json(path, None), now=now) for year in (args.season - 1, args.season)
         for path in sorted((ROOT / 'docs/data/game_stats' / str(year)).glob('20*.json'))]
args.output.write_bytes(encoded(games))
print(f'{len(games)} validated games; corrected present-day archives, not original forecast vintages')
