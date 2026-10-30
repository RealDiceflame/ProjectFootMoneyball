"""Offline contracts for historical archives: no provider calls or invented history."""
import csv
from datetime import datetime, timezone
import gzip
from io import StringIO
import json

import pytest

from app import game_stats_backfill as backfill

NOW = datetime(2026, 10, 30, tzinfo=timezone.utc)


def csv_bytes(rows):
    stream = StringIO()
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)
    return stream.getvalue().encode()


def schedule_row(year, *, week=1, away='BUF', home='BAL', home_score=0, away_score=14):
    return {'game_id':f'{year}_{week:02d}_{away}_{home}', 'season':year, 'game_type':'REG',
            'week':week, 'gameday':f'{year}-09-15', 'gametime':'13:00',
            'home_team':home, 'away_team':away, 'home_score':home_score, 'away_score':away_score}


def stats_bytes(kind, game, *, missing_team=False):
    rows=[]
    for team, opponent in [(game['home_team'],game['away_team']), (game['away_team'],game['home_team'])]:
        row={'game_id':game['game_id'],'season':game['season'],'season_type':'REG','week':game['week'],
             'team':team,'opponent_team':opponent,'passing_yards':0,'rushing_yards':-2,
             'def_sacks':0.5,'receiving_yards':'','fg_made_list':'27;44'}
        if kind=='players':
            row.update(player_id='00-0000001' if team==game['home_team'] else '00-0000002',
                       player_display_name='Same Name',position='QB')
        rows.append(row)
    return csv_bytes(rows[:1] if missing_team else rows)


def fixture(tmp_path, monkeypatch, years=(2019,2020), *, fail_year=None):
    for year in years:
        monkeypatch.setitem(backfill.EXPECTED_COMPLETED_GAMES,year,1)
    games={year:schedule_row(year) for year in years}
    calls=[]
    def fetch(url):
        calls.append(url)
        if url==backfill.SCHEDULE_URL:
            return gzip.compress(csv_bytes(list(games.values()))), 'source-schedule-date'
        for year,game in games.items():
            if str(year) in url:
                if year==fail_year: raise OSError('offline source')
                return stats_bytes('players' if 'stats_player' in url else 'teams',game), 'source-stat-date'
        raise AssertionError(f'Unexpected provider URL {url}')
    data=tmp_path/'docs/data'; data.mkdir(parents=True)
    scores=data/'scores.json'; scores.write_text('{"season":2026,"games":[]}')
    catalogue=data/'game_stats/index.json'; catalogue.parent.mkdir()
    catalogue.write_text(json.dumps({'schema_version':1,'seasons':[2026],'current_season':2026,'checked_at':'old'}))
    return games,calls,fetch,scores,catalogue


def test_completed_game_policy_matches_regular_season_history():
    assert backfill.EXPECTED_COMPLETED_GAMES=={
        **{year:256 for year in range(2016,2021)},2021:272,2022:271,2023:272,2024:272,2025:272}


def test_backfill_preserves_current_site_and_records_real_collection_dates(tmp_path, monkeypatch):
    games,calls,fetch,scores,catalogue=fixture(tmp_path,monkeypatch)
    saved=scores.read_bytes()
    assert backfill.backfill_game_stats(tmp_path,[2019,2020],fetch=fetch,now=NOW)=={2019:1,2020:1}
    assert calls.count(backfill.SCHEDULE_URL)==1
    assert scores.read_bytes()==saved
    index=json.loads(catalogue.read_text())
    assert index['current_season']==2026
    assert index['seasons']==[2026,2020,2019]
    for year,game in games.items():
        folder=tmp_path/f'docs/data/game_stats/{year}'
        bundle=json.loads((folder/f"{game['game_id']}.json").read_text())
        assert bundle['historical'] is True
        assert bundle['first_collected_at']==NOW.isoformat()
        rows=[dict(zip(bundle['player_columns'],row)) for row in bundle['players']]
        assert len({r['player_id'] for r in rows})==2
        assert all(r['passing_yards']==0 and r['rushing_yards']==-2 and r['def_sacks']==0.5
                   and r['receiving_yards'] is None and r['fg_made_list']=='27;44' for r in rows)
        summary=json.loads((folder/'summary.json').read_text())
        assert summary['historical'] is True
        assert summary['periods']['all']['game_count']==1
        assert json.loads((folder/'index.json').read_text())['historical'] is True


def test_later_year_failure_cannot_partially_publish_earlier_year(tmp_path, monkeypatch):
    _,_,fetch,_,_=fixture(tmp_path,monkeypatch,fail_year=2020)
    before={str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    with pytest.raises(OSError):
        backfill.backfill_game_stats(tmp_path,[2019,2020],fetch=fetch,now=NOW)
    after={str(p.relative_to(tmp_path)):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    assert after==before


def test_second_collection_does_not_redate_unchanged_games(tmp_path, monkeypatch):
    games,_,fetch,_,_=fixture(tmp_path,monkeypatch,years=(2020,))
    backfill.backfill_game_stats(tmp_path,[2020],fetch=fetch,now=NOW)
    path=tmp_path/f"docs/data/game_stats/2020/{games[2020]['game_id']}.json"
    before=path.read_bytes()
    backfill.backfill_game_stats(tmp_path,[2020],fetch=fetch,now=datetime(2026,10,31,tzinfo=timezone.utc))
    assert path.read_bytes()==before


def test_only_documented_2022_no_contest_can_lack_scores(monkeypatch):
    monkeypatch.setitem(backfill.EXPECTED_COMPLETED_GAMES,2022,1)
    valid=schedule_row(2022)
    cancelled=schedule_row(2022,week=17,away='BUF',home='CIN',home_score='',away_score='')
    parsed=backfill.parse_historical_schedule(csv_bytes([valid,cancelled]).decode(),2022,now=NOW)
    assert set(parsed)=={valid['game_id']}
    other=schedule_row(2022,week=2,away='CHI',home='GB',home_score='',away_score='')
    with pytest.raises(ValueError):
        backfill.parse_historical_schedule(csv_bytes([valid,other]).decode(),2022,now=NOW)


@pytest.mark.parametrize('mutation',[{'game_id':'2020_01_BUF_CHI'},{'home_score':''}])
def test_identity_mismatch_or_unknown_final_result_is_not_a_completed_archive(monkeypatch,mutation):
    monkeypatch.setitem(backfill.EXPECTED_COMPLETED_GAMES,2020,1)
    game=schedule_row(2020);game.update(mutation)
    with pytest.raises(ValueError):
        backfill.parse_historical_schedule(csv_bytes([game]).decode(),2020,now=NOW)


def test_cancelled_fixture_with_actual_score_is_not_silently_excluded(monkeypatch):
    monkeypatch.setitem(backfill.EXPECTED_COMPLETED_GAMES,2022,1)
    game=schedule_row(2022,week=17,away='BUF',home='CIN',home_score=0,away_score='')
    with pytest.raises(ValueError):
        backfill.parse_historical_schedule(csv_bytes([game]).decode(),2022,now=NOW)


def test_schedule_coverage_cannot_drop_an_unexplained_completed_game(monkeypatch):
    monkeypatch.setitem(backfill.EXPECTED_COMPLETED_GAMES,2020,2)
    with pytest.raises(ValueError):
        backfill.parse_historical_schedule(csv_bytes([schedule_row(2020)]).decode(),2020,now=NOW)


def test_current_franchise_codes_resolve_only_to_historical_fixture_sides():
    from app.game_stats import parse_stats
    game={'game_id':'2016_01_OAK_SD','week':1,'home':'SD','away':'OAK'}
    rows=[]
    for team,opponent,player_id in [('LV','LAC','00-0000001'),('LAC','LV','00-0000002')]:
        rows.append({'game_id':game['game_id'],'season':2016,'season_type':'REG','week':1,
            'team':team,'opponent_team':opponent,'passing_yards':0,'rushing_yards':-2,
            'player_id':player_id,'player_display_name':'Same Name','position':'QB'})
    raw=csv_bytes(rows)
    _,groups=parse_stats(raw,'players',2016,{game['game_id']:game})
    assert [(r['team'],r['opponent_team'],r['player_id']) for r in groups[game['game_id']]]==[
        ('OAK','SD','00-0000001'),('SD','OAK','00-0000002')]
    assert b'LV,LAC' in raw  # Saved provider bytes retain their source codes.
    rows[0]['team']='NYJ'
    with pytest.raises(ValueError,match='identity'):
        parse_stats(csv_bytes(rows),'players',2016,{game['game_id']:game})


def test_missing_opponent_is_derived_only_from_valid_fixture_and_known_team():
    from app.game_stats import parse_stats
    game={'game_id':'2016_10_CLE_BAL','week':10,'home':'BAL','away':'CLE'}
    row={'game_id':game['game_id'],'season':2016,'season_type':'REG','week':10,
         'team':'CLE','opponent_team':'','passing_yards':'','rushing_yards':0,
         'player_id':'00-0000001','player_display_name':'Known Player','position':'QB'}
    raw=csv_bytes([row])
    _,groups=parse_stats(raw,'players',2016,{game['game_id']:game})
    actual=groups[game['game_id']][0]
    assert actual['team']=='CLE' and actual['opponent_team']=='BAL'
    assert actual['passing_yards'] is None and actual['rushing_yards']==0
    assert actual['player_id']=='00-0000001'
    row['team']='NYJ'
    with pytest.raises(ValueError,match='identity'):
        parse_stats(csv_bytes([row]),'players',2016,{game['game_id']:game})
    row['team']='CLE';row['game_id']='2016_10_CLE_NYJ'
    with pytest.raises(ValueError):
        parse_stats(csv_bytes([row]),'players',2016,{game['game_id']:game})
