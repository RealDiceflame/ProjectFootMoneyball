"""Build a reviewable, offline registry from downloaded public source snapshots.

DynastyProcess rows must agree with nflverse on GSIS ID plus birth date or an
independent ESPN/PFR ID. Missing crosswalk links require a unique exact
name, birth-date, position and college match. Sleeper corroborates its IDs by birth
date plus name or GSIS. A one-day rookie date discrepancy requires matching
name, position, college, draft team and rookie year. Conflicts are logged.
"""
import argparse
import csv
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_fetcher.player_identity import OFFENSIVE_POSITIONS, _player_key, clean_id

SOURCES = {
    'nflverse': 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv',
    'fantasy': 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
    'sleeper': 'https://api.sleeper.app/v1/players/nfl',
}


def _biography_key(name, birthday):
    """Require an actual date and full name before looking for a candidate."""
    name = _player_key(name or '', '').rsplit('|', 1)[0]
    try:
        birthday = date.fromisoformat(birthday).isoformat()
    except (TypeError, ValueError):
        return None
    return (name, birthday) if name else None


def build(nflverse, fantasy, sleeper, *, supplemental_sleeper_ids=()):
    by_gsis = {}
    for row in fantasy:
        by_gsis.setdefault(row['gsis_id'], []).append(row)
    sleeper_biographies = {}
    for identity, record in sleeper.items():
        key = _biography_key(record.get('full_name'), record.get('birth_date'))
        if key and clean_id(record.get('player_id')) == clean_id(identity):
            sleeper_biographies.setdefault(key, []).append((identity, record))
    result, issues = [], []
    for n in nflverse:
        gsis = n['gsis_id']
        if not gsis.startswith('00-'):
            continue
        aliases = {n.get('display_name', '')}
        for first in ('first_name', 'common_first_name', 'football_name'):
            if n.get(first) and n.get('last_name'):
                aliases.add(n[first] + ' ' + n['last_name'])
        row = dict(gsis_id=gsis, name=n['display_name'], position=n['position'], latest_team=n.get('latest_team', ''), last_season=n.get('last_season', ''))
        fields = ('sleeper_id', 'mfl_id', 'espn_id', 'yahoo_id', 'pfr_id')
        values = {key: set() for key in fields}
        for key in ('espn_id', 'pfr_id'):
            if clean_id(n.get(key)):
                values[key].add(clean_id(n[key]))
        for d in by_gsis.get(gsis, []):
            same_date = bool(n['birth_date']) and n['birth_date'] == d['birthdate']
            corroborated_id = any(clean_id(n.get(k)) and clean_id(n.get(k)) == clean_id(d.get(k)) for k in ('espn_id', 'pfr_id'))
            if not (same_date or corroborated_id):
                issues.append({'gsis_id': gsis, 'reason': 'uncorroborated_identity', 'source': 'fantasy'})
                continue
            if not same_date:
                issues.append({'gsis_id': gsis, 'reason': 'corroborated_source_date_discrepancy', 'nflverse_birth_date': n['birth_date'], 'fantasy_birth_date': d['birthdate']})
            aliases.add(d['name'])
            for key in fields:
                value = clean_id(d[key])
                if not value:
                    continue
                if key == 'sleeper_id':
                    s = sleeper.get(value, {})
                    same_name = any(_player_key(s.get('full_name', ''), '') == _player_key(a, '') for a in aliases)
                    same_birthday = bool(s.get('birth_date')) and s.get('birth_date') in {n['birth_date'], d['birthdate']}
                    try:
                        adjacent_date = abs((date.fromisoformat(s.get('birth_date', '')) - date.fromisoformat(n['birth_date'])).days) == 1
                    except (ValueError, TypeError):
                        adjacent_date = False
                    # Bounded corroboration for a source date-entry discrepancy.
                    # Never infer an ID from this alone: DynastyProcess already
                    # supplied the GSIS/Sleeper pair and matched nflverse's DOB.
                    rookie_evidence = (adjacent_date and same_name and s.get('position') == n['position']
                        and s.get('college') in n.get('college_name', '').split('; ')
                        and bool(s.get('college')) and s.get('team') == n.get('draft_team')
                        and bool(s.get('team')) and s.get('years_exp') == 0
                        and n.get('rookie_season') == n.get('last_season') == n.get('draft_year')
                        and bool(n.get('draft_year')))
                    if (not (same_birthday or rookie_evidence) or
                        (clean_id(s.get('gsis_id')) and clean_id(s['gsis_id']) != gsis) or
                        not (same_name or clean_id(s.get('gsis_id')) == gsis)):
                        issues.append({'gsis_id': gsis, 'reason': 'sleeper_not_corroborated', 'provider_id': value})
                        continue
                    if rookie_evidence and not same_birthday:
                        issues.append({'gsis_id': gsis, 'reason': 'corroborated_rookie_date_discrepancy', 'provider_id': value, 'sleeper_birth_date': s['birth_date'], 'nflverse_birth_date': n['birth_date']})
                    aliases.add(s.get('full_name', ''))
                values[key].add(value)
        # Supplement absent crosswalk links only. A rejected explicit claim is
        # never rescued by a looser match. Team is not identity evidence here:
        # transfers and stale team labels cannot attach one person's stats to another.
        if supplemental_sleeper_ids and not any(clean_id(d.get('sleeper_id')) for d in by_gsis.get(gsis, [])):
            candidates = set()
            for alias in aliases:
                key = _biography_key(alias, n.get('birth_date'))
                for identity, s in sleeper_biographies.get(key, []):
                    college = clean_id(s.get('college')).casefold()
                    colleges = {c.strip().casefold() for c in n.get('college_name', '').split(';')}
                    if (college and college in colleges and s.get('position') == n['position']
                        and (not clean_id(s.get('gsis_id')) or clean_id(s['gsis_id']) == gsis)):
                        candidates.add(identity)
            if len(candidates) == 1 and candidates.intersection(supplemental_sleeper_ids):
                value = next(iter(candidates))
                values['sleeper_id'].add(value)
                issues.append({'gsis_id': gsis, 'reason': 'corroborated_sleeper_biography',
                               'provider_id': value,
                               'evidence': ['name', 'birth_date', 'position', 'college']})
            elif len(candidates) > 1 and candidates.intersection(supplemental_sleeper_ids):
                issues.append({'gsis_id': gsis, 'reason': 'ambiguous_sleeper_biography',
                               'provider_ids': sorted(candidates)})
        for key, ids in values.items():
            row[key] = next(iter(ids)) if len(ids) == 1 else ''
            if len(ids) > 1:
                issues.append({'gsis_id': gsis, 'reason': 'conflicting_provider_values', 'provider': key, 'values': sorted(ids)})
        row['aliases'] = ';'.join(sorted(aliases - {row['name'], ''}))
        result.append(row)
    # A provider token claimed by two people is never a usable link.
    for key in fields:
        owners = {}
        for row in result:
            if row[key]:
                owners.setdefault(row[key], set()).add(row['gsis_id'])
        for row in result:
            if row[key] and len(owners[row[key]]) > 1:
                issues.append({'gsis_id': row['gsis_id'], 'reason': 'provider_collision', 'provider': key, 'value': row[key]})
                row[key] = ''
    for row in result:
        s = sleeper.get(row['sleeper_id'], {})
        positions = s.get('fantasy_positions')
        # Only a surviving, corroborated provider link can add eligibility.
        row['position_aliases'] = ';'.join(sorted(
            (set(positions) & OFFENSIVE_POSITIONS) - {row['position']}
        )) if isinstance(positions, list) else ''
    if len({r['gsis_id'] for r in result}) != len(result):
        raise ValueError('Duplicate GSIS IDs in nflverse source')
    return sorted(result, key=lambda r: r['gsis_id']), issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in SOURCES:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--adp', type=Path,
                        help='Saved ADP CSV limiting supplemental biography matching to reviewed provider IDs.')
    parser.add_argument('--output', type=Path, default=Path('data/identity'))
    args = parser.parse_args()
    inputs = {name: getattr(args, name).read_bytes() for name in SOURCES}
    adp = args.adp.read_bytes() if args.adp else b''
    supplemental_ids = {clean_id(row.get('Sleeper_ID')) for row in csv.DictReader(adp.decode().splitlines())} - {''}
    rows, issues = build(list(csv.DictReader(inputs['nflverse'].decode().splitlines())),
                         list(csv.DictReader(inputs['fantasy'].decode().splitlines())), json.loads(inputs['sleeper']),
                         supplemental_sleeper_ids=supplemental_ids)
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / 'player_ids.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['gsis_id','name','position','aliases','latest_team','last_season','sleeper_id','mfl_id','espn_id','yahoo_id','pfr_id','position_aliases'], lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
    metadata = {'captured_at': datetime.now(timezone.utc).isoformat(), 'row_count': len(rows),
                'sources': {name: {'url': url, 'sha256': hashlib.sha256(inputs[name]).hexdigest()} for name,url in SOURCES.items()},
                'excluded_links': [x for x in issues if not x['reason'].startswith('corroborated_')],
                'corroborated_discrepancies': [x for x in issues if x['reason'].startswith('corroborated_') and x['reason'] != 'corroborated_sleeper_biography'],
                'supplemental_sleeper_links': [x for x in issues if x['reason'] == 'corroborated_sleeper_biography'
                    and any(r['gsis_id'] == x['gsis_id'] and r['sleeper_id'] == x['provider_id'] for r in rows)],
                'position_aliases': [{'gsis_id': r['gsis_id'], 'sleeper_id': r['sleeper_id'],
                    'primary_position': r['position'], 'offensive_alternatives': r['position_aliases'].split(';')}
                    for r in rows if r['position_aliases']]}
    if adp:
        metadata['reviewed_adp'] = {'file': args.adp.as_posix(), 'sha256': hashlib.sha256(adp).hexdigest(),
                                  'sleeper_id_count': len(supplemental_ids)}
    (args.output / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f"{len(rows)} canonical identities; {len(metadata['excluded_links'])} excluded links; "
          f"{len(metadata['corroborated_discrepancies'])} corroborated discrepancies")


if __name__ == '__main__':
    main()
