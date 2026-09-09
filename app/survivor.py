"""Experimental team-score baseline and leakage-safe survivor data snapshot.

Fantasy points are intentionally not inputs: this estimates NFL scoreboard points.
Positive offense means points added; positive defense means points prevented.
"""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from io import StringIO
import json
import math
from pathlib import Path
import statistics
from zoneinfo import ZoneInfo

import numpy as np
import requests

from app.odds_board import NFLVERSE_SOURCE_URL, SCHEDULE_URL, TEAM_NAMES

TEAMS = sorted(TEAM_NAMES)
INDEX = {team: i for i, team in enumerate(TEAMS)}
MODEL_VERSION = "Team Baseline v1"
HALF_LIFE_DAYS = 365
RIDGE = 8.0


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("A timestamp string is required")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("A timezone is required")
    return result.astimezone(timezone.utc)


def parse_schedule(text: str) -> list[dict]:
    rows = list(csv.DictReader(StringIO(text)))
    required = {"game_id", "season", "game_type", "week", "gameday", "gametime",
                "home_team", "away_team", "home_score", "away_score", "location"}
    if not rows or not required.issubset(rows[0]):
        raise ValueError("The schedule is empty or its columns changed")
    games = []
    for row in rows:
        if row["game_type"] != "REG":
            continue
        # Missing kickoff times must not turn into invented playable matchups.
        if not row["gametime"] or not row["gameday"]:
            continue
        kickoff = datetime.fromisoformat(f'{row["gameday"]}T{row["gametime"]}').replace(
            tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc)
        scores = [float(row[f"{side}_score"]) if row[f"{side}_score"] else None
                  for side in ("home", "away")]
        if any(score is not None and (not math.isfinite(score) or score < 0) for score in scores):
            raise ValueError("Invalid schedule score")
        games.append({"game_id": row["game_id"], "season": int(row["season"]),
                      "week": int(row["week"]), "kickoff": kickoff.isoformat(),
                      "home": row["home_team"], "away": row["away_team"],
                      "home_score": scores[0], "away_score": scores[1],
                      "neutral": row["location"].strip().casefold() == "neutral",
                      "stadium": row.get("stadium", "")})
    return games


def completed(game: dict, as_of: datetime) -> bool:
    # The feed has no final-status flag. A conservative six-hour lag excludes live
    # scores; delayed/postponed games without scores remain locked, not completed.
    return (game["home_score"] is not None and game["away_score"] is not None
            and timestamp(game["kickoff"]) + timedelta(hours=6) < as_of)


def design(game: dict) -> np.ndarray:
    x = np.zeros((2, 65))
    h, a = INDEX[game["home"]], INDEX[game["away"]]
    x[0, h], x[0, 32 + a] = 1, -1
    x[1, a], x[1, 32 + h] = 1, -1
    if not game["neutral"]:
        x[0, -1], x[1, -1] = .5, -.5
    return x


def fit_model(games: list[dict], as_of: datetime, season: int) -> dict:
    training = [g for g in games if season - 3 <= g["season"] <= season
                and g["home"] in INDEX and g["away"] in INDEX and completed(g, as_of)]
    if len(training) < 200:
        raise ValueError("At least 200 completed games are required to fit the team model")
    game_weights = np.array([.5 ** ((as_of - timestamp(g["kickoff"])).total_seconds()
                                    / 86400 / HALF_LIFE_DAYS) for g in training])
    weights = np.repeat(game_weights, 2)
    x = np.vstack([design(g) for g in training])
    y = np.array([g[key] for g in training for key in ("home_score", "away_score")])
    average = float(np.average(y, weights=weights))
    penalty = np.full(65, RIDGE)
    penalty[-1] = 20
    prior = np.zeros(65)
    prior[-1] = 2  # Conservative prior for total home-field margin advantage.
    coefficients = np.linalg.solve(x.T @ (weights[:, None] * x) + np.diag(penalty),
                                   x.T @ (weights * (y - average)) + penalty * prior)
    errors = (y - (average + x @ coefficients)).reshape(-1, 2)
    margin_errors = errors[:, 0] - errors[:, 1]
    margin_sd = max(12., float(np.sqrt(np.average(margin_errors ** 2, weights=game_weights))))
    ties = sum(g["home_score"] == g["away_score"] for g in training)
    return {"coefficients": coefficients, "average": average, "margin_sd": margin_sd,
            "tie_probability": (ties + 1) / (len(training) + 200),
            "training_games": len(training),
            "current_season_games": sum(g["season"] == season for g in training),
            "training_first": min(g["kickoff"] for g in training),
            "training_last": max(g["kickoff"] for g in training)}


def predict(model: dict, game: dict) -> dict:
    points = np.maximum(3, model["average"] + design(game) @ model["coefficients"])
    margin = float(points[0] - points[1])
    conditional_home = max(.025, min(.975, .5 * (1 + math.erf(margin / model["margin_sd"] / math.sqrt(2)))))
    tie = round(model["tie_probability"], 6)
    home_win = round((1 - tie) * conditional_home, 6)
    return {"home_points": round(float(points[0]), 1), "away_points": round(float(points[1]), 1),
            "home_win": home_win, "away_win": round(1 - tie - home_win, 6), "tie": tie}


def backtest(games: list[dict], season: int, as_of: datetime) -> dict:
    """Refit BEFORE each historical week, never using that week's results."""
    observations = []
    score_residuals = []
    for year in range(season - 2, season):
        for week in range(1, 19):
            batch = [g for g in games if g["season"] == year and g["week"] == week
                     and g["home"] in INDEX and g["away"] in INDEX and completed(g, as_of)]
            if not batch:
                continue
            cutoff = min(timestamp(g["kickoff"]) for g in batch)
            model = fit_model(games, cutoff, year)
            for game in batch:
                forecast = predict(model, game)
                p = forecast["home_win"]
                observations.append((p, float(game["home_score"] > game["away_score"])))
                # Keep errors from the SAME game together to retain scoring
                # dependence. Every forecast was fitted before this week's games.
                if "home_points" in forecast and "away_points" in forecast:
                    weight = .5 ** ((as_of - timestamp(game["kickoff"])).total_seconds()
                                      / 86400 / HALF_LIFE_DAYS)
                    score_residuals.append([round(game["home_score"] - forecast["home_points"], 3),
                                            round(game["away_score"] - forecast["away_points"], 3),
                                            round(weight, 8)])
    if not observations:
        return {"games": 0}
    return {"games": len(observations), "seasons": [season - 2, season - 1],
            "brier_score": round(statistics.mean((p - y) ** 2 for p, y in observations), 4),
            "coin_flip_brier": .25, "score_residuals": score_residuals,
            "description": "Pre-week refits; home-win Brier score (lower is better). Ties are not home wins. Fixed settings; this is a historical diagnostic, not proof of an edge."}


def implied_probability(price: float) -> float:
    if not math.isfinite(price) or abs(price) < 100:
        raise ValueError("Invalid American moneyline")
    return -price / (-price + 100) if price < 0 else 100 / (price + 100)


def market_comparison(game: dict, odds_game: dict | None, as_of: datetime) -> dict | None:
    """Only complete, fresh, same-book pairs; never mix best opposing prices."""
    if not odds_game or not as_of < timestamp(game["kickoff"]) <= as_of + timedelta(days=8):
        return None
    books = {}
    for row in odds_game.get("rows", []):
        if row.get("provider_kind") != "sportsbook" or row.get("market") != "Moneyline":
            continue
        try:
            updated = timestamp(row["updated_at"])
            if not timedelta(0) <= as_of - updated <= timedelta(hours=48):
                continue
            implied = implied_probability(float(row["price"]))
        except (KeyError, TypeError, ValueError):
            continue
        key = row.get("provider_key")
        if key and row.get("selection") in (game["home"], game["away"]):
            books.setdefault(key, {})[row["selection"]] = (implied, updated)
    pairs = [pair for pair in books.values() if game["home"] in pair and game["away"] in pair
             and abs((pair[game["home"]][1] - pair[game["away"]][1]).total_seconds()) <= 3600]
    if not pairs:
        return None
    share = statistics.median(pair[game["home"]][0] / (pair[game["home"]][0] + pair[game["away"]][0]) for pair in pairs)
    return {"home_share": round(share, 6), "away_share": round(1 - share, 6), "books": len(pairs),
            "oldest_quote": min(value[1] for pair in pairs for value in pair.values()).isoformat()}


def build_snapshot(games: list[dict], season: int, as_of: datetime, odds: dict | None = None) -> dict:
    current = [g for g in games if g["season"] == season]
    if not current or any(g["home"] not in INDEX or g["away"] not in INDEX for g in current):
        raise ValueError("No valid current-season schedule")
    identities = [g["game_id"] for g in current]
    appearances = [(g["week"], g[side]) for g in current for side in ("home", "away")]
    if len(set(identities)) != len(current) or len(set(appearances)) != len(appearances):
        raise ValueError("Duplicate schedule games or team/week appearances")
    team_counts = {team: sum(g[side] == team for g in current for side in ("home", "away")) for team in TEAMS}
    if len(current) != 272 or set(g["week"] for g in current) != set(range(1, 19)) or set(team_counts.values()) != {17}:
        raise ValueError("Incomplete season schedule; retaining the previous snapshot")
    model = fit_model(games, as_of, season)
    odds_by_id = {g["game_id"]: g for g in (odds or {}).get("games", [])}
    fixtures = []
    for game in sorted(current, key=lambda g: (g["week"], g["kickoff"])):
        final = completed(game, as_of)
        status = "final" if final else "locked" if timestamp(game["kickoff"]) <= as_of else "scheduled"
        # Do not show retrospectively fitted probabilities for finished games.
        fixtures.append({**game, "status": status,
                         "home_score": game["home_score"] if final else None,
                         "away_score": game["away_score"] if final else None,
                         "model": predict(model, game) if status == "scheduled" else None,
                         "market": market_comparison(game, odds_by_id.get(game["game_id"]), as_of) if status == "scheduled" else None})
    def season_scoring(team):
        finished = [g for g in current if team in (g["home"], g["away"]) and completed(g, as_of)]
        scored = [g["home_score" if g["home"] == team else "away_score"] for g in finished]
        allowed = [g["away_score" if g["home"] == team else "home_score"] for g in finished]
        return {"games": len(finished),
                "points_for": round(statistics.mean(scored), 2) if scored else None,
                "points_against": round(statistics.mean(allowed), 2) if allowed else None}

    teams = [{"team": team, "name": TEAM_NAMES[team],
              "offense": round(float(model["coefficients"][INDEX[team]]), 2),
              "defense": round(float(model["coefficients"][32 + INDEX[team]]), 2),
              "current_season": season_scoring(team)} for team in TEAMS]
    evidence = backtest(games, season, as_of)
    residuals = evidence.pop("score_residuals", [])
    return {"season": season, "generated_at": as_of.isoformat(), "model_version": MODEL_VERSION,
            "source": {"name": "nflverse schedules and results", "url": NFLVERSE_SOURCE_URL},
            "training": {k: model[k] for k in ("training_games", "current_season_games", "training_first", "training_last", "margin_sd", "tie_probability")},
            "league_points": round(model["average"], 2), "home_advantage": round(float(model["coefficients"][-1]), 2),
            "backtest": evidence, "teams": teams, "games": fixtures,
            "simulation": {"method": "Paired pre-week forecast errors v1", "seasons": evidence.get("seasons", []),
                           "residuals": residuals,
                           "description": "Home error, away error, recency weight. Prior two regular seasons, forecasts fitted before each week. Centered in the simulator; not calibrated prediction intervals."}}


def refresh_survivor(destination: Path, season: int, odds_path: Path) -> dict:
    response = requests.get(SCHEDULE_URL, timeout=60)
    response.raise_for_status()
    odds = json.loads(odds_path.read_text(encoding="utf-8")) if odds_path.exists() else None
    snapshot = build_snapshot(parse_schedule(response.text), season, datetime.now(timezone.utc), odds)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(snapshot, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(destination)
    print(f"Survivor: {len(snapshot['games'])} games; {snapshot['training']['training_games']} training games; historical Brier {snapshot['backtest'].get('brier_score')}")
    return snapshot
