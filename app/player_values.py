"""Export scoring-neutral player observations from the saved game archive only.

Rows are recorded appearances, not an active-roster ledger. A missing player row
must never be converted into a zero game, injury, or inactive designation. The
score snapshot currently has reported scores, not an explicit final/live flag;
its completion inference is exposed and those observations remain provisional.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import math
from pathlib import Path
import re

from app.game_stats import GAME_ID, encoded, read_json, write_atomic
from app.scoreboard import parse_time

POSITIONS = {"QB", "RB", "WR", "TE"}
GSIS_ID = re.compile(r"^00-\d{7}$")
STAT_COLUMNS = (
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "carries", "rushing_yards", "rushing_tds", "targets", "receptions",
    "receiving_yards", "receiving_tds", "fumbles_lost_total",
    "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions",
    "special_teams_tds",
)
OBSERVATION_COLUMNS = (
    "player_id", "player", "pos", "team", "opponent", "week", "game_id",
    "gameday", "kickoff", "status", "provisional", "analysis_ready", *STAT_COLUMNS,
)
IDENTITY_COLUMNS = {"player_id", "player_display_name", "position", "team",
                    "opponent_team", "game_id", "season", "season_type", "week"}


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _number(value, key):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid archived statistic: {key}")
    return value


def _schedule_game(game, season):
    if not isinstance(game, dict) or not isinstance(game.get("game_id"), str) or not GAME_ID.fullmatch(game["game_id"]):
        raise ValueError("Invalid saved schedule game")
    identity = game["game_id"]
    if not identity.startswith(f"{season}_") or type(game.get("week")) is not int or not 1 <= game["week"] <= 18:
        raise ValueError(f"Mismatched schedule season/week: {identity}")
    home, away = _text(game.get("home")), _text(game.get("away"))
    if not home or not away or home == away or identity != f"{season}_{game['week']:02}_{away}_{home}":
        raise ValueError(f"Mismatched schedule teams: {identity}")
    try:
        datetime.strptime(game["gameday"], "%Y-%m-%d")
        if game.get("kickoff") is not None:
            parse_time(game["kickoff"])
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise ValueError(f"Invalid schedule date: {identity}") from error
    for side in ("home", "away"):
        score = game.get(f"{side}_score")
        if score is not None and (type(score) is not int or not 0 <= score <= 200):
            raise ValueError(f"Invalid reported score: {identity}")
    return game


def _game_status(game, now):
    # Honor explicit future format additions, but do not manufacture a final flag.
    source_status = _text(game.get("status")).lower()
    explicit_final = game.get("completed") is True or source_status in {"final", "completed", "complete"}
    explicit_live = game.get("completed") is False or source_status in {"live", "in_progress", "in progress", "scheduled", "postponed", "canceled", "cancelled"}
    reported = all(game.get(f"{side}_score") is not None for side in ("home", "away"))
    kickoff = parse_time(game["kickoff"]) if game.get("kickoff") else None
    if explicit_final:
        return "final", True, False, "explicit_final", reported
    if explicit_live:
        return source_status or "not_completed", False, True, "explicit_not_final", reported
    if reported:
        return "reported", True, True, "reported_score_pair", True
    if kickoff is not None and kickoff > now:
        return "scheduled", False, True, "kickoff_in_future", False
    return ("started" if kickoff is not None else "unknown"), None, True, "completion_unknown", False


def _unpack(bundle, kind, game):
    columns = bundle.get("player_columns" if kind == "players" else "team_columns")
    rows = bundle.get(kind)
    required = IDENTITY_COLUMNS if kind == "players" else {"game_id", "team"}
    if not isinstance(columns, list) or not all(isinstance(key, str) and key for key in columns) \
            or len(columns) != len(set(columns)) or not required.issubset(columns) or not isinstance(rows, list):
        raise ValueError(f"Invalid archived {kind} columns")
    result = []
    for values in rows:
        if not isinstance(values, list) or len(values) != len(columns):
            raise ValueError(f"Truncated archived {kind} row")
        row = dict(zip(columns, values))
        if row["game_id"] != game["game_id"] or row["team"] not in {game["home"], game["away"]}:
            raise ValueError("Archived row game/team mismatch")
        result.append(row)
    return result


def build_player_value_inputs(root, season, *, now=None):
    """Read validated saved files, returning a compact browser-ready payload.

    No network, roster lookup, rankings filter, scoring model, or archive writes
    are involved. All validation finishes before the caller publishes anything.
    """
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Export time requires a timezone")
    folder = root / "docs/data/game_stats" / str(season)
    index = read_json(folder / "index.json", None)
    board = read_json(root / "docs/data/scores.json", None)
    if not isinstance(index, dict) or index.get("schema_version") != 1 or index.get("season") != season or not isinstance(index.get("games"), dict):
        raise ValueError("No valid saved game archive for this season")
    if not isinstance(board, dict) or board.get("season") != season or not isinstance(board.get("games"), list):
        raise ValueError("No matching saved score schedule for this season")
    schedule = {}
    for game in board["games"]:
        game = _schedule_game(game, season)
        if game["game_id"] in schedule:
            raise ValueError("Duplicate saved schedule game")
        schedule[game["game_id"]] = game
    if not schedule:
        raise ValueError("Empty saved score schedule")
    records, games, seen, skipped = [], [], set(), {"non_offensive": 0, "unnamed_or_anonymous": 0}
    missing_stats = {key: 0 for key in STAT_COLUMNS}
    for identity in index["games"]:
        if identity not in schedule:
            raise ValueError(f"Archived game missing from saved schedule: {identity}")
    for identity, game in sorted(schedule.items(), key=lambda pair: (pair[1]["week"], pair[1]["gameday"], pair[0])):
        status, completed, provisional, basis, reported = _game_status(game, now)
        available = identity in index["games"]
        elapsed = bool(game.get("kickoff") and now - parse_time(game["kickoff"]) >= timedelta(hours=8))
        analysis_ready = available and (basis == "explicit_final" or (reported and elapsed and basis != "explicit_not_final"))
        if analysis_ready and basis != "explicit_final":
            basis = "elapsed_8h_and_archived"
        item = {key: game.get(key) for key in ("game_id", "week", "home", "away", "gameday", "kickoff", "home_score", "away_score")}
        item.update(status=status, completed=completed, provisional=provisional,
                    completion_basis=basis, score_reported=reported, stats_available=available, analysis_ready=analysis_ready,
                    source_updated_at=None, source_first_collected_at=None, source_sha256=None)
        if available:
            bundle = read_json(folder / f"{identity}.json", None)
            metadata = index["games"][identity]
            if not isinstance(bundle, dict) or bundle.get("schema_version") != 1 or bundle.get("season") != season or not isinstance(metadata, dict):
                raise ValueError(f"Invalid saved game artifact: {identity}")
            archived_game = _schedule_game(bundle.get("game"), season)
            if any(archived_game.get(key) != game.get(key) for key in ("game_id", "week", "home", "away", "gameday", "kickoff")):
                raise ValueError(f"Archived schedule identity changed: {identity}")
            if any(metadata.get(key) != game[key] for key in ("week", "home", "away")):
                raise ValueError(f"Archive index identity mismatch: {identity}")
            teams = _unpack(bundle, "teams", game)
            players = _unpack(bundle, "players", game)
            if len(teams) != 2 or {row["team"] for row in teams} != {game["home"], game["away"]} \
                    or {row["team"] for row in players} != {game["home"], game["away"]}:
                raise ValueError(f"Incomplete archived team coverage: {identity}")
            if metadata.get("player_rows") != len(players):
                raise ValueError(f"Archive player row count mismatch: {identity}")
            if bundle.get("content_sha256"):
                content = {key: bundle[key] for key in ("schema_version", "season", "game", "team_columns", "teams", "player_columns", "players")}
                if hashlib.sha256(encoded(content)).hexdigest() != bundle["content_sha256"]:
                    raise ValueError(f"Archive checksum mismatch: {identity}")
            item.update(source_updated_at=bundle.get("updated_at"), source_first_collected_at=bundle.get("first_collected_at"),
                        source_sha256=bundle.get("content_sha256"))
            for row in players:
                if row["season"] != season or row["season_type"] != "REG" or row["week"] != game["week"] \
                        or row["opponent_team"] not in {game["home"], game["away"]} or row["opponent_team"] == row["team"]:
                    raise ValueError("Archived player season/week/opponent mismatch")
                player_id = _text(row["player_id"])
                if player_id:
                    if not GSIS_ID.fullmatch(player_id):
                        raise ValueError("Invalid archived GSIS player ID")
                    if (identity, player_id) in seen:
                        raise ValueError("Duplicate archived player game")
                    seen.add((identity, player_id))
                position = {"FB": "RB", "HB": "RB"}.get(row["position"], row["position"])
                if position not in POSITIONS:
                    skipped["non_offensive"] += 1
                    continue
                name = _text(row["player_display_name"]) or _text(row.get("player_name"))
                if not player_id or not name:
                    skipped["unnamed_or_anonymous"] += 1
                    continue
                observation = {"player_id": player_id, "player": name, "pos": position,
                               "team": row["team"], "opponent": row["opponent_team"], "week": game["week"],
                               "game_id": identity, "gameday": game["gameday"], "kickoff": game.get("kickoff"),
                               "status": status, "provisional": provisional, "analysis_ready": analysis_ready}
                for key in STAT_COLUMNS:
                    observation[key] = _number(row.get(key), key)
                    missing_stats[key] += observation[key] is None
                records.append(observation)
        games.append(item)
    records.sort(key=lambda row: (row["week"], row["gameday"], row["game_id"], row["player_id"]))

    def coverage(subset):
        completed = [game for game in subset if game["completed"] is True]
        archived = [game for game in subset if game["stats_available"]]
        return {"scheduled_games": len(subset), "completed_games": len(completed), "archived_games": len(archived),
                "completed_with_stats": sum(game["stats_available"] for game in completed),
                "analysis_ready_games": sum(game["analysis_ready"] for game in subset),
                "analysis_ready_game_ids": [game["game_id"] for game in subset if game["analysis_ready"]],
                "completed_game_ids": [game["game_id"] for game in completed],
                "archived_game_ids": [game["game_id"] for game in archived],
                "pending_stats_game_ids": [game["game_id"] for game in completed if not game["stats_available"]],
                "completion_unknown_game_ids": [game["game_id"] for game in subset if game["completed"] is None],
                "remaining_game_ids": [game["game_id"] for game in subset if game["completed"] is not True]}

    teams = sorted({game[side] for game in games for side in ("home", "away")})
    details = coverage(games)
    details.update(player_count=len({row["player_id"] for row in records}), observation_count=len(records),
                   missing_stat_counts=missing_stats, skipped_rows=skipped,
                   teams={team: coverage([game for game in games if team in (game["home"], game["away"])]) for team in teams})
    return {"schema_version": 1, "season": season, "season_type": "REG", "generated_at": now.isoformat(),
            "sources": {"archive": {"path": f"data/game_stats/{season}/index.json", "checked_at": index.get("checked_at"), "sources": index.get("sources", {})},
                        "scores": {"path": "data/scores.json", "checked_at": board.get("checked_at"), "score_type": board.get("score_type"), "source": board.get("source")}},
            "semantics": {"identity": "GSIS player_id only; FB/HB normalized to RB",
                          "observations": "Recorded stat rows only. No row does not establish a zero game, activity, roster membership, or health.",
                          "missing_stats": "null is unavailable, not zero; fumbles_lost_total is not fumbles_total",
                          "completion": "completed includes reported-score-pair inference; inspect completion_basis. Only explicit final evidence clears provisional.",
                          "analysis_ready": "Archived stats plus a reported score pair at least 8 hours after kickoff, or explicit final evidence. This is not certified final status.",
                          "revisions": "Saved statistics may be corrected; source collection dates and checksums are preserved, not backdated."},
            "columns": list(OBSERVATION_COLUMNS), "rows": [[row[key] for key in OBSERVATION_COLUMNS] for row in records],
            "games": games, "coverage": details}


def export_player_value_inputs(root, season, *, now=None, destination=None):
    payload = build_player_value_inputs(root, season, now=now)
    target = Path(destination) if destination is not None else Path(root) / "docs/data/player_value_inputs.json"
    write_atomic(target, encoded(payload))
    return payload
