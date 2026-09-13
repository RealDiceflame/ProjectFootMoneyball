from datetime import datetime, timezone
import json
import pytest
from app.scoreboard import parse_games, refresh_due, refresh_scores

HEADER = "game_id,season,game_type,week,gameday,gametime,home_team,away_team,home_score,away_score\n"
ROW = "2026_01_BUF_BAL,2026,REG,1,2026-09-13,13:00,BAL,BUF,0,14\n"
NOW = datetime(2026,9,13,18,tzinfo=timezone.utc)

def test_scores_preserve_zero_eastern_kickoff_and_unknown_time():
    game = parse_games(HEADER+ROW,2026,expected_games=1)[0]
    assert game["home_score"] == 0 and game["away_score"] == 14
    assert game["kickoff"] == "2026-09-13T17:00:00+00:00"
    assert "status" not in game  # No unsupported final/live assertion.
    assert parse_games(HEADER+ROW.replace("13:00",""),2026,expected_games=1)[0]["kickoff"] is None

def test_invalid_partial_and_duplicate_data():
    for value in ["-1", "nan", "inf", "1.5"]:
        with pytest.raises(ValueError):
            parse_games(HEADER+ROW.replace(",0,14",f",{value},14"),2026,expected_games=1)
    assert parse_games(HEADER+ROW.replace(",0,14",",,14"),2026,expected_games=1)[0]["away_score"] is None
    with pytest.raises(ValueError): parse_games(HEADER+ROW+ROW,2026,expected_games=2)
    with pytest.raises(ValueError): parse_games(HEADER+ROW,2026)

def test_refresh_window_and_off_day_frequency():
    game = parse_games(HEADER+ROW,2026,expected_games=1)[0]
    assert refresh_due({"checked_at":"2026-09-13T17:55:00Z","games":[game]},NOW)
    monday = datetime(2026,9,14,12,tzinfo=timezone.utc)
    assert not refresh_due({"checked_at":"2026-09-14T11:00:00Z","games":[game]},monday)
    assert refresh_due({"checked_at":"2026-09-14T05:00:00Z","games":[game]},monday)
    assert refresh_due({},NOW)


def test_missing_scores_do_not_erase_reported_results_or_advance_timestamp(tmp_path):
    path = tmp_path / "scores.json"
    refresh_scores(path,2026,now=NOW,fetch=lambda:HEADER+ROW,expected_games=1)
    saved = path.read_bytes()
    for missing in [",,", ",,14", ",0,"]:
        with pytest.raises(ValueError, match="disappeared"):
            refresh_scores(path,2026,now=NOW,fetch=lambda:HEADER+ROW.replace(",0,14",missing),expected_games=1)
        assert path.read_bytes() == saved
    # A genuine numeric correction, including downward corrections, is allowed.
    refresh_scores(path,2026,now=NOW,fetch=lambda:HEADER+ROW.replace(",0,14",",0,7"),expected_games=1)
    assert json.loads(path.read_text())["games"][0]["away_score"] == 7

def test_failed_fetch_or_invalid_data_retains_last_good_file(tmp_path):
    path = tmp_path / "scores.json"
    assert refresh_scores(path,2026,now=NOW,fetch=lambda:HEADER+ROW,expected_games=1)
    saved = path.read_bytes()
    with pytest.raises(ValueError): refresh_scores(path,2026,now=NOW,fetch=lambda:"broken")
    assert path.read_bytes() == saved
    def fail(): raise OSError("Network unavailable")
    with pytest.raises(OSError): refresh_scores(path,2026,now=NOW,fetch=fail)
    assert path.read_bytes() == saved
    monday = datetime(2026,9,14,12,tzinfo=timezone.utc)
    state = json.loads(saved); state["checked_at"] = "2026-09-14T11:00:00Z"
    path.write_text(json.dumps(state))
    assert not refresh_scores(path,2026,scheduled=True,now=monday,fetch=fail)
