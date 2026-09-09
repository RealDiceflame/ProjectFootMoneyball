"""Refresh the website's year-by-year player stat history."""

import argparse
from pathlib import Path

from app.player_history import DEFAULT_HISTORY_SEASONS, refresh_player_history
from config import STAT_SEASON


def main():
    parser = argparse.ArgumentParser(description="Update player history for the website.")
    parser.add_argument("--rankings", type=Path, default=Path("docs/data/rankings.json"))
    parser.add_argument("--destination", type=Path, default=Path("docs/data/player_history.json"))
    parser.add_argument(
        "--start-season",
        type=int,
        default=STAT_SEASON - DEFAULT_HISTORY_SEASONS + 1,
    )
    parser.add_argument("--end-season", type=int, default=STAT_SEASON)
    args = parser.parse_args()
    return refresh_player_history(
        args.rankings,
        args.destination,
        start_season=args.start_season,
        end_season=args.end_season,
    )


if __name__ == "__main__":
    main()
