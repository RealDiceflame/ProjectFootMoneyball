"""Compact, source-dated empirical inputs for a shared play simulation engine.

Raw current-season downloads stay in a temporary cache; versioned sufficient
statistics preserve reproducible forecasts without committing large daily CSVs.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import csv
import gzip
import hashlib
from io import BytesIO, StringIO
from pathlib import Path
import re

from app.game_stats import download, encoded, read_json, write_atomic, GSIS_ID
from app.scoreboard import parse_time, SCHEDULE_URL

LICENSE = 'https://creativecommons.org/licenses/by-sa/4.0/'
URLS = {
    'pbp': 'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz',
    'charting': 'https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_{season}.csv',
    'participation': 'https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_{season}.csv',
}


def number(value):
    if value in (None, '', 'NA', 'NaN'):
        return None
    result = float(value)
    if not -1e8 < result < 1e8:
        raise ValueError('Invalid simulation source number')
    return int(result) if result.is_integer() else result


def csv_rows(blob, required=()):
    if blob[:2] == b'\x1f\x8b':
        with gzip.GzipFile(fileobj=BytesIO(blob)) as source:
            blob = source.read(180_000_001)
    if len(blob) > 180_000_000:
        raise ValueError('Simulation source exceeds size limit')
    reader = csv.DictReader(StringIO(blob.decode('utf-8-sig')))
    if not reader.fieldnames or not set(required) <= set(reader.fieldnames) or len(reader.fieldnames) != len(set(reader.fieldnames)):
        raise ValueError('Simulation source schema changed')
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError('Incomplete simulation CSV row')
        yield row


def field_zone(yards):
    return 'goal' if yards <= 10 else 'red' if yards <= 20 else 'fg' if yards <= 40 else 'middle' if yards <= 65 else 'own'


def decision_key(down, distance, yards):
    return f'{down}|{"short" if distance <= 3 else "medium" if distance <= 7 else "long"}|{field_zone(yards)}'


def clean_id(value):
    return value if value and GSIS_ID.fullmatch(value) else None


def new_profile():
    return {'decisions': defaultdict(Counter), 'types': defaultdict(Counter), 'dropbacks': Counter(),
            'outcomes': defaultdict(Counter), 'blitz': Counter(), 'coverage': Counter(), 'routes': Counter(),
            'formations': Counter(), 'features': Counter(), 'conversions': defaultdict(Counter), 'returns': Counter(),
            'starts': Counter(), 'clocks': defaultdict(Counter), 'plays': 0}


def finish(profile, scope='all'):
    def compact(value):
        return {key: compact(item) for key, item in value.items()} if isinstance(value, dict) else round(value, 4) if isinstance(value, float) else value
    result = {}
    for key, value in profile.items():
        if key == 'outcomes':
            result[key] = {kind: [[*item, round(count, 4)] for item, count in sorted(histogram.items())] for kind, histogram in value.items()
                           if scope != 'coach' and (scope == 'all' or '|' not in kind)
                           and (scope != 'environment' or kind in {'run', 'pass', 'sack', 'scramble', 'fg', 'punt'} or kind.startswith('fg_'))}
        elif isinstance(value, dict):
            result[key] = compact(value)
        else:
            result[key] = value
    return result


def build_simulation_inputs(root, raw, sources, *, now):
    root = Path(root)
    rankings = read_json(root / 'docs/data/ranking_inputs.json', {})
    season = rankings.get('season')
    status = rankings.get('defense', {}).get('personnel', {}).get('status')
    if not status or parse_time(status['generated_at']) > now:
        raise ValueError('Validated current roster inputs required')
    coaches = read_json(root / 'docs/data/coaching_staff.json', {'teams': {}})
    score_games = {game['game_id']: game for game in read_json(root / 'docs/data/scores.json', {}).get('games', [])}
    odds_bundle = read_json(root / 'docs/data/nfl_odds.json', {})
    odds_games = {game['game_id']: game for game in odds_bundle.get('games', [])}
    boxes = {game['game_id']: game for game in rankings['defense']['games'] if parse_time(game['kickoff']) < now}
    schedule = {row['game_id']: row for row in csv_rows(raw['schedule'], ['game_id', 'home_coach', 'away_coach', 'surface'])}
    future = []
    for game in rankings['games']:
        source = schedule.get(game['game_id'], {})
        if source.get('home_team') != game['home'] or source.get('away_team') != game['away']:
            raise ValueError('Simulation schedule identity mismatch')
        public = score_games.get(game['game_id'], {})
        odds = odds_games.get(game['game_id'], {})
        same = all(odds.get(key) == public.get(key) for key in ('game_id', 'stadium_id', 'kickoff'))
        weather = odds.get('weather') if same else public.get('weather')
        future.append({**game, 'stadium': public.get('stadium'), 'stadium_id': public.get('stadium_id'),
                       'roof': public.get('roof'), 'surface': source.get('surface') or None,
                       'weather': weather, 'weather_checked_at': odds_bundle.get('generated_at') if same else (public.get('weather') or {}).get('checked_at'),
                       'home_coach': source.get('home_coach') or None, 'away_coach': source.get('away_coach') or None})
    current_coaches = {team: record.get('roles', {}).get('head_coach', {}).get('name') for team, record in coaches['teams'].items()}
    league, team_profiles, coach_profiles, environments = new_profile(), {}, {}, {}
    players, team_games, coverage, seen = {}, defaultdict(list), Counter(), set()
    game_evidence = []

    for year in (season - 1, season):
        charting = {}
        for row in csv_rows(raw[f'charting_{year}'], ['nflverse_game_id', 'nflverse_play_id', 'season']):
            if number(row['season']) != year:
                raise ValueError('Wrong charting season')
            key = (row['nflverse_game_id'], number(row['nflverse_play_id']))
            if key in charting:
                raise ValueError('Duplicate charting game/play identity')
            charting[key] = row
        participation = {}
        if f'participation_{year}' in raw:
            for row in csv_rows(raw[f'participation_{year}'], ['nflverse_game_id', 'play_id', 'defense_coverage_type']):
                if not row['nflverse_game_id'].startswith(f'{year}_'):
                    raise ValueError('Wrong participation season')
                key = (row['nflverse_game_id'], number(row['play_id']))
                if key in participation:
                    raise ValueError('Duplicate participation game/play identity')
                participation[key] = row
        grouped = defaultdict(list)
        required = ['game_id', 'season', 'season_type', 'play_id', 'posteam', 'defteam', 'down', 'ydstogo', 'yardline_100',
                    'qb_dropback', 'qb_scramble', 'sack', 'complete_pass', 'interception', 'fumble_lost', 'yards_gained',
                    'home_coach', 'away_coach', 'home_team', 'away_team', 'game_seconds_remaining', 'order_sequence']
        for row in csv_rows(raw[f'pbp_{year}'], required):
            if number(row['season']) != year:
                raise ValueError('Wrong play-by-play season')
            if row['season_type'] != 'REG' or row['game_id'] not in boxes:
                continue
            key = (row['game_id'], number(row['play_id']))
            if key in seen:
                raise ValueError('Duplicate simulation game/play identity')
            seen.add(key)
            box = boxes[row['game_id']]
            if {row['home_team'], row['away_team']} != {team['team'] for team in box['teams']} or number(row['week']) != box['week']:
                raise ValueError('Simulation play game identity mismatch')
            if row['posteam'] and {row['posteam'], row['defteam']} != {row['home_team'], row['away_team']}:
                raise ValueError('Simulation play possession identity mismatch')
            grouped[row['game_id']].append(row)
        weight = 1 if year == season else .35
        for identity, rows in sorted(grouped.items()):
            rows.sort(key=lambda row: number(row['order_sequence']))
            box = boxes[identity]
            if rows[-1].get('desc') != 'END GAME':
                coverage['incomplete_games'] += 1
                continue
            for side in ('home', 'away'):
                team = next(team for team in box['teams'] if team['team'] == rows[0][f'{side}_team'])
                if number(rows[-1].get(f'{side}_score')) != team['points_scored']:
                    raise ValueError('Play final score does not reconcile with the validated box')
            for side in ('home', 'away'):
                team = rows[0][f'{side}_team']
                team_games[team].append({'game_id': identity, 'kickoff': box['kickoff'], 'season': year})
            game_evidence.append({'game_id': identity, 'kickoff': box['kickoff'], 'plays': len(rows)})
            last_drive = None
            for i, row in enumerate(rows):
                offense, defense = row['posteam'], row['defteam']
                down, distance, yardline = (number(row[key]) for key in ('down', 'ydstogo', 'yardline_100'))
                if not offense or yardline is None or not 0 <= yardline <= 100:
                    continue
                key = (identity, number(row['play_id']))
                chart, participants = charting.get(key), participation.get(key)
                profiles = [league]
                for side, team in [('offense', offense), ('defense', defense)]:
                    coach = row['home_coach' if team == row['home_team'] else 'away_coach']
                    coach_key = f'{side}|{coach}'
                    if coach:
                        profiles.append(coach_profiles.setdefault(coach_key, new_profile()))
                    cutoff = coaches['teams'].get(team, {}).get('staff_change_observed_at')
                    if (not current_coaches.get(team) or current_coaches[team] == coach) and (not cutoff or parse_time(box['kickoff']) >= parse_time(cutoff)):
                        profiles.append(team_profiles.setdefault(f'{side}|{team}', new_profile()))
                indoor = row.get('roof') in ('dome', 'closed')
                temp, wind = number(row.get('temp')), number(row.get('wind'))
                environment_keys = [f'roof:{"indoor" if indoor else "outdoor"}']
                if row.get('surface'):
                    environment_keys.append(f'surface:{row["surface"]}')
                if row.get('stadium_id'):
                    environment_keys.append(f'stadium:{row["stadium_id"]}')
                if not indoor:
                    if wind is not None:
                        environment_keys.append(f'wind:{"high" if wind >= 15 else "moderate" if wind >= 8 else "light"}')
                    if temp is not None:
                        environment_keys.append(f'temperature:{"cold" if temp <= 35 else "hot" if temp >= 85 else "mild"}')
                profiles += [environments.setdefault(name, new_profile()) for name in environment_keys]
                elapsed = None
                clock = number(row['game_seconds_remaining'])
                if clock is not None and i + 1 < len(rows):
                    next_clock = number(rows[i + 1]['game_seconds_remaining'])
                    if next_clock is not None and 1 <= clock - next_clock <= 60:
                        elapsed = clock - next_clock
                if number(row.get('extra_point_attempt')) == 1 or number(row.get('two_point_attempt')) == 1:
                    kind = 'two' if number(row.get('two_point_attempt')) == 1 else 'xp'
                    good = row.get('two_point_conv_result') == 'success' if kind == 'two' else row.get('extra_point_result') == 'good'
                    for profile in profiles:
                        profile['conversions'][kind]['good' if good else 'failed'] += weight
                    continue
                if number(row.get('kickoff_attempt')) == 1:
                    for profile in profiles:
                        profile['returns']['kickoffs'] += weight
                        profile['returns']['kickoff_tds'] += weight * (number(row.get('return_touchdown')) == 1)
                    continue
                if down not in (1, 2, 3, 4) or distance is None or number(row.get('qb_kneel')) == 1 or number(row.get('qb_spike')) == 1:
                    continue
                dropback = number(row.get('qb_dropback')) == 1
                action = 'pass' if dropback else 'run' if number(row.get('rush_attempt')) == 1 else 'fg' if number(row.get('field_goal_attempt')) == 1 else 'punt' if number(row.get('punt_attempt')) == 1 else 'penalty' if row['play_type'] == 'no_play' and number(row.get('penalty')) == 1 else None
                if action is None:
                    continue
                coverage['modeled_plays'] += 1
                coverage[f'plays_{year}'] += 1
                coverage['charted_plays' if chart else 'uncharted_plays'] += 1
                if participants:
                    coverage['historical_participation_plays'] += 1
                dkey = decision_key(down, distance, yardline)
                drive = number(row.get('fixed_drive'))
                for profile in profiles:
                    profile['plays'] += weight
                    profile['decisions'][dkey][action] += weight
                    if drive != last_drive:
                        profile['starts'][str(max(1, min(99, yardline)))] += weight
                    if elapsed is not None:
                        profile['clocks'][action][str(elapsed)] += weight
                    if chart:
                        for feature in ('is_motion', 'is_play_action', 'is_screen_pass', 'is_rpo', 'is_no_huddle'):
                            if chart.get(feature) in ('TRUE', 'FALSE', 'true', 'false'):
                                profile['features'][feature + ':known'] += weight
                                profile['features'][feature] += weight * (chart[feature].lower() == 'true')
                        blitzers = number(chart.get('n_blitzers'))
                        if blitzers is not None and dropback:
                            profile['blitz']['yes' if blitzers > 0 else 'no'] += weight
                    if participants:
                        for field, target in [('defense_coverage_type', 'coverage'), ('route', 'routes'), ('offense_formation', 'formations')]:
                            if participants.get(field) not in ('', 'NA'):
                                profile[target][participants[field]] += weight
                last_drive = drive
                yards = number(row['yards_gained'])
                if yards is None or not -100 <= yards <= 100:
                    coverage['unknown_yards_plays'] += 1
                    continue
                kind = action
                if dropback:
                    kind = 'sack' if number(row['sack']) == 1 else 'scramble' if number(row['qb_scramble']) == 1 else 'attempt'
                    for profile in profiles:
                        profile['dropbacks'][kind] += weight
                subtype = None
                if action == 'run':
                    subtype = f'run_{row["run_location"]}' if row.get('run_location') in ('left', 'middle', 'right') else None
                elif kind == 'attempt':
                    subtype = f'pass_{row["pass_length"]}_{row["pass_location"]}' if row.get('pass_length') in ('short', 'deep') and row.get('pass_location') in ('left', 'middle', 'right') else None
                    if chart:
                        for flag, label in [('is_play_action', 'play_action'), ('is_rpo', 'rpo'), ('is_screen_pass', 'screen')]:
                            if chart.get(flag, '').lower() == 'true':
                                subtype = label
                outcome_kind = 'pass' if kind == 'attempt' else kind
                complete = number(row['complete_pass']) if kind == 'attempt' else 0
                interception = number(row['interception'])
                lost = number(row['fumble_lost'])
                if any(value is None for value in (complete, interception, lost)):
                    coverage['unknown_event_plays'] += 1
                    continue
                # Named player stats are assigned by the simulator, not copied
                # from the sampled historical play's participants.
                gain = number(row.get('penalty_yards')) or 0 if action == 'penalty' else yards
                if action == 'punt':
                    gain = (number(row.get('kick_distance')) or 0) - (number(row.get('return_yards')) or 0)
                if action == 'penalty' and row.get('penalty_team') == offense:
                    gain = -gain
                result = (gain, complete, interception, lost, number(row.get('return_yards')) or 0,
                          number(row.get('air_yards')) or 0, int(row.get('field_goal_result') == 'made'),
                          number(row.get('kick_distance')) or 0, int(row.get('field_goal_result') == 'blocked' or number(row.get('punt_blocked')) == 1),
                          int(number(row.get('first_down_penalty')) == 1))
                labels = [outcome_kind] + ([subtype] if subtype else [])
                if action == 'fg':
                    labels.append(f'fg_{int((number(row.get("kick_distance")) or 0) // 10)}')
                for profile in profiles:
                    if subtype:
                        profile['types'][action][subtype] += weight
                    for label in labels:
                        profile['outcomes'][label][result] += weight
                        profile['outcomes'][f'{label}|{field_zone(yardline)}'][result] += weight
                    if participants and kind == 'attempt' and participants.get('defense_coverage_type') not in ('', 'NA', None):
                        profile['outcomes'][f'coverage:{participants["defense_coverage_type"]}'][result] += weight
                if chart and dropback and number(chart.get('n_blitzers')) is not None:
                    blitz_key = 'yes' if number(chart['n_blitzers']) > 0 else 'no'
                    for profile in profiles:
                        profile['dropbacks'][f'{blitz_key}:{kind}'] += weight
                role_ids = [('passer', row.get('passer_player_id'), 'pass'), ('rusher', row.get('rusher_player_id'), 'run'),
                            ('receiver', row.get('receiver_player_id'), 'target'), ('kicker', row.get('kicker_player_id'), 'fg')]
                for role, player_id, opportunity in role_ids:
                    player_id = clean_id(player_id)
                    if not player_id or (role == 'kicker' and action != 'fg'):
                        continue
                    person = players.setdefault(player_id, {'games': {}, 'profile': new_profile()})
                    player_game = person['games'].setdefault(identity, {'team': offense, 'kickoff': box['kickoff'], 'opportunities': Counter()})
                    player_game['opportunities'][opportunity] += 1
                    if subtype:
                        player_game['opportunities'][subtype] += 1
                    if (role in ('receiver', 'passer') and kind == 'attempt') or role == 'rusher' or (role == 'kicker' and action == 'fg'):
                        for label in labels:
                            person['profile']['outcomes'][label][result] += weight
                    if role == 'passer':
                        person['profile']['dropbacks'][kind] += weight
    if coverage['modeled_plays'] < 10000 or len(team_games) != 32:
        raise ValueError('Insufficient league simulation evidence')
    for player in players.values():
        player['profile'] = finish(player['profile'])
        player['games'] = [{'game_id': key, **value, 'opportunities': dict(value['opportunities'])} for key, value in player['games'].items()]
    payload = {'schema_version': 1, 'model_version': 'matchup-simulation-v1', 'season': season, 'generated_at': now.isoformat(),
        'sources': sources, 'attribution': 'FTN Data via nflverse; nflverse play-by-play. Derived charting and participation data: CC BY-SA 4.0.', 'license_url': LICENSE,
        'coverage': {**coverage, 'archived_games': len(boxes), 'used_games': len(game_evidence),
                     'missing_game_ids': sorted(set(boxes) - {row['game_id'] for row in game_evidence}), 'participation_seasons': [season - 1]},
        'games': future, 'game_evidence': game_evidence, 'coaching': coaches, 'status': status,
        'league': finish(league), 'teams': {key: finish(value, 'team') for key, value in team_profiles.items()},
        'coaches': {key: finish(value, 'coach') for key, value in coach_profiles.items()},
        'environments': {key: finish(value, 'environment') for key, value in environments.items()}, 'players': players,
        'team_games': {team: sorted(games, key=lambda game: game['kickoff'], reverse=True) for team, games in team_games.items()}}
    return payload


def refresh_simulation_inputs(root, cache_dir, *, fetch=download, now=None, use_cache=False):
    root, cache = Path(root), Path(cache_dir)
    now = now or datetime.now(timezone.utc)
    season = read_json(root / 'docs/data/ranking_inputs.json', {})['season']
    cache.mkdir(parents=True, exist_ok=True)
    sources, raw = {}, {}
    requests = {'schedule': SCHEDULE_URL}
    for year in (season - 1, season):
        requests[f'pbp_{year}'] = URLS['pbp'].format(season=year)
        requests[f'charting_{year}'] = URLS['charting'].format(season=year)
    requests[f'participation_{season - 1}'] = URLS['participation'].format(season=season - 1)
    aliases = {f'charting_{year}': f'ftn_{year}' for year in (season - 1, season)}
    saved_audit = read_json(cache.parent / 'source-audit.json', [])
    audit = {row.get('name'): row for row in saved_audit}
    for name, url in requests.items():
        path = cache / aliases.get(name, name)
        if name == f'pbp_{season - 1}':
            prior = read_json(root / f'data/play_by_play/{season - 1}/provenance.json', {}).get('plays')
            if prior:
                raw[name] = (root / prior['saved_path']).read_bytes()
                if hashlib.sha256(raw[name]).hexdigest() != prior['sha256']:
                    raise ValueError('Archived play-by-play checksum mismatch')
                sources[name] = {key: value for key, value in prior.items() if key != 'saved_path'}
                continue
        if use_cache and path.exists():
            blob, modified = path.read_bytes(), audit.get(aliases.get(name, name), {}).get('last_modified')
            retrieved_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
        else:
            blob, modified = fetch(url)
            path.write_bytes(blob)
            retrieved_at = now.isoformat()
        raw[name] = blob
        sources[name] = {'url': url, 'sha256': hashlib.sha256(blob).hexdigest(), 'http_last_modified': modified, 'retrieved_at': retrieved_at,
                         'license_url': LICENSE, 'raw_retention': 'Temporary download; compact model inputs are versioned.'}
    result = build_simulation_inputs(root, raw, sources, now=now)
    write_atomic(root / 'docs/data/simulation_inputs.json', encoded(result))
    return result
