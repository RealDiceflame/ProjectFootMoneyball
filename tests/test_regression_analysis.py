"""Exercise real CSV regression boundaries without inventing rates or ADP."""
import numpy as np
import pandas as pd
import pytest

from stat_utils.data_analytics.regression_analysis import calculate_fantasy_value_vs_adp


def test_csv_regression_excludes_unknown_rates_and_invalid_adp(tmp_path):
    rows = []
    for name, games, adp, points in [
        ('Known A', 10, 10, 100), ('Known B', 10, 20, -10),
        ('Zero games', 0, 30, 200), ('Negative games', -2, 30, 200),
        ('Infinite games', float('inf'), 30, 200), ('Unknown games', None, 30, 200),
        ('Infinite points', 10, 30, float('inf')), ('Unknown points', 10, 30, None),
        ('Zero ADP', 10, 0, 200), ('Negative ADP', 10, -1, 200),
        ('Infinite ADP', 10, float('inf'), 200), ('Unknown ADP', 10, None, 200),
    ]:
        rows.append({'player':name,'pos':'RB','g':games,'ADP':adp,
                     **{f'fantasy_{mode}_ppr':points for mode in ['standard','half','full']}})
    source=tmp_path/'input.csv';output=tmp_path/'values.csv'
    pd.DataFrame(rows).to_csv(source,index=False)
    calculate_fantasy_value_vs_adp(source,output)
    result=pd.read_csv(output)
    assert set(result.player)=={'Known A','Known B'}
    assert set(result.scoring_type)=={'standard','half','full'}
    assert len(result)==6
    assert np.isfinite(result[['expected_points','value_diff','regression_coef']]).all().all()
    assert result.loc[result.player.eq('Known B'),'fantasy_standard_ppr_proj_17g'].eq(-17).all()


def test_invalid_rows_cannot_supply_the_second_regression_sample(tmp_path):
    source=tmp_path/'input.csv'
    pd.DataFrame([{'pos':'QB','g':games,'ADP':10,
        **{f'fantasy_{mode}_ppr':100 for mode in ['standard','half','full']}}
        for games in [10,0]]).to_csv(source,index=False)
    with pytest.raises(ValueError,match='No regression results'):
        calculate_fantasy_value_vs_adp(source,tmp_path/'values.csv')
