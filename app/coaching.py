"""Source-dated coaching staff observations, distinct from play-calling duties."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from app.game_stats import download, encoded, read_json, write_atomic
from app.scoreboard import parse_time

DOMAINS = dict(zip(
    'ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAC LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS'.split(),
    'azcardinals atlantafalcons baltimoreravens buffalobills panthers chicagobears bengals clevelandbrowns dallascowboys denverbroncos detroitlions packers houstontexans colts jaguars chiefs therams chargers raiders miamidolphins vikings patriots neworleanssaints giants newyorkjets philadelphiaeagles steelers seahawks 49ers buccaneers tennesseetitans commanders'.split()))
ROLES = {'head_coach': 'head coach', 'offensive_coordinator': 'offensive coordinator',
         'defensive_coordinator': 'defensive coordinator', 'special_teams_coordinator': 'special teams coordinator'}


def parse_staff(content, url):
    soup = BeautifulSoup(content.decode('utf-8'), 'html.parser')
    staff = {}
    for body in soup.select('.d3-o-media-object__body, .d3-o-person-card'):
        link = body.find_parent('a') or body.select_one('a[href*="/coaches"]')
        name = body.select_one('.d3-o-media-object__title, .d3-o-person-card__name')
        title = body.select_one('.d3-o-media-object__roofline, .d3-o-person-card__position')
        if not name or not title:
            continue
        person, role_text = name.get_text(' ', strip=True), title.get_text(' ', strip=True)
        for role, label in ROLES.items():
            # Assistant head coach and passing-game coordinator are not the HC/OC.
            if not any(part.strip().lower().removeprefix('interim ') == label for part in role_text.split('/')):
                continue
            if not person or len(person) > 120:
                raise ValueError('Invalid coaching name')
            record = {'name': person, 'title': role_text, 'source_url': urljoin(url, link['href']) if link else url}
            if role in staff and staff[role]['name'] != person:
                raise ValueError(f'Ambiguous coaching role: {role}')
            staff[role] = record
    if 'head_coach' not in staff:
        raise ValueError('No unambiguous head coach found on the official staff page')
    return staff


def refresh_coaching(root, *, fetch=download, now=None, force=False):
    root, now = Path(root), now or datetime.now(timezone.utc)
    path = root / 'docs/data/coaching_staff.json'
    previous = read_json(path, {'teams': {}})
    if not force and previous.get('checked_at') and timedelta(0) <= now - parse_time(previous['checked_at']) < timedelta(hours=24):
        return previous
    overrides = read_json(root / 'data/coaching_play_callers.json', {'records': []})

    def collect(item):
        team, domain = item
        url = f'https://www.{domain}.com/team/{"coaches" if team == "CHI" else "coaches-roster"}/'
        old = previous.get('teams', {}).get(team, {})
        try:
            content, _ = fetch(url)
            roles = parse_staff(content, url)
            events = old.get('observations', [])
            changed = old.get('roles') != roles
            if changed:
                events = [*events, {'observed_at': now.isoformat(), 'roles': roles}]
            record = {'roles': roles, 'observations': events, 'checked_at': now.isoformat(),
                'source_url': url, 'source_sha256': hashlib.sha256(content).hexdigest(), 'refresh_status': 'ok',
                'missing_roles': sorted(set(ROLES) - set(roles))}
            # A first observation is not evidence of an appointment date. A
            # detected change gives a conservative boundary for future samples.
            people_changed = any(roles[key]['name'] != value['name'] for key, value in old.get('roles', {}).items() if key in roles)
            record['staff_change_observed_at'] = now.isoformat() if people_changed else old.get('staff_change_observed_at')
        except Exception as error:
            record = {**old, 'refresh_status': 'retained' if old else 'unavailable', 'source_url': url,
                      'last_attempt_at': now.isoformat(), 'error': type(error).__name__}
        callers = {}
        for item in overrides['records']:
            if item.get('team') != team or item.get('side') not in {'offense', 'defense'}:
                continue
            if not item.get('source_url', '').startswith('https://') or not item.get('effective_from'):
                raise ValueError('Play-caller evidence requires a source and effective date')
            if parse_time(item['effective_from']) <= now and (not item.get('effective_until') or now < parse_time(item['effective_until'])):
                if item['side'] in callers:
                    raise ValueError('Overlapping play-caller records')
                callers[item['side']] = item
        record['play_callers'] = {side: callers.get(side) for side in ('offense', 'defense')}
        return team, record

    with ThreadPoolExecutor(max_workers=4) as pool:
        teams = dict(pool.map(collect, DOMAINS.items()))
    if not any(row.get('roles') for row in teams.values()):
        raise ValueError('No coaching evidence available; preserving the previous publication')
    result = {'schema_version': 1, 'checked_at': now.isoformat(), 'teams': teams,
              'notes': ['Roles do not establish play-calling responsibility. Unknown play callers are not inferred.',
                        'Observed staff changes are dated observations, not unverified appointment dates.']}
    write_atomic(path, encoded(result))
    return result
