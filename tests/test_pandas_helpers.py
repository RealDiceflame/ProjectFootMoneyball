"""Direct contracts for shared helpers: precedence, nulls, duplicates and removal."""
import logging

import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from stat_utils import pandas_helpers as helpers


def test_aliases_use_source_order_trim_case_and_preserve_zero_and_unknown():
    frame = pd.DataFrame({' AGE ': [0., None, None, 7.],
                          'Age': [9., 4., None, 8.], 'other': [1, 2, 3, 4]})
    result = helpers.alias_bfill(frame, 'age', ['age'])
    assert result is frame  # Existing in-place API.
    assert result.columns.tolist() == ['other', 'age']
    assert result.age.iloc[[0, 1, 3]].tolist() == [0, 4, 7]
    assert pd.isna(result.age.iloc[2])


@pytest.mark.parametrize('labels', [['Age', 'Age'], ['age', 'age']])
def test_duplicate_alias_labels_preserve_existing_broadcast_policy(labels):
    frame = pd.DataFrame([[None, 0.], [2., 9.], [None, None]], columns=labels)
    result = helpers.alias_bfill(frame, 'age', ['Age'])
    # Duplicate canonical labels are retained by the existing in-place helper;
    # each contains the same first-known value. Diagnostics must not change this.
    expected = pd.Series([0., 2., float('nan')])
    for index in range(len(result.columns)):
        pd.testing.assert_series_equal(result.iloc[:, index], expected, check_names=False)
    assert result.columns.tolist() == (['age'] if labels[0] == 'Age' else labels)


def test_absent_alias_is_noop():
    frame = pd.DataFrame({'points': [None, 0.]})
    expected = frame.copy(deep=True)
    assert helpers.alias_bfill(frame, 'age', ['Age']) is frame
    assert_frame_equal(frame, expected)


def test_drop_columns_removes_all_duplicate_labels_without_mutating_input():
    frame = pd.DataFrame([[1, 2, None, 0]], columns=['rk', 'rk', 'unknown', 'points'])
    expected = frame.copy(deep=True)
    result = helpers.drop_columns(frame, ['rk', 'absent'])
    assert result.columns.tolist() == ['unknown', 'points']
    assert pd.isna(result.unknown.iloc[0])
    assert result.points.iloc[0] == 0
    assert_frame_equal(frame, expected)


def test_file_removal_keeps_scoring_columns_and_custom_exceptions(tmp_path):
    path = tmp_path / 'drop.txt'
    path.write_text('AWARDS\nrk\nyds\nfumbles\n')
    frame = pd.DataFrame([[1, 2, 3, None, 0, 0]], columns=[
        'Awards', 'rk', 'rk', 'passing_yds', 'receiving_yds', 'fumbles_lost_total'])
    result = helpers.drop_columns_from_file(frame, path, keep_patterns=['fumbles_lost_total'])
    assert result.columns.tolist() == ['passing_yds', 'receiving_yds', 'fumbles_lost_total']
    assert pd.isna(result.passing_yds.iloc[0])
    assert result.iloc[0, 1:].tolist() == [0, 0]
    assert frame.shape == (1, 6)


@pytest.mark.parametrize('text', ['', 'nonexistent_field\n'])
def test_empty_or_nonmatching_removal_file_is_noop(tmp_path, text):
    path = tmp_path / 'drop.txt'
    path.write_text(text)
    frame = pd.DataFrame({'player': ['a'], 'points': [0]})
    assert_frame_equal(helpers.drop_columns_from_file(frame, path), frame)


def test_missing_removal_file_warns_and_preserves_data(tmp_path, caplog):
    frame = pd.DataFrame({'points': [0.]})
    result = helpers.drop_columns_from_file(frame, tmp_path / 'missing.txt')
    assert result is frame
    assert caplog.records[0].event == 'missing_source_file'
    assert caplog.records[0].levelno == logging.WARNING
