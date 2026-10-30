"""Backfill historical weekly offense, defense and special-teams box scores."""
import argparse
from pathlib import Path

from app.game_stats_backfill import backfill_game_stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-season", type=int, default=2016)
    parser.add_argument("--end-season", type=int, default=2025)
    args = parser.parse_args()
    if not 2016 <= args.start_season <= args.end_season <= 2025:
        parser.error("Select an increasing season range within 2016–2025")
    counts = backfill_game_stats(Path(__file__).resolve().parent,
                                range(args.start_season, args.end_season + 1))
    print(f"Archived {sum(counts.values())} games across {len(counts)} historical seasons.")


if __name__ == "__main__":
    main()
