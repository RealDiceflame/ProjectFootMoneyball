import pandas as pd
from stat_utils.project_dataframe_utils import auto_unify_columns

def test_auto_unify_columns_merges_x_y():
    df = pd.DataFrame({
        'games_x': [10, None],
        'games_y': [None, 12],
        'other': [1, 2]
    })
    unified = auto_unify_columns(df)
    assert 'games' in unified.columns
    assert unified['games'].tolist() == [10, 12]