"""Small, no-key NFL reported-score snapshot, independent of projection refreshes."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import gzip
from io import StringIO
import json
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from app.game_conditions import schedule_conditions, attach_saved_weather

SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz"
SOURCE_URL = "https://github.com/nflverse/nflverse-data/releases/tag/schedules"
LICENSE_URL = "https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md"
TEAMS = set("ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAC LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split())
TEAM_ALIASES = {"LAR": "LA", "WSH": "WAS"}


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timezone required")
    return result.astimezone(timezone.utc)


def parse_games(text, season, *, expected_games=272):
    reader = csv.DictReader(StringIO(text))
    required = {"game_id", "season", "game_type", "week", "gameday", "gametime", "home_team", "away_team", "home_score", "away_score"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Schedule columns changed")
    games, seen, appearances = [], set(), set()
    for row in reader:
        if row["season"] != str(season) or row["game_type"] != "REG":
            continue
        week, identity = int(row["week"]), row["game_id"].strip()
        home, away = (TEAM_ALIASES.get(row[f"{side}_team"], row[f"{side}_team"]) for side in ("home", "away"))
        if not identity or identity in seen or not 1 <= week <= 18 or home == away or not {home, away} <= TEAMS:
            raise ValueError("Invalid or duplicate game")
        if any((week, team) in appearances for team in (home, away)):
            raise ValueError("Duplicate team appearance")
        seen.add(identity); appearances.update([(week, home), (week, away)])
        date = datetime.strptime(row["gameday"], "%Y-%m-%d").date().isoformat()
        kickoff = None
        if row["gametime"].strip():
            kickoff = datetime.fromisoformat(f'{date}T{row["gametime"]}').replace(tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc).isoformat()
        scores = []
        for side in ("home", "away"):
            value = row[f"{side}_score"].strip()
            score = None if not value else float(value)
            if score is not None and (not score.is_integer() or not 0 <= score <= 200):
                raise ValueError("Invalid score")
            scores.append(None if score is None else int(score))
        # An incomplete pair is unavailable, not a fabricated zero for the other team.
        if None in scores:
            scores = [None, None]
        games.append({"game_id": identity, "week": week, "home": home, "away": away,
                      "gameday": date, "kickoff": kickoff, "home_score": scores[0], "away_score": scores[1],
                      **schedule_conditions(row)})
    if len(games) != expected_games:
        raise ValueError("Incomplete regular-season schedule; keeping the previous scoreboard")
    return sorted(games, key=lambda game: (game["week"], game["gameday"], game["kickoff"] or "", game["game_id"]))


def refresh_due(snapshot, now):
    """Check every scheduled run near kickoff, otherwise at most once per six hours."""
    try:
        checked = parse_time(snapshot["checked_at"])
        if checked > now or now - checked >= timedelta(hours=6):
            return True
        return any(game.get("kickoff") and -timedelta(hours=2) <= now - parse_time(game["kickoff"]) <= timedelta(hours=10)
                   for game in snapshot["games"])
    except (ValueError, KeyError, TypeError, AttributeError):
        return True


def fetch_schedule():
    request = Request(SCHEDULE_URL, headers={"User-Agent": "OutlierBaseline-scoreboard/1.0"})
    with urlopen(request, timeout=45) as response:
        data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise ValueError("Schedule download exceeded size limit")
    return gzip.decompress(data).decode("utf-8-sig")


def refresh_scores(destination, season, *, scheduled=False, now=None, fetch=fetch_schedule, expected_games=272):
    now = now or datetime.now(timezone.utc)
    destination = Path(destination)
    try:
        previous = json.loads(destination.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    if scheduled and previous.get("season") == season and not refresh_due(previous, now):
        return False
    # Validate the entire response before touching the published last-good file.
    games = parse_games(fetch(), season, expected_games=expected_games)
    if previous.get("season") == season:
        earlier = {game["game_id"]: game for game in previous.get("games", [])
                   if isinstance(game, dict) and "game_id" in game}
        for game in games:
            old = earlier.get(game["game_id"], {})
            had_scores = all(type(old.get(f"{side}_score")) is int and 0 <= old[f"{side}_score"] <= 200
                             for side in ("home", "away"))
            if had_scores and game["home_score"] is None and game["kickoff"] and parse_time(game["kickoff"]) <= now:
                raise ValueError("Previously reported scores disappeared; keeping the previous scoreboard")
    # Reuse the six-hour weather snapshot. Frequent score checks add no weather API calls.
    try:
        odds = json.loads(destination.with_name("nfl_odds.json").read_text(encoding="utf-8"))
        if not isinstance(odds, dict) or odds.get("season") != season or not isinstance(odds.get("games"), list):
            odds = {}
    except (OSError, ValueError):
        odds = {}
    attach_saved_weather(games, previous if previous.get("season") == season else {}, odds, now)
    payload = {"season": season, "checked_at": now.isoformat(), "score_type": "reported",
               "source": {"name": "Lee Sharpe / nflverse", "url": SOURCE_URL, "license_url": LICENSE_URL},
               "games": games}
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return True
