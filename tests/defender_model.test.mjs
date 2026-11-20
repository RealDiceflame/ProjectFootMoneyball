import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defenderContext, projectDefenders, personnelDefenseProjection, combineDefenseForecasts, DEFENDER_EVENTS} from '../docs/defender-model.mjs';
import {buildRankingBoard} from '../docs/ranking-model.mjs';

const now = Date.parse('2026-11-20T16:00:00Z');
const columns = ['player_id', 'player', 'pos', 'team', 'defense_snaps', ...Object.keys(DEFENDER_EVENTS)];
function fixture() {
  const reports = {}, positions = ['DE', 'DE', 'DT', 'DE', 'DT', 'LB', 'LB', 'LB', 'CB', 'CB', 'S', 'S'];
  const rows = positions.map((pos, i) => {
    reports[`id${i}`] = {player_id: `id${i}`, player: `Defender ${i}`, team: 'BUF', pos, status: 'ACT', roster_week: 11, injury: null};
    return [`id${i}`, `Defender ${i}`, pos, 'BUF', i === 0 ? 40 : i === 1 ? 20 : 60, i === 0 ? 3 : 0, 0, 0, 0];
  });
  const games = [1, 2, 3].map(week => ({game_id: `past${week}`, season: 2026, week,
    kickoff: `2026-11-${week + 10}T18:00:00Z`, teams: [{team: 'BUF', defender_snap_total: 660, rows}, {team: 'NYJ', defender_snap_total: 660, rows: rows.map(row => [null, row[1], row[2], 'NYJ', ...row.slice(4).map((v, i) => i === 0 ? v : 0)])}]}));
  return {season: 2026, defense: {games, personnel: {schema_version: 1, columns, games, coverage: {missing_snap_game_ids: []},
    status: {schema_version: 1, season: 2026, generated_at: '2026-11-20T15:00:00Z', reports,
      injury_context: {season: 2026, expected_week: 11, status: 'current', teams: ['BUF', 'NYJ'], valid_from: '2026-11-17T00:00:00Z', valid_until: '2026-11-24T00:00:00Z'}}}}};
}
const game = {week: 11}, later = {week: 12};
const allEvents = {...Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, 1])), def_safeties: .1, def_punt_blocks: .1, def_pat_blocks: .1, def_fg_blocks: .1, special_teams_tds: .1, def_2pt_made: .1};
const teams = {teams: {BUF: {events: allEvents, conceded: {sacks_suffered: 2, passing_interceptions: 1, fumbles_lost_total: 1}, allowed_score: 1}, NYJ: {events: allEvents, conceded: {sacks_suffered: 2, passing_interceptions: 1, fumbles_lost_total: 1}, offense_score: 1}}};
const forecast = (inputs, match = game) => personnelDefenseProjection(teams, defenderContext(inputs, now), 'BUF', 'NYJ', match, 15);
const sum = values => values.reduce((a, b) => a + b, 0);

test('individual production changes the healthy team forecast, with exact component reconciliation', () => {
  const data = fixture(), base = forecast(data);
  for (const match of data.defense.personnel.games) match.teams[0].rows[0][5] = 0;
  assert.ok(base.points > forecast(data).points);
  assert.ok(Math.abs(base.points - sum(Object.values(base.components))) < 1e-9);
  assert.ok(Math.abs(base.components.named_defenders - sum(base.contributors.map(row => row.points))) < 1e-9);
  assert.ok(base.contributors.find(row => row.player_id === 'id0').points > base.contributors.find(row => row.player_id === 'id1').points);
});

test('current Out reallocates workload, respects per-player caps, and affects only matching week', () => {
  const data = fixture(), base = forecast(data);
  data.defense.personnel.status.reports.id0.injury = {season: 2026, week: 11, report_status: 'Out'};
  const out = forecast(data), future = forecast(data, later);
  assert.equal(out.contributors.find(row => row.player_id === 'id0').snaps, 0);
  assert.ok(out.contributors.find(row => row.player_id === 'id1').snaps > base.contributors.find(row => row.player_id === 'id1').snaps);
  assert.ok(out.points < base.points);
  assert.equal(future.points, base.points);
  assert.ok(out.contributors.every(row => row.snaps <= out.estimated_team_plays + 1e-9));
  assert.ok(Math.abs(sum([...out.contributors, ...out.replacements].map(row => row.snaps)) - out.defender_snap_total) < 1e-8);
});

test('missing replacement identity becomes an explicit replacement, never disappearing workload', () => {
  const data = fixture(); delete data.defense.personnel.status.reports.id0; delete data.defense.personnel.status.reports.id1;
  const value = forecast(data);
  assert.ok(value.replacements.some(row => row.group === 'DL' && row.snaps > 0));
  assert.ok(Math.abs(sum([...value.contributors, ...value.replacements].map(row => row.snaps)) - 660) < 1e-8);
});

test('old, future and mismatched injury reports do not establish an absence', () => {
  for (const injury of [{season: 2026, week: 10, report_status: 'Out'}, {season: 2026, week: 12, report_status: 'Out'}, {season: 2025, week: 11, report_status: 'Out'}, {season: 2026, week: 11, report_status: 'Questionable'}, null]) {
    const data = fixture(); data.defense.personnel.status.reports.id0.injury = injury;
    assert.ok(forecast(data).contributors.find(row => row.player_id === 'id0').snaps > 0);
  }
});

test('a fresh transfer moves a defender to one roster only and carries his individual history', () => {
  const data = fixture(); data.defense.personnel.status.reports.id0.team = 'NYJ';
  const context = defenderContext(data, now), oldTeam = projectDefenders(context, 'BUF', game), newTeam = projectDefenders(context, 'NYJ', game);
  assert.ok(!oldTeam.contributors.some(row => row.player_id === 'id0'));
  assert.equal(newTeam.contributors.filter(row => row.player_id === 'id0').length, 1);
  assert.match(newTeam.contributors[0].role_basis, /Transferred/);
});

test('stale/future rosters fall back honestly; reserve status is not an invented return date', () => {
  for (const time of ['2026-11-17T00:00:00Z', '2026-11-21T00:00:00Z']) {
    const data = fixture(); data.defense.personnel.status.generated_at = time;
    const value = forecast(data); assert.equal(value.mode, 'team_fallback'); assert.equal(value.points, 15); assert.deepEqual(value.contributors, []);
  }
  const data = fixture(); data.defense.personnel.status.reports.id0.status = 'RES';
  assert.equal(forecast(data).contributors.find(row => row.player_id === 'id0').snaps, 0);
  assert.ok(forecast(data, later).contributors.find(row => row.player_id === 'id0').snaps > 0);
});

test('future games and participation without a matching box cannot enter the player rates', () => {
  const data = fixture(), base = forecast(data), extra = structuredClone(data.defense.personnel.games[0]);
  extra.game_id = 'future'; extra.kickoff = '2026-11-21T18:00:00Z'; extra.teams[0].rows[0][5] = 10000;
  data.defense.personnel.games.push(extra);
  assert.equal(forecast(data).points, base.points);
  extra.kickoff = '2026-11-19T18:00:00Z';
  data.defense.games = data.defense.games.filter(game => game.game_id !== 'future');
  assert.equal(forecast(data).points, base.points);
});

test('null event samples do not become zero production and horizon aggregation reconciles', () => {
  const data = fixture(); for (const match of data.defense.personnel.games) match.teams[0].rows[0][5] = null;
  const missing = forecast(data), zeroData = fixture();
  for (const match of zeroData.defense.personnel.games) match.teams[0].rows[0][5] = 0;
  // Add a nonzero cohort so a missing observation is measurably different from zero.
  for (const inputs of [data, zeroData]) for (const match of inputs.defense.personnel.games) match.teams[0].rows[2][5] = 2;
  assert.notEqual(forecast(data).points, forecast(zeroData).points);
  const joined = combineDefenseForecasts([missing, missing]);
  assert.equal(joined.points, missing.points * 2);
  assert.ok(Math.abs(sum(joined.contributors.map(row => row.points)) - joined.components.named_defenders) < 1e-9);
});

test('real archive produces bounded, reconciled player-driven forecasts for all 32 teams', () => {
  const data = Object.fromEntries(Object.entries({rankings: 'rankings', history: 'player_history', news: 'player_news', inputs: 'ranking_inputs'})
    .map(([key, file]) => [key, JSON.parse(readFileSync(new URL(`../docs/data/${file}.json`, import.meta.url)))]));
  const asOf = Date.parse(data.inputs.generated_at) + 1000;
  const board = buildRankingBoard(data, {defenses: 'Include', ppr: 'Half PPR'}, {now: asOf, horizon: 'ros'});
  const defenses = board.rows.filter(row => row.pos === 'DST'); assert.equal(defenses.length, 32);
  for (const row of defenses) {
    assert.equal(row.defense_breakdown.mode, 'player_based');
    assert.ok(row.defense_breakdown.contributors.length > 10);
    assert.ok(Math.abs(row.projected_points - sum(Object.values(row.defense_breakdown.components))) < .06);
    for (const match of row.forecast_games) {
      assert.ok(match.breakdown.contributors.every(person => person.snaps >= 0 && person.snaps <= match.breakdown.estimated_team_plays + 1e-8));
      assert.ok(Math.abs(sum([...match.breakdown.contributors, ...match.breakdown.replacements].map(person => person.snaps)) - match.breakdown.defender_snap_total) < 1e-7);
    }
  }
});
