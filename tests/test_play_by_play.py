import csv
from datetime import datetime, timezone, timedelta
import gzip
from io import StringIO
import json

import pytest
from app import play_by_play as pbp

GAME = "2025_01_DAL_PHI"
SCHEDULE = {GAME: {"game_id": GAME, "week": 1, "away": "DAL", "home": "PHI", "away_score": 6, "home_score": 0}}


def rows():
    base = {key: "" for key in pbp.REQUIRED}
    base.update(game_id=GAME, season="2025", season_type="REG", week="1", home_team="PHI", away_team="DAL",
                home_score="0", away_score="6", qtr="1", time="15:00", fixed_drive="1", fixed_drive_result="Touchdown",
                ydstogo="0", total_home_score="0", total_away_score="0", sp="0", desc="GAME")
    return [{**base, "play_id": "101", "order_sequence": "1"},
            {**base, "play_id": "100", "order_sequence": "2", "desc": "A runner scores.", "time": "13:20",
             "posteam": "DAL", "defteam": "PHI", "play_type": "run", "down": "1", "ydstogo": "1",
             "yardline_100": "1", "yards_gained": "1", "total_away_score": "6", "sp": "1", "touchdown": "1",
             "penalty": "0", "rusher_player_id": "00-0036997", "rusher_player_name": "J.Williams"},
            {**base, "play_id": "103", "order_sequence": "3", "qtr": "4", "time": "00:00", "desc": "END GAME", "total_away_score": "6"}]


def source(records):
    stream = StringIO()
    writer = csv.DictWriter(stream, fieldnames=sorted(pbp.REQUIRED))
    writer.writeheader()
    writer.writerows(records)
    return gzip.compress(stream.getvalue().encode(), mtime=0)


def test_source_order_ids_null_zero_and_postseason_retention():
    records = rows()
    records.append({**records[0], "season_type": "POST"})
    grouped, drives, audit = pbp.parse_plays(source(records), SCHEDULE)
    plays = grouped[GAME]
    assert [p["play_id"] for p in plays] == [101, 100, 103]
    assert plays[0]["yards_gained"] is None and plays[1]["penalty"] == 0
    assert plays[1]["players"] == [{"role": "rusher", "player_id": "00-0036997", "name": "J.Williams"}]
    assert drives[GAME][1]["start_team"] == "DAL"
    assert audit["regular_season_rows"] == 3 and audit["postseason_rows_retained_raw"] == 1


@pytest.mark.parametrize("field,value", [
    ("game_id", "2025_02_DAL_PHI"), ("home_team", "BUF"), ("week", "2"), ("season", "2024"),
    ("season_type", "PRE"), ("home_score", "7"), ("total_away_score", "5"), ("sp", "0"),
    ("play_id", "NaN"), ("down", "2.5"), ("yards_gained", "Infinity"), ("time", "16:00"),
    ("posteam", "NYG"), ("defteam", "DAL"), ("rusher_player_id", "bad-id"), ("desc", ""),
])
def test_invalid_source_fails(field, value):
    data = rows()
    data[1][field] = value
    with pytest.raises(ValueError):
        pbp.parse_plays(source(data), SCHEDULE)


@pytest.mark.parametrize("change", ["duplicate", "duplicate_order", "no_end", "missing_game", "score_regression", "period_regression"])
def test_incomplete_or_conflicting_games_fail(change):
    data = rows()
    schedule = SCHEDULE
    if change == "duplicate": data.append(data[1])
    if change == "duplicate_order": data[1]["order_sequence"] = "1"
    if change == "no_end": data[-1]["desc"] = "Still playing"
    if change == "missing_game": schedule = {**SCHEDULE, "2025_01_NE_BUF": {}}
    if change == "score_regression": data[-1]["total_away_score"] = "0"
    if change == "period_regression": data[0]["qtr"] = "2"
    with pytest.raises(ValueError): pbp.parse_plays(source(data), schedule)


def test_overtime_can_end_with_time_remaining_and_missing_clock_is_unknown():
    data = rows()
    data[0]["time"] = ""
    data[-1].update(qtr="5", time="03:36")
    plays, _, _ = pbp.parse_plays(source(data), SCHEDULE)
    assert plays[GAME][0]["clock"] is None
    assert plays[GAME][-1]["clock"] == "03:36"


def test_defensive_score_and_pat_can_change_team_inside_corrected_drive():
    data = rows()
    data[2].update(posteam="PHI", defteam="DAL")
    _, drives, _ = pbp.parse_plays(source(data), SCHEDULE)
    assert drives[GAME][1]["start_team"] == "DAL"


def test_truncated_columns_and_bad_compression_fail():
    with pytest.raises(ValueError): pbp.parse_plays(gzip.compress(b"game_id,season\n"), SCHEDULE)
    with pytest.raises((OSError, EOFError)): pbp.parse_plays(b"not gzip", SCHEDULE)
    with pytest.raises(ValueError, match="size limit"): pbp.expanded(gzip.compress(b"x" * 20), 10)


def test_refresh_is_idempotent_and_failure_preserves_every_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pbp, "parse_historical_schedule", lambda *a, **kw: SCHEDULE)
    data = rows()
    fetch = lambda url: (source(data) if url == pbp.PBP_URL else gzip.compress(b"schedule", mtime=0), None)
    sentinel = tmp_path / "docs/data/scores.json"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text('{"season":2026}')
    now = datetime(2026, 10, 30, tzinfo=timezone.utc)
    pbp.refresh_play_by_play(tmp_path, fetch=fetch, now=now)
    snapshots = lambda: {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    before = snapshots()
    pbp.refresh_play_by_play(tmp_path, fetch=fetch, now=now+timedelta(days=1))
    assert snapshots() == before
    data[1]["sp"] = "0"
    with pytest.raises(ValueError): pbp.refresh_play_by_play(tmp_path, fetch=fetch, now=now)
    assert snapshots() == before
    assert json.loads(sentinel.read_text())["season"] == 2026


def test_previously_archived_non_scoring_event_cannot_disappear(tmp_path, monkeypatch):
    monkeypatch.setattr(pbp, "parse_historical_schedule", lambda *a, **kw: SCHEDULE)
    data = rows()
    fetch = lambda url: (source(data) if url == pbp.PBP_URL else gzip.compress(b"schedule"), None)
    pbp.refresh_play_by_play(tmp_path, fetch=fetch)
    data.pop(0)
    with pytest.raises(ValueError, match="plays disappeared"): pbp.refresh_play_by_play(tmp_path, fetch=fetch)
