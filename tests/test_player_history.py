from datetime import datetime, timezone
import json

import pandas as pd

from app.player_history import build_player_history, history_key


def _rankings(path):
    path.write_text(json.dumps({
        "columns": ["overall_rank", "player", "player_id", "team", "pos"],
        "boards": {"12team_2qb_te_premium_half_ppr": [
            [1, "DeVonta Smith", "00-0036912", "PHI", "WR"],
            [2, "No ID Runner", None, "BUF", "RB"],
            [3, "New Rookie", "00-0099999", "DAL", "WR"],
        ]},
    }), encoding="utf-8")


def _stats(season):
    return pd.DataFrame([
        {
            "player_id": "00-0036912", "player_display_name": "DeVonta Smith",
            "position": "WR", "season": season, "season_type": "REG", "recent_team": "PHI",
            "games": 17, "completions": 0, "attempts": 0, "passing_yards": 0,
            "passing_tds": 0, "passing_interceptions": 0, "carries": 2,
            "rushing_yards": 12, "rushing_tds": 0, "targets": 120, "receptions": 80,
            "receiving_yards": 1050, "receiving_tds": 7, "fumbles_total": 1,
        },
        {
            "player_id": "", "player_display_name": "No ID Runner Jr.", "position": "RB",
            "season": season, "season_type": "REG", "recent_team": "BUF", "games": 12,
            "completions": 0, "attempts": 0, "passing_yards": 0, "passing_tds": 0,
            "passing_interceptions": 0, "carries": 150, "rushing_yards": 700,
            "rushing_tds": 5, "targets": 35, "receptions": 28, "receiving_yards": 230,
            "receiving_tds": 1, "fumbles_total": 2,
        },
    ])


def test_history_key_prefers_stable_player_id_and_falls_back_to_name_position():
    assert history_key({"player": "Josh Allen", "player_id": "00-0034857", "pos": "QB"}) == "id:00-0034857"
    assert history_key({"player": "No ID Runner Jr.", "player_id": None, "pos": "RB"}) == "name:noidrunner|RB"


def test_build_player_history_matches_ids_and_name_position_and_sorts_newest_first(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "history.json"
    _rankings(rankings)
    build_player_history(
        rankings,
        destination,
        season_frames=[_stats(2024), _stats(2025)],
        now=datetime(2026, 9, 6, tzinfo=timezone.utc),
    )

    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert payload["seasons"] == [2024, 2025]
    assert payload["start_season"] == 2024
    assert payload["end_season"] == 2025
    assert payload["season_count"] == 2
    assert payload["player_count"] == 2
    assert payload["player_season_count"] == 4
    assert payload["players"]["id:00-0036912"]["seasons"][0][0] == 2025
    assert payload["players"]["name:noidrunner|RB"]["seasons"][0][1] == "BUF"
    assert "id:00-0099999" not in payload["players"]
