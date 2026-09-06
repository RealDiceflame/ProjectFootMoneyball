from datetime import datetime, timezone

import pandas as pd

from app.odds_board import build_odds_board, probability_to_american


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
    assert game["kickoff"] == "2026-09-10T00:20:00+00:00"
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


def test_past_games_are_left_off_the_upcoming_board():
    payload = build_odds_board(
        _schedule(),
        season=2026,
        now=datetime(2026, 9, 11, tzinfo=timezone.utc),
    )
    assert payload["games"] == []
