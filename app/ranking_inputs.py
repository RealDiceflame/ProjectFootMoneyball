"""Publish defensive observations from validated, saved regular-season boxes.

No external requests. The current-season player exporter validates the schedule
and completion evidence; historical boxes retain their actual source timestamps.
"""
from datetime import datetime, timezone
import hashlib
from pathlib import Path

from app.game_stats import encoded, read_json, write_atomic
from app.player_values import (STAT_COLUMNS, POSITIONS, _number, _schedule_game,
                               _unpack, build_player_value_inputs)
from app.scoreboard import parse_time

DEFENSE_STATS = (
    "def_sacks", "def_interceptions", "fumble_recovery_opp", "def_safeties",
    "def_punt_blocks", "def_pat_blocks", "def_fg_blocks", "def_tds",
    "special_teams_tds", "def_2pt_made", "sacks_suffered",
    "passing_interceptions", "fumbles_lost_total", "def_qb_hits",
    "passing_epa", "rushing_epa", "attempts", "carries",
)


def defense_game(bundle, *, now):
    season = bundle.get("season")
    game = _schedule_game(bundle.get("game"), season)
    if not game.get("kickoff") or parse_time(game["kickoff"]) > now:
        raise ValueError("Future or undated defensive observation")
    content = {key: bundle[key] for key in ("schema_version", "season", "game", "team_columns", "teams", "player_columns", "players")}
    if bundle.get("schema_version") != 1 or hashlib.sha256(encoded(content)).hexdigest() != bundle.get("content_sha256"):
        raise ValueError("Defensive archive checksum mismatch")
    for key in ("updated_at", "first_collected_at"):
        if bundle.get(key) and parse_time(bundle[key]) > now:
            raise ValueError("Defensive evidence is dated after export")
    teams, players = _unpack(bundle, "teams", game), _unpack(bundle, "players", game)
    if len(teams) != 2 or {row["team"] for row in teams} != {game["home"], game["away"]}:
        raise ValueError("Incomplete defensive team coverage")
    seen = set()
    for row in teams + players:
        opponent = game["away"] if row["team"] == game["home"] else game["home"]
        if any(row.get(key) != value for key, value in {"season": season, "season_type": "REG", "week": game["week"], "opponent_team": opponent}.items()):
            raise ValueError("Defensive observation identity mismatch")
    for row in players:
        identity = row.get("player_id")
        if identity and identity in seen:
            raise ValueError("Duplicate player in defensive observation")
        if identity:
            seen.add(identity)
    records = []
    for team in teams:
        opponent = game["away"] if team["team"] == game["home"] else game["home"]
        allowed = {}
        for position in sorted(POSITIONS):
            rows = [row for row in players if row["team"] == opponent and {"FB": "RB", "HB": "RB"}.get(row["position"], row["position"]) == position]
            # A missing positional group is unknown, not an inferred shutout.
            allowed[position] = {key: (sum(row[key] for row in rows) if rows and all(_number(row.get(key), key) is not None for row in rows) else None) for key in STAT_COLUMNS}
        stats = {key: _number(team.get(key), key) for key in DEFENSE_STATS}
        if any(value is not None and value < 0 for key, value in stats.items() if key not in {"passing_epa", "rushing_epa"}):
            raise ValueError("Negative defensive count")
        records.append({"team": team["team"], "opponent": opponent, "stats": stats,
                        "points_allowed": game["away_score" if team["team"] == game["home"] else "home_score"],
                        "points_scored": game["home_score" if team["team"] == game["home"] else "away_score"],
                        "allowed": allowed})
    return {"game_id": game["game_id"], "season": season, "week": game["week"], "kickoff": game["kickoff"],
            "source_updated_at": bundle.get("updated_at"), "source_sha256": bundle["content_sha256"], "teams": records}


def build_ranking_inputs(root, season, *, now=None):
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    inputs = build_player_value_inputs(root, season, now=now)
    ready = {game["game_id"] for game in inputs["games"] if game["analysis_ready"]}
    games, evidence = [], {}
    for year in (season - 1, season):
        folder = root / "docs/data/game_stats" / str(year)
        index = read_json(folder / "index.json", None)
        if not index or index.get("season") != year or not isinstance(index.get("games"), dict):
            raise ValueError(f"Missing defensive archive for {year}")
        evidence[str(year)] = {"checked_at": index.get("checked_at"), "path": f"data/game_stats/{year}/index.json"}
        for identity, metadata in sorted(index["games"].items()):
            if year == season and identity not in ready:
                continue
            bundle = read_json(folder / f"{identity}.json", None)
            if not bundle or bundle.get("game", {}).get("game_id") != identity or bundle.get("season") != year:
                raise ValueError("Defensive archive identity mismatch")
            if metadata.get("player_rows") != len(bundle.get("players", [])):
                raise ValueError("Defensive archive row count mismatch")
            item = defense_game(bundle, now=now)
            item["provisional"] = year == season  # Reported boxes are not certified finals.
            games.append(item)
    inputs["defense"] = {"schema_version": 1, "games": games, "sources": evidence,
        "scoring": "OB box-score D/ST: 1/sack, 2/interception, 2/opponent fumble recovery, 2/safety, 2/blocked kick, 6/defensive or special-teams TD, 2/defensive conversion. Points-allowed tiers use the full opponent scoreboard total (0:10, 1–6:7, 7–13:4, 14–20:1, 21–27:0, 28–34:-1, 35+:-4). This differs from platforms that exclude defensive-return points.",
        "coverage": {"games": len(games), "current_season_games": len(ready), "teams": len({row["team"] for game in games for row in game["teams"]})}}
    return inputs


def export_ranking_inputs(root, season, *, now=None):
    payload = build_ranking_inputs(root, season, now=now)
    write_atomic(Path(root) / "docs/data/ranking_inputs.json", encoded(payload))
    return payload
