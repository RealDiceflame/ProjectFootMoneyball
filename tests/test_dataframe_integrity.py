"""Prevent source identities and distinct statistical metrics being conflated."""

import pandas as pd
import pytest

from stat_utils.project_dataframe_utils import auto_unify_columns, normalize_stat_dataframe
from stat_utils.project_dataframe_utils import (
    merge_stats, merge_full_adp, fill_identity_columns, build_final_player_stats,
    ensure_games_column, append_rookies_to_stats,
    clean_all,
    normalize_name,
)


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


def test_same_name_quarterback_and_defensive_end_never_share_statistics():
    passing = pd.DataFrame([
        {'player': 'Josh Allen', 'player_id': 'quarterback-id', 'pos': 'QB', 'team': 'BUF', 'yds': 300},
        {'player': 'Josh Allen', 'player_id': 'defender-id', 'pos': 'DE', 'team': 'JAX', 'yds': 0},
    ])
    rushing = pd.DataFrame([
        {'player': 'Josh Allen', 'player_id': 'defender-id', 'pos': 'DE', 'team': 'JAX', 'rushing_yds': -2},
        {'player': 'Josh Allen', 'player_id': 'quarterback-id', 'pos': 'QB', 'team': 'BUF', 'rushing_yds': 45},
    ])
    result = fill_identity_columns(merge_stats([(passing, 'Passing'), (rushing, 'Rushing')]))
    by_id = result.set_index('player_id')
    assert len(result) == 2
    assert by_id.loc['quarterback-id', ['pos', 'team', 'passing_yds', 'rushing_yds']].tolist() == ['QB', 'BUF', 300, 45]
    assert by_id.loc['defender-id', ['pos', 'team', 'passing_yds', 'rushing_yds']].tolist() == ['DE', 'JAX', 0, -2]


def test_same_id_survives_name_team_and_position_changes():
    before = pd.DataFrame([{'player': 'Old Name', 'player_id': 'person-id', 'pos': 'RB', 'team': 'BUF', 'rushing_yds': 40}])
    after = pd.DataFrame([{'player': 'New Name', 'player_id': 'person-id', 'pos': 'WR', 'team': 'KC', 'receiving_yds': 50}])
    result = merge_stats([(before, 'Rushing'), (after, 'Receiving')])
    assert len(result) == 1
    assert result.iloc[0]['rushing_yds'] == 40
    assert result.iloc[0]['receiving_yds'] == 50


def test_ambiguous_idless_name_does_not_attach_to_either_known_person():
    known = pd.DataFrame([{'player': 'Alex Smith', 'player_id': key, 'pos': 'WR', 'rushing_yds': value}
                          for key, value in [('one', 5), ('two', 10)]])
    unknown = pd.DataFrame([{'player': 'Alex Smith', 'pos': 'WR', 'receiving_yds': 100}])
    result = merge_stats([(known, 'Rushing'), (unknown, 'Receiving')])
    assert len(result) == 3
    assert result.loc[result.player_id.notna(), 'receiving_yds'].isna().all()


def test_adp_aliases_combine_without_joining_same_name_other_position(tmp_path):
    stats_path, adp_path, out = (tmp_path / name for name in ['stats.csv', 'adp.csv', 'out.csv'])
    pd.DataFrame([
        {'player': 'DJ Moore', 'player_id': 'receiver-id', 'pos': 'WR', 'fantasy_points': 100},
        {'player': 'DJ Moore', 'player_id': 'defender-id', 'pos': 'DE', 'fantasy_points': 2},
    ]).to_csv(stats_path, index=False)
    pd.DataFrame([
        {'Player': 'DJ Moore', 'Position': 'WR', 'Team': 'CHI', 'Yahoo': 60, 'Sleeper': 50},
        {'Player': 'D.J. Moore', 'Position': 'WR', 'Team': 'CHI', 'MFL': 70},
    ]).to_csv(adp_path, index=False)
    merge_full_adp(stats_path, adp_path, out)
    result = pd.read_csv(out, na_values='-').set_index('player_id')
    assert len(result) == 2
    assert result.loc['receiver-id', ['Yahoo', 'Sleeper', 'MFL', 'ADP']].tolist() == [60, 50, 70, 60]
    assert pd.isna(result.loc['defender-id', 'ADP'])


def test_final_builder_retains_distinct_ids_and_rejects_conflicting_same_id(tmp_path):
    source, output = tmp_path / 'source.csv', tmp_path / 'out.csv'
    rows = [{'player': 'Josh Allen', 'player_id': key, 'pos': pos} for key, pos in [('qb', 'QB'), ('de', 'DE')]]
    pd.DataFrame(rows).to_csv(source, index=False)
    build_final_player_stats(source, output)
    assert len(pd.read_csv(output)) == 2
    pd.DataFrame([rows[0], {**rows[0], 'pos': 'WR'}]).to_csv(source, index=False)
    with pytest.raises(ValueError, match='Conflicting duplicate'):
        build_final_player_stats(source, output)


def test_missing_games_stays_unknown_and_projection_cannot_overwrite_observed_zero(tmp_path):
    assert ensure_games_column(pd.DataFrame({'player': ['Example']}))['g'].isna().all()
    source = tmp_path / 'rookies.csv'
    pd.DataFrame([{'Player': 'Example', 'Pos': 'WR', 'Games': 17, 'Recs': 30}]).to_csv(source, index=False)
    actual = pd.DataFrame([{'player': 'example', 'pos': 'WR', 'g': 1, 'receiving_rec': 0}])
    result = append_rookies_to_stats(actual, source)
    assert len(result) == 1
    assert result.iloc[0]['receiving_rec'] == 0
    assert result.iloc[0]['is_rookie'] == False


def test_cleanup_retains_scoring_adjustments_and_known_zeroes():
    source = pd.DataFrame([{'player': 'Example', 'fumbles_lost_total': 0,
                            'special_teams_tds': 1, 'passing_2pt_conversions': 0}])
    result = clean_all(source)
    assert result.iloc[0]['fumbles_lost_total'] == 0
    assert result.iloc[0]['special_teams_tds'] == 1
    assert result.iloc[0]['passing_2pt_conversions'] == 0


@pytest.mark.parametrize('source,saved', [
    ("Ja'Marr Chase", 'jamarr chase'), ('Jaxon Smith-Njigba', 'jaxon smithnjigba'),
    ("De'Von Achane", 'devon achane'), ('Amon-Ra St. Brown', 'amonra st brown'),
    ("D'Andre Swift", 'dandre swift'), ("Wan'Dale Robinson", 'wandale robinson'),
    ('Jacory Croskey-Merritt', 'jacory croskeymerritt'), ("Ja'Tavion Sanders", 'jatavion sanders'),
    ("De'Zhaun Stribling", 'dezhaun stribling'), ('D. J. Moore', 'dj moore'),
])
def test_name_aliases_match_existing_snapshots_without_dropping_middle_tokens(source, saved):
    assert normalize_name(source) == normalize_name(saved)
