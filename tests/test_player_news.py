from datetime import datetime, timezone
import json

import pandas as pd

from app.player_news import build_player_news, espn_team_url, match_headlines, normalize_name


def _rankings(path):
    path.write_text(json.dumps({
        "columns": ["overall_rank", "player", "team", "pos"],
        "boards": {"12team_2qb_te_premium_half_ppr": [
            [1, "Starter Runner", "BUF", "RB"],
            [2, "Reserve Receiver", "KC", "WR"],
        ]},
    }), encoding="utf-8")


def test_normalize_name_ignores_common_suffixes_and_punctuation():
    assert normalize_name("Brian Thomas Jr.") == normalize_name("Brian Thomas")
    assert normalize_name("Kenneth Walker III") == normalize_name("Kenneth Walker")


def test_espn_team_url_handles_team_code_differences():
    assert espn_team_url("depth", "BUF").endswith("/name/buf")
    assert espn_team_url("depth", "LA").endswith("/name/lar")
    assert espn_team_url("roster", "WAS").endswith("/name/wsh")


def test_match_headlines_uses_full_name_in_url_and_labels_injury_watch():
    players = [
        {"player": "Starter Runner", "team": "BUF", "pos": "RB"},
        {"player": "Another Player", "team": "KC", "pos": "WR"},
    ]
    matched = match_headlines(players, [{
        "title": "Runner misses practice with injury",
        "date": "2026-09-04",
        "url": "https://www.espn.com/nfl/story/starter-runner-injury",
    }])
    assert matched["starter runner|BUF"][0]["severity"] == "watch"
    assert matched["starter runner|BUF"][0]["category"] == "Recent news"


def test_match_headlines_skips_ambiguous_roster_names():
    players = [{"player": "Same Name", "team": "BUF", "pos": "QB"}]
    headlines = [{
        "title": "Same Name changes teams",
        "date": "2026-09-04",
        "url": "https://www.espn.com/nfl/story/same-name",
    }]

    assert match_headlines(players, headlines, ambiguous_names={"samename"}) == {}


def test_build_player_news_creates_depth_roster_and_position_updates(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "player_news.json"
    _rankings(rankings)
    roster = pd.DataFrame([
        {
            "team": "BUF",
            "status": "ACT",
            "full_name": "Starter Runner",
            "status_description_abbr": None,
            "headshot_url": "https://static.www.nfl.com/image/upload/f_auto,q_auto/league/starter",
        },
        {"team": "KC", "status": "RES", "full_name": "Reserve Receiver Jr.", "status_description_abbr": "R/I"},
    ])
    current_depth = pd.DataFrame([
        {"dt": "2026-09-04T12:00:00Z", "team": "BUF", "player_name": "New Backup", "pos_abb": "RB", "pos_rank": 1},
        {"dt": "2026-09-04T12:00:00Z", "team": "BUF", "player_name": "Starter Runner", "pos_abb": "RB", "pos_rank": 2},
        {"dt": "2026-09-04T12:00:00Z", "team": "KC", "player_name": "Reserve Receiver Jr.", "pos_abb": "WR", "pos_rank": 4},
    ])
    previous_depth = pd.DataFrame([
        {"dt": "2025-12-31T12:00:00Z", "team": "BUF", "player_name": "Old Backup", "pos_abb": "RB", "pos_rank": 1},
        {"dt": "2025-12-31T12:00:00Z", "team": "BUF", "player_name": "Starter Runner", "pos_abb": "RB", "pos_rank": 2},
        {"dt": "2025-12-31T12:00:00Z", "team": "KC", "player_name": "Reserve Receiver Jr.", "pos_abb": "WR", "pos_rank": 2},
    ])
    build_player_news(
        rankings,
        destination,
        season=2026,
        current_roster=roster,
        current_depth=current_depth,
        previous_depth=previous_depth,
        now=datetime(2026, 9, 4, 15, 0, tzinfo=timezone.utc),
    )
    payload = json.loads(destination.read_text(encoding="utf-8"))
    starter = payload["reports"]["starter runner|BUF"]
    reserve = payload["reports"]["reserve receiver|KC"]
    assert payload["player_count"] == 2
    assert starter["listed_team"] == "BUF"
    assert starter["current_team"] == "BUF"
    assert starter["headshot_url"] == (
        "https://static.www.nfl.com/image/upload/"
        "f_auto,q_auto,w_160,c_fill,g_face/league/starter"
    )
    assert {event["category"] for event in starter["events"]} >= {"Depth chart", "Arrival", "Departure"}
    depth_event = next(event for event in starter["events"] if event["category"] == "Depth chart")
    assert depth_event["source"] == {
        "title": "View BUF depth chart at ESPN",
        "url": "https://www.espn.com/nfl/team/depth/_/name/buf",
    }
    assert starter["signal"] == "watch"
    assert reserve["signal"] == "risk"
    assert reserve["events"][0]["title"] == "Reserve-list status"
    assert reserve["events"][0]["source"]["url"] == "https://www.espn.com/nfl/team/roster/_/name/kc"


def test_build_player_news_records_both_listed_and_current_team(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "player_news.json"
    rankings.write_text(json.dumps({
        "columns": ["overall_rank", "player", "team", "pos"],
        "boards": {"12team_2qb_te_premium_half_ppr": [[1, "Moved Player", "WAS", "WR"]]},
    }), encoding="utf-8")
    roster = pd.DataFrame([{
        "team": "NYG",
        "status": "ACT",
        "full_name": "Moved Player",
        "status_description_abbr": None,
        "headshot_url": "https://static.example.com/moved-player.png",
    }])
    current_depth = pd.DataFrame([{
        "dt": "2026-09-04T12:00:00Z",
        "team": "NYG",
        "player_name": "Moved Player",
        "pos_abb": "WR",
        "pos_rank": 2,
    }])
    depth_columns = ["dt", "team", "player_name", "pos_abb", "pos_rank"]

    build_player_news(
        rankings,
        destination,
        season=2026,
        current_roster=roster,
        current_depth=current_depth,
        previous_depth=pd.DataFrame(columns=depth_columns),
        now=datetime(2026, 9, 4, 15, 0, tzinfo=timezone.utc),
    )

    report = json.loads(destination.read_text(encoding="utf-8"))["reports"]["moved player|WAS"]
    assert report["listed_team"] == "WAS"
    assert report["current_team"] == "NYG"
    assert report["headshot_url"] == "https://static.example.com/moved-player.png"
    assert report["events"][0]["source"]["url"] == "https://www.espn.com/nfl/team/roster/_/name/nyg"
    depth_event = next(event for event in report["events"] if event["category"] == "Depth chart")
    assert depth_event["title"] == "Listed as WR2"
    assert depth_event["source"]["url"] == "https://www.espn.com/nfl/team/depth/_/name/nyg"


def test_player_id_prevents_same_name_roster_collision(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "player_news.json"
    rankings.write_text(json.dumps({
        "columns": ["overall_rank", "player", "player_id", "team", "pos"],
        "boards": {"12team_2qb_te_premium_half_ppr": [[
            1, "DeVonta Smith", "00-0036912", "PHI", "WR",
        ]]},
    }), encoding="utf-8")
    roster = pd.DataFrame([
        {
            "gsis_id": "00-0036912",
            "full_name": "DeVonta Smith",
            "team": "PHI",
            "position": "WR",
            "status": "ACT",
            "status_description_abbr": None,
            "headshot_url": "https://static.example.com/eagles-smith.png",
        },
        {
            "gsis_id": "00-0041153",
            "full_name": "Devonta Smith",
            "team": "CAR",
            "position": "DB",
            "status": "DEV",
            "status_description_abbr": None,
            "headshot_url": "https://static.example.com/panthers-smith.png",
        },
    ])
    depth = pd.DataFrame([{
        "dt": "2026-09-04T12:00:00Z",
        "team": "PHI",
        "player_name": "DeVonta Smith",
        "pos_abb": "WR",
        "pos_rank": 1,
    }])

    build_player_news(
        rankings,
        destination,
        season=2026,
        current_roster=roster,
        current_depth=depth,
        previous_depth=depth,
        now=datetime(2026, 9, 4, 15, 0, tzinfo=timezone.utc),
    )

    report = json.loads(destination.read_text(encoding="utf-8"))["reports"]["devonta smith|PHI"]
    assert report["player_id"] == "00-0036912"
    assert report["current_team"] == "PHI"
    assert report["headshot_url"] == "https://static.example.com/eagles-smith.png"
    assert all(event["category"] != "Roster" for event in report["events"])


def test_position_fallback_separates_same_name_players_without_an_id(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "player_news.json"
    rankings.write_text(json.dumps({
        "columns": ["overall_rank", "player", "team", "pos"],
        "boards": {"12team_2qb_te_premium_half_ppr": [[1, "Josh Allen", "BUF", "QB"]]},
    }), encoding="utf-8")
    roster = pd.DataFrame([
        {"full_name": "Josh Allen", "team": "BUF", "position": "QB", "status": "ACT"},
        {"full_name": "Josh Allen", "team": "JAX", "position": "DE", "status": "ACT"},
    ])
    depth = pd.DataFrame([{
        "dt": "2026-09-04T12:00:00Z",
        "team": "BUF",
        "player_name": "Josh Allen",
        "pos_abb": "QB",
        "pos_rank": 1,
    }])

    build_player_news(
        rankings,
        destination,
        season=2026,
        current_roster=roster,
        current_depth=depth,
        previous_depth=depth,
        now=datetime(2026, 9, 4, 15, 0, tzinfo=timezone.utc),
    )

    report = json.loads(destination.read_text(encoding="utf-8"))["reports"]["josh allen|BUF"]
    assert report["current_team"] == "BUF"
    assert all(event["category"] != "Roster" for event in report["events"])
