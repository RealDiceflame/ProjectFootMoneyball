from copy import deepcopy
from datetime import datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

from app.defender_inputs import build_defender_status, build_defender_inputs, refresh_defender_status, rows_from_gzip, EVENTS
from app.game_stats import encoded

ROOT = Path(__file__).resolve().parents[1]
SAVED_STATUS = json.loads((ROOT / 'docs/data/defender_status.json').read_text())
NOW = datetime.fromisoformat(SAVED_STATUS['generated_at']) + timedelta(seconds=1)


def status_sources():
    status = json.loads((ROOT / 'docs/data/defender_status.json').read_text())
    return {key: (ROOT / value['saved_path']).read_bytes() if value.get('saved_path') else None for key, value in status['sources'].items()}


def test_full_roster_joins_injuries_by_id_and_retains_unknown_health():
    raw = status_sources()
    schedule = json.loads((ROOT / 'docs/data/scores.json').read_text())
    result = build_defender_status(raw['roster'], raw['injuries'], schedule, 2026, NOW)
    assert len(result['reports']) >= 1000
    assert result['injury_context']['expected_week'] == SAVED_STATUS['injury_context']['expected_week']
    assert result['injury_context']['status'] == SAVED_STATUS['injury_context']['status']
    assert any(row['injury'] is None for row in result['reports'].values())
    assert all(row['injury'] is None or row['team'] == row['injury']['team'] for row in result['reports'].values())
    missing = build_defender_status(raw['roster'], None, schedule, 2026, NOW)
    assert missing['injury_context']['status'] == 'unavailable'
    assert all(row['injury'] is None for row in missing['reports'].values())


@pytest.mark.parametrize('source', [b'not a gzip', gzip.compress(b'season,season\n2026,2026'), gzip.compress(b'season,team\n2026')])
def test_truncated_or_changed_sources_fail(source):
    with pytest.raises((ValueError, OSError)):
        rows_from_gzip(source, {'season', 'team'})


def test_partial_refresh_never_overwrites_last_good_status(tmp_path):
    folder = tmp_path / 'docs/data'; folder.mkdir(parents=True)
    (folder / 'scores.json').write_text((ROOT / 'docs/data/scores.json').read_text())
    target = folder / 'defender_status.json'; target.write_text('{"last_good":true}')
    def failed(url):
        raise HTTPError(url, 503, 'Unavailable', {}, None)
    with pytest.raises(HTTPError):
        refresh_defender_status(tmp_path, 2026, fetch=failed, now=NOW)
    assert target.read_text() == '{"last_good":true}'


def archive_fixture(tmp_path):
    inputs = json.loads((ROOT / 'docs/data/ranking_inputs.json').read_text())
    game = next(game for game in inputs['defense']['games'] if game['season'] == 2026)
    snap_path = f"docs/data/snap_counts/2026/{game['game_id']}.json"
    paths = ['docs/data/defender_status.json', 'docs/data/snap_counts/2025/index.json', 'docs/data/snap_counts/2026/index.json', snap_path,
             f"docs/data/game_stats/2026/{game['game_id']}.json"]
    for relative in paths:
        destination = tmp_path / relative; destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / relative).read_bytes())
    return game, tmp_path / snap_path


def seal_snap(snap):
    core = {key: snap[key] for key in ('schema_version', 'season', 'game_id', 'players', 'coverage')}
    snap['content_sha256'] = hashlib.sha256(encoded(core)).hexdigest()


@pytest.mark.parametrize('mutation', ['checksum', 'duplicate', 'wrong_team', 'negative', 'mapping', 'future', 'coverage'])
def test_corrupt_participation_is_rejected(tmp_path, mutation):
    game, path = archive_fixture(tmp_path); snap = json.loads(path.read_text())
    if mutation == 'checksum':
        snap['players'][0]['defense_snaps'] += 1
    elif mutation == 'duplicate':
        snap['players'].append(deepcopy(snap['players'][0])); snap['coverage']['source_rows'] += 1; seal_snap(snap)
    elif mutation == 'wrong_team':
        snap['players'][0]['team'] = 'INVALID'; seal_snap(snap)
    elif mutation == 'negative':
        snap['players'][0]['defense_snaps'] = -1; seal_snap(snap)
    elif mutation == 'mapping':
        snap['players'][0]['mapping_status'] = 'unmapped'; seal_snap(snap)
    elif mutation == 'future':
        snap['updated_at'] = '2099-01-01T00:00:00Z'
    else:
        snap['coverage']['source_issues'] = 1; seal_snap(snap)
    path.write_bytes(encoded(snap))
    with pytest.raises(ValueError):
        build_defender_inputs(tmp_path, 2026, [game], now=NOW)


def test_missing_snap_game_remains_a_visible_gap_and_null_stat_is_unknown(tmp_path):
    game, snap_path = archive_fixture(tmp_path)
    box_path = tmp_path / f"docs/data/game_stats/2026/{game['game_id']}.json"
    box = json.loads(box_path.read_text()); snap = json.loads(snap_path.read_text())
    defender = next(person for person in snap['players'] if person['defense_snaps'] > 0 and person['player_id'] in {row[box['player_columns'].index('player_id')] for row in box['players']})
    player = next(row for row in box['players'] if row[box['player_columns'].index('player_id')] == defender['player_id'])
    player[box['player_columns'].index('def_sacks')] = None
    box_path.write_bytes(encoded(box))
    missing = deepcopy(game); missing['game_id'] = 'missing_game'
    result = build_defender_inputs(tmp_path, 2026, [game, missing], now=NOW)
    assert result['coverage']['missing_snap_game_ids'] == ['missing_game']
    rows = [dict(zip(result['columns'], row)) for team in result['games'][0]['teams'] for row in team['rows']]
    assert next(row for row in rows if row['player_id'] == defender['player_id'])['def_sacks'] is None
    assert all(row['defense_snaps'] > 0 for row in rows)


def test_player_credits_cannot_exceed_authoritative_team_total(tmp_path):
    game, _ = archive_fixture(tmp_path)
    box_path = tmp_path / f"docs/data/game_stats/2026/{game['game_id']}.json"
    box = json.loads(box_path.read_text())
    box['players'][0][box['player_columns'].index(EVENTS[0])] = 999
    box_path.write_bytes(encoded(box))
    with pytest.raises(ValueError, match='exceed team total'):
        build_defender_inputs(tmp_path, 2026, [game], now=NOW)
