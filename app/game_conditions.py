"""Game-site metadata and saved kickoff forecasts; never fetch weather per visitor."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math

from app.venues import STADIUM_CITIES, venue_overrides

NWS_SOURCE = "https://www.weather.gov/documentation/services-web-api"
SCHEDULE_SOURCE = "https://github.com/nflverse/nflverse-data/releases/tag/schedules"


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def _number(value, low, high):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) and low <= number <= high else None
    except (ValueError, TypeError):
        return None


def schedule_conditions(row):
    stadium_id = (row.get("stadium_id") or "").strip()
    roof = venue_overrides(stadium_id, row.get("roof")).get("roof", row.get("roof") or "unknown")
    temperature = _number(row.get("temp"), -100, 160)
    wind = _number(row.get("wind"), 0, 200)
    weather = None
    if temperature is not None or wind is not None:
        weather = {"status": "schedule", "temperature": temperature,
                   "wind_speed": None if wind is None else f"{wind:g} mph",
                   "source_url": SCHEDULE_SOURCE}
    return {"stadium_id": stadium_id or None, "stadium": (row.get("stadium") or "").strip() or None,
            "city": STADIUM_CITIES.get(stadium_id), "roof": roof, "weather": weather}


def _same_game(game, candidate):
    return (isinstance(candidate, dict) and game.get("stadium_id")
            and all(game.get(key) == candidate.get(key) for key in ("game_id", "home", "away", "stadium_id"))
            and _time(game.get("kickoff")) is not None
            and _time(game.get("kickoff")) == _time(candidate.get("kickoff")))


def attach_saved_weather(games, previous, odds, now):
    """Join by game, venue AND kickoff; retain forecasts as forecasts after kickoff."""
    def index(payload):
        rows = payload.get("games", [])
        return {g.get("game_id"): g for g in rows if isinstance(g, dict) and isinstance(g.get("game_id"), str)} if isinstance(rows, list) else {}
    def conditions(candidate):
        value = candidate.get("weather")
        return value if isinstance(value, dict) else {}
    old_games = index(previous)
    forecast_games = index(odds)
    for game in games:
        old = old_games.get(game["game_id"], {})
        old_weather = conditions(old)
        if game.get("weather"):
            # Keep missing individual fields from an earlier report, but never mix
            # a forecast into reported conditions or transfer weather to a moved game.
            if _same_game(game, old) and old_weather.get("status") == "schedule":
                for key in ("temperature", "wind_speed"):
                    if game["weather"].get(key) is None:
                        game["weather"][key] = old_weather.get(key)
            continue
        if game.get("roof") in {"dome", "closed"}:
            continue
        candidates = []
        if _same_game(game, old) and old_weather.get("status") == "schedule":
            game["weather"] = old_weather
            continue
        fresh = forecast_games.get(game["game_id"], {})
        for candidate, checked in ((old, old_weather.get("checked_at")), (fresh, odds.get("generated_at"))):
            weather = conditions(candidate)
            fetched = _time(checked)
            kickoff = _time(game.get("kickoff"))
            if (not _same_game(game, candidate) or weather.get("status") != "forecast"
                    or weather.get("source_url") != NWS_SOURCE or not fetched
                    or fetched > now + timedelta(minutes=5) or fetched > kickoff):
                continue
            valid_at = _time(weather.get("valid_at"))
            if weather.get("valid_at") is not None and (valid_at is None or not valid_at <= kickoff < valid_at + timedelta(hours=1)):
                continue
            temperature = _number(weather.get("temperature"), -100, 160)
            summary = weather.get("summary")
            if temperature is None and not isinstance(summary, str):
                continue
            candidates.append((fetched, {"status": "forecast", "temperature": temperature,
                "summary": str(summary or "Forecast available")[:160],
                "wind_speed": str(weather.get("wind_speed") or "")[:40] or None,
                "wind_direction": str(weather.get("wind_direction") or "")[:8] or None,
                "source_url": NWS_SOURCE, "checked_at": fetched.isoformat(),
                "valid_at": (valid_at or kickoff).isoformat()}))
        if candidates:
            game["weather"] = max(candidates, key=lambda item: item[0])[1]
