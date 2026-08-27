import pandas as pd
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
rookie_path = root / 'data' / 'stats' / '2025 Rookie Prediction Stats - Sheet1.csv'
merged_path = root / 'output' / 'all_stats_merged.csv'

if not rookie_path.exists():
    print(f"Rookie file missing: {rookie_path}")
    raise SystemExit(1)
if not merged_path.exists():
    print(f"Merged stats missing: {merged_path}")
    raise SystemExit(1)

r = pd.read_csv(rookie_path)
# find player column in rookie file (allow player_rookie or variants)
player_col_r = next((c for c in r.columns if 'player' in c.lower()), None)
if player_col_r is None:
    print("No player-like column found in rookie file")
    raise SystemExit(1)
# normalize rookie player names like pipeline: strip, lowercase
r_players = r[player_col_r].astype(str).str.strip().str.lower().tolist()

m = pd.read_csv(merged_path)
if 'player' not in m.columns:
    print("Merged file has no 'player' column")
    raise SystemExit(1)
merged_players = m['player'].astype(str).str.strip().str.lower().tolist()

found = [p for p in r_players if p in merged_players]
missing = [p for p in r_players if p not in merged_players]

print(f"Rookie file total rows: {len(r_players)}")
print(f"Merged stats players: {len(merged_players)}")
print(f"Rookies present in merged stats: {len(found)}")
print(f"Rookies missing from merged stats: {len(missing)}")

if found:
    print('\nSample rookies found (up to 20):')
    for p in found[:20]:
        print(' -', p)
if missing:
    print('\nSample rookies missing (up to 20):')
    for p in missing[:20]:
        print(' -', p)
else:
    print('\nAll rookies from file are present in merged stats.')
