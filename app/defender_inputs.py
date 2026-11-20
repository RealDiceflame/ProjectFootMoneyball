"""Validated individual-defender evidence; no name joins or invented absences."""
import csv
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
from io import BytesIO, StringIO
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.error import HTTPError

from app.game_stats import GSIS_ID, download, encoded, read_json, write_atomic
from app.player_values import _number, _unpack
from app.scoreboard import TEAM_ALIASES, parse_time

EVENTS = ('def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds')
PLAYER_COLUMNS = ('player_id', 'player', 'pos', 'team', 'defense_snaps', *EVENTS)
URLS = {name: f'https://github.com/nflverse/nflverse-data/releases/download/{folder}/{filename}_{{season}}.csv.gz'
        for name, folder, filename in [('roster', 'rosters', 'roster'), ('injuries', 'injuries', 'injuries')]}


def rows_from_gzip(content, required):
    with gzip.GzipFile(fileobj=BytesIO(content)) as source:
        expanded = source.read(25_000_001)
    if len(expanded) > 25_000_000:
        raise ValueError('Defender source exceeds expanded size limit')
    reader = csv.DictReader(StringIO(expanded.decode('utf-8-sig')))
    if not required <= set(reader.fieldnames or ()) or len(reader.fieldnames) != len(set(reader.fieldnames)):
        raise ValueError('Defender source schema changed')
    rows = []
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError('Truncated defender source row')
        rows.append({key: value.strip() for key, value in row.items()})
    return rows


def report_window(schedule, season, now):
    context = {'season': season, 'expected_week': None, 'status': 'unknown', 'teams': [],
               'valid_from': None, 'valid_until': None}
    weeks = {}
    for game in schedule.get('games', []):
        if not 1 <= game.get('week', 0) <= 18:
            continue
        weeks.setdefault(game['week'], []).append(game)
    for week, games in sorted(weeks.items()):
        days = [datetime.strptime(game['gameday'], '%Y-%m-%d').date() for game in games]
        tuesday = min(days) - timedelta(days=(min(days).weekday() - 1) % 7)
        start = datetime.combine(tuesday, datetime.min.time(), ZoneInfo('America/New_York'))
        end = max(start + timedelta(days=7), datetime.combine(max(days) + timedelta(days=1), datetime.min.time(), ZoneInfo('America/New_York')))
        if start <= now < end:
            context.update(expected_week=week, valid_from=start.isoformat(), valid_until=end.isoformat(),
                           teams=sorted({game[side] for game in games for side in ('home', 'away')}))
            break
    return context


def build_defender_status(roster_bytes, injury_bytes, schedule, season, now):
    roster = rows_from_gzip(roster_bytes, {'season', 'team', 'gsis_id', 'full_name', 'position', 'status', 'week'})
    reports = {}
    for row in roster:
        if row['season'] != str(season):
            raise ValueError('Wrong roster season')
        identity = row['gsis_id']
        if not identity:
            continue
        if not GSIS_ID.fullmatch(identity) or identity in reports:
            raise ValueError('Invalid or duplicate roster identity')
        reports[identity] = {'player_id': identity, 'player': row['full_name'], 'pos': row['position'],
            'team': TEAM_ALIASES.get(row['team'], row['team']), 'status': row['status'],
            'status_detail': row.get('status_description_abbr') or None, 'roster_week': int(row['week']) if row['week'] else None,
            'injury': None}
    scheduled_teams = {game[side] for game in schedule.get('games', []) for side in ('home', 'away')}
    if len(scheduled_teams) != 32 or not scheduled_teams <= {row['team'] for row in reports.values()} or len(reports) < 1000:
        raise ValueError('Incomplete current roster coverage')
    injuries = rows_from_gzip(injury_bytes, {'season', 'team', 'week', 'gsis_id', 'report_status'}) if injury_bytes else []
    seen, latest = set(), {}
    for row in injuries:
        if row['season'] != str(season):
            raise ValueError('Wrong injury season')
        if (row.get('game_type') or row.get('season_type') or 'REG') != 'REG':
            continue
        identity, week = row['gsis_id'], int(row['week'])
        if not identity:
            continue
        team = TEAM_ALIASES.get(row['team'], row['team'])
        if not GSIS_ID.fullmatch(identity) or not 1 <= week <= 18 or (identity, team, week) in seen:
            raise ValueError('Invalid or duplicate injury identity/week')
        seen.add((identity, team, week))
        if identity not in reports or reports[identity]['team'] != team:
            continue
        if week > latest.get(identity, 0):
            latest[identity] = week
            reports[identity]['injury'] = {'season': season, 'week': week, 'team': team,
                'report_status': row['report_status'] or None, 'practice_status': row.get('practice_status') or None,
                'name': row.get('report_primary_injury') or row.get('practice_primary_injury') or None}
    context = report_window(schedule, season, now)
    context['status'] = 'current' if any(week == context['expected_week'] for _, _, week in seen) else 'behind' if injuries else 'unavailable'
    return {'schema_version': 1, 'season': season, 'generated_at': now.isoformat(), 'refresh_status': 'ok',
            'injury_context': context, 'reports': reports}


def refresh_defender_status(root, season, *, fetch=download, now=None):
    root, now = Path(root), now or datetime.now(timezone.utc)
    schedule = read_json(root / 'docs/data/scores.json', {})
    if schedule.get('season') != season:
        raise ValueError('Defender status requires a matching schedule')
    content, sources = {}, {}
    for name, template in URLS.items():
        url = template.format(season=season)
        try:
            blob, modified = fetch(url)
        except HTTPError as error:
            # A not-yet-published injury season is explicitly unknown. Server
            # failures and malformed feeds still fail the whole publication.
            if name != 'injuries' or error.code != 404:
                raise
            content[name] = None
            sources[name] = {'url': url, 'status': 'unavailable', 'retrieved_at': now.isoformat()}
            continue
        content[name] = blob
        digest = hashlib.sha256(blob).hexdigest()
        path = f'data/defender_status/{season}/{digest}-{name}.csv.gz'
        sources[name] = {'url': url, 'sha256': digest, 'http_last_modified': modified, 'retrieved_at': now.isoformat(), 'saved_path': path}
    payload = build_defender_status(content['roster'], content['injuries'], schedule, season, now)
    payload['sources'] = sources
    # Validate both sources before publishing either the manifest or raw evidence.
    for name in sources:
        if content[name] is not None:
            write_atomic(root / sources[name]['saved_path'], content[name])
    write_atomic(root / 'docs/data/defender_status.json', encoded(payload))
    return payload


def build_defender_inputs(root, season, defense_games, *, now):
    root = Path(root)
    status = read_json(root / 'docs/data/defender_status.json', None)
    if not status or status.get('schema_version') != 1 or status.get('season') != season:
        raise ValueError('Current defender roster evidence unavailable')
    if parse_time(status['generated_at']) > now:
        raise ValueError('Future defender roster evidence')
    sources, indexes = {}, {}
    for year in (season - 1, season):
        index = read_json(root / f'docs/data/snap_counts/{year}/index.json', None)
        if not index or index.get('season') != year or index.get('schema_version') != 1:
            raise ValueError(f'Defensive participation archive missing for {year}')
        indexes[year] = index
        sources[str(year)] = {'checked_at': index.get('checked_at'), 'sources': index.get('sources')}
    games, missing, reconciled_zeros, unmatched = [], [], 0, 0
    for game in defense_games:
        identity, year = game['game_id'], game['season']
        if identity not in indexes[year]['games']:
            missing.append(identity)
            continue
        snap = read_json(root / f'docs/data/snap_counts/{year}/{identity}.json', None)
        if not snap or snap.get('season') != year or snap.get('game_id') != identity:
            raise ValueError('Defender participation identity mismatch')
        core = {key: snap[key] for key in ('schema_version', 'season', 'game_id', 'players', 'coverage')}
        if hashlib.sha256(encoded(core)).hexdigest() != snap.get('content_sha256'):
            raise ValueError('Defender participation checksum mismatch')
        if parse_time(snap['updated_at']) > now or snap['coverage']['source_rows'] != len(snap['players']):
            raise ValueError('Invalid participation time or coverage')
        if snap['coverage'].get('status') != 'reported' or snap['coverage'].get('source_issues'):
            raise ValueError('Incomplete defensive participation source')
        if {person['team'] for person in snap['players']} != {team['team'] for team in game['teams']}:
            raise ValueError('Participation teams do not match the game')
        box = read_json(root / f'docs/data/game_stats/{year}/{identity}.json', None)
        players = _unpack(box, 'players', box['game'])  # Box checksum validated by defense_game first.
        by_id = {row['player_id']: row for row in players if row['player_id']}
        teams = []
        ids, pfrs = set(), set()
        for person in snap['players']:
            identity_pfr, identity_gsis = person.get('pfr_player_id'), person.get('player_id')
            if not identity_pfr or identity_pfr in pfrs or (identity_gsis and (not GSIS_ID.fullmatch(identity_gsis) or identity_gsis in ids)):
                raise ValueError('Duplicate or invalid defender participation ID')
            if bool(identity_gsis) != (person.get('mapping_status') == 'mapped'):
                raise ValueError('Defender identity mapping is inconsistent')
            pfrs.add(identity_pfr)
            if identity_gsis:
                ids.add(identity_gsis)
        for team in game['teams']:
            code = team['team']
            roster = [row for row in snap['players'] if row['team'] == code]
            if not roster:
                raise ValueError('Missing team in defensive participation')
            credit_complete = {}
            for event in EVENTS:
                credited = [row.get(event) for row in players if row['team'] == code]
                total = team['stats'].get(event)
                known = all(_number(value, event) is not None for value in credited)
                summed = sum(credited) if known else None
                if known and total is not None and summed > total + 1e-6:
                    raise ValueError(f'Player credits exceed team total: {identity}/{code}/{event}')
                credit_complete[event] = known and total is not None and abs(summed - total) < 1e-6
            observations, snap_total = [], 0
            for person in roster:
                snaps = _number(person.get('defense_snaps'), 'defense_snaps')
                if snaps is None or snaps < 0 or not float(snaps).is_integer():
                    raise ValueError('Missing or invalid defensive participation count')
                snap_total += snaps
                if not snaps:
                    continue
                identity_player = person.get('player_id')
                if not identity_player:
                    unmatched += 1
                row = by_id.get(identity_player)
                if row and row['team'] != code:
                    raise ValueError('Player ID linked across opposing teams')
                observation = {'player_id': identity_player, 'player': person['player_name'], 'pos': person['position'],
                               'team': code, 'defense_snaps': snaps}
                for event in EVENTS:
                    value = _number(row.get(event), event) if row else None
                    if value is None and identity_player and not row and credit_complete[event]:
                        # Zero is proved only when all team event credits are
                        # accounted for elsewhere, never by absence alone.
                        value = 0
                        reconciled_zeros += 1
                    if value is not None and value < 0:
                        raise ValueError('Negative defender event count')
                    observation[event] = value
                observations.append([observation[key] for key in PLAYER_COLUMNS])
            if snap_total <= 0:
                raise ValueError('Empty defensive participation budget')
            teams.append({'team': code, 'defender_snap_total': snap_total, 'rows': observations, 'credit_complete': credit_complete})
        games.append({'game_id': identity, 'season': year, 'week': game['week'], 'kickoff': game['kickoff'],
                      'source_updated_at': snap['updated_at'], 'source_sha256': snap['content_sha256'], 'teams': teams})
    return {'schema_version': 1, 'season': season, 'generated_at': now.isoformat(), 'columns': list(PLAYER_COLUMNS),
            'games': games, 'status': status, 'sources': sources,
            'coverage': {'joined_games': len(games), 'missing_snap_game_ids': missing,
                         'unmapped_defender_appearances': unmatched, 'reconciled_zero_events': reconciled_zeros}}
