"""Validated PFR/nflverse participation sidecars, separate from box-score totals."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import gzip
import hashlib
from io import BytesIO, StringIO
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from app.game_stats import (GAME_ID, GSIS_ID, download, encoded, read_json,
                            team_for_game, write_atomic)
from app.game_stats_backfill import EXPECTED_COMPLETED_GAMES, parse_historical_schedule
from app.scoreboard import SCHEDULE_URL, TEAM_ALIASES

SNAPS_URL = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv"
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
PFR_ID = re.compile(r"^[A-Za-z0-9._'-]{1,32}$")
CATEGORIES = ("offense", "defense", "st")
# Reviewed source defects: preserve raw value and count, never clamp to 100%.
PERCENTAGE_EXCEPTIONS = {
    (2021, "2021_13_IND_HOU", "MoorA.00", "st_pct", "1.01"),
    (2021, "2021_13_IND_HOU", "SmitTr04", "st_pct", "1.01"),
    (2021, "2021_15_SEA_LA", "HoecMi00", "st_pct", "1.01"),
}
REQUIRED = {"game_id", "pfr_game_id", "season", "game_type", "week", "player",
            "pfr_player_id", "position", "team", "opponent"} | {
                f"{category}_{suffix}" for category in CATEGORIES for suffix in ("snaps", "pct")}


def csv_rows(content, required):
    reader = csv.DictReader(StringIO(content.decode("utf-8-sig")))
    columns = reader.fieldnames or []
    if not required <= set(columns) or len(columns) != len(set(columns)):
        raise ValueError("Snap source columns changed")
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError("Truncated or over-wide source row")
        yield {key: value.strip() for key, value in row.items()}


def player_links(content):
    """Only explicit one-to-one PFR/GSIS links; conflicting IDs remain unlinked."""
    candidates, reverse = {}, {}
    for row in csv_rows(content, {"pfr_id", "gsis_id"}):
        pfr, gsis = row["pfr_id"], row["gsis_id"]
        if not pfr or not gsis:
            continue
        if not PFR_ID.fullmatch(pfr):
            raise ValueError("Malformed PFR identity in player source")
        if not GSIS_ID.fullmatch(gsis):
            # nflverse also lists legacy identifiers for pre-modern NFL players.
            # They are not compatible with our canonical GSIS namespace.
            continue
        candidates.setdefault(pfr, set()).add(gsis)
        reverse.setdefault(gsis, set()).add(pfr)
    ambiguous = {pfr for pfr, ids in candidates.items()
                 if len(ids) != 1 or any(len(reverse[gsis]) != 1 for gsis in ids)}
    return {pfr: next(iter(ids)) for pfr, ids in candidates.items() if pfr not in ambiguous}, ambiguous


def parse_schedule(content, season, now):
    with gzip.GzipFile(fileobj=BytesIO(content)) as stream:
        expanded = stream.read(20_000_001)
    if len(expanded) > 20_000_000:
        raise ValueError("Expanded schedule exceeded size limit")
    rows = list(csv_rows(expanded, {"game_id", "season", "game_type", "week", "pfr",
                                  "away_team", "home_team", "gameday", "gametime",
                                  "home_score", "away_score"}))
    historical = season in EXPECTED_COMPLETED_GAMES
    if historical:
        games = parse_historical_schedule(expanded.decode("utf-8-sig"), season, now=now)
    else:
        games = {}
        for row in rows:
            if row["season"] != str(season) or row["game_type"] != "REG":
                continue
            identity = row["game_id"]
            week = int(row["week"])
            away, home = (TEAM_ALIASES.get(row[key], row[key]) for key in ("away_team", "home_team"))
            if (not GAME_ID.fullmatch(identity) or identity != f"{season}_{week:02}_{away}_{home}"
                    or away == home or not 1 <= week <= 18):
                raise ValueError("Invalid schedule game identity")
            # Only scored, past fixtures can have published participation.
            if not row["home_score"] or not row["away_score"]:
                continue
            kickoff = datetime.fromisoformat(f"{row['gameday']}T{row['gametime']}").replace(
                tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc)
            if kickoff >= now:
                raise ValueError("Scored schedule game has future kickoff")
            if identity in games:
                raise ValueError("Duplicate schedule game")
            games[identity] = {"game_id": identity, "week": week, "away": away, "home": home}
    pfr_seen = set()
    for row in rows:
        if row["game_id"] not in games:
            continue
        pfr = row["pfr"]
        if not pfr or not PFR_ID.fullmatch(pfr) or pfr in pfr_seen:
            raise ValueError("Missing or duplicate schedule PFR game identity")
        pfr_seen.add(pfr)
        games[row["game_id"]]["pfr_game_id"] = pfr
    return games


def numeric(value, *, percentage):
    if not value:
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise ValueError("Non-numeric participation value") from exc
    if not math.isfinite(result) or not 0 <= result <= (1 if percentage else 300):
        raise ValueError("Participation value out of range")
    if not percentage and not result.is_integer():
        raise ValueError("Fractional snap count")
    return result if percentage else int(result)


def parse_snaps(content, season, schedule, links, ambiguous):
    games, seen = {}, set()
    for row in csv_rows(content, REQUIRED):
        if row["season"] != str(season):
            raise ValueError("Unexpected season in snap source")
        if row["game_type"] != "REG":
            if row["game_type"] not in {"POST", "WC", "DIV", "CON", "SB", "PRE"}:
                raise ValueError("Unknown snap game type")
            continue
        identity, pfr = row["game_id"], row["pfr_player_id"]
        game = schedule.get(identity)
        if not game or not GAME_ID.fullmatch(identity):
            raise ValueError(f"Unknown or uncompleted snap game: {identity}")
        if row["pfr_game_id"] != game["pfr_game_id"] or int(row["week"]) != game["week"]:
            raise ValueError(f"Snap game identity mismatch: {identity}")
        team, opponent = (team_for_game(row[key], game) for key in ("team", "opponent"))
        if {team, opponent} != {game["away"], game["home"]} or team == opponent:
            raise ValueError(f"Snap opponent mismatch: {identity}")
        if not PFR_ID.fullmatch(pfr) or not row["player"]:
            raise ValueError("Missing snap player identity")
        if (identity, pfr) in seen:
            raise ValueError("Duplicate snap player/game row")
        seen.add((identity, pfr))
        player = {"pfr_player_id": pfr, "player_id": links.get(pfr),
                  "player_name": row["player"], "position": row["position"] or None,
                  "team": team, "mapping_status": "mapped" if pfr in links else "ambiguous" if pfr in ambiguous else "unmapped"}
        for category in CATEGORIES:
            count = numeric(row[f"{category}_snaps"], percentage=False)
            pct_key = f"{category}_pct"
            if (season, identity, pfr, pct_key, row[pct_key]) in PERCENTAGE_EXCEPTIONS:
                pct = None
                player.setdefault("data_issues", []).append({"field": pct_key,
                    "source_value": row[pct_key], "reason": "Source percentage exceeds 100%; unavailable"})
            else:
                pct = numeric(row[pct_key], percentage=True)
            if count == 0 and pct not in (None, 0):
                raise ValueError("Positive percentage with zero snaps")
            player[f"{category}_snaps"], player[f"{category}_pct"] = count, pct
        games.setdefault(identity, []).append(player)
    if not games:
        raise ValueError("Empty regular-season snap source")
    for identity, players in games.items():
        if {player["team"] for player in players} != {schedule[identity]["home"], schedule[identity]["away"]}:
            raise ValueError(f"Missing snap team in {identity}")
        gsis = [player["player_id"] for player in players if player["player_id"]]
        if len(gsis) != len(set(gsis)):
            raise ValueError("Duplicate canonical player in snap game")
        players.sort(key=lambda p: (p["team"], p["pfr_player_id"]))
    return games


def build_season(root, season, content, schedule, links, ambiguous, sources, now):
    grouped = parse_snaps(content, season, schedule, links, ambiguous)
    if season in EXPECTED_COMPLETED_GAMES and set(grouped) != set(schedule):
        raise ValueError(f"Incomplete historical snap coverage for {season}")
    root = Path(root)
    destination = root / "docs/data/snap_counts" / str(season)
    prior_index = read_json(destination / "index.json", {"games": {}})
    if not set(prior_index["games"]) <= set(grouped):
        raise ValueError("Previously archived snap games disappeared")
    artifacts, index, unmatched, issues = {}, {}, {}, []
    for identity, players in grouped.items():
        path = destination / f"{identity}.json"
        previous = read_json(path, None)
        if previous:
            prior_ids = {p["pfr_player_id"] for p in previous["players"]}
            if not prior_ids <= {p["pfr_player_id"] for p in players}:
                raise ValueError("Previously archived snap participants disappeared; review correction")
        for player in players:
            for issue in player.get("data_issues", []):
                issues.append({"game_id": identity, "pfr_player_id": player["pfr_player_id"], **issue})
            if not player["player_id"]:
                entry = unmatched.setdefault(player["pfr_player_id"], {
                    "pfr_player_id": player["pfr_player_id"], "player_name": player["player_name"],
                    "mapping_status": player["mapping_status"], "games": []})
                entry["games"].append(identity)
        mapped = sum(p["player_id"] is not None for p in players)
        coverage = {"status": "reported", "source_rows": len(players), "mapped_rows": mapped,
                    "unmapped_rows": len(players) - mapped,
                    "source_issues": sum(len(p.get("data_issues", [])) for p in players),
                    "teams": sorted({p["team"] for p in players})}
        values = {"schema_version": 1, "season": season, "game_id": identity,
                  "players": players, "coverage": coverage}
        digest = hashlib.sha256(encoded(values)).hexdigest()
        artifact = {**values, "content_sha256": digest, "updated_at": now.isoformat(), "sources": sources}
        if previous and previous.get("content_sha256") == digest and previous.get("sources") == sources:
            artifact = previous
        elif previous and previous.get("content_sha256") == digest:
            artifact["updated_at"] = previous["updated_at"]
        artifacts[path] = encoded(artifact)
        index[identity] = {**coverage, "week": schedule[identity]["week"], "updated_at": artifact["updated_at"]}
    missing = sorted(set(schedule) - set(grouped))
    summary = {"schema_version": 1, "season": season, "checked_at": now.isoformat(), "sources": sources,
               "expected_games": len(schedule), "reported_games": len(grouped), "missing_games": missing,
               "coverage_status": "complete" if not missing else "partial",
               "unmatched_players": len(unmatched), "source_issues": len(issues), "games": index}
    if (prior_index.get("sources") == sources and prior_index.get("games") == index
            and prior_index.get("missing_games") == missing):
        summary["checked_at"] = prior_index["checked_at"]
    artifacts[destination / "index.json"] = encoded(summary)
    artifacts[destination / "unmatched.json"] = encoded({"season": season, "players": sorted(unmatched.values(), key=lambda p: p["pfr_player_id"])})
    artifacts[destination / "source_issues.json"] = encoded({"season": season, "issues": issues})
    return artifacts, summary


def refresh_snap_counts(root, seasons, *, fetch=download, now=None):
    """Validate every requested season before any writes; publish catalogue last."""
    root = Path(root)
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Collection time requires a timezone")
    years = sorted(set(seasons))
    if not years or any(type(y) is not int or y not in range(2016, 2027) for y in years):
        raise ValueError("Choose snap seasons from 2016 through 2026")
    artifacts, sources = {}, {}
    downloads = {}
    for key, url, filename in (("schedule", SCHEDULE_URL, "games.csv.gz"), ("players", PLAYERS_URL, "players.csv")):
        content, modified = fetch(url)
        downloads[key] = content
        path = f"data/snap_counts/sources/{hashlib.sha256(content).hexdigest()}-{filename}"
        sources[key] = {"url": url, "sha256": hashlib.sha256(content).hexdigest(),
                        "http_last_modified": modified, "retrieved_at": now.isoformat(), "saved_path": path}
        artifacts[root / path] = content
    links, ambiguous = player_links(downloads["players"])
    counts = {}
    for year in years:
        schedule = parse_schedule(downloads["schedule"], year, now)
        url = SNAPS_URL.format(season=year)
        content, modified = fetch(url)
        path = f"data/snap_counts/sources/{hashlib.sha256(content).hexdigest()}-snap_counts_{year}.csv"
        provenance = {**sources, "snaps": {"url": url, "sha256": hashlib.sha256(content).hexdigest(),
                      "http_last_modified": modified, "retrieved_at": now.isoformat(), "saved_path": path}}
        previous_sources = read_json(root / f"data/snap_counts/{year}/provenance.json", {})
        for key in provenance:
            if previous_sources.get(key, {}).get("sha256") == provenance[key]["sha256"]:
                provenance[key] = previous_sources[key]
        prepared, summary = build_season(root, year, content, schedule, links, ambiguous, provenance, now)
        artifacts.update(prepared)
        artifacts[root / path] = content
        artifacts[root / f"data/snap_counts/{year}/provenance.json"] = encoded(provenance)
        counts[year] = {key: summary[key] for key in ("reported_games", "expected_games", "unmatched_players", "coverage_status")}
        print(f"Validated snap counts {year}: {counts[year]}", flush=True)
    catalogue_path = root / "docs/data/snap_counts/index.json"
    catalogue = read_json(catalogue_path, {"schema_version": 1, "seasons": []})
    changed = False
    for path, content in artifacts.items():
        if not path.exists() or path.read_bytes() != content:
            changed = True
            write_atomic(path, content)
    if changed or not catalogue_path.exists():
        catalogue.update(seasons=sorted(set(catalogue["seasons"]) | set(years), reverse=True), checked_at=now.isoformat())
        write_atomic(catalogue_path, encoded(catalogue))
    return counts
