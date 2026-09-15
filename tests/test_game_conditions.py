from datetime import datetime, timezone
from copy import deepcopy
from app.game_conditions import schedule_conditions, attach_saved_weather, NWS_SOURCE

NOW = datetime(2026, 9, 15, 14, tzinfo=timezone.utc)
GAME = {"game_id": "2026_02_DET_BUF", "home": "BUF", "away": "DET",
        "kickoff": "2026-09-18T00:15:00Z", "stadium_id": "BUF00", "roof": "outdoors",
        "weather": None}
FORECAST = {"status": "forecast", "summary": "Sunny", "temperature": 0,
            "wind_speed": "0 mph", "source_url": NWS_SOURCE}


def odds(game=GAME):
    return {"generated_at": NOW.isoformat(), "games": [{**game, "weather": FORECAST}]}


def test_venue_is_actual_game_site_and_zero_is_not_missing():
    melbourne = schedule_conditions({"stadium_id": "MEL00", "roof": "dome", "temp": "0", "wind": "0"})
    assert melbourne["city"] == "Melbourne, Australia"
    assert melbourne["roof"] == "outdoors"
    assert melbourne["weather"]["temperature"] == 0
    assert melbourne["weather"]["wind_speed"] == "0 mph"
    assert schedule_conditions({"stadium_id": "NYC01"})["city"] == "East Rutherford, NJ"
    assert schedule_conditions({"stadium_id": "PAR00"})["city"] == "Saint-Denis, France"
    assert schedule_conditions({"stadium_id": "new", "temp": "nan", "wind": ""})["weather"] is None
    assert schedule_conditions({"stadium_id": "new"})["city"] is None
    assert schedule_conditions({"stadium_id": "MAD01", "roof": "closed"})["roof"] == "closed"
    assert schedule_conditions({"stadium_id": "MAD01", "roof": ""})["roof"] == "retractable"


def test_forecast_cached_locally_survives_game_end_and_source_outage():
    games = [deepcopy(GAME)]
    attach_saved_weather(games, {}, odds(), NOW)
    assert games[0]["weather"]["status"] == "forecast"
    assert games[0]["weather"]["temperature"] == 0
    assert games[0]["weather"]["checked_at"] == NOW.isoformat()
    previous = {"games": deepcopy(games)}
    games = [deepcopy(GAME)]
    attach_saved_weather(games, previous, {}, datetime(2026, 9, 20, tzinfo=timezone.utc))
    assert games[0]["weather"] == previous["games"][0]["weather"]
    # Reported data replaces forecasts, with blanks left blank.
    games[0]["weather"] = {"status": "schedule", "temperature": 61, "wind_speed": None}
    attach_saved_weather(games, previous, odds(), NOW)
    assert games[0]["weather"] == {"status": "schedule", "temperature": 61, "wind_speed": None}


def test_moved_games_and_invalid_weather_snapshots_cannot_reuse_forecasts():
    for change in [{"stadium_id": "MEL00"}, {"home": "DET", "away": "BUF"},
                   {"kickoff": "2026-09-19T00:15:00Z"}]:
        games = [{**GAME, **change}]
        attach_saved_weather(games, {}, odds(), NOW)
        assert games[0]["weather"] is None
    for generated in ["invalid", "2026-09-15T20:00:00Z", "2026-09-20T00:00:00Z"]:
        games = [deepcopy(GAME)]
        attach_saved_weather(games, {}, {**odds(), "generated_at": generated}, NOW)
        assert games[0]["weather"] is None
    games = [{**GAME, "roof": "dome"}]
    attach_saved_weather(games, {}, odds(), NOW)
    assert games[0]["weather"] is None


def test_malformed_optional_weather_never_blocks_score_refresh():
    for weather in [None, "", "unavailable", [], 42]:
        games = [deepcopy(GAME)]
        malformed = {"games": [{**GAME, "weather": weather}], "generated_at": NOW.isoformat()}
        attach_saved_weather(games, malformed, malformed, NOW)
        assert games[0]["weather"] is None
    for valid_at in ["bad", "2026-09-17T00:00:00Z", "2026-09-18T01:00:00Z", "2026-09-18T00:00:00"]:
        games = [deepcopy(GAME)]
        wrong_hour = {"generated_at": NOW.isoformat(), "games": [{**GAME, "weather": {**FORECAST, "valid_at": valid_at}}]}
        attach_saved_weather(games, {}, wrong_hour, NOW)
        assert games[0]["weather"] is None
    games = [deepcopy(GAME)]
    matching_hour = {"generated_at": NOW.isoformat(), "games": [{**GAME, "weather": {**FORECAST, "valid_at": "2026-09-17T20:00:00-04:00"}}]}
    attach_saved_weather(games, {}, matching_hour, NOW)
    assert games[0]["weather"]["valid_at"] == "2026-09-18T00:00:00+00:00"


def test_previous_reported_conditions_preserved_when_feed_omits_them():
    previous = {"games": [{**GAME, "weather": {"status": "schedule", "temperature": 70, "wind_speed": "0 mph"}}]}
    games = [deepcopy(GAME)]
    attach_saved_weather(games, previous, {}, NOW)
    assert games[0]["weather"]["temperature"] == 70
    games[0]["weather"] = {"status": "schedule", "temperature": 71, "wind_speed": None}
    attach_saved_weather(games, previous, {}, NOW)
    assert games[0]["weather"]["wind_speed"] == "0 mph"
