import csv
from datetime import datetime, timezone, timedelta
import gzip
from io import StringIO
import json
from pathlib import Path
import pytest
from app import snap_counts as snaps

NOW = datetime(2026, 10, 30, tzinfo=timezone.utc)
GAME = '2026_01_NE_ARI'
SCHEDULE = {GAME: {'game_id': GAME, 'week': 1, 'home': 'ARI', 'away': 'NE', 'pfr_game_id': '202609130crd'}}
LINKS = {'AlleJo00': '00-0034857', 'AlleJo01': '00-0035663'}


def csv_bytes(rows):
    stream = StringIO()
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode()


def row(pfr='AlleJo00', team='NE', **changes):
    result = dict(game_id=GAME, pfr_game_id='202609130crd', season='2026', game_type='REG', week='1',
                  player='Josh Allen', pfr_player_id=pfr, position='QB', team=team,
                  opponent='ARI' if team == 'NE' else 'NE', offense_snaps='60', offense_pct='1',
                  defense_snaps='0', defense_pct='0', st_snaps='0', st_pct='0')
    return {**result, **changes}


def source(*extra):
    return csv_bytes([row(), row('AlleJo01', 'ARI', position='DE'), *extra])


def test_same_name_explicit_ids_remain_distinct_and_unmapped_lineman_retained():
    games = snaps.parse_snaps(source(row('UnknLi00', position='OL')), 2026, SCHEDULE, LINKS, set())
    rows = games[GAME]
    assert {p['player_id'] for p in rows} == {None, *LINKS.values()}
    assert len(rows) == 3
    assert next(p for p in rows if p['pfr_player_id'] == 'UnknLi00')['mapping_status'] == 'unmapped'


def test_registry_conflicts_quarantined_without_name_matching():
    data = csv_bytes([{'pfr_id': 'AlleJo00', 'gsis_id': '00-0034857'},
                      {'pfr_id': 'AlleJo00', 'gsis_id': '00-0035663'},
                      {'pfr_id': 'Clean00', 'gsis_id': '00-0000001'}])
    links, ambiguous = snaps.player_links(data)
    assert links == {'Clean00': '00-0000001'}
    assert ambiguous == {'AlleJo00'}
    player = next(p for p in snaps.parse_snaps(source(), 2026, SCHEDULE, links, ambiguous)[GAME] if p['pfr_player_id'] == 'AlleJo00')
    assert player['player_id'] is None and player['mapping_status'] == 'ambiguous'


@pytest.mark.parametrize('change', [dict(pfr_game_id='wrong'), dict(week='2'), dict(opponent='BUF'),
    dict(game_id='2026_01_BUF_ARI'), dict(season='2025'), dict(pfr_player_id=''),
    dict(offense_snaps='NaN'), dict(offense_snaps='-1'), dict(offense_snaps='1.5'),
    dict(offense_pct='1.01'), dict(offense_pct='inf'), dict(offense_snaps='0', offense_pct='.5')])
def test_invalid_rows_fail(change):
    with pytest.raises(ValueError):
        snaps.parse_snaps(csv_bytes([row(**change), row('AlleJo01', 'ARI')]), 2026, SCHEDULE, LINKS, set())


def test_duplicate_participant_and_one_sided_game_fail():
    for data in [source(row()), csv_bytes([row()])]:
        with pytest.raises(ValueError):
            snaps.parse_snaps(data, 2026, SCHEDULE, LINKS, set())


def test_missing_values_preserved_and_postseason_excluded():
    data = source(row('Null00', offense_snaps='', offense_pct=''), row('Post00', game_type='POST', game_id='2026_19_NE_ARI'))
    rows = snaps.parse_snaps(data, 2026, SCHEDULE, LINKS, set())[GAME]
    assert len(rows) == 3
    assert next(p for p in rows if p['pfr_player_id'] == 'Null00')['offense_snaps'] is None


def test_historical_franchise_labels_match_exact_game():
    game = '2016_01_SD_OAK'
    schedule = {game: {'week': 1, 'home': 'OAK', 'away': 'SD', 'pfr_game_id': '201609110rai'}}
    data = csv_bytes([row(game_id=game, season='2016', pfr_game_id='201609110rai', team='LAC', opponent='LV'),
                      row('AlleJo01', game_id=game, season='2016', pfr_game_id='201609110rai', team='LV', opponent='LAC')])
    assert {p['team'] for p in snaps.parse_snaps(data, 2016, schedule, LINKS, set())[game]} == {'OAK', 'SD'}


def test_game_coverage_and_participant_regression_retain_last_good(tmp_path):
    artifacts, summary = snaps.build_season(tmp_path, 2026, source(row('Other00')), SCHEDULE, LINKS, set(), {}, NOW)
    for path, content in artifacts.items():
        snaps.write_atomic(path, content)
    before = {p: p.read_bytes() for p in tmp_path.rglob('*.json')}
    with pytest.raises(ValueError, match='participants disappeared'):
        snaps.build_season(tmp_path, 2026, source(), SCHEDULE, LINKS, set(), {}, NOW)
    assert {p: p.read_bytes() for p in tmp_path.rglob('*.json')} == before
    assert summary['unmatched_players'] == 1


def test_missing_current_game_is_explicit(tmp_path):
    schedule = {**SCHEDULE, '2026_02_NE_ARI': {'week': 2, 'home': 'ARI', 'away': 'NE', 'pfr_game_id': 'other'}}
    _, summary = snaps.build_season(tmp_path, 2026, source(), schedule, LINKS, set(), {}, NOW)
    assert summary['coverage_status'] == 'partial'
    assert summary['missing_games'] == ['2026_02_NE_ARI']


def schedule_source():
    return gzip.compress(csv_bytes([dict(game_id=GAME, season='2026', game_type='REG', week='1',
          pfr='202609130crd', away_team='NE', home_team='ARI', gameday='2026-09-13',
          gametime='16:25', away_score='24', home_score='20')]), mtime=0)


def fetcher(url):
    if url == snaps.SCHEDULE_URL:
        return schedule_source(), None
    if url == snaps.PLAYERS_URL:
        return csv_bytes([{'pfr_id': pfr, 'gsis_id': gsis} for pfr, gsis in LINKS.items()]), None
    return source(), None


def test_refresh_idempotent_sources_are_immutable_and_box_scores_untouched(tmp_path):
    box = tmp_path / 'docs/data/game_stats/index.json'
    box.parent.mkdir(parents=True)
    box.write_text('{"current_season":2026}')
    snaps.refresh_snap_counts(tmp_path, [2026], fetch=fetcher, now=NOW)
    before = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    snaps.refresh_snap_counts(tmp_path, [2026], fetch=fetcher, now=NOW + timedelta(days=1))
    after = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    assert before == after
    provenance = json.loads((tmp_path / 'data/snap_counts/2026/provenance.json').read_text())
    assert all(source['sha256'] in source['saved_path'] for source in provenance.values())
    assert box.read_text() == '{"current_season":2026}'


def test_refresh_failure_writes_nothing(tmp_path):
    def fail(url):
        if 'snap_counts_' in url:
            return b'broken', None
        return fetcher(url)
    with pytest.raises(ValueError):
        snaps.refresh_snap_counts(tmp_path, [2026], fetch=fail, now=NOW)
    assert not list(tmp_path.rglob('*'))


def test_historical_incomplete_source_is_rejected(tmp_path):
    schedule = {**SCHEDULE, '2026_02_NE_ARI': {'week': 2, 'home': 'ARI', 'away': 'NE', 'pfr_game_id': 'other'}}
    # The strict historical rule applies independent of the fixture year label.
    data = source().replace(b'2026,REG', b'2025,REG')
    with pytest.raises(ValueError, match='Incomplete historical'):
        snaps.build_season(tmp_path, 2025, data, schedule, LINKS, set(), {}, NOW)


def test_punctuated_pfr_ids_and_legacy_nfl_ids():
    links, ambiguous = snaps.player_links(csv_bytes([
        {'pfr_id': 'WattT.00', 'gsis_id': '00-0033873'},
        {'pfr_id': 'Ya-SRo00', 'gsis_id': '00-0035637'},
        {'pfr_id': 'Legacy00', 'gsis_id': 'ABC123456'}]))
    assert links == {'WattT.00': '00-0033873', 'Ya-SRo00': '00-0035637'}
    assert not ambiguous


def test_all_seasons_prepare_before_any_write(tmp_path, monkeypatch):
    def schedule(content, season, now):
        return SCHEDULE
    original = snaps.build_season
    def build(root, season, *args):
        if season == 2025:
            return original(root, 2026, *args)
        raise ValueError('later season source failed')
    monkeypatch.setattr(snaps, 'parse_schedule', schedule)
    monkeypatch.setattr(snaps, 'build_season', build)
    with pytest.raises(ValueError, match='later season'):
        snaps.refresh_snap_counts(tmp_path, [2025, 2026], fetch=fetcher, now=NOW)
    assert not list(tmp_path.rglob('*'))


@pytest.mark.parametrize('pfr', ['Cox_Mi20', "O\'ShJa00", "ReedD\'00", "Ta\'aAl00"])
def test_registry_preserves_real_pfr_punctuation(pfr):
    links, _ = snaps.player_links(csv_bytes([{'pfr_id': pfr, 'gsis_id': '00-0000001'}]))
    assert links[pfr] == '00-0000001'


@pytest.mark.parametrize('game,pfr', [('2021_13_IND_HOU', 'MoorA.00'), ('2021_13_IND_HOU', 'SmitTr04'), ('2021_15_SEA_LA', 'HoecMi00')])
def test_reviewed_source_percentage_exception_is_null_and_reported(game, pfr):
    _, week, away, home = game.split('_')
    schedule = {game: {'week': int(week), 'away': away, 'home': home, 'pfr_game_id': 'exact'}}
    data = csv_bytes([row(pfr, away, game_id=game, season='2021', week=week, pfr_game_id='exact', opponent=home, st_snaps='22', st_pct='1.01'),
                      row('Other00', home, game_id=game, season='2021', week=week, pfr_game_id='exact', opponent=away)])
    result = next(p for p in snaps.parse_snaps(data, 2021, schedule, {}, set())[game] if p['pfr_player_id'] == pfr)
    assert result['st_snaps'] == 22 and result['st_pct'] is None
    assert result['data_issues'] == [{'field': 'st_pct', 'source_value': '1.01', 'reason': 'Source percentage exceeds 100%; unavailable'}]
    # Same bad value on another player is not an approved exception.
    with pytest.raises(ValueError, match='out of range'):
        snaps.parse_snaps(data.replace(pfr.encode(), b'Unexpected00'), 2021, schedule, {}, set())
