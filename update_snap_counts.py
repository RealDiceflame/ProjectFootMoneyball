"""Collect validated regular-season snap participation without changing box scores."""
import argparse
from pathlib import Path
from app.game_stats import read_json
from app.snap_counts import refresh_snap_counts


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-season", type=int)
    parser.add_argument("--end-season", type=int)
    args = parser.parse_args()
    current = read_json(root / "docs/data/scores.json", {}).get("season")
    start = args.start_season if args.start_season is not None else current
    end = args.end_season if args.end_season is not None else start
    if start is None or end is None or not 2016 <= start <= end <= 2026:
        parser.error("Choose an ordered season range from 2016 through 2026; otherwise a scoreboard season is required")
    refresh_snap_counts(root, range(start, end + 1))


if __name__ == "__main__":
    main()
