"""Build a descriptive historical draft-capital dataset, not a preseason backtest.

MFL's previous-year ADP cannot be restricted to a preseason date. Its public feed
does not filter QB count or TE premium, so those limitations travel with the data.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from io import StringIO
import json
import math
from pathlib import Path
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen


MFL_URL = "https://api.myfantasyleague.com/{season}/export"
STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{season}.csv"
POSITIONS = {"QB", "RB", "WR", "TE"}
STAT_COLUMNS = ["games", "passing_yards", "passing_tds", "passing_interceptions", "rushing_yards",
                "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fumbles_total"]
COLUMNS = ["season", "player_id", "player", "pos", "adp", *STAT_COLUMNS]
SOURCE_FILTERS = {"FCOUNT": 12, "IS_PPR": 1, "IS_KEEPER": "N", "IS_MOCK": -1, "CUTOFF": 5}


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "OutlierBaseline/1.0"})
    with urlopen(request, timeout=90) as response:
        return response.read().decode("utf-8-sig")


def normalized_name(value: str) -> str:
    if "," in value:
        last, first = value.split(",", 1)
        value = f"{first} {last}"
    parts = re.findall(r"[a-z0-9]+", value.casefold())
    if parts and parts[-1] in {"jr", "sr", "ii", "iii", "iv", "v"}:
        parts.pop()
    return "".join(parts)


def position(value: str) -> str:
    value = value.upper()
    return "RB" if value in {"FB", "HB"} else value


def records(value) -> list[dict]:
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def join_season(season: int, adp: dict, players: dict, stats: list[dict]) -> dict:
    market = records(adp.get("adp", {}).get("player"))
    identities = records(players.get("players", {}).get("player"))
    if not market or not identities or not stats:
        raise ValueError(f"{season}: missing source data")
    by_name = {}
    by_id = {}
    for row in stats:
        if int(row["season"]) != season or row["season_type"] != "REG":
            continue
        pos = position(row["position"])
        if pos not in POSITIONS:
            continue
        key = (normalized_name(row["player_display_name"]), pos)
        by_name.setdefault(key, []).append(row)
        by_id.setdefault(row["player_id"], []).append(row)
    mfl_by_id = {str(p["id"]): p for p in identities}
    # Ambiguous source names (even if only one appeared in NFL stats) are not joined.
    source_names = {}
    for player in identities:
        key = (normalized_name(player.get("name", "")), position(player.get("position", "")))
        source_names.setdefault(key, set()).add(str(player["id"]))
    candidates, unmatched, ambiguous = 0, 0, 0
    output, used = [], set()
    for entry in market:
        player = mfl_by_id.get(str(entry.get("id")))
        if not player or position(player.get("position", "")) not in POSITIONS:
            continue
        try:
            pick = float(entry["averagePick"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(pick) or pick <= 0:
            continue
        candidates += 1
        key = (normalized_name(player["name"]), position(player["position"]))
        matches = by_name.get(key, [])
        if len(matches) > 1 or len(source_names[key]) > 1:
            ambiguous += 1
            continue
        if not matches:
            unmatched += 1
            continue
        stat = matches[0]
        # A player-season must be a single regular-season total, not team splits.
        if len(by_id[stat["player_id"]]) != 1 or stat["player_id"] in used:
            ambiguous += 1
            continue
        values = {name: float(stat[name]) for name in STAT_COLUMNS}
        if any(not math.isfinite(n) for n in values.values()) or values["games"] <= 0:
            unmatched += 1
            continue
        used.add(stat["player_id"])
        output.append([season, stat["player_id"], stat["player_display_name"], key[1], pick,
                       *[values[name] for name in STAT_COLUMNS]])
    if len(output) < 50:
        raise ValueError(f"{season}: only {len(output)} unambiguous player matches; refusing to publish")
    return {"season": season, "rows": output, "coverage": {
        "adp_players": candidates, "matched": len(output), "missing_stats": unmatched,
        "ambiguous": ambiguous, "drafts": int(adp["adp"].get("totalDrafts", 0)),
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "adp_url": MFL_URL.format(season=season) + "?" + urlencode({"TYPE": "adp", "JSON": 1, **SOURCE_FILTERS}),
        "stats_url": STATS_URL.format(season=season)}}


def refresh_history(destination: Path, seasons: list[int], *, refresh=False, fetch=fetch_text) -> dict:
    previous = json.loads(destination.read_text(encoding="utf-8")) if destination.exists() else {}
    # Completed-season snapshots are retained; normal site refreshes fetch only new years.
    cached = previous.get("years", {}) if previous.get("schema_version") == 1 and previous.get("source_filters") == SOURCE_FILTERS else {}
    years = {}
    for season in sorted(set(seasons)):
        if not refresh and str(season) in cached:
            years[str(season)] = cached[str(season)]
            continue
        base = MFL_URL.format(season=season)
        adp = json.loads(fetch(base + "?" + urlencode({"TYPE": "adp", "JSON": 1, **SOURCE_FILTERS})))
        players = json.loads(fetch(base + "?TYPE=players&JSON=1"))
        stats = list(csv.DictReader(StringIO(fetch(STATS_URL.format(season=season)))))
        years[str(season)] = join_season(season, adp, players, stats)
        print(f"{season}: {years[str(season)]['coverage']['matched']} matched player-seasons")
    payload = {"schema_version": 1, "source_filters": SOURCE_FILTERS, "columns": COLUMNS,
               "seasons": sorted(set(seasons)), "years": years,
               "adp_basis": "MyFantasyLeague historical 12-team PPR redraft; actual and mock drafts; minimum 5% selection rate. QB count, PPR amount, and TE premium are not specified.",
               "limitations": "Historical ADP is a year-level aggregate, not a verified preseason snapshot. Missing or ambiguous player-season matches are excluded, never filled with zero. This can bias averages upward when injured players have no recorded season. This is descriptive history, not an out-of-sample forecast or backtest."}
    if payload == previous:
        print("Historical draft-capital snapshot is already current.")
        return payload
    temporary = destination.with_suffix(".json.tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return payload
