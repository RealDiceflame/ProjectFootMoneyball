"""Refresh just the public scoreboard, without running models or paid odds requests."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
from app.scoreboard import refresh_scores


def main():
    now = datetime.now(timezone.utc)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, default=now.year - (now.month < 3))
    parser.add_argument("--destination", type=Path, default=Path("docs/data/scores.json"))
    parser.add_argument("--scheduled", action="store_true")
    args = parser.parse_args()
    changed = refresh_scores(args.destination, args.season, scheduled=args.scheduled, now=now)
    print("Scoreboard refreshed." if changed else "Outside game windows; current snapshot retained.")


if __name__ == "__main__":
    main()
