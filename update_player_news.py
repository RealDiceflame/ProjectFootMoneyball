"""Refresh the website's factual player-news timeline without an API key."""

import argparse
from pathlib import Path

from app.player_news import refresh_player_news
from config import PROJECTION_SEASON


def main():
    parser = argparse.ArgumentParser(description="Update no-key player news for the website.")
    parser.add_argument("--rankings", type=Path, default=Path("docs/data/rankings.json"))
    parser.add_argument("--destination", type=Path, default=Path("docs/data/player_news.json"))
    parser.add_argument("--season", type=int, default=PROJECTION_SEASON)
    args = parser.parse_args()
    return refresh_player_news(args.rankings, args.destination, season=args.season)


if __name__ == "__main__":
    main()
