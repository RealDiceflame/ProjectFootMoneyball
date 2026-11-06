"""Identity regression cases use explicit source evidence, never invented real IDs."""
import json
from pathlib import Path
import pandas as pd
import pytest
from data_fetcher.player_identity import PlayerRegistry, clean_id, default_registry
from scripts.build_player_registry import build


def registry():
    return PlayerRegistry([
        {'gsis_id': 'qb', 'name': 'Josh Allen', 'position': 'QB', 'sleeper_id': '001', 'mfl_id': '001'},
        {'gsis_id': 'de', 'name': 'Josh Allen', 'position': 'DE', 'sleeper_id': '002', 'mfl_id': '002'},
        {'gsis_id': 'wr1', 'name': 'Alex Smith', 'position': 'WR', 'sleeper_id': '003'},
        {'gsis_id': 'wr2', 'name': 'Alex Smith', 'position': 'WR', 'sleeper_id': '004'},
    ])


def test_provider_ids_survive_name_team_and_position_changes():
    assert registry().resolve({'Player': 'New Name', 'Position': 'TE', 'Team': 'KC', 'Sleeper_ID': '001'}) == ('qb', 'provider_id')


def test_same_name_same_position_never_assigns_a_person():
    assert registry().resolve({'Player': 'Alex Smith', 'Position': 'WR'}) == ('', 'ambiguous')
    assert registry().resolve({'Player': 'Alex Smith', 'Position': 'WR', 'Sleeper_ID': '004'})[0] == 'wr2'


def test_two_josh_allens_and_namespaced_provider_ids():
    assert registry().resolve({'Player': 'Josh Allen', 'Position': 'DE'})[0] == 'de'
    assert registry().resolve({'Player': 'Josh Allen', 'Position': 'QB'})[0] == 'qb'
    assert registry().resolve({'MFL_ID': '001', 'Sleeper_ID': '001'})[0] == 'qb'
    with pytest.raises(ValueError, match='Conflicting player identity'):
        registry().resolve({'MFL_ID': '001', 'Sleeper_ID': '002'})


def test_unknown_explicit_id_cannot_fall_back_to_known_name():
    assert registry().resolve({'Player': 'Josh Allen', 'Position': 'QB', 'Sleeper_ID': 'unlisted'}) == ('', 'unresolved_provider_id')


def test_existing_canonical_id_cannot_be_overwritten():
    with pytest.raises(ValueError, match='Conflicting player identity'):
        registry().resolve({'player_id': 'de', 'Sleeper_ID': '001'})


def test_duplicate_provider_claim_requires_review():
    r = PlayerRegistry([{'gsis_id': 'a', 'sleeper_id': '12'}, {'gsis_id': 'b', 'sleeper_id': '12'}])
    with pytest.raises(ValueError, match='Conflicting registry mapping'):
        r.resolve({'Sleeper_ID': '12'})


@pytest.mark.parametrize('value,expected', [(None,''), (float('nan'),''), ('NA',''), ('-',''), (' 00-0041562 ','00-0041562'), ('001','001'), (12.0,'12')])
def test_csv_id_cleanup(value, expected):
    assert clean_id(value) == expected


def test_all_eleven_saved_rookies_have_distinct_ids_and_provider_links():
    root = Path(__file__).resolve().parents[1]
    rookies = pd.read_csv(root / 'data/stats/rookie_betting_lines_2026.csv').drop_duplicates('Player').rename(columns={'Pos':'Position'})
    resolved = default_registry().attach(rookies)
    assert len(resolved) == 11 and resolved.player_id.notna().all() and resolved.player_id.is_unique
    for identity in resolved.player_id:
        row = default_registry().ids[identity][0]
        assert row['sleeper_id'] and row['mfl_id'] and row['espn_id']
    # Missing Yahoo links are intentionally blank, never fabricated from another ID.
    assert all(not default_registry().ids[i][0]['yahoo_id'] for i in resolved.player_id)


def test_builder_excludes_conflicting_sources_and_provider_collisions():
    n = [{'gsis_id':'00-a', 'display_name':'One', 'position':'WR', 'birth_date':'2000-01-01', 'espn_id':'100'},
         {'gsis_id':'00-b', 'display_name':'Two', 'position':'WR', 'birth_date':'2000-01-02', 'espn_id':'200'}]
    d = [dict(gsis_id='00-a',name='One',birthdate='2000-01-01',sleeper_id='',mfl_id='1',espn_id='999',yahoo_id='',pfr_id=''),
         dict(gsis_id='00-b',name='Two',birthdate='2000-01-02',sleeper_id='',mfl_id='1',espn_id='200',yahoo_id='',pfr_id='')]
    rows, issues = build(n,d,{})
    assert rows[0]['espn_id'] == ''
    assert all(not r['mfl_id'] for r in rows)
    assert {i['reason'] for i in issues} == {'conflicting_provider_values','provider_collision'}


def test_unknown_provider_id_stays_unjoined_to_same_named_stats(tmp_path):
    from stat_utils.project_dataframe_utils import merge_full_adp
    stats,adp,out=[tmp_path/p for p in ('stats.csv','adp.csv','out.csv')]
    pd.DataFrame([{'player':'Josh Allen','pos':'QB','player_id':'00-0034857','fantasy_points':100}]).to_csv(stats,index=False)
    pd.DataFrame([{'Player':'Josh Allen','Position':'QB','Sleeper_ID':'unlisted','Sleeper':10}]).to_csv(adp,index=False)
    merge_full_adp(stats,adp,out)
    rows=pd.read_csv(out,na_values='-')
    assert len(rows)==2
    assert rows.loc[rows.player_id.notna(),'Sleeper'].isna().all()


@pytest.mark.parametrize('team,expected', [('CLE','13298'), ('NYJ','')])
def test_rookie_one_day_discrepancy_requires_all_corroborating_fields(team, expected):
    n=[dict(gsis_id='00-a',display_name='Example Rookie',position='WR',birth_date='2004-09-24',
            college_name='Example College',draft_team='CLE',draft_year='2026',rookie_season='2026',last_season='2026')]
    d=[dict(gsis_id='00-a',name='Example Rookie',birthdate='2004-09-24',sleeper_id='13298',mfl_id='',espn_id='',yahoo_id='',pfr_id='')]
    s={'13298':dict(full_name='Example Rookie',birth_date='2004-09-23',position='WR',college='Example College',team=team,years_exp=0)}
    rows,issues=build(n,d,s)
    assert rows[0]['sleeper_id']==expected
    assert issues[0]['reason']==('corroborated_rookie_date_discrepancy' if expected else 'sleeper_not_corroborated')


def test_birth_date_discrepancy_requires_secondary_id_agreement():
    n=[dict(gsis_id='00-a',display_name='Example',position='WR',birth_date='2000-01-01',espn_id='100')]
    d=[dict(gsis_id='00-a',name='Example',birthdate='2000-01-02',sleeper_id='',mfl_id='9',espn_id='100',yahoo_id='',pfr_id='')]
    rows,issues=build(n,d,{})
    assert rows[0]['mfl_id']=='9'
    assert issues[0]['reason']=='corroborated_source_date_discrepancy'
    d[0]['espn_id']='other'
    rows,issues=build(n,d,{})
    assert rows[0]['mfl_id']==''
    assert issues[0]['reason']=='uncorroborated_identity'


def test_dated_team_evidence_can_disambiguate_historical_namesakes():
    r=PlayerRegistry([
        dict(gsis_id='old',name='Kyle Williams',position='WR',latest_team='SF',last_season='2014'),
        dict(gsis_id='current',name='Kyle Williams',position='WR',latest_team='NE',last_season='2026')])
    row=dict(Player='Kyle Williams',Position='WR',Team='NE',Source_Updated='2026-10-30')
    assert r.resolve(row)==('current','name_position_team_season')
    assert r.resolve({**row,'Source_Updated':'2025-10-30'})==('','ambiguous')
    assert r.resolve({**row,'Team':'BUF'})==('','ambiguous')
    assert r.resolve({**row,'Sleeper_ID':'unknown'})==('','unresolved_provider_id')
    assert r.resolve({**row,'player_id':'old'})==('old','source_id')


def test_reviewed_position_alias_resolves_two_way_player_without_merging_namesakes():
    r = PlayerRegistry([
        dict(gsis_id='two-way', name='Example Player', position='CB', position_aliases='WR', sleeper_id='1'),
        dict(gsis_id='namesake', name='Example Player', position='WR', sleeper_id='2')])
    assert r.resolve(dict(Player='Example Player', Position='CB')) == ('two-way', 'unique_name_position')
    assert r.resolve(dict(Player='Example Player', Position='WR')) == ('', 'ambiguous')
    assert r.resolve(dict(Player='Example Player', Position='WR', Sleeper_ID='1')) == ('two-way', 'provider_id')
    assert r.resolve(dict(Player='Example Player', Position='WR', Sleeper_ID='unknown')) == ('', 'unresolved_provider_id')
    assert r.offensive_position('two-way', 'CB') == 'WR'
    assert r.offensive_position('unknown', 'CB') == 'CB'


def biography_sources():
    n = [dict(gsis_id='00-example', display_name='Example Player', position='QB',
              birth_date='2000-01-02', college_name='First College; Second College')]
    s = {'001': dict(player_id='001', full_name='Example Player', position='QB',
                    birth_date='2000-01-02', college='Second College', fantasy_positions=['QB'])}
    return n, s


def test_missing_crosswalk_link_requires_complete_unique_biography():
    n, s = biography_sources()
    assert build(n, [], s)[0][0]['sleeper_id'] == ''  # No unrequested global expansion.
    rows, issues = build(n, [], s, supplemental_sleeper_ids={'001', '002'})
    assert rows[0]['sleeper_id'] == '001'
    assert issues == [dict(gsis_id='00-example', reason='corroborated_sleeper_biography',
                           provider_id='001', evidence=['name', 'birth_date', 'position', 'college'])]


@pytest.mark.parametrize('field,value', [('birth_date', ''), ('birth_date', '2000-01-03'),
    ('full_name', 'Someone Else'), ('position', 'WR'), ('college', ''),
    ('college', 'Other College'), ('gsis_id', '00-other'), ('player_id', '002')])
def test_incomplete_or_conflicting_biography_cannot_supply_a_provider_id(field, value):
    n, s = biography_sources()
    s['001'][field] = value
    assert build(n, [], s, supplemental_sleeper_ids={'001', '002'})[0][0]['sleeper_id'] == ''


def test_duplicate_biographies_and_cross_player_claims_stay_unresolved():
    n, s = biography_sources()
    s['002'] = {**s['001'], 'player_id': '002'}
    # A duplicate outside the reviewed ADP slice still makes the match ambiguous.
    rows, issues = build(n, [], s, supplemental_sleeper_ids={'001'})
    assert rows[0]['sleeper_id'] == ''
    assert issues[0]['reason'] == 'ambiguous_sleeper_biography'
    del s['002']
    n.append({**n[0], 'gsis_id': '00-other'})
    rows, issues = build(n, [], s, supplemental_sleeper_ids={'001', '002'})
    assert all(not row['sleeper_id'] for row in rows)
    assert sum(i['reason'] == 'provider_collision' for i in issues) == 2


def test_rejected_explicit_crosswalk_is_not_rescued_by_another_biography():
    n, s = biography_sources()
    d = [dict(gsis_id='00-example', name='Example Player', birthdate='2000-01-02',
              sleeper_id='unverified', mfl_id='', espn_id='', yahoo_id='', pfr_id='')]
    rows, issues = build(n, d, s, supplemental_sleeper_ids={'001'})
    assert rows[0]['sleeper_id'] == ''
    assert issues[0]['reason'] == 'sleeper_not_corroborated'


def test_position_alias_requires_a_corroborated_provider_link():
    n, s = biography_sources()
    s['001']['fantasy_positions'] = ['QB', 'WR', 'DB']
    rows, _ = build(n, [], s, supplemental_sleeper_ids={'001', '002'})
    assert rows[0]['position_aliases'] == 'WR'
    s['001']['birth_date'] = '2000-01-03'
    assert build(n, [], s, supplemental_sleeper_ids={'001', '002'})[0][0]['position_aliases'] == ''


def test_saved_hunter_identity_supports_receiver_without_replacing_nfl_position():
    r = default_registry()
    assert r.ids['00-0040718'][0]['position'] == 'CB'
    assert r.resolve(dict(Player='Travis Hunter', Position='WR')) == ('00-0040718', 'unique_name_position')
    assert r.resolve(dict(Sleeper_ID='12530')) == ('00-0040718', 'provider_id')


@pytest.mark.parametrize('provider_id', ['13293', '5094'])
def test_saved_source_conflicts_remain_unresolved(provider_id):
    # Lane's birth date and Izzo's explicit GSIS disagree between sources.
    assert default_registry().resolve(dict(Sleeper_ID=provider_id)) == ('', 'unresolved_provider_id')
