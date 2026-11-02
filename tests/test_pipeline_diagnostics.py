"""Logging is observable without changing cleaned data or emitting row dumps."""
import logging

import pandas as pd
from pandas.testing import assert_frame_equal

from stat_utils.project_dataframe_utils import (
    clean_all, clean_and_prepare, fetch_stat_category, save_and_report_merged_stats,
    _identity_keys,
)


def test_debug_events_explain_cleanup_and_preserve_output(caplog, capsys):
    source = pd.DataFrame({' Player ': ['a'], 'Age': [20], 'awards': ['x'],
                           'passing_yds_x': [float('nan')], 'passing_yds_y': [0]})
    quiet = clean_all(source.copy(deep=True))
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger='stat_utils'):
        debug = clean_all(source.copy(deep=True))
    assert_frame_equal(quiet, debug)
    events = [r for r in caplog.records if getattr(r, 'event', None) == 'column_changes']
    assert {'normalize_column_names', 'alias_bfill', 'drop_columns', 'clean_all'} <= {r.stage for r in events}
    final = next(r for r in events if r.stage == 'clean_all')
    assert final.columns_before == source.columns.tolist()
    assert final.columns_after == debug.columns.tolist()
    assert debug.passing_yds.iloc[0] == 0
    assert any(getattr(r, 'missing_fields', None) == ['pos', 'g'] for r in caplog.records)
    assert capsys.readouterr().out == ''


def test_save_is_quiet_and_preserves_csv_contract(tmp_path, capsys):
    frame = pd.DataFrame({'player': ['a', 'b'], 'att': [3, 4], 'passing_att': [0., None]})
    save_and_report_merged_stats(frame, tmp_path)
    assert (tmp_path / 'all_stats_merged.csv').read_text() == 'player,passing_att\na,0.0\nb,-\n'
    assert 'att' in frame  # Saving does not mutate the caller.
    assert capsys.readouterr().out == ''


def test_fetch_logs_shape_without_preview(monkeypatch, caplog, capsys):
    from data_fetcher.data_fetcher import DataFetcher
    frame = pd.DataFrame({'player': ['private-row-value'], 'yds': [0]})
    monkeypatch.setattr(DataFetcher, 'fetch_data', lambda self: None)
    monkeypatch.setattr(DataFetcher, 'get_data', lambda self: frame)
    with caplog.at_level(logging.DEBUG, logger='stat_utils'):
        assert fetch_stat_category('Passing', 'https://example.test', 'unused.csv') is frame
    record = next(r for r in caplog.records if getattr(r, 'event', None) == 'stats_fetched')
    assert (record.rows, record.column_count) == (1, 2)
    assert 'private-row-value' not in caplog.text
    assert capsys.readouterr().out == ''


def test_unexpected_structure_warns_before_rejection(caplog):
    import pytest
    with pytest.raises(ValueError, match='player'):
        clean_and_prepare(pd.DataFrame({'yards': [1]}), 'Passing')
    assert any(getattr(r, 'missing_fields', None) == ['player'] for r in caplog.records)


def test_unresolved_identities_warn_and_remain_distinct(caplog):
    keys = _identity_keys([pd.DataFrame({'player': [None, None]})])[0]
    assert len(set(keys)) == 2
    assert caplog.records[-1].unresolved_count == 2
