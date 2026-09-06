"""Refresh the website's weekly NFL odds comparison."""

import argparse
from pathlib import Path

from app.odds_board import refresh_odds_board
from config import PROJECTION_SEASON


def main():
    parser = argparse.ArgumentParser(description="Update the weekly NFL odds board.")
    parser.add_argument("--destination", type=Path, default=Path("docs/data/nfl_odds.json"))
    parser.add_argument("--season", type=int, default=PROJECTION_SEASON)
    args = parser.parse_args()
    return refresh_odds_board(args.destination, season=args.season)


if __name__ == "__main__":
    main()
