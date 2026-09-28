"""Export current-season value inputs from saved box scores (no network)."""
import argparse
from datetime import datetime, timezone
from pathlib import Path

from app.player_values import export_player_value_inputs


def main():
    now = datetime.now(timezone.utc)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, default=now.year - (now.month < 3))
    args = parser.parse_args()
    payload = export_player_value_inputs(Path(__file__).resolve().parent, args.season, now=now)
    coverage = payload["coverage"]
    print(f"Exported {coverage['observation_count']} recorded player games for {coverage['player_count']} players; "
          f"{coverage['archived_games']} archived games, {len(coverage['pending_stats_game_ids'])} reported games awaiting stats.")


if __name__ == "__main__":
    main()
