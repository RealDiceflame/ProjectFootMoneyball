"""Import completed weekly seasons without changing today's scoreboard.

The published archive currently exposes regular-season games. Original player
and team downloads also retain postseason rows for later, separately typed use.
These corrected historical observations are not point-in-time prediction data.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import gzip
import hashlib
from io import BytesIO, StringIO
from pathlib import Path
from zoneinfo import ZoneInfo

from app.game_conditions import schedule_conditions
from app.game_stats import GAME_ID, build_game_archive, download, encoded, read_json, write_atomic
from app.scoreboard import SCHEDULE_URL, TEAMS, TEAM_ALIASES, parse_time

# The 2022 Buffalo–Cincinnati game was cancelled and has no official box score.
# The current schedule omits it. Permit an explicitly unscored fixture too, but
# never interpret an arbitrary missing game or missing score as a cancellation.
CANCELLED_GAME = "2022_17_BUF_CIN"
EXPECTED_COMPLETED_GAMES = {year: 256 if year < 2021 else 271 if year == 2022 else 272
                            for year in range(2016, 2026)}
HISTORICAL_TEAMS = TEAMS | {"SD", "OAK", "STL"}


def parse_historical_schedule(text, season, *, now):
    """Require a complete, scored historical schedule with distinct game IDs."""
    if season not in EXPECTED_COMPLETED_GAMES:
        raise ValueError("Historical backfill supports completed seasons 2016–2025")
    if now.tzinfo is None:
        raise ValueError("Collection time requires a timezone")
    reader = csv.DictReader(StringIO(text))
    required = {"game_id", "season", "game_type", "week", "gameday", "gametime",
                "home_team", "away_team", "home_score", "away_score"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Historical schedule columns changed")
    games, appearances = {}, set()
    cancelled_seen = False
    for row in reader:
        if row["season"] != str(season) or row["game_type"] != "REG":
            continue
        if any(row[key] is None for key in required):
            raise ValueError("Truncated historical schedule row")
        identity = row["game_id"].strip()
        if identity == CANCELLED_GAME:
            if cancelled_seen or row["home_score"].strip() or row["away_score"].strip():
                raise ValueError("Cancelled game cannot have an official scored box score")
            cancelled_seen = True
            continue
        home, away = (TEAM_ALIASES.get(row[f"{side}_team"], row[f"{side}_team"])
                      for side in ("home", "away"))
        week = int(row["week"])
        max_week = 17 if season < 2021 else 18
        if (not GAME_ID.fullmatch(identity) or identity != f"{season}_{week:02}_{away}_{home}"
                or identity in games or home == away or not {home, away} <= HISTORICAL_TEAMS
                or not 1 <= week <= max_week
                or any((week, team) in appearances for team in (home, away))):
            raise ValueError(f"Invalid historical game identity: {identity}")
        date = datetime.strptime(row["gameday"], "%Y-%m-%d").date().isoformat()
        if not row["gametime"].strip():
            raise ValueError(f"Missing historical kickoff: {identity}")
        kickoff = datetime.fromisoformat(f"{date}T{row['gametime']}").replace(
            tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc).isoformat()
        if parse_time(kickoff) >= now:
            raise ValueError("Historical game is not in the past")
        scores = []
        for side in ("home", "away"):
            value = row[f"{side}_score"].strip()
            if not value or not value.isdigit() or not 0 <= int(value) <= 200:
                raise ValueError(f"Missing or invalid historical score: {identity}")
            scores.append(int(value))
        games[identity] = {"game_id": identity, "week": week, "home": home, "away": away,
                           "gameday": date, "kickoff": kickoff, "home_score": scores[0],
                           "away_score": scores[1], "season_type": "REG", "status": "final",
                           "completed": True, "historical": True, **schedule_conditions(row),
                           "surface": row.get("surface") or None,
                           "home_coach": row.get("home_coach") or None,
                           "away_coach": row.get("away_coach") or None}
        appearances.update((week, team) for team in (home, away))
    if len(games) != EXPECTED_COMPLETED_GAMES[season]:
        raise ValueError(f"Incomplete historical schedule for {season}: {len(games)} games")
    return games


def backfill_game_stats(root, seasons, *, fetch=download, now=None):
    """Prepare every requested season before publishing any of the new artifacts.

    Failure in a source response leaves the previous archive and current-season
    selection untouched. The final catalogue is written last, making new seasons
    discoverable only after their complete files have been installed.
    """
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    years = sorted(set(seasons))
    if not years or any(type(year) is not int or year not in EXPECTED_COMPLETED_GAMES for year in years):
        raise ValueError("Choose historical seasons from 2016 through 2025")
    content, modified = fetch(SCHEDULE_URL)
    if len(content) > 4_000_000:
        raise ValueError("Historical schedule exceeded size limit")
    # Bound the expanded payload as well as the compressed transfer.
    with gzip.GzipFile(fileobj=BytesIO(content)) as archive:
        schedule_bytes = archive.read(20_000_001)
    if len(schedule_bytes) > 20_000_000:
        raise ValueError("Expanded historical schedule exceeded size limit")
    text = schedule_bytes.decode("utf-8-sig")
    provenance = {"url": SCHEDULE_URL, "sha256": hashlib.sha256(content).hexdigest(),
                  "http_last_modified": modified, "retrieved_at": now.isoformat(),
                  "saved_path": "data/game_stats/historical_schedule.csv.gz"}
    artifacts, counts = {}, {}
    for season in years:
        schedule = parse_historical_schedule(text, season, now=now)
        prepared, count = build_game_archive(root, season, schedule, fetch=fetch, now=now,
                                             historical=True, schedule_source=provenance)
        artifacts.update(prepared)
        counts[season] = count
        print(f"Validated {season}: {count} regular-season games", flush=True)
    artifacts[root / provenance["saved_path"]] = content
    catalogue_path = root / "docs/data/game_stats/index.json"
    catalogue = read_json(catalogue_path, {"schema_version": 1, "seasons": []})
    catalogue["seasons"] = sorted(set(catalogue["seasons"]) | set(years), reverse=True)
    catalogue.setdefault("current_season", max(catalogue["seasons"]))
    catalogue["checked_at"] = now.isoformat()
    for path, data in artifacts.items():
        write_atomic(path, data)
    write_atomic(catalogue_path, encoded(catalogue))
    return counts
