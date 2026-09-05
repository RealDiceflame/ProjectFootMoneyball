import json

import pandas as pd
import pytest

from app.web_exporter import TEAM_SIZES, export_special_teams, export_web_rankings


def _ranking_row(value):
    return {
        "overall_rank": 1,
        "player": "Player One",
        "player_id": "00-0012345",
        "is_rookie": False,
        "team": "BUF",
        "pos": "QB",
        "position_rank": "QB1",
        "projected_points": 300.0,
        "vorp": 100.0,
        "market_expected_points": 280.0,
        "market_value": value,
        "adp": 5.0,
        "source_count": 5,
        "adp_spread": 4.0,
        "adp_stddev": 1.6,
        "value_vs_adp": value,
        "Yahoo": 4.0,
        "Sleeper": 5.0,
        "NFL": 6.0,
        "MFL": 3.0,
        "format": "test",
    }


def test_export_web_rankings_builds_every_board_and_draft_tag(tmp_path):
    rankings = tmp_path / "rankings"
    rankings.mkdir()
    for teams in TEAM_SIZES:
        for number in range(12):
            pd.DataFrame([_ranking_row(50 if number == 0 else -20)]).to_csv(
                rankings / f"draft_rankings_{teams}team_format_{number}.csv",
                index=False,
            )

    destination = tmp_path / "site" / "rankings.json"
    result = export_web_rankings(
        rankings,
        destination,
        projection_season=2026,
        stat_season=2025,
        adp_updated="2026-08-29",
        adp_sources={
            "Yahoo": "2026-08-28", "Sleeper": "2026-08-29", "NFL": "2026-08-29",
            "MFL": "2026-08-29",
        },
    )

    payload = json.loads(result.read_text(encoding="utf-8"))
    assert len(payload["boards"]) == 60
    assert payload["projection_season"] == 2026
    assert payload["adp_sources"]["Yahoo"] == "2026-08-28"
    assert "market_value" in payload["columns"]
    assert "adp_spread" in payload["columns"]
    assert "adp_stddev" in payload["columns"]
    assert "is_rookie" in payload["columns"]
    tag_index = payload["columns"].index("draft_tag")
    assert payload["boards"]["8team_format_0"][0][tag_index] == "TARGET"
    assert payload["boards"]["8team_format_1"][0][tag_index] == "REACH"


def test_export_web_rankings_requires_all_formats(tmp_path):
    with pytest.raises(FileNotFoundError, match="Expected 60"):
        export_web_rankings(
            tmp_path,
            tmp_path / "rankings.json",
            projection_season=2026,
            stat_season=2025,
            adp_updated="2026-08-29",
        )


def test_export_special_teams_builds_compact_market_payload(tmp_path):
    source = tmp_path / "special.csv"
    pd.DataFrame([{
        "Player": "Houston Texans",
        "Team": "HOU",
        "Position": "DST",
        "Position_Rank": "DST1",
        "ADP": 101.2,
        "Source_Count": 3,
        "ADP_StdDev": 4.3,
        "Sleeper": 99.0,
        "NFL": 100.0,
        "MFL": 104.6,
        "Sleeper_Updated": "2026-09-04",
        "NFL_Updated": "2026-09-04",
        "MFL_Updated": "2026-09-04",
    }]).to_csv(source, index=False)

    destination = export_special_teams(
        source,
        tmp_path / "special.json",
        projection_season=2026,
    )
    payload = json.loads(destination.read_text(encoding="utf-8"))

    assert payload["rows"][0][payload["columns"].index("position_rank")] == "DST1"
    assert payload["source_dates"]["NFL"] == "2026-09-04"
