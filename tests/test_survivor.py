"""Team model, causal cutoff, and source-quality regression tests."""

from datetime import datetime, timedelta, timezone
import json

import numpy as np
import pytest

from app import survivor as s

NOW = datetime(2026, 9, 9, 12, tzinfo=timezone.utc)


def game(**overrides):
    return {"game_id": "g", "season": 2026, "week": 1,
            "kickoff": (NOW + timedelta(days=1)).isoformat(), "home": "BUF", "away": "KC",
            "neutral": False, "home_score": None, "away_score": None, **overrides}


def training():
    return [game(game_id=str(i), season=2025, kickoff=(NOW - timedelta(days=250 + i)).isoformat(),
                 home=s.TEAMS[i % 32], away=s.TEAMS[(i + 9) % 32],
                 home_score=20 + (i % 13), away_score=17 + (i % 17)) for i in range(250)]


def test_no_future_or_live_score_leakage():
    past = training()
    fit = s.fit_model(past, NOW, 2026)
    injected = past + [game(home_score=99, away_score=0),
                       game(kickoff=(NOW - timedelta(hours=2)).isoformat(), home_score=70, away_score=0)]
    alternate = s.fit_model(injected, NOW, 2026)
    np.testing.assert_array_equal(fit["coefficients"], alternate["coefficients"])
    assert fit["training_games"] == 250


def test_score_model_defense_direction_neutral_and_probability_sum():
    model = s.fit_model(training(), NOW, 2026)
    model["coefficients"] = np.zeros(65)
    model["coefficients"][-1] = 3
    neutral = s.predict(model, game(neutral=True))
    home = s.predict(model, game())
    assert home["home_points"] > neutral["home_points"]
    assert home["away_points"] < neutral["away_points"]
    model["coefficients"][32 + s.INDEX["BUF"]] = 4
    defense = s.predict(model, game())
    assert defense["away_points"] < home["away_points"]
    assert defense["home_win"] > home["home_win"]
    assert defense["home_win"] + defense["away_win"] + defense["tie"] == pytest.approx(1, abs=1e-6)
    assert neutral["home_win"] == pytest.approx(neutral["away_win"], abs=2e-6)


def moneyline(team, price, provider="a", age=1, kind="sportsbook"):
    return {"selection": team, "price": price, "provider_key": provider, "provider_kind": kind,
            "market": "Moneyline", "updated_at": (NOW - timedelta(hours=age)).isoformat()}


def test_market_requires_fresh_complete_same_book_pair():
    row = game()
    pair = {"rows": [moneyline("BUF", -150), moneyline("KC", 130)]}
    result = s.market_comparison(row, pair, NOW)
    assert result["books"] == 1
    assert result["home_share"] == pytest.approx(.6 / (.6 + 100/230), abs=1e-6)
    assert result["home_share"] + result["away_share"] == 1
    for rows in ([moneyline("BUF", -150)],
                 [moneyline("BUF", -150), moneyline("KC", 130, provider="b")],
                 [moneyline("BUF", -150, age=49), moneyline("KC", 130, age=49)],
                 [moneyline("BUF", -150, kind="reference"), moneyline("KC", 130, kind="reference")],
                 [moneyline("BUF", -150), moneyline("KC", 130, age=4)],
                 [moneyline("BUF", -150), moneyline("KC", 0)]):
        assert s.market_comparison(row, {"rows": rows}, NOW) is None
    assert s.market_comparison(game(kickoff=(NOW + timedelta(days=9)).isoformat()), pair, NOW) is None
    assert s.market_comparison(game(kickoff=NOW.isoformat()), pair, NOW) is None
    assert s.market_comparison(row, {"rows": [{**moneyline("BUF", -150), "updated_at": None}]}, NOW) is None


def test_regular_season_parser_and_neutral_site():
    csv = "game_id,season,game_type,week,gameday,gametime,home_team,away_team,home_score,away_score,location\n"
    csv += "g,2026,REG,1,2026-09-10,20:20,BUF,KC,,,Neutral\n"
    csv += "p,2026,PRE,1,2026-08-10,20:20,BUF,KC,20,10,Home\n"
    games = s.parse_schedule(csv)
    assert len(games) == 1 and games[0]["neutral"] is True
    assert games[0]["kickoff"] == "2026-09-11T00:20:00+00:00"
    assert games[0]["home_score"] is None
    with pytest.raises(ValueError):
        s.parse_schedule("wrong,columns\n1,2")


def test_backtest_uses_pre_week_cutoff(monkeypatch):
    batch = [game(season=2025, kickoff=(NOW - timedelta(days=365)).isoformat(), home_score=24, away_score=20),
             game(game_id="later", season=2025, kickoff=(NOW - timedelta(days=363)).isoformat(), home_score=17, away_score=20)]
    cutoffs = []
    def fit(games, cutoff, year):
        cutoffs.append(cutoff)
        assert not any(s.completed(g, cutoff) for g in batch)
        return {}
    monkeypatch.setattr(s, "fit_model", fit)
    monkeypatch.setattr(s, "predict", lambda model, g: {"home_win": .6, "home_points": 21, "away_points": 18})
    result = s.backtest(batch, 2026, NOW)
    assert cutoffs == [s.timestamp(batch[0]["kickoff"])]
    assert result["games"] == 2
    assert result["brier_score"] == .26
    assert len(result["score_residuals"]) == 2
    assert result["score_residuals"][0][:2] == [3, 2]
    assert all(0 < row[2] <= 1 for row in result["score_residuals"])


def test_failed_refresh_preserves_snapshot(tmp_path, monkeypatch):
    dest = tmp_path / "survivor.json"
    dest.write_text('{"previous": true}', encoding="utf-8")
    class BadResponse:
        text = "unexpected,columns\n1,2"
        def raise_for_status(self):
            pass
    monkeypatch.setattr(s.requests, "get", lambda *a, **k: BadResponse())
    with pytest.raises(ValueError):
        s.refresh_survivor(dest, 2026, tmp_path / "missing.json")
    assert json.loads(dest.read_text()) == {"previous": True}


def test_published_snapshot_consistency():
    from pathlib import Path
    payload = json.loads((Path(__file__).resolve().parents[1] / "docs/data/survivor.json").read_text())
    assert len(payload["games"]) == 272
    assert len(payload["teams"]) == 32
    appearances = set()
    for row in payload["games"]:
        for side in ("home", "away"):
            key = (row["week"], row[side])
            assert key not in appearances
            appearances.add(key)
        if row["model"]:
            assert sum(row["model"][key] for key in ("home_win", "away_win", "tie")) == pytest.approx(1, abs=1e-6)
        else:
            assert row["status"] != "scheduled"
    assert payload["backtest"]["games"] == 544
    assert len(payload["simulation"]["residuals"]) == payload["backtest"]["games"]
    assert all(len(row) == 3 and row[2] > 0 for row in payload["simulation"]["residuals"])


def test_incomplete_schedule_is_rejected():
    with pytest.raises(ValueError, match="Incomplete"):
        s.build_snapshot([game()], 2026, NOW)


def test_finished_games_have_results_not_retrospective_forecasts(monkeypatch):
    from pathlib import Path
    payload = json.loads((Path(__file__).resolve().parents[1] / "docs/data/survivor.json").read_text())
    games = payload["games"]
    first = games[0]
    first.update(home_score=24, away_score=20)
    cutoff = s.timestamp(first["kickoff"]) + timedelta(hours=7)
    model = s.fit_model(training(), NOW, 2026)
    monkeypatch.setattr(s, "fit_model", lambda *a: model)
    monkeypatch.setattr(s, "backtest", lambda *a: {"games": 0})
    result = s.build_snapshot(games, payload["season"], cutoff)
    saved = next(g for g in result["games"] if g["game_id"] == first["game_id"])
    assert saved["status"] == "final" and saved["home_score"] == 24
    assert saved["model"] is None and saved["market"] is None
    home = next(t for t in result["teams"] if t["team"] == first["home"])
    assert home["current_season"] == {"games": 1, "points_for": 24, "points_against": 20}
