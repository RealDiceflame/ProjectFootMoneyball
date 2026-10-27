"""Prevent source identities and distinct statistical metrics being conflated."""

import pandas as pd
import pytest

from stat_utils.project_dataframe_utils import auto_unify_columns, normalize_stat_dataframe


@pytest.mark.parametrize('name_column', ['player', 'player_name', 'player_display_name'])
def test_player_names_and_ids_survive_identifier_first_column_order(name_column):
    source = pd.DataFrame({'player_id': ['00-001'], name_column: ['Josh Allen'], 'yds': [100]})

    result = normalize_stat_dataframe(source)

    assert result['player'].tolist() == ['josh allen']
    assert result['player_id'].tolist() == ['00-001']
    assert result['yds'].tolist() == [100]


def test_canonical_name_takes_priority_over_an_earlier_name_alias():
    source = pd.DataFrame({'player_name': ['Alternate Name'], 'player': ['Josh Allen']})

    assert normalize_stat_dataframe(source)['player'].tolist() == ['josh allen']


def test_identifier_alone_is_never_treated_as_a_player_name():
    result = normalize_stat_dataframe(pd.DataFrame({'player_id': ['00-001']}))

    assert 'player' not in result.columns
    assert result['player_id'].tolist() == ['00-001']


def test_duplicate_normalized_name_columns_keep_first_source_by_position():
    source = pd.DataFrame([['Josh Allen', 'Other Player', '00-001']],
                          columns=['Player', ' player ', 'player_id'])

    result = normalize_stat_dataframe(source)

    assert result.columns.tolist() == ['player', 'player_id']
    assert result['player'].tolist() == ['josh allen']
    assert result['player_id'].tolist() == ['00-001']


def test_unifying_merge_suffixes_preserves_rates_and_missing_totals():
    source = pd.DataFrame({
        'yards_x': [None, 100, None],
        'yards_y': [80, None, None],
        'yards_per_attempt': [8.0, 10.0, 7.0],
        'yards_projection': [150, 200, 175],
    })

    result = auto_unify_columns(source)

    assert result['yards'].iloc[:2].tolist() == [80, 100]
    assert pd.isna(result['yards'].iloc[2])
    assert result['yards_per_attempt'].tolist() == [8.0, 10.0, 7.0]
    assert result['yards_projection'].tolist() == [150, 200, 175]
    assert 'yards_x' not in result.columns
    assert 'yards_y' not in result.columns
