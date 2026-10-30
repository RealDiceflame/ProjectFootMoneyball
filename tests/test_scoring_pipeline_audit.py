"""Reconcile the real saved source through normalization, joins, and scoring."""
from pathlib import Path

import pandas as pd
import pytest

from stat_utils.project_dataframe_utils import load_nflverse_stat_tables, merge_stats, clean_all
from stat_utils.data_analytics.fantasy_points import calculate_fantasy_points

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('mode,ppr', [('standard', 0), ('half', .5), ('full', 1)])
def test_saved_source_scores_survive_category_merges_and_cleanup(mode, ppr):
    path = ROOT / 'data/stats/nflverse_player_stats_2025.csv'
    raw = pd.read_csv(path)
    raw = raw.loc[raw.season_type.eq('REG') & raw.player_display_name.notna() & raw.player_id.notna()]
    assert raw.player_id.is_unique
    cleaned = clean_all(merge_stats(load_nflverse_stat_tables(path)))
    scored = calculate_fantasy_points(cleaned, mode, allow_legacy=False).set_index('player_id')
    assert scored.index.is_unique
    assert set(scored.index) == set(raw.player_id)
    raw = raw.set_index('player_id').loc[scored.index]
    # Independent reconciliation uses source fields, before any aliasing or joins.
    expected = (raw.passing_yards * .04 + raw.passing_tds * 4 - raw.passing_interceptions * 2
                + raw.rushing_yards * .1 + raw.rushing_tds * 6 + raw.receptions * ppr
                + raw.receiving_yards * .1 + raw.receiving_tds * 6 - raw.fumbles_lost_total * 2
                + (raw.passing_2pt_conversions + raw.rushing_2pt_conversions
                   + raw.receiving_2pt_conversions) * 2 + raw.special_teams_tds * 6)
    pd.testing.assert_series_equal(scored.fantasy_points, expected, check_names=False,
                                   check_dtype=False, atol=1e-8, rtol=0)
    assert scored.scoring_coverage.eq('full').all()
