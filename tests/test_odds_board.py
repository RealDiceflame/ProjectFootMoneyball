from datetime import datetime, timezone

import pandas as pd

from app.odds_board import (
    add_nws_weather,
    build_odds_board,
    build_polymarket_markets,
    probability_to_american,
)


def _schedule():
    return pd.DataFrame([{
        "game_id": "2026_01_NE_SEA",
        "season": 2026,
        "game_type": "REG",
        "week": 1,
        "gameday": "2026-09-09",
        "gametime": "20:20",
        "away_team": "NE",
        "home_team": "SEA",
        "away_moneyline": 150,
        "home_moneyline": -180,
        "spread_line": 3.5,
        "away_spread_odds": -115,
        "home_spread_odds": -105,
        "total_line": 44.5,
        "under_odds": -115,
        "over_odds": -105,
        "stadium_id": "SEA00",
        "stadium": "Lumen Field",
        "roof": "outdoors",
        "surface": "fieldturf",
        "temp": None,
        "wind": None,
    }])


def test_probability_to_american_handles_both_sides_of_even_money():
    assert probability_to_american("0.40") == 150
    assert probability_to_american("0.60") == -150
    assert probability_to_american(0) is None


def test_build_odds_board_maps_reference_lines_and_kalshi_contracts():
    payload = build_odds_board(
        _schedule(),
        season=2026,
        kalshi_events=[{
            "title": "New England vs Seattle",
            "markets": [{
                "subtitle": "Seattle",
                "yes_ask_dollars": "0.63",
                "last_price_ts": "2026-09-06T12:00:00Z",
            }],
        }],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )

    assert payload["weeks"] == [1]
    game = payload["games"][0]
    assert game["away"] == "NE"
    assert game["home"] == "SEA"
    assert game["away_logo_url"].endswith("/ne.png")
    assert game["home_logo_url"].endswith("/sea.png")
    assert game["kickoff"] == "2026-09-10T00:20:00+00:00"
    assert game["stadium"] == "Lumen Field"
    assert game["surface"] == "fieldturf"
    assert game["weather"]["status"] == "pending"
    assert any(
        row["market"] == "Spread" and row["selection"] == "NE" and row["line"] == 3.5
        for row in game["rows"]
    )
    kalshi = next(row for row in game["rows"] if row["provider"] == "Kalshi")
    assert kalshi["selection"] == "SEA"
    assert kalshi["contract_price"] == 63
    assert kalshi["price"] == -170


def test_sportsbook_comparison_marks_best_line_then_best_price():
    sportsbook_event = {
        "away_team": "New England Patriots",
        "home_team": "Seattle Seahawks",
        "bookmakers": [
            {
                "key": "draftkings",
                "title": "DraftKings",
                "last_update": "2026-09-06T12:00:00Z",
                "markets": [
                    {"key": "h2h", "outcomes": [
                        {"name": "New England Patriots", "price": 145},
                        {"name": "Seattle Seahawks", "price": -165},
                    ]},
                    {"key": "spreads", "outcomes": [
                        {"name": "New England Patriots", "price": -110, "point": 3.0},
                        {"name": "Seattle Seahawks", "price": -110, "point": -3.0},
                    ]},
                    {"key": "totals", "outcomes": [
                        {"name": "Over", "price": -110, "point": 44.5},
                        {"name": "Under", "price": -110, "point": 44.5},
                    ]},
                ],
            },
            {
                "key": "fanduel",
                "title": "FanDuel",
                "last_update": "2026-09-06T12:01:00Z",
                "markets": [
                    {"key": "h2h", "outcomes": [
                        {"name": "New England Patriots", "price": 150},
                        {"name": "Seattle Seahawks", "price": -170},
                    ]},
                    {"key": "spreads", "outcomes": [
                        {"name": "New England Patriots", "price": -115, "point": 3.5},
                        {"name": "Seattle Seahawks", "price": -105, "point": -3.5},
                    ]},
                    {"key": "totals", "outcomes": [
                        {"name": "Over", "price": -115, "point": 44.0},
                        {"name": "Under", "price": -105, "point": 44.0},
                    ]},
                ],
            },
        ],
    }
    payload = build_odds_board(
        _schedule(),
        season=2026,
        sportsbook_events=[sportsbook_event],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )
    rows = payload["games"][0]["rows"]

    best = {(row["provider"], row["market"], row["selection"], row["line"])
            for row in rows if row["is_best"]}
    assert ("FanDuel", "Moneyline", "NE", None) in best
    assert ("FanDuel", "Spread", "NE", 3.5) in best
    assert ("DraftKings", "Spread", "SEA", -3.0) in best
    assert ("FanDuel", "Total", "Over", 44.0) in best
    assert ("DraftKings", "Total", "Under", 44.5) in best
    assert payload["has_sportsbooks"] is True


def test_sportsgameodds_backup_maps_bookmakers_into_matching_columns():
    event = {
        "teams": {
            "away": {"names": {"long": "New England Patriots"}},
            "home": {"names": {"long": "Seattle Seahawks"}},
        },
        "links": {"bookmakers": {"draftkings": "https://sportsbook.draftkings.com/"}},
        "updatedAt": "2026-09-06T12:00:00Z",
        "odds": {
            "points-away-game-ml-away": {
                "betTypeID": "ml", "sideID": "away",
                "byBookmaker": {"draftkings": {"odds": 150, "available": True}},
            },
            "points-home-game-ml-home": {
                "betTypeID": "ml", "sideID": "home",
                "byBookmaker": {"draftkings": {"odds": -170, "available": True}},
            },
            "points-all-game-ou-over": {
                "betTypeID": "ou", "sideID": "over", "bookOverUnder": 44.5,
                "byBookmaker": {"draftkings": {"odds": -105, "available": True}},
            },
        },
    }
    payload = build_odds_board(
        _schedule(),
        season=2026,
        sportsgameodds_events=[event],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )
    rows = [row for row in payload["games"][0]["rows"] if row["provider_kind"] == "sportsbook"]
    assert {(row["market"], row["selection"], row["line"], row["price"]) for row in rows} == {
        ("Moneyline", "NE", None, 150),
        ("Moneyline", "SEA", None, -170),
        ("Total", "Over", 44.5, -105),
    }
    assert all(row["provider"] == "DraftKings" for row in rows)
    assert payload["sources"]["sportsbooks"]["name"] == "SportsGameOdds"


def test_polymarket_events_become_compact_ranked_prediction_cards():
    cards = build_polymarket_markets([
        {
            "id": "87239",
            "title": "Tush Push banned for 2026 NFL Season?",
            "slug": "tush-push-banned-for-2026-nfl-season",
            "active": True,
            "closed": False,
            "endDate": "2026-09-10T00:00:00Z",
            "volume": 415785.14,
            "liquidity": 623.53,
            "markets": [{
                "active": True,
                "closed": False,
                "question": "Tush Push banned for 2026 NFL Season?",
                "outcomes": '["Yes", "No"]',
                "outcomePrices": '["0.0035", "0.9965"]',
            }],
        },
    ])
    assert len(cards) == 1
    assert cards[0]["url"].endswith("/event/tush-push-banned-for-2026-nfl-season")
    assert cards[0]["contracts"] == [
        {"label": "No", "probability": 0.9965},
        {"label": "Yes", "probability": 0.0035},
    ]


def test_polymarket_game_adds_only_main_lines_to_the_comparison_table():
    event = {
        "id": "772173",
        "title": "Patriots vs. Seahawks",
        "slug": "nfl-ne-sea-2026-09-10",
        "active": True,
        "closed": False,
        "markets": [
            {"active": True, "sportsMarketType": "moneyline", "outcomes": '["Patriots", "Seahawks"]', "outcomePrices": '["0.375", "0.625"]'},
            {"active": True, "sportsMarketType": "spreads", "line": -1.5, "outcomes": '["Seahawks", "Patriots"]', "outcomePrices": '["0.59", "0.41"]'},
            {"active": True, "sportsMarketType": "spreads", "line": -3.5, "outcomes": '["Seahawks", "Patriots"]', "outcomePrices": '["0.475", "0.525"]'},
            {"active": True, "sportsMarketType": "totals", "line": 43.5, "outcomes": '["Over", "Under"]', "outcomePrices": '["0.525", "0.475"]'},
            {"active": True, "sportsMarketType": "totals", "line": 44.5, "outcomes": '["Over", "Under"]', "outcomePrices": '["0.485", "0.515"]'},
        ],
    }
    payload = build_odds_board(
        _schedule(),
        season=2026,
        polymarket_events=[event],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )
    rows = [row for row in payload["games"][0]["rows"] if row["provider_key"] == "polymarket"]
    assert {(row["market"], row["selection"], row["line"], row["contract_price"]) for row in rows} == {
        ("Moneyline", "NE", None, 38),
        ("Moneyline", "SEA", None, 63),
        ("Spread", "NE", 3.5, 53),
        ("Spread", "SEA", -3.5, 48),
        ("Total", "Over", 44.5, 49),
        ("Total", "Under", 44.5, 52),
    }


def test_past_games_are_left_off_the_upcoming_board():
    payload = build_odds_board(
        _schedule(),
        season=2026,
        now=datetime(2026, 9, 11, tzinfo=timezone.utc),
    )
    assert payload["games"] == []


def test_indoor_games_are_labeled_without_requesting_a_forecast():
    schedule = _schedule()
    schedule.loc[0, "roof"] = "dome"
    game = build_odds_board(
        schedule,
        season=2026,
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )["games"][0]
    assert game["weather"]["status"] == "indoor"
    assert "weather impact limited" in game["weather"]["summary"]
    assert game["weather"]["source_url"] is None


def test_international_venue_uses_its_own_field_details():
    schedule = _schedule()
    schedule.loc[0, "stadium_id"] = "MEL00"
    schedule.loc[0, "stadium"] = "Melbourne Cricket Ground"
    schedule.loc[0, "roof"] = "dome"
    schedule.loc[0, "surface"] = "matrixturf"
    game = build_odds_board(
        schedule,
        season=2026,
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )["games"][0]
    assert game["roof"] == "outdoors"
    assert game["surface"] == "grass"
    assert game["weather"]["status"] == "unavailable"


def test_nws_hourly_forecast_is_added_near_kickoff():
    game = build_odds_board(
        _schedule(),
        season=2026,
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )["games"][0]

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_get(url, **_kwargs):
        if "/points/" in url:
            return Response({"properties": {"forecastHourly": "https://api.weather.gov/gridpoints/SEW/1,1/forecast/hourly"}})
        return Response({"properties": {"periods": [{
            "startTime": "2026-09-09T17:00:00-07:00",
            "temperature": 68,
            "windSpeed": "8 mph",
            "windDirection": "NW",
            "shortForecast": "Mostly Sunny",
        }]}})

    updated = add_nws_weather(
        [game],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
        get=fake_get,
    )
    assert updated == 1
    assert game["weather"] == {
        "status": "forecast",
        "summary": "Mostly Sunny",
        "temperature": 68,
        "wind_speed": "8 mph",
        "wind_direction": "NW",
        "source_url": "https://www.weather.gov/documentation/services-web-api",
    }
