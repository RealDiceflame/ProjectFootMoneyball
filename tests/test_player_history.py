from datetime import datetime, timezone
import json

import pandas as pd
import pytest

from app.player_history import (HISTORY_COLUMNS, OPTIONAL_STAT_COLUMNS, STAT_COLUMNS,
                                _download_season, build_player_history, history_key, refresh_player_history)


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


def test_keeps_recent_historical_careers_and_birth_dates_without_marking_retirement(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "history.json"
    _rankings(rankings)
    rows = [
        {**_stats(year).iloc[0].to_dict(), "player_id": "retired-wr", "player_display_name": "Past Receiver"}
        for year in [2016, 2019, 2020]
    ]
    rows.extend([
        {**_stats(2019).iloc[0].to_dict(), "player_id": "older-wr", "player_display_name": "Older Receiver"},
        {**_stats(2025).iloc[0].to_dict(), "player_id": "defender", "player_display_name": "DeVonta Smith", "position": "CB"},
        {**_stats(2022).iloc[0].to_dict(), "player_id": "same-name-wr", "player_display_name": "DeVonta Smith"},
        {**_stats(2025).iloc[0].to_dict(), "player_id": "post-only", "season_type": "POST"},
    ])
    players = pd.DataFrame([
        {"gsis_id": "retired-wr", "birth_date": "1987-06-03"},
        {"gsis_id": "00-0036912", "birth_date": "1998-11-14"},
    ])
    build_player_history(rankings, destination, season_frames=[_stats(2025), pd.DataFrame(rows)], player_frame=players)
    payload = json.loads(destination.read_text())
    archived = payload["players"]["id:retired-wr"]
    assert archived["last_recorded_season"] == 2020
    assert [row[0] for row in archived["seasons"]] == [2020, 2019, 2016]
    assert archived["birth_date"] == "1987-06-03"
    assert archived["is_ranked"] is False
    assert "retired" not in archived
    assert payload["historical_since_season"] == 2020
    assert payload["ranked_player_count"] == 2
    assert payload["historical_player_count"] == 2
    assert "id:older-wr" not in payload["players"]
    assert "id:defender" not in payload["players"]
    assert "id:post-only" not in payload["players"]
    assert [row[0] for row in payload["players"]["id:00-0036912"]["seasons"]] == [2025]
    assert payload["players"]["id:same-name-wr"]["birth_date"] is None


def test_idless_ranked_match_is_not_duplicated_in_the_archive(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "history.json"
    _rankings(rankings)
    frame = _stats(2025)
    frame.loc[1, "player_id"] = "runner-id"
    build_player_history(rankings, destination, season_frames=[frame])
    payload = json.loads(destination.read_text())
    assert payload["player_count"] == 2
    assert payload["historical_player_count"] == 0
    assert payload["players"]["name:noidrunner|RB"]["player_id"] == "runner-id"


def test_empty_history_and_invalid_lookback_are_handled(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "history.json"
    _rankings(rankings)
    build_player_history(rankings, destination, season_frames=[])
    payload = json.loads(destination.read_text())
    assert payload["players"] == {}
    assert payload["historical_player_count"] == 0
    assert payload["historical_since_season"] is None
    with pytest.raises(ValueError, match="historical_lookback"):
        refresh_player_history(rankings, destination, start_season=2016, end_season=2025, historical_lookback=-1)


def test_failed_identity_download_preserves_published_history(tmp_path, monkeypatch):
    destination = tmp_path / "history.json"
    destination.write_text('{"previous":true}')
    monkeypatch.setattr("app.player_history._download_season", lambda season: _stats(season))

    def unavailable():
        raise RuntimeError("Identity source unavailable")

    monkeypatch.setattr("app.player_history._download_players", unavailable)
    with pytest.raises(RuntimeError, match="Identity source unavailable"):
        refresh_player_history(tmp_path / "rankings.json", destination, start_season=2025, end_season=2025)
    assert json.loads(destination.read_text()) == {"previous": True}


def test_optional_scoring_columns_append_without_changing_legacy_order(tmp_path):
    rankings, destination = tmp_path / "rankings.json", tmp_path / "history.json"
    _rankings(rankings)
    newer = _stats(2025)
    for column in OPTIONAL_STAT_COLUMNS:
        newer[column] = [0, 1]
    newer.loc[1, "receiving_2pt_conversions"] = None
    build_player_history(rankings, destination, season_frames=[_stats(2024), newer])
    payload = json.loads(destination.read_text())
    legacy = ["season", "team", *STAT_COLUMNS, "pos"]
    assert payload["columns"][:len(legacy)] == legacy
    assert payload["columns"][len(legacy):] == list(OPTIONAL_STAT_COLUMNS)
    records = payload["players"]["id:00-0036912"]["seasons"]
    assert records[0][-5:] == [0, 0, 0, 0, 0]
    assert records[1][-5:] == [None] * 5
    # The old scoring field stays intact and is never relabeled as lost fumbles.
    assert records[0][payload["columns"].index("fumbles_total")] == 1
    coverage = payload["scoring_coverage"]["by_season"]
    assert coverage["2024"]["complete_optional_rows"] == 0
    assert coverage["2024"]["missing"]["fumbles_lost_total"] == 2
    assert coverage["2025"]["complete_optional_rows"] == 1
    assert coverage["2025"]["missing"]["receiving_2pt_conversions"] == 1
    assert all(len(row) == len(HISTORY_COLUMNS) for record in payload["players"].values() for row in record["seasons"])


@pytest.mark.parametrize("optional", [False, True])
def test_season_download_accepts_legacy_and_optional_columns_and_preserves_provenance(optional):
    frame = _stats(2025)
    if optional:
        for column in OPTIONAL_STAT_COLUMNS:
            frame[column] = [0, 1]

    class Response:
        content = frame.to_csv(index=False).encode()
        headers = {"Last-Modified": "source-date"}

        def raise_for_status(self):
            pass

    downloaded = _download_season(2025, get=lambda *args, **kwargs: Response())
    assert all((column in downloaded.columns) is optional for column in OPTIONAL_STAT_COLUMNS)
    assert downloaded.attrs["source"]["season"] == 2025
    assert downloaded.attrs["source"]["http_last_modified"] == "source-date"
    assert len(downloaded.attrs["source"]["sha256"]) == 64


@pytest.mark.parametrize("fault", ["missing_required", "wrong_season", "empty"])
def test_season_download_rejects_incomplete_or_wrong_season_sources(fault):
    frame = _stats(2025)
    if fault == "missing_required":
        frame = frame.drop(columns=["fumbles_total"])
    elif fault == "wrong_season":
        frame["season"] = 2024
    else:
        frame = frame.iloc[:0]

    class Response:
        content = frame.to_csv(index=False).encode()

        def raise_for_status(self):
            pass

    with pytest.raises(ValueError, match="Season history source"):
        _download_season(2025, get=lambda *args, **kwargs: Response())


@pytest.mark.parametrize("value", [float("inf"), -1, 1.5, "broken", True])
def test_invalid_optional_statistic_preserves_last_good_history(tmp_path, value):
    rankings, destination = tmp_path / "rankings.json", tmp_path / "history.json"
    _rankings(rankings)
    destination.write_text('{"previous":true}')
    frame = _stats(2025)
    frame["fumbles_lost_total"] = pd.Series([value, 0], dtype=object)
    with pytest.raises(ValueError, match="optional scoring statistic"):
        build_player_history(rankings, destination, season_frames=[frame])
    assert json.loads(destination.read_text()) == {"previous": True}


def test_failed_middle_season_download_preserves_last_good_history(tmp_path, monkeypatch):
    destination = tmp_path / "history.json"
    destination.write_text('{"previous":true}')

    def download(season):
        if season == 2020:
            raise OSError("Season unavailable")
        return _stats(season)

    monkeypatch.setattr("app.player_history._download_season", download)
    with pytest.raises(OSError, match="Season unavailable"):
        refresh_player_history(tmp_path / "rankings.json", destination, start_season=2016, end_season=2025)
    assert json.loads(destination.read_text()) == {"previous": True}
