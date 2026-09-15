"""Archive complete nflverse game-level releases and publish validated box scores."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
from io import StringIO
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

from app.scoreboard import TEAM_ALIASES, parse_time
from app.league_leaders import build_stats_summary

RELEASES = {
    "players": "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv",
    "teams": "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{season}.csv",
}
IDENTITY = {"player_id", "player_name", "player_display_name", "position", "position_group",
            "headshot_url", "season_type", "game_id", "team", "opponent_team"}
GAME_ID = re.compile(r"^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$")


def download(url):
    with urlopen(Request(url, headers={"User-Agent": "OutlierBaseline/1.0"}), timeout=90) as response:
        content = response.read(80_000_001)
        modified = response.headers.get("Last-Modified")
    if len(content) > 80_000_000:
        raise ValueError("Stats download exceeded size limit")
    return content, modified


def parse_stats(content, kind, season, schedule):
    reader = csv.DictReader(StringIO(content.decode("utf-8-sig")))
    columns = reader.fieldnames or []
    required = {"game_id", "season", "season_type", "week", "team", "opponent_team",
                "passing_yards", "rushing_yards"}
    if kind == "players":
        required |= {"player_id", "player_display_name", "position"}
    if not required.issubset(columns) or len(columns) != len(set(columns)):
        raise ValueError(f"{kind} stats columns changed")
    grouped, seen = {}, set()
    for source in reader:
        if source["season"] != str(season) or source["season_type"] != "REG":
            continue
        game_id = source["game_id"]
        game = schedule.get(game_id)
        if not GAME_ID.fullmatch(game_id) or not game:
            raise ValueError(f"Unknown stats game: {game_id}")
        team, opponent = (TEAM_ALIASES.get(source[key], source[key]) for key in ("team", "opponent_team"))
        if {team, opponent} != {game["home"], game["away"]} or team == opponent or int(source["week"]) != game["week"]:
            raise ValueError(f"Game identity mismatch: {game_id}")
        identity = (game_id, team, source.get("player_id")) if kind == "players" else (game_id, team)
        if identity in seen:
            raise ValueError(f"Duplicate {kind} row: {game_id}")
        seen.add(identity)
        row = {}
        for key in columns:
            value = source[key]
            if value is None:
                raise ValueError(f"Truncated {kind} row")
            value = value.strip()
            if not value:
                row[key] = None
            elif key in IDENTITY or key.endswith("_list"):
                row[key] = value
            elif re.fullmatch(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", value):
                number = float(value)
                if not -1e9 < number < 1e9:
                    raise ValueError("Invalid numeric statistic")
                row[key] = int(number) if number.is_integer() else number
            else:
                raise ValueError(f"Non-numeric statistic in {key}; review source format")
        row["team"], row["opponent_team"] = team, opponent
        grouped.setdefault(game_id, []).append(row)
    return columns, grouped


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def refresh_game_stats(root, season, *, fetch=download, now=None):
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    collected_at = now.isoformat()
    board = read_json(root / "docs/data/scores.json", {})
    if board.get("season") != season:
        raise ValueError("Scoreboard season does not match stats season")
    schedule = {game["game_id"]: game for game in board["games"]}
    public = root / "docs/data/game_stats"
    season_path = public / str(season)
    prior = read_json(season_path / "index.json", {"games": {}})
    source_info, downloads, tables = {}, {}, {}
    for kind, pattern in RELEASES.items():
        url = pattern.format(season=season)
        content, modified = fetch(url)
        downloads[kind] = content
        source_info[kind] = {"url": url, "sha256": hashlib.sha256(content).hexdigest(),
                             "http_last_modified": modified, "retrieved_at": collected_at}
        tables[kind] = parse_stats(content, kind, season, schedule)
    team_columns, teams = tables["teams"]
    player_columns, players = tables["players"]
    if not teams or set(teams) != set(players):
        raise ValueError("Incomplete team/player game coverage; last-good archive retained")
    if not set(prior["games"]).issubset(teams):
        raise ValueError("Previously archived games disappeared; last-good archive retained")
    artifacts, index = {}, {}
    for identity, team_rows in teams.items():
        game = schedule[identity]
        if len(team_rows) != 2 or {row["team"] for row in team_rows} != {game["home"], game["away"]}:
            raise ValueError(f"Incomplete team pair: {identity}")
        if not game.get("kickoff") or parse_time(game["kickoff"]) > now:
            raise ValueError(f"Statistics arrived before known kickoff: {identity}")
        player_rows = players[identity]
        if {row["team"] for row in player_rows} != {game["home"], game["away"]}:
            raise ValueError(f"Missing player team: {identity}")
        team_rows.sort(key=lambda row: row["team"])
        player_rows.sort(key=lambda row: (row["team"], row.get("player_id") or ""))
        previous = read_json(season_path / f"{identity}.json", None)
        changes = {"removed": [], "added": []}
        if previous:
            if not set(previous["team_columns"]).issubset(team_columns) or not set(previous["player_columns"]).issubset(player_columns):
                raise ValueError("Previously archived statistic columns disappeared")
            previous_ids = {(row[previous["player_columns"].index("team")], row[previous["player_columns"].index("player_id")])
                            for row in previous["players"] if row[previous["player_columns"].index("player_id")]}
            current_ids = {(row["team"], row["player_id"]) for row in player_rows if row["player_id"]}
            # Corrected player credits are legitimate. Record the change; Git keeps the prior source.
            changes = {"removed": sorted(previous_ids - current_ids), "added": sorted(current_ids - previous_ids)}
        values = {
            "schema_version": 1, "season": season, "game": game,
            "team_columns": team_columns, "teams": [[row[key] for key in team_columns] for row in team_rows],
            "player_columns": player_columns, "players": [[row[key] for key in player_columns] for row in player_rows],
        }
        digest = hashlib.sha256(encoded(values)).hexdigest()
        if previous and previous.get("content_sha256") == digest:
            artifact = previous
        else:
            artifact = {**values, "first_collected_at": (previous or {}).get("first_collected_at", collected_at),
                        "updated_at": collected_at, "content_sha256": digest, "sources": source_info,
                        "player_credit_changes": changes}
            artifacts[season_path / f"{identity}.json"] = encoded(artifact)
        index[identity] = {"week": game["week"], "home": game["home"], "away": game["away"],
                           "updated_at": artifact["updated_at"], "player_rows": len(player_rows)}
    # All responses, identity joins, and regressions are validated before any writes.
    for kind, content in downloads.items():
        artifacts[root / f"data/game_stats/{season}/{kind}.csv"] = content
    artifacts[root / f"data/game_stats/{season}/provenance.json"] = encoded(source_info)
    artifacts[season_path / "index.json"] = encoded({"schema_version": 1, "season": season,
        "checked_at": collected_at, "sources": source_info, "games": index})
    artifacts[season_path / "summary.json"] = encoded(
        build_stats_summary(season, schedule, players, index, collected_at))
    catalogue = read_json(public / "index.json", {"schema_version": 1, "seasons": []})
    catalogue["seasons"] = sorted(set(catalogue["seasons"]) | {season}, reverse=True)
    catalogue["checked_at"] = collected_at
    catalogue["current_season"] = season
    artifacts[public / "index.json"] = encoded(catalogue)
    for path, content in artifacts.items():
        write_atomic(path, content)
    return len(index)
