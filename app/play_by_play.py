"""Validated 2025 regular-season play-by-play, isolated from box-score totals."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import gzip
import hashlib
from io import BytesIO, StringIO
import math
from pathlib import Path
import re

from app.game_stats import GSIS_ID, download, encoded, read_json, write_atomic
from app.game_stats_backfill import parse_historical_schedule
from app.scoreboard import SCHEDULE_URL

PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.csv.gz"
ROLES = ("passer", "rusher", "receiver")
NUMBERS = {
    "play_id": (1, 100000), "order_sequence": (1, 100000), "qtr": (1, 5),
    "fixed_drive": (1, 100), "down": (1, 4), "ydstogo": (0, 100),
    "yardline_100": (0, 100), "yards_gained": (-100, 100),
    "total_home_score": (0, 200), "total_away_score": (0, 200),
    "sp": (0, 1), "penalty": (0, 1), "touchdown": (0, 1),
    "safety": (0, 1),
}
REQUIRED = set(NUMBERS) | {"game_id", "season", "season_type", "week", "home_team",
    "away_team", "home_score", "away_score", "posteam", "defteam", "time", "yrdln",
    "desc", "play_type", "fixed_drive_result"} | {
        f"{role}_player_{field}" for role in ROLES for field in ("id", "name")}
NULLS = {"", "NA"}
CLOCK = re.compile(r"^(?:[0-9]|[0-5][0-9]):[0-5][0-9]$")


def expanded(content, limit):
    with gzip.GzipFile(fileobj=BytesIO(content)) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Expanded source exceeded size limit")
    return data.decode("utf-8-sig")


def number(value, low, high, *, required=False):
    if value in NULLS:
        if required:
            raise ValueError("Required play number is missing")
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise ValueError("Invalid play number") from exc
    if not math.isfinite(result) or not result.is_integer() or not low <= result <= high:
        raise ValueError("Play number out of range")
    return int(result)


def text(value):
    return None if value in NULLS else value


def clock(value, *, period=False):
    value = text(value)
    if value is not None and (not CLOCK.fullmatch(value) or (period and int(value.split(":")[0]) * 60 + int(value.split(":")[1]) > 900)):
        raise ValueError("Invalid play clock")
    return value


def parse_plays(content, schedule):
    reader = csv.DictReader(StringIO(expanded(content, 150_000_000)))
    columns = reader.fieldnames or []
    if not REQUIRED <= set(columns) or len(columns) != len(set(columns)):
        raise ValueError("Play-by-play source columns changed")
    grouped, drives, seen, post_rows = {}, {}, set(), 0
    for source in reader:
        if None in source or any(v is None for v in source.values()):
            raise ValueError("Truncated or over-wide play row")
        row = {k: v.strip() for k, v in source.items()}
        if row["season"] != "2025" or row["season_type"] not in {"REG", "POST"}:
            raise ValueError("Unexpected play season or type")
        if row["season_type"] == "POST":
            post_rows += 1
            continue
        identity = row["game_id"]
        game = schedule.get(identity)
        if (not game or row["home_team"] != game["home"] or row["away_team"] != game["away"]
                or number(row["week"], 1, 18, required=True) != game["week"]):
            raise ValueError(f"Play game identity mismatch: {identity}")
        for side in ("home", "away"):
            if number(row[f"{side}_score"], 0, 200, required=True) != game[f"{side}_score"]:
                raise ValueError(f"Final score differs from schedule: {identity}")
        required_numbers = {"play_id", "order_sequence", "qtr", "fixed_drive", "ydstogo", "total_home_score", "total_away_score", "sp"}
        values = {key: number(row[key], *bounds, required=key in required_numbers) for key, bounds in NUMBERS.items()}
        key = (identity, values["play_id"])
        if key in seen:
            raise ValueError("Duplicate game/play identity")
        seen.add(key)
        sides = {game["home"], game["away"]}
        offense, defense = text(row["posteam"]), text(row["defteam"])
        if (offense is not None and offense not in sides) or (defense is not None and defense not in sides) or (offense and offense == defense):
            raise ValueError("Invalid possession or defense team")
        if not row["desc"] or len(row["desc"]) > 12000:
            raise ValueError("Missing or excessive play description")
        players = []
        for role in ROLES:
            player_id, name = (text(row[f"{role}_player_{field}"]) for field in ("id", "name"))
            if player_id and not GSIS_ID.fullmatch(player_id):
                raise ValueError("Invalid explicit NFL player ID")
            if player_id or name:
                players.append({"role": role, "player_id": player_id, "name": name})
        play = {"play_id": values["play_id"], "order": values["order_sequence"],
            "quarter": values["qtr"], "clock": clock(row["time"], period=True),
            "drive": values["fixed_drive"], "possession_team": offense, "defense_team": defense,
            "down": values["down"], "yards_to_go": values["ydstogo"], "yardline": text(row["yrdln"]),
            "yards_to_goal": values["yardline_100"], "yards_gained": values["yards_gained"],
            "description": row["desc"], "play_type": text(row["play_type"]),
            "home_score": values["total_home_score"], "away_score": values["total_away_score"],
            "scoring": bool(values["sp"]), "penalty": values["penalty"],
            "touchdown": values["touchdown"], "safety": values["safety"], "players": players}
        grouped.setdefault(identity, []).append(play)
        drive = drives.setdefault(identity, {}).setdefault(play["drive"], {
            "drive": play["drive"], "start_team": None, "result": None})
        result = text(row["fixed_drive_result"])
        if result is not None:
            if drive["result"] is not None and drive["result"] != result:
                raise ValueError("Conflicting corrected drive result")
            drive["result"] = result
    if not grouped or set(grouped) != set(schedule):
        raise ValueError("Incomplete regular-season play coverage")
    for identity, plays in grouped.items():
        plays.sort(key=lambda p: p["order"])
        if len(plays) > 1000 or len({p["order"] for p in plays}) != len(plays):
            raise ValueError("Duplicate play order or excessive game rows")
        prior = {"quarter": 1, "drive": 1, "home_score": 0, "away_score": 0}
        for play in plays:
            drive = drives[identity][play["drive"]]
            # Defensive touchdowns can put the OTHER offense on the ensuing PAT
            # within the same corrected drive. Label its starting possession only.
            if drive["start_team"] is None and play["possession_team"] is not None:
                drive["start_team"] = play["possession_team"]
            if any(play[k] < prior[k] for k in ("quarter", "drive", "home_score", "away_score")):
                raise ValueError("Play order or score regressed; source correction needs review")
            delta = play["home_score"] + play["away_score"] - prior["home_score"] - prior["away_score"]
            if (delta != 0) != play["scoring"]:
                raise ValueError("Scoring flag disagrees with running score")
            prior = play
        if any(plays[-1][f"{side}_score"] != schedule[identity][f"{side}_score"] for side in ("home", "away")):
            raise ValueError("Incomplete final play score")
        if (plays[-1]["quarter"] < 4 or plays[-1]["clock"] is None
                or (plays[-1]["quarter"] == 4 and plays[-1]["clock"] != "00:00")
                or plays[-1]["description"] != "END GAME"):
            raise ValueError("Missing end-of-game record")
    return grouped, drives, {"source_columns": len(columns), "regular_season_rows": sum(map(len, grouped.values())), "postseason_rows_retained_raw": post_rows}


def refresh_play_by_play(root, *, fetch=download, now=None):
    """Validate all 272 games before any writes; keep raw bytes and publish catalogue last."""
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Collection time requires a timezone")
    prior_sources = read_json(root / "data/play_by_play/2025/provenance.json", {})
    sources, artifacts, downloads = {}, {}, {}
    for key, url, filename in (("schedule", SCHEDULE_URL, "games.csv.gz"), ("plays", PBP_URL, "play_by_play_2025.csv.gz")):
        content, modified = fetch(url)
        digest = hashlib.sha256(content).hexdigest()
        path = f"data/play_by_play/sources/{digest}-{filename}"
        sources[key] = {"url": url, "sha256": digest, "http_last_modified": modified,
                        "retrieved_at": now.isoformat(), "saved_path": path}
        if prior_sources.get(key, {}).get("sha256") == digest:
            sources[key] = prior_sources[key]
        artifacts[root / path] = content
        downloads[key] = content
    schedule = parse_historical_schedule(expanded(downloads["schedule"], 20_000_000), 2025, now=now)
    grouped, drives, audit = parse_plays(downloads["plays"], schedule)
    destination = root / "docs/data/play_by_play/2025"
    previous_index = read_json(destination / "index.json", {"games": {}})
    if not set(previous_index["games"]) <= set(grouped):
        raise ValueError("Previously archived play games disappeared")
    index = {}
    for identity, plays in grouped.items():
        path = destination / f"{identity}.json"
        previous = read_json(path, None)
        if previous and not {p["play_id"] for p in previous["plays"]} <= {p["play_id"] for p in plays}:
            raise ValueError("Previously archived plays disappeared; review correction")
        game = {key: schedule[identity][key] for key in ("game_id", "week", "away", "home", "away_score", "home_score")}
        coverage = {"status": "complete", "events": len(plays), "drives": len(drives[identity]),
                    "scoring_events": sum(p["scoring"] for p in plays),
                    "missing_clocks": sum(p["clock"] is None for p in plays)}
        values = {"schema_version": 1, "season": 2025, "season_type": "REG", "game_id": identity,
                  "game": game, "coverage": coverage, "plays": plays,
                  "drives": sorted(drives[identity].values(), key=lambda d: d["drive"])}
        digest = hashlib.sha256(encoded(values)).hexdigest()
        artifact = {**values, "content_sha256": digest, "updated_at": now.isoformat(), "sources": sources}
        if previous and previous.get("content_sha256") == digest:
            artifact["updated_at"] = previous["updated_at"]
        artifacts[path] = encoded(artifact)
        index[identity] = {"week": game["week"], **coverage}
    summary = {"schema_version": 1, "season": 2025, "season_type": "REG", "checked_at": now.isoformat(),
               "expected_games": len(schedule), "reported_games": len(grouped), "missing_games": [],
               "coverage_status": "complete", **audit, "sources": sources, "games": index}
    if all(previous_index.get(k) == summary[k] for k in summary if k != "checked_at"):
        summary["checked_at"] = previous_index["checked_at"]
    artifacts[destination / "index.json"] = encoded(summary)
    artifacts[root / "data/play_by_play/2025/provenance.json"] = encoded(sources)
    changed = False
    for path, content in artifacts.items():
        if not path.exists() or path.read_bytes() != content:
            write_atomic(path, content)
            changed = True
    catalogue = root / "docs/data/play_by_play/index.json"
    if changed or not catalogue.exists():
        write_atomic(catalogue, encoded({"schema_version": 1, "seasons": [2025], "checked_at": now.isoformat()}))
    return {key: summary[key] for key in ("reported_games", "regular_season_rows", "postseason_rows_retained_raw", "coverage_status")}
