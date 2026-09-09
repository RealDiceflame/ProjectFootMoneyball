"""Maintain the draft-capital map's matched historical ADP and season statistics."""

import argparse
import json
from pathlib import Path

from app.draft_capital_history import refresh_history


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, default=Path("docs/data/player_history.json"))
    parser.add_argument("--destination", type=Path, default=Path("docs/data/draft_capital_history.json"))
    parser.add_argument("--refresh", action="store_true", help="Refetch completed seasons instead of reusing saved snapshots")
    args = parser.parse_args()
    seasons = json.loads(args.history.read_text(encoding="utf-8"))["seasons"]
    refresh_history(args.destination, seasons, refresh=args.refresh)


if __name__ == "__main__":
    main()
