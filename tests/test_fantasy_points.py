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