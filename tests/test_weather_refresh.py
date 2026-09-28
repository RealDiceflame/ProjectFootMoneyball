"""NWS coverage windows are different from transport failures; all fixtures are local."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import pandas as pd
import pytest
import requests

import app.odds_board as odds


NOW = datetime(2026, 9, 27, 22, tzinfo=timezone.utc)


class Response:
    def __init__(self, payload=None, text=""):
        self.payload = payload
        self.text = text

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def game(kickoff="2026-10-04T17:00:00+00:00"):
    return {"game_id": "2026_04_TEN_BAL", "kickoff": kickoff, "stadium_id": "BAL00", "weather": {
        "status": "pending", "summary": "Forecast is being updated", "temperature": None,
        "wind_speed": None, "wind_direction": None, "source_url": odds.NWS_SOURCE_URL,
    }}


def nws_get(periods):
    def get(url, **kwargs):
        if "/points/" in url:
            return Response({"properties": {"forecastHourly": "https://api.weather.gov/gridpoints/LWX/100,100/forecast/hourly"}})
        return Response({"properties": {"updateTime": "2026-09-27T20:53:27+00:00", "periods": periods}})
    return get


def period(start="2026-10-04T06:00:00-04:00", end="2026-10-04T07:00:00-04:00"):
    return {"startTime": start, "endTime": end, "temperature": 70, "temperatureUnit": "F",
            "shortForecast": "Sunny", "windSpeed": "5 mph", "windDirection": "SW"}


def test_valid_hourly_feed_short_of_kickoff_is_pending_not_failed():
    row = game()
    assert odds.add_nws_weather([row], now=NOW, get=nws_get([period()])) == 0
    assert row["weather"]["status"] == "pending"
    assert row["weather"]["reason_code"] == "outside_forecast_window"
    assert row["weather"]["forecast_through"] == "2026-10-04T07:00:00-04:00"
    assert row["weather"]["temperature"] is None
    assert "captured_at" not in row["weather"]


@pytest.mark.parametrize("payload", [[], [{"startTime": "bad", "endTime": "bad"}], {"bad": "shape"}])
def test_empty_or_invalid_periods_do_not_masquerade_as_a_known_future_window(payload):
    row = game()
    odds.add_nws_weather([row], now=NOW, get=nws_get(payload))
    assert row["weather"]["status"] == "unavailable"


def test_successful_forecast_tracks_publication_capture_and_valid_times_separately():
    row = game("2026-10-04T10:20:00+00:00")
    assert odds.add_nws_weather([row], now=NOW, get=nws_get([period()])) == 1
    weather = row["weather"]
    assert weather["issued_at"] == "2026-09-27T20:53:27+00:00"
    assert weather["captured_at"] == NOW.isoformat()
    assert weather["valid_at"] == "2026-10-04T06:00:00-04:00"
    assert weather["valid_until"] == "2026-10-04T07:00:00-04:00"


def test_http_failure_retains_only_a_forecast_for_the_same_venue_and_valid_hour():
    saved = game("2026-10-04T10:20:00+00:00")
    odds.add_nws_weather([saved], now=NOW, get=nws_get([period()]))
    prior = {saved["game_id"]: deepcopy(saved)}
    def offline(*args, **kwargs):
        raise requests.Timeout("temporary failure")
    row = game(saved["kickoff"])
    assert odds.add_nws_weather([row], now=NOW, get=offline) == 0
    assert odds.retain_nws_weather([row], prior) == 1
    assert row["weather"]["retained"]
    assert row["weather"]["valid_at"] == saved["weather"]["valid_at"]
    assert row["weather"]["captured_at"] == saved["weather"]["captured_at"]
    delayed = game("2026-10-04T17:00:00+00:00")
    odds.add_nws_weather([delayed], now=NOW, get=offline)
    assert odds.retain_nws_weather([delayed], prior) == 0
    assert delayed["weather"]["status"] == "unavailable"
    moved = game(saved["kickoff"])
    moved["stadium_id"] = "BUF00"
    odds.add_nws_weather([moved], now=NOW, get=offline)
    assert odds.retain_nws_weather([moved], prior) == 0


def test_public_health_does_not_treat_unpublished_kickoff_hour_as_provider_failure(tmp_path, monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 27, 22, tzinfo=timezone.utc)
    monkeypatch.setattr(odds, "datetime", FixedDatetime)
    monkeypatch.delenv("ODDS_API_KEY", raising=False)
    monkeypatch.delenv("SPORTSGAMEODDS_API_KEY", raising=False)
    schedule = pd.DataFrame([{"game_id": "2026_04_TEN_BAL", "season": 2026, "game_type": "REG", "week": 4,
                              "gameday": "2026-10-04", "gametime": "13:00", "away_team": "TEN", "home_team": "BAL",
                              "stadium_id": "BAL00", "roof": "outdoors"}])
    def get(url, **kwargs):
        if url == odds.SCHEDULE_URL:
            return Response(text=schedule.to_csv(index=False))
        if url == f"{odds.KALSHI_API}/events":
            return Response({"events": []})
        if url == odds.POLYMARKET_EVENTS_API:
            return Response([])
        if url.startswith(odds.NWS_API):
            return nws_get([period()])(url, **kwargs)
        raise AssertionError("Unexpected external request")
    output = tmp_path / "odds.json"
    odds.refresh_odds_board(output, season=2026, get=get, status=lambda _: None)
    payload = json.loads(output.read_text())
    health = payload["source_health"]["weather"]
    assert health["status"] == "success"
    assert health["row_count"] == 0
    assert health["pending_count"] == 1
    assert health["failed_count"] == 0
    assert health["games"]["2026_04_TEN_BAL"]["status"] == "pending"
    assert payload["games"][0]["weather"]["status"] == "pending"
