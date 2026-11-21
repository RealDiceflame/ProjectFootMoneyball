from datetime import datetime, timezone, timedelta
import json
import pytest
from app.coaching import parse_staff, refresh_coaching

NOW = datetime(2026, 11, 21, tzinfo=timezone.utc)
def staff(name='Coach One', title='Head Coach'):
    return f'<a href="/team/coaches-roster/test"><div class="d3-o-media-object__body"><h3 class="d3-o-media-object__title">{name}</h3><h5 class="d3-o-media-object__roofline">{title}</h5></div></a>'.encode()

def test_titles_do_not_invent_play_calling_or_promote_assistants():
    html=staff()+staff('Coordinator','Interim Defensive Coordinator')+staff('Assistant','Assistant Head Coach')
    roles=parse_staff(html,'https://www.example.com/team/coaches-roster/')
    assert roles['head_coach']['name']=='Coach One'
    assert roles['defensive_coordinator']['name']=='Coordinator'
    assert 'offensive_coordinator' not in roles
    with pytest.raises(ValueError): parse_staff(staff()+staff('Other'), 'https://example.com')

def test_changed_staff_is_dated_and_failed_sources_keep_previous_observation(tmp_path):
    first=refresh_coaching(tmp_path,fetch=lambda _: (staff(),None),now=NOW)
    assert len(first['teams'])==32
    assert first['teams']['DAL']['staff_change_observed_at'] is None
    assert first['teams']['DAL']['play_callers']=={'offense':None,'defense':None}
    later=NOW+timedelta(days=1)
    second=refresh_coaching(tmp_path,fetch=lambda _: (staff('Coach Two'),None),now=later)
    assert second['teams']['DAL']['staff_change_observed_at']==later.isoformat()
    assert len(second['teams']['DAL']['observations'])==2
    def fail(_): raise OSError('Offline')
    third=refresh_coaching(tmp_path,fetch=fail,now=later+timedelta(days=1))
    assert third['teams']['DAL']['roles']==second['teams']['DAL']['roles']
    assert third['teams']['DAL']['checked_at']==later.isoformat()
    assert third['teams']['DAL']['refresh_status']=='retained'

def test_ambiguous_play_caller_dates_fail_without_publishing(tmp_path):
    refresh_coaching(tmp_path,fetch=lambda _: (staff(),None),now=NOW)
    path=tmp_path/'docs/data/coaching_staff.json'; original=path.read_bytes()
    data=tmp_path/'data'; data.mkdir()
    record={'team':'DAL','side':'defense','name':'Caller','effective_from':NOW.isoformat(),'source_url':'https://example.com/announcement'}
    (data/'coaching_play_callers.json').write_text(json.dumps({'records':[record,record]}))
    with pytest.raises(ValueError,match='Overlapping'): refresh_coaching(tmp_path,fetch=lambda _: (staff(),None),now=NOW+timedelta(days=1))
    assert path.read_bytes()==original
