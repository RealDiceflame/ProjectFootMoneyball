import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordPlayerValues} from '../scripts/record_player_values.mjs';
import {MODEL_VERSION} from '../docs/player-values.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'outlier-value-history-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const folder = join(root, 'docs/data'); await mkdir(folder, {recursive: true});
  const columns = ['player_id', 'player', 'pos', 'team', 'week', 'game_id', 'kickoff', 'analysis_ready',
    'passing_yards', 'passing_tds', 'passing_interceptions', 'rushing_yards', 'rushing_tds', 'receptions',
    'receiving_yards', 'receiving_tds', 'fumbles_lost_total', 'passing_2pt_conversions', 'rushing_2pt_conversions', 'receiving_2pt_conversions', 'special_teams_tds'];
  const past = {game_id: '2026_03_KC_BUF', home: 'BUF', away: 'KC', kickoff: '2026-09-27T17:00:00Z', week: 3, analysis_ready: true};
  const inputs = {schema_version: 1, season: 2026, season_type: 'REG', generated_at: '2026-09-28T10:00:00Z',
    columns, rows: [['00-0000001', 'Test Player', 'QB', 'BUF', 3, past.game_id, past.kickoff, true, 200, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    games: [past, {...past, game_id: '2026_04_KC_BUF', kickoff: '2026-10-04T17:00:00Z', week: 4, analysis_ready: false}], coverage: {analysis_ready_games: 1}};
  for (const [file, value] of Object.entries({'player_value_inputs': inputs, rankings: {columns: [], boards: {}}, player_news: {}, player_history: {columns: [], players: {}}}))
    await writeFile(join(folder, `${file}.json`), JSON.stringify(value));
  return {root, folder};
}

test('record twelve formats with input fingerprints; preserve earlier UTC dates', async t => {
  const {root, folder} = await setup(t);
  const firstTime = Date.parse('2026-09-28T12:00:00Z');
  const result = await recordPlayerValues(root, {now: firstTime});
  assert.deepEqual(result, {date: '2026-09-28', players: 1, formats: 12});
  const firstPath = join(folder, 'player_values/2026-09-28.json');
  const firstBytes = await readFile(firstPath, 'utf8'), first = JSON.parse(firstBytes);
  assert.equal(first.model_version, MODEL_VERSION);
  assert.match(first.evidence.inputs.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(first.formats).length, 12);
  await recordPlayerValues(root, {now: firstTime + 86400000});
  assert.equal(await readFile(firstPath, 'utf8'), firstBytes);
  const index = JSON.parse(await readFile(join(folder, 'player_values/index.json'), 'utf8'));
  assert.deepEqual(index.snapshots.map(row => row.date), ['2026-09-28', '2026-09-29']);
  await assert.rejects(recordPlayerValues(root, {now: firstTime}), /backdated/);
});

test('same-day refresh replaces only that day; malformed manifest cannot erase history', async t => {
  const {root, folder} = await setup(t), firstTime = Date.parse('2026-09-28T12:00:00Z');
  await recordPlayerValues(root, {now: firstTime});
  await recordPlayerValues(root, {now: firstTime + 3600000});
  const indexPath = join(folder, 'player_values/index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(index.snapshots.length, 1); assert.equal(index.snapshots[0].as_of, '2026-09-28T13:00:00.000Z');
  await writeFile(indexPath, '{');
  await assert.rejects(recordPlayerValues(root, {now: firstTime + 7200000}));
  assert.equal(await readFile(indexPath, 'utf8'), '{');
});

test('newer historical evidence cannot be recorded as an earlier forecast', async t => {
  const {root, folder} = await setup(t);
  await writeFile(join(folder, 'player_history.json'), JSON.stringify({generated_at: '2026-10-01T00:00:00Z', columns: [], players: {}}));
  await assert.rejects(recordPlayerValues(root, {now: Date.parse('2026-09-28T12:00:00Z')}), /future-dated history/);
});
