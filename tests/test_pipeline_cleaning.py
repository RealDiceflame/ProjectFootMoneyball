import pandas as pd
from stat_utils.pipeline_cleaning import filter_missing_adp, remove_non_skill_positions


def test_filter_missing_adp_keeps_numeric_players():
    frame = pd.DataFrame({"player": ["A", "B", "C"], "ADP": [10, "-", "22.5"]})
    result = filter_missing_adp(frame)
    assert result["player"].tolist() == ["A", "C"]
    assert result["ADP"].tolist() == [10.0, 22.5]


def test_remove_non_skill_positions_uses_position_not_player_text():
    frame = pd.DataFrame({
        "player": ["K.J. Osborn", "A Kicker", "Defense"],
        "pos": ["WR", "K", "DEF"],
    })
    assert remove_non_skill_positions(frame)["player"].tolist() == ["K.J. Osborn"]
