"""Top-ten recorded player totals; never combine players by display name."""
from collections import defaultdict
import math


# Only additive statistics belong here. Rates require workload rules and must not
# be summed; longest kicks/punts use a maximum instead.
STAT_GROUPS = {
    "Passing": {
        "passing_yards": "Passing yards", "passing_tds": "Passing touchdowns",
        "completions": "Completions", "attempts": "Pass attempts",
        "passing_first_downs": "Passing first downs",
    },
    "Rushing": {
        "rushing_yards": "Rushing yards", "rushing_tds": "Rushing touchdowns",
        "carries": "Rush attempts", "rushing_first_downs": "Rushing first downs",
    },
    "Receiving": {
        "receiving_yards": "Receiving yards", "receiving_tds": "Receiving touchdowns",
        "receptions": "Receptions", "targets": "Targets",
        "receiving_yards_after_catch": "Yards after catch", "receiving_first_downs": "Receiving first downs",
    },
    "Defense": {
        "def_tackles_solo": "Solo tackles", "def_tackle_assists": "Tackle assists",
        "def_tackles_for_loss": "Tackles for loss", "def_sacks": "Sacks",
        "def_qb_hits": "Quarterback hits", "def_interceptions": "Interceptions",
        "def_pass_defended": "Passes defended", "def_fumbles_forced": "Forced fumbles",
        "def_tds": "Defensive touchdowns",
    },
    "Kicking": {
        "fg_made": "Field goals made", "fg_att": "Field goal attempts",
        "fg_long": "Longest field goal", "fg_made_50_59": "Field goals: 50–59 yards",
        "fg_made_60_": "Field goals: 60+ yards", "pat_made": "Extra points made",
    },
    "Punting": {
        "pt_yards": "Punt yards", "pt_net_yards": "Net punt yards",
        "pt_inside_20": "Punts inside the 20", "pt_long": "Longest punt",
    },
    "Returns": {
        "kickoff_return_yards": "Kickoff return yards", "punt_return_yards": "Punt return yards",
        "special_teams_tds": "Special-teams touchdowns",
    },
    "Fantasy": {
        "fantasy_points": "Fantasy points · standard", "fantasy_points_ppr": "Fantasy points · PPR",
    },
}
MAXIMUM_STATS = {"fg_long", "pt_long"}


def top_ten(rows, key):
    eligible = [row for row in rows if key in row["values"] and row["values"][key] != 0]
    eligible.sort(key=lambda row: (-row["values"][key], row["player"].casefold(), row["player_id"]))
    leaders, rank, previous = [], 0, None
    for place, row in enumerate(eligible[:10], 1):
        value = round(row["values"][key], 3)
        if value != previous:
            rank = place
        leaders.append({field: row[field] for field in ("player_id", "player", "teams", "position")}
                       | {"rank": rank, "value": value})
        previous = value
    return leaders


def build_stats_summary(season, schedule, player_games, game_index, checked_at):
    """Summarize only validated, archived regular-season box scores."""
    metrics = [{"key": key, "label": label, "group": group}
               for group, fields in STAT_GROUPS.items() for key, label in fields.items()]
    present = {key for rows in player_games.values() for row in rows for key in row}
    metrics = [metric for metric in metrics if metric["key"] in present]
    totals = defaultdict(dict)
    seen = set()
    for game_id in sorted(player_games):
        game = schedule[game_id]
        if game_id not in game_index:
            raise ValueError("Leader game is not in the validated archive")
        for source in player_games[game_id]:
            player_id = source.get("player_id")
            if not player_id:
                continue  # Anonymous team events are not players.
            identity = (game_id, player_id)
            if identity in seen:
                raise ValueError("Duplicate player game in league leaders")
            seen.add(identity)
            for period in ("all", str(game["week"])):
                row = totals[period].setdefault(player_id, {
                    "player_id": player_id,
                    "player": source.get("player_display_name") or source.get("player_name") or player_id,
                    "position": source.get("position") or "—", "teams": [], "values": {},
                })
                if source["team"] not in row["teams"]:
                    row["teams"].append(source["team"])
                for metric in metrics:
                    key = metric["key"]
                    value = source.get(key)
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        continue
                    if key in MAXIMUM_STATS:
                        row["values"][key] = max(row["values"].get(key, value), value)
                    else:
                        row["values"][key] = row["values"].get(key, 0) + value
    periods = {}
    for period in ["all", *map(str, sorted({game["week"] for game in game_index.values()}))]:
        ids = [game_id for game_id, game in game_index.items()
               if period == "all" or str(game["week"]) == period]
        periods[period] = {"game_count": len(ids), "game_ids": sorted(ids),
                          "leaders": {metric["key"]: top_ten(totals[period].values(), metric["key"]) for metric in metrics}}
    games = [{**game, "stats_available": game_id in game_index,
              "stats_updated_at": game_index.get(game_id, {}).get("updated_at")}
             for game_id, game in schedule.items()]
    games.sort(key=lambda game: (game["week"], game.get("kickoff") or "", game["game_id"]))
    return {"schema_version": 1, "season": season, "season_type": "REG", "checked_at": checked_at,
            "metrics": metrics, "periods": periods, "games": games}


def rebuild_saved_summary(root, season):
    """Backfill the new view without redownloading or redating source data."""
    from pathlib import Path
    from app.game_stats import GAME_ID, encoded, read_json, write_atomic

    root = Path(root)
    folder = root / "docs/data/game_stats" / str(season)
    index = read_json(folder / "index.json", None)
    if not index or index.get("season") != season:
        raise ValueError("No saved game archive for this season")
    board = read_json(root / "docs/data/scores.json", {})
    schedule = {game["game_id"]: game for game in board.get("games", [])} if board.get("season") == season else {}
    player_games = {}
    for game_id in index["games"]:
        if not GAME_ID.fullmatch(game_id):
            raise ValueError("Invalid archive game")
        bundle = read_json(folder / f"{game_id}.json", None)
        if not bundle or bundle.get("season") != season or bundle["game"]["game_id"] != game_id:
            raise ValueError("Mismatched saved archive")
        columns = bundle["player_columns"]
        if len(columns) != len(set(columns)) or any(len(row) != len(columns) for row in bundle["players"]):
            raise ValueError("Invalid saved player rows")
        player_games[game_id] = [dict(zip(columns, row)) for row in bundle["players"]]
        schedule.setdefault(game_id, bundle["game"])
    summary = build_stats_summary(season, schedule, player_games, index["games"], index["checked_at"])
    write_atomic(folder / "summary.json", encoded(summary))
    return len(player_games)


if __name__ == "__main__":
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Build leaders from already saved game box scores.")
    parser.add_argument("--season", required=True, type=int)
    args = parser.parse_args()
    print(f"Prepared stats for {rebuild_saved_summary(Path(__file__).resolve().parents[1], args.season)} games.")
