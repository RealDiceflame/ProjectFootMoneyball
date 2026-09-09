"""Refresh the static survivor matrix without exposing API keys to visitors."""

import argparse
from pathlib import Path

from app.survivor import refresh_survivor
from config import PROJECTION_SEASON


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, default=PROJECTION_SEASON)
    parser.add_argument("--destination", type=Path, default=Path("docs/data/survivor.json"))
    parser.add_argument("--odds", type=Path, default=Path("docs/data/nfl_odds.json"))
    args = parser.parse_args()
    refresh_survivor(args.destination, args.season, args.odds)


if __name__ == "__main__":
    main()
