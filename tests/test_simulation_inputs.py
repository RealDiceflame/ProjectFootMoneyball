import csv
import gzip
from io import StringIO
import json
from pathlib import Path
from datetime import datetime, timezone
import pytest
from app.simulation_inputs import csv_rows, number, build_simulation_inputs, finish, new_profile

@pytest.mark.parametrize('raw',[b'a,a\n1,2',b'a,b\n1',b'a,b\n1,2,3',b'wrong\n1'])
def test_changed_or_truncated_csv_rejected(raw):
    with pytest.raises(ValueError): list(csv_rows(raw,['a','b']))

@pytest.mark.parametrize('value',['nan','inf','-inf','1000000000'])
def test_nonfinite_numbers_rejected(value):
    with pytest.raises(ValueError): number(value)

def test_gzip_and_null_handling():
    assert list(csv_rows(gzip.compress(b'a,b\n1,NA'),['a','b']))==[{'a':'1','b':'NA'}]
    assert number('NA') is None and number('0')==0

def test_compaction_preserves_counts_but_not_false_coach_outcome_effects():
    profile=new_profile(); sample=(5,1,0,0,0,3,0,0,0,0)
    profile['outcomes']['pass'][sample]=1.35; profile['outcomes']['pass|goal'][sample]=.35
    assert finish(profile)['outcomes']['pass'][0][-1]==1.35
    assert 'pass|goal' not in finish(profile,'team')['outcomes']
    assert finish(profile,'coach')['outcomes']=={}

def test_future_roster_is_rejected_before_source_join(tmp_path):
    folder=tmp_path/'docs/data'; folder.mkdir(parents=True)
    (folder/'ranking_inputs.json').write_text(json.dumps({'season':2026,'defense':{'personnel':{'status':{'generated_at':'2027-01-01T00:00:00Z'}}}}))
    with pytest.raises(ValueError,match='roster'): build_simulation_inputs(tmp_path,{}, {},now=datetime(2026,11,21,tzinfo=timezone.utc))

def test_published_evidence_is_dated_and_detailed_coverage_is_prior_season_only():
    path=Path(__file__).resolve().parents[1]/'docs/data/simulation_inputs.json'
    data=json.loads(path.read_text())
    assert data['coverage']['used_games']>=400
    assert data['coverage']['charted_plays']+data['coverage']['uncharted_plays']==data['coverage']['modeled_plays']
    assert data['coverage']['participation_seasons']==[data['season']-1]
    assert len(data['coaching']['teams'])==32
    assert len(data['games'])==272
    assert all(len(source['sha256'])==64 for source in data['sources'].values())
    assert all(game['kickoff']<data['generated_at'] for game in data['game_evidence'])
