import pandas as pd
from stat_utils.data_analytics.fantasy_points import calculate_fantasy_points

def test_half_ppr_scoring():
    df = pd.DataFrame([{
        'pass_yds': 300, 'pass_td': 2, 'int': 1,
        'rush_yds': 40, 'rush_td': 1,
        'receiving rec': 5, 'receiving yds': 60, 'receiving td': 1,
        'fmb': 1
    }])
    result = calculate_fantasy_points(df, ppr_type='half')
    points = result['fantasy_points'].iloc[0]
    expected = (
        300 * 0.04 + 2 * 4 - 2 + 40 * 0.1 + 6 +
        5 * 0.5 + 60 * 0.1 + 6 - 2
    )
    assert round(points, 2) == round(expected, 2)

def test_targets_do_not_count_as_receptions():
    frame = pd.DataFrame([{"targets": 12, "rec_yds": 80}])
    result = calculate_fantasy_points(frame, "full")
    assert result.loc[0, "fantasy_points"] == 8
    assert "fantasy_points" not in frame  # Scoring must not mutate the input.


def test_all_formats_match_hand_calculated_totals():
    frame = pd.DataFrame([{"pass_yds": 250, "pass_td": 2, "int": 1,
                           "rush_yds": 20, "rush_td": 1, "rec": 4,
                           "rec_yds": 50, "rec_td": 1, "fmb": 1}])
    # Non-reception points: 10 + 8 - 2 + 2 + 6 + 5 + 6 - 2 = 33.
    for scoring_format, expected in [("standard", 33), ("half", 35), ("full", 37)]:
        assert calculate_fantasy_points(frame, scoring_format).loc[0, "fantasy_points"] == expected


def test_unknown_scoring_format_is_rejected():
    import pytest
    with pytest.raises(ValueError, match="Unknown PPR format"):
        calculate_fantasy_points(pd.DataFrame([{"rec": 4}]), "halff")


def test_receptions_take_precedence_over_targets():
    result = calculate_fantasy_points(pd.DataFrame([{"receptions": 3, "targets": 10}]), "full")
    assert result.loc[0, "fantasy_points"] == 3
