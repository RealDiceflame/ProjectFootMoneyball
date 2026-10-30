import pandas as pd
from stat_utils.data_analytics.fantasy_points import calculate_fantasy_points

def test_half_ppr_scoring():
    df = pd.DataFrame([{
        'pass_yds': 300, 'pass_td': 2, 'int': 1,
        'rush_yds': 40, 'rush_td': 1,
        'receiving rec': 5, 'receiving yds': 60, 'receiving td': 1,
        'fumbles_lost': 1
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
                           "rec_yds": 50, "rec_td": 1, "fumbles_lost": 1}])
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


def test_nflverse_aliases_charge_only_lost_fumbles_and_keep_negative_yards():
    frame = pd.DataFrame([{'passing_yards': 250, 'passing_tds': 2,
        'passing_interceptions': 1, 'rushing_yards': -10, 'rushing_tds': 1,
        'receptions': 3, 'receiving_yards': 40, 'receiving_tds': 1,
        'fumbles_total': 4, 'fmb': 4, 'fumbles_lost_total': 1}])
    for kind, expected in [('standard',29),('half',30.5),('full',32)]:
        assert calculate_fantasy_points(frame,kind).loc[0,'fantasy_points'] == expected


def test_recovered_fumbles_are_not_turnovers():
    frame = pd.DataFrame([{'rushing_yds':100, 'fmb':3, 'fumbles_lost_total':0}])
    assert calculate_fantasy_points(frame).loc[0,'fantasy_points'] == 10


def test_nonfinite_stats_cannot_generate_infinite_fantasy_points():
    for value in [float('inf'),float('-inf'),'inf']:
        assert pd.isna(calculate_fantasy_points(pd.DataFrame([{'rec_yds':value}])).loc[0,'fantasy_points'])


def test_missing_or_invalid_games_do_not_invent_seventeen_game_rates(tmp_path):
    from stat_utils.data_analytics.fantasy_points import calculate_and_save_fantasy_points
    source=tmp_path/'source.csv'; output=tmp_path/'scored.csv'
    pd.DataFrame({'rushing_yds':[100,100,100,100], 'g':[10,0,None,float('inf')]}).to_csv(source,index=False)
    calculate_and_save_fantasy_points(source,output)
    result=pd.read_csv(output,na_values=['-'])
    assert result.loc[0,'fantasy_standard_ppr_per_game']==1
    assert result.loc[0,'fantasy_standard_ppr_proj_17g']==17
    assert result.loc[1:,'fantasy_standard_ppr_per_game'].isna().all()
    assert result.loc[1:,'fantasy_standard_ppr_proj_17g'].isna().all()


def test_supplied_unknown_stats_are_not_zero_but_absent_categories_are_sparse():
    for value in [None, 'bad', '-']:
        scored=calculate_fantasy_points(pd.DataFrame([{'rushing_yds':value}]))
        assert pd.isna(scored.loc[0,'fantasy_points'])
        assert scored.loc[0,'scoring_coverage']=='unavailable'
    sparse=calculate_fantasy_points(pd.DataFrame([{'rushing_yds':100}]))
    assert sparse.loc[0,'fantasy_points']==10
    assert sparse.loc[0,'scoring_coverage']=='core_only'


def test_full_scoring_adds_conversions_and_special_teams_once():
    frame=pd.DataFrame([{'pass_yds':0,'pass_td':0,'int':0,'rush_td':0,
        'rec':0,'rec_yds':0,'rec_td':0,'rushing_yds':100,'fumbles_lost_total':1,
        'passing_2pt_conversions':1,'rushing_2pt_conversions':2,
        'receiving_2pt_conversions':1,'special_teams_tds':1}])
    scored=calculate_fantasy_points(frame,'standard')
    assert scored.loc[0,'fantasy_points']==22
    assert scored.loc[0,'scoring_coverage']=='full'


def test_negative_counts_are_unknown_while_negative_yards_are_real():
    assert pd.isna(calculate_fantasy_points(pd.DataFrame([{'rec':-1}])).loc[0,'fantasy_points'])
    assert calculate_fantasy_points(pd.DataFrame([{'rushing_yards':-10}])).loc[0,'fantasy_points']==-1


def test_partial_scoring_applies_each_known_optional_adjustment():
    frame=pd.DataFrame([{'rushing_yds':100,'fumbles_lost_total':1,
                         'passing_2pt_conversions':None,'special_teams_tds':1}])
    scored=calculate_fantasy_points(frame)
    assert scored.loc[0,'fantasy_points']==14
    assert scored.loc[0,'scoring_coverage']=='core_only'
    assert pd.isna(calculate_fantasy_points(frame,allow_legacy=False).loc[0,'fantasy_points'])


def test_unknown_optional_is_preserved_and_partial_score_disclosed():
    frame=pd.DataFrame([{'rushing_yds':100,'fumbles_lost_total':None}])
    scored=calculate_fantasy_points(frame)
    assert scored.loc[0,'fantasy_points']==10
    assert pd.isna(scored.loc[0,'fumbles_lost_total'])
    assert pd.isna(scored.loc[0,'fumbles_lost'])
    assert scored.loc[0,'scoring_coverage']=='core_only'
