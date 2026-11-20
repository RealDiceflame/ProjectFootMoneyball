import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordRankings} from '../scripts/record_rankings.mjs';
import {buildRankingBoard, defensiveContext, matchupFactor, pointsAllowedScore, scoreDefense, validateRankingInputs} from '../docs/ranking-model.mjs';

const data = Object.fromEntries(Object.entries({rankings: 'rankings', history: 'player_history', news: 'player_news', inputs: 'ranking_inputs'})
  .map(([key, file]) => [key, JSON.parse(readFileSync(new URL(`../docs/data/${file}.json`, import.meta.url)))]));
const now = Math.max(...Object.values(data).map(bundle => Date.parse(bundle.generated_at) || 0)) + 1000;
const settings = {teams: 12, quarterbacks: '2QB', ppr: 'Half PPR', tePremium: '+0.5', defenses: 'Include'};
const build = (horizon, changes = {}) => buildRankingBoard({...data, ...changes}, settings, {now, horizon});

test('D/ST scoring distinguishes half sacks, recoveries, forced fumbles, and missing stats', () => {
  const stats = Object.fromEntries(['def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_safeties', 'def_punt_blocks', 'def_pat_blocks', 'def_fg_blocks', 'def_tds', 'special_teams_tds', 'def_2pt_made'].map(key => [key, 0]));
  assert.equal(scoreDefense({stats, points_allowed: 0}), 10);
  assert.equal(scoreDefense({stats: {...stats, def_sacks: 1.5, def_fumbles_forced: 8, fumble_recovery_own: 5, fumble_recovery_opp: 1}, points_allowed: 21}), 3.5);
  assert.equal(scoreDefense({stats: {...stats, def_interceptions: null}, points_allowed: 7}), null);
  assert.equal(scoreDefense({stats, points_allowed: null}), null);
  assert.deepEqual([0, 1, 6, 7, 13, 14, 20, 21, 27, 28, 34, 35].map(pointsAllowedScore), [10, 7, 7, 4, 4, 1, 1, 0, 0, -1, -1, -4]);
});

test('all horizons have 32 defenses, finite forecasts and no invented rookie prior', () => {
  for (const horizon of ['draft', 'weekly', 'ros']) {
    const board = build(horizon);
    assert.equal(board.rows.filter(row => row.pos === 'DST').length, 32);
    assert.ok(board.rows.some(row => row.pos === 'QB' && Number.isFinite(row.projected_points)));
    assert.ok(board.rows.every(row => row.projected_points === null || Number.isFinite(row.projected_points)));
    const missing = board.rows.filter(row => row.prior_ppg === null && row.current_ppg === null && row.pos !== 'DST');
    assert.ok(missing.every(row => row.projected_points === null && row.overall_rank === null));
  }
});

test('weekly excludes byes and started games; ROS equals its unstarted fixture sum', () => {
  const weekly = build('weekly'), ros = build('ros');
  for (const row of weekly.rows) {
    const games = row.forecast_games.filter(game => game.week === weekly.week);
    assert.equal(row.eligible, games.length > 0);
    if (!games.length) assert.equal(row.overall_rank, null);
    assert.ok(games.every(game => Date.parse(game.kickoff) > now));
  }
  for (const row of ros.rows.filter(row => row.projected_points !== null))
    assert.ok(Math.abs(row.projected_points - row.forecast_games.reduce((sum, game) => sum + game.points, 0)) < .011);
});

test('defensive adjustments are bounded, scoring sensitive, and never use future games', () => {
  const before = defensiveContext(data.inputs, settings, now);
  for (const profile of Object.values(before.teams)) for (const item of Object.values(profile.positions)) assert.ok(item.factor >= .9 && item.factor <= 1.1);
  const copy = structuredClone(data.inputs), poisoned = structuredClone(copy.defense.games[0]);
  poisoned.kickoff = new Date(now + 86400000).toISOString();
  poisoned.teams[0].allowed.WR.receptions = 999999;
  copy.defense.games.push(poisoned);
  assert.deepEqual(defensiveContext(copy, settings, now), before);
  assert.equal(matchupFactor(before, 'UNKNOWN', 'WR').factor, 1);
  const standard = defensiveContext(data.inputs, {ppr: 'Standard'}, now);
  assert.notEqual(before.league.WR.value, standard.league.WR.value);
});

test('market metrics do not turn weekly projections into draft values; league size changes scarcity', () => {
  const board = build('weekly');
  assert.ok(board.rows.every(row => row.market_value === null && row.value_vs_adp === null));
  const small = buildRankingBoard(data, {...settings, teams: 8}, {now, horizon: 'ros'});
  const first = small.rows.find(row => row.pos === 'QB');
  assert.notEqual(first.vorp, build('ros').rows.find(row => row.player_id === first.player_id).vorp);
});

test('input validation rejects truncated rows and missing defense evidence', () => {
  assert.ok(validateRankingInputs(data.inputs));
  assert.equal(validateRankingInputs({...data.inputs, defense: null}), false);
  assert.equal(validateRankingInputs({...data.inputs, rows: [[1]]}), false);
});

test('draft outlook can use historical priors before any current-season observations exist', () => {
  const inputs = structuredClone(data.inputs);
  inputs.rows = [];
  inputs.defense.games = inputs.defense.games.filter(game => game.season < inputs.season);
  const board = build('draft', {inputs});
  assert.ok(board.rows.some(row => row.pos === 'WR' && row.projected_points > 0));
  assert.ok(board.rows.filter(row => row.pos !== 'DST').every(row => row.current_ppg === null));
  assert.equal(board.rows.filter(row => row.pos === 'DST' && Number.isFinite(row.projected_points)).length, 32);
});

test('a failed complete-board publication preserves the last good forecasts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ob-rankings-'));
  try {
    await mkdir(join(root, 'docs/data'), {recursive: true});
    const inputs = structuredClone(data.inputs);
    for (const game of inputs.defense.games) for (const row of game.teams) row.stats.def_sacks = null;
    for (const [key, name] of Object.entries({rankings: 'rankings', history: 'player_history', news: 'player_news', inputs: 'ranking_inputs'}))
      await writeFile(join(root, `docs/data/${name}.json`), JSON.stringify(key === 'inputs' ? inputs : data[key]));
    const destination = join(root, 'docs/data/ranking_forecasts.json');
    await writeFile(destination, '{"last_good":true}');
    await assert.rejects(recordRankings(root, {now}), /Incomplete player or defense/);
    assert.equal(await readFile(destination, 'utf8'), '{"last_good":true}');
  } finally {await rm(root, {recursive: true, force: true});}
});
