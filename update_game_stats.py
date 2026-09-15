"""Save current-season team/player game stats for the website and future analysis."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
from app.game_stats import refresh_game_stats


def main():
    now = datetime.now(timezone.utc)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, default=now.year - (now.month < 3))
    args = parser.parse_args()
    count = refresh_game_stats(Path(__file__).resolve().parent, args.season, now=now)
    print(f"Archived and prepared {count} game box scores.")


if __name__ == "__main__":
    main()
