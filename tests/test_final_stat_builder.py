import pandas as pd

from stat_utils.project_dataframe_utils import (
    append_rookies_to_stats,
    build_final_player_stats,
    load_nflverse_stat_tables,
)


def test_build_final_player_stats_uses_requested_paths(tmp_path):
    input_path = tmp_path / "merged.csv"
    output_path = tmp_path / "season" / "final.csv"
    output_path.parent.mkdir()

    pd.DataFrame(
        {
            "player": ["Zed Player", "Amy Player", "Amy Player"],
            "team": ["ZZZ", "AAA", "AAA"],
        }
    ).to_csv(input_path, index=False)

    build_final_player_stats(input_path=input_path, output_path=output_path)

    result = pd.read_csv(output_path)
    assert result["player"].tolist() == ["Amy Player", "Zed Player"]


def test_load_nflverse_stat_tables_splits_categories(tmp_path):
    source_path = tmp_path / "nflverse.csv"
    pd.DataFrame(
        {
            "player_id": ["00-0012345"],
            "player_display_name": ["Example Player"],
            "position": ["RB"],
            "recent_team": ["BUF"],
            "games": [17],
            "fumbles_total": [1],
            "season_type": ["REG"],
            "completions": [0],
            "attempts": [0],
            "passing_yards": [0],
            "passing_tds": [0],
            "passing_interceptions": [0],
            "carries": [200],
            "rushing_yards": [900],
            "rushing_tds": [8],
            "targets": [50],
            "receptions": [40],
            "receiving_yards": [300],
            "receiving_tds": [2],
        }
    ).to_csv(source_path, index=False)

    passing, rushing, receiving = load_nflverse_stat_tables(source_path)

    assert passing[0].empty
    assert rushing[0].iloc[0]["rushing_yds"] == 900
    assert rushing[0].iloc[0]["player_id"] == "00-0012345"
    assert receiving[0].iloc[0]["receiving_rec"] == 40


def test_appended_rookie_projections_are_identified(tmp_path):
    rookie_path = tmp_path / "rookies.csv"
    pd.DataFrame([{
        "Player": "New Rookie", "Pos": "WR", "Team": "BUF", "Games": 17,
        "Recs": 50, "Rec Yds": 700, "Rec TDs": 5,
    }]).to_csv(rookie_path, index=False)
    veterans = pd.DataFrame([{"player": "veteran player", "pos": "WR", "team": "KC"}])

    combined = append_rookies_to_stats(veterans, rookie_path)

    assert combined.loc[combined["player"] == "veteran player", "is_rookie"].iloc[0] == False
    assert combined.loc[combined["player"] == "new rookie", "is_rookie"].iloc[0] == True
