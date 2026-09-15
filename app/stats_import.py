"""Validate saved statistics before any database writes. No network or credentials."""
from dataclasses import dataclass
from datetime import date, datetime
import hashlib
import json
import math
from pathlib import Path
import re

PLAYER_ID = re.compile(r"^00-[0-9]{7}$")
GAME_ID = re.compile(r"^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$")
IDENTITY = {"player_id", "player_name", "player_display_name", "position", "position_group",
            "headshot_url", "season", "week", "season_type", "game_id", "team", "opponent_team"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Source timestamp must include a timezone")
    return parsed


def identifier(value):
    if not isinstance(value, str) or not PLAYER_ID.fullmatch(value):
        raise ValueError("A stable player ID is required; names are not identities")
    return value


def unpack(columns, rows):
    if not isinstance(columns, list) or any(not isinstance(key, str) for key in columns) or len(set(columns)) != len(columns):
        raise ValueError("Duplicate or invalid statistic columns")
    if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != len(columns) for row in rows):
        raise ValueError("Incomplete statistic rows")
    return [dict(zip(columns, row)) for row in rows]


def statistics(row, excluded=IDENTITY):
    stats = {key: value for key, value in row.items() if key not in excluded}
    for key, value in stats.items():
        if value is None:
            continue
        if key.endswith("_list") and isinstance(value, str):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Invalid statistic: {key}")
    return stats


@dataclass
class Snapshot:
    dataset: str
    object_key: str
    source_path: str
    source_updated_at: datetime
    content_hash: str
    file_hash: str
    payload: dict
    players: list
    player_games: list
    team_games: list
    player_seasons: list


def prepare_snapshot(payload, source_path, raw=None):
    players, player_games, team_games, player_seasons = {}, [], [], []
    is_game = "game" in payload
    if is_game:
        if payload.get("schema_version") != 1:
            raise ValueError("Unknown game schema")
        game = payload["game"]
        match = GAME_ID.fullmatch(game.get("game_id", ""))
        if not match or (int(match[1]), int(match[2]), match[3], match[4]) != (
                payload.get("season"), game.get("week"), game.get("away"), game.get("home")):
            raise ValueError("Game identity mismatch")
        if not 1 <= game["week"] <= 18 or game["away"] == game["home"]:
            raise ValueError("Invalid regular-season game")
        dataset, key, updated = "game", game["game_id"], timestamp(payload["updated_at"])
        if timestamp(game["kickoff"]) > updated:
            raise ValueError("Stats cannot precede kickoff")
        seen = set()
        for kind in ("players", "teams"):
            records = unpack(payload["player_columns" if kind == "players" else "team_columns"], payload[kind])
            for row in records:
                if (row.get("game_id"), row.get("season"), row.get("week"), row.get("season_type")) != (key, payload["season"], game["week"], "REG"):
                    raise ValueError("Statistic row belongs to another game")
                if {row.get("team"), row.get("opponent_team")} != {game["home"], game["away"]}:
                    raise ValueError("Statistic team mismatch")
                stats = statistics(row)
                if kind == "teams":
                    team_games.append({"team": row["team"], "opponent_team": row["opponent_team"], "stats": stats})
                    continue
                player_id = row.get("player_id")
                if player_id:
                    identifier(player_id)
                    if not row.get("player_display_name"):
                        raise ValueError("Named player has no display name")
                    players[player_id] = {"player_id": player_id, "name": row["player_display_name"], "birth_date": None}
                row_key = "player:" + player_id if player_id else "anonymous:" + row["team"]
                if row_key in seen:
                    raise ValueError("Duplicate player observation")
                seen.add(row_key)
                player_games.append({"row_key": row_key, "player_id": player_id or None,
                    "player_name": row.get("player_display_name"), "team": row["team"],
                    "opponent_team": row["opponent_team"], "position": row.get("position"), "stats": stats})
            if {row["team"] for row in records} != {game["home"], game["away"]}:
                raise ValueError("One team's statistics are missing")
        if len(team_games) != 2:
            raise ValueError("Expected exactly two team totals")
        content = {key: payload[key] for key in ("schema_version", "season", "game", "player_columns", "players", "team_columns", "teams")}
    else:
        dataset, key, updated = "player_history", "maintained_history", timestamp(payload["generated_at"])
        if not isinstance(payload.get("players"), dict) or not payload["players"]:
            raise ValueError("Player history is empty")
        seen = set()
        for entry in payload["players"].values():
            player_id = identifier(entry.get("player_id"))
            if player_id in players:
                raise ValueError("Duplicate historical player identity")
            birth = entry.get("birth_date")
            if birth:
                date.fromisoformat(birth)
            if not isinstance(entry.get("player"), str) or not entry["player"].strip():
                raise ValueError("Player name is missing")
            players[player_id] = {"player_id": player_id, "name": entry["player"], "birth_date": birth}
            for row in unpack(payload["columns"], entry["seasons"]):
                season = row.get("season")
                if isinstance(season, bool) or not isinstance(season, int) or not 1900 <= season <= 2200:
                    raise ValueError("Invalid historical season")
                if (player_id, season) in seen:
                    raise ValueError("Duplicate player season")
                seen.add((player_id, season))
                if not row.get("pos"):
                    raise ValueError("Missing historical position")
                stats = statistics(row, {"season", "team", "pos"})
                player_seasons.append({"player_id": player_id, "season": season,
                    "recent_team": row.get("team"), "position": row["pos"], "stats": stats})
        if len(player_seasons) != payload.get("player_season_count"):
            raise ValueError("Historical row count does not match its manifest")
        content = {key: value for key, value in payload.items() if key != "generated_at"}
    content_hash = hashlib.sha256(canonical(content).encode("utf-8")).hexdigest()
    file_hash = hashlib.sha256(raw if raw is not None else canonical(payload).encode("utf-8")).hexdigest()
    return Snapshot(dataset, key, source_path, updated, content_hash, file_hash, payload,
                    list(players.values()), player_games, team_games, player_seasons)


def load_saved_stats(root):
    root = Path(root)
    folder = root / "docs/data/game_stats"
    catalogue = json.loads((folder / "index.json").read_text(encoding="utf-8"))
    paths = [root / "docs/data/player_history.json"]
    for season in catalogue["seasons"]:
        if isinstance(season, bool) or not isinstance(season, int) or not 1900 <= season <= 2200:
            raise ValueError("Invalid archive season")
        index = json.loads((folder / str(season) / "index.json").read_text(encoding="utf-8"))
        for game_id in sorted(index["games"]):
            if not GAME_ID.fullmatch(game_id) or not game_id.startswith(str(season) + "_"):
                raise ValueError("Invalid archived game key")
            paths.append(folder / str(season) / f"{game_id}.json")
    snapshots = []
    for path in paths:
        raw = path.read_bytes()
        data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
        snapshot = prepare_snapshot(data, path.relative_to(root).as_posix(), raw)
        if snapshot.dataset == "game" and snapshot.object_key != path.stem:
            raise ValueError("Archive filename and game identity disagree")
        snapshots.append(snapshot)
    return snapshots


def import_plan(snapshots):
    return {"snapshots": len(snapshots),
            "players": len({row["player_id"] for snapshot in snapshots for row in snapshot.players}),
            "games": sum(snapshot.dataset == "game" for snapshot in snapshots),
            "player_game_rows": sum(len(snapshot.player_games) for snapshot in snapshots),
            "team_game_rows": sum(len(snapshot.team_games) for snapshot in snapshots),
            "player_season_rows": sum(len(snapshot.player_seasons) for snapshot in snapshots)}
