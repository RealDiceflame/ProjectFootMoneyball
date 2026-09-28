import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildValueBoard, scoreValueStats, valueFormatKey} from '../docs/player-values.mjs';

const now = Date.parse('2026-09-28T12:00:00Z');
const stats = {passing_yards: 0, passing_tds: 0, passing_interceptions: 0, rushing_yards: 0,
  rushing_tds: 0, receptions: 0, receiving_yards: 0, receiving_tds: 0, fumbles_lost_total: 0,
  passing_2pt_conversions: 0, rushing_2pt_conversions: 0, receiving_2pt_conversions: 0, special_teams_tds: 0,
  targets: 0, carries: 0};
const game = (week, kickoff, home = 'BUF', away = 'KC') => ({game_id: `2026_${String(week).padStart(2, '0')}_${away}_${home}`,
  week, kickoff, home, away, analysis_ready: Date.parse(kickoff) < now});
const past = game(3, '2026-09-27T17:00:00Z'), future = game(4, '2026-10-04T17:00:00Z');
const player = {player_id: '00-0000001', player: 'Test Player', pos: 'QB', team: 'BUF'};
const pack = rows => {const columns = [...new Set(rows.flatMap(Object.keys))]; return {columns, rows: rows.map(row => columns.map(key => row[key] ?? null))};};
function fixture({observed = [{...stats, ...player, ...past, passing_yards: 250, passing_tds: 2}], historical = [], players = [player], games = [past, future], news = {}} = {}) {
  const ranked = pack(players), input = pack(observed);
  const seasonRows = pack(historical);
  return {rankings: {columns: ranked.columns, boards: {[valueFormatKey()]: ranked.rows}},
    inputs: {schema_version: 1, season: 2026, season_type: 'REG', ...input, games, coverage: {}},
    history: {columns: seasonRows.columns, players: {[`id:${player.player_id}`]: {...player, seasons: seasonRows.rows}}}, news};
}
const build = (data = fixture(), settings = {}) => buildValueBoard(data, settings, {now});
const report = status => ({season: 2026, generated_at: '2026-09-28T10:00:00Z',
  injury_context: {season: 2026, expected_week: 4, valid_from: '2026-09-28T00:00:00Z', valid_until: '2026-10-06T00:00:00Z', teams: ['BUF'], status: 'current'},
  reports: {test: {...player, current_team: 'BUF', injury: {season: 2026, week: 4, report_status: status}}}});

test('scoring uses lost fumbles and all conversions; missing is distinct from zero', () => {
  assert.equal(scoreValueStats({...stats, ...player, fumbles_total: 10}).points, 0);
  assert.equal(scoreValueStats({...stats, fumbles_lost_total: 1}).points, -2);
  assert.equal(scoreValueStats({...stats, passing_2pt_conversions: 1, rushing_2pt_conversions: 1, receiving_2pt_conversions: 1, special_teams_tds: 1}).points, 12);
  assert.equal(scoreValueStats({...stats, passing_yards: null}).points, null);
  for (const invalid of [true, [], '10', {}]) assert.equal(scoreValueStats({...stats, receptions: invalid}).points, null);
  assert.equal(scoreValueStats({...stats, fumbles_lost_total: null}).points, null);
  assert.deepEqual(scoreValueStats({...stats, fumbles_lost_total: null}, {}, {allowLegacy: true}), {points: 0, complete: false});
  assert.equal(scoreValueStats({...stats, pos: 'TE', receptions: 10}, {ppr: 'Full PPR', tePremium: '+0.5'}).points, 15);
});

test('observations count credited appearances, not elapsed weeks or missing rows', () => {
  const rows = [{...stats, ...player, ...past, passing_yards: 250, passing_tds: 2},
    {...stats, ...player, ...past, passing_yards: 300, passing_tds: 2}];
  const data = fixture({observed: rows});
  const row = build(data).rows[0];
  assert.equal(row.appearances, 1); assert.equal(row.current_ppg, 20);
  const missing = build(fixture({observed: []})).rows[0];
  assert.equal(missing.current_ppg, null); assert.equal(missing.ros_index, null);
  const zero = build(fixture({observed: [{...stats, ...player, ...past}]})).rows[0];
  assert.equal(zero.current_ppg, 0); assert.equal(zero.ros_index, 0);
});

test('current and future seasons never leak into the prior; distant rows are not promoted', () => {
  const historical = [2026, 2027, 2022].map(season => ({...stats, season, games: 17, passing_yards: 9000}));
  const row = build(fixture({historical})).rows[0];
  assert.equal(row.prior_ppg, null); assert.equal(row.projected_ppg, 18);
  historical.push({...stats, season: 2025, games: 10, passing_yards: 2500});
  const blended = build(fixture({historical})).rows[0];
  assert.equal(blended.prior_ppg, 10); assert.equal(blended.projected_ppg, 10.89);
  assert.deepEqual(blended.prior_seasons, [2025]);
});

test('only current Out excludes exactly its matching unstarted game', () => {
  const games = [past, future, game(5, '2026-10-11T17:00:00Z')];
  const out = build(fixture({games, news: report('Out')})).rows[0];
  assert.equal(out.remaining_games, 2); assert.equal(out.available_games, 1);
  assert.deepEqual(out.excluded_game_ids, [future.game_id]); assert.equal(out.projected_ppg, 18);
  for (const status of ['Questionable', 'Probable', 'Doubtful', 'IR']) {
    const row = build(fixture({games, news: report(status)})).rows[0];
    assert.equal(row.available_games, 2, status); assert.equal(row.ros_points, 36);
  }
  const stale = report('Out'); stale.generated_at = '2026-09-01T00:00:00Z';
  assert.equal(build(fixture({games, news: stale})).rows[0].available_games, 2);
  const wrongWeek = report('Out'); wrongWeek.reports.test.injury.week = 3;
  assert.equal(build(fixture({games, news: wrongWeek})).rows[0].available_games, 2);
});

test('stable IDs reject same-name conflicting injury records and preserve team transfer', () => {
  const news = report('Out'); news.reports.test.player_id = '00-0000002';
  assert.equal(build(fixture({news})).rows[0].available_games, 1);
  news.reports.test.player_id = player.player_id; news.reports.test.current_team = 'NYJ';
  news.injury_context.teams = ['NYJ']; news.reports.test.injury.report_status = 'Questionable';
  const moved = build(fixture({news, games: [past, future, game(6, '2026-10-18T17:00:00Z', 'NYJ', 'DAL')]})).rows[0];
  assert.equal(moved.team, 'NYJ'); assert.equal(moved.remaining_games, 1); assert.equal(moved.appearances, 1);
});

test('byes, started, postseason, canceled and wrong-season games are not remaining fixtures', () => {
  const games = [past, future, {...future, game_id: '2027_04_KC_BUF', season: 2027},
    {...future, game_id: '2026_19_KC_BUF', week: 19, season_type: 'POST'},
    {...future, game_id: '2026_05_KC_BUF', week: 5, status: 'postponed'},
    game(6, '2026-10-18T17:00:00Z', 'NYJ', 'DAL')];
  assert.equal(build(fixture({games})).rows[0].remaining_games, 1);
  const unready = fixture(); unready.inputs.games[0] = {...past, analysis_ready: false};
  assert.equal(build(unready).rows[0].appearances, 0);
});

test('dynasty includes ROS once and exactly two discounted playing scenarios', () => {
  const row = build().rows[0];
  assert.equal(row.age, null); assert.deepEqual(row.future_year_points, [306, 306]);
  assert.equal(row.dynasty_points, Number((18 + .85 * 306 + .85 ** 2 * 306).toFixed(2)));
  assert.equal(build(fixture(), {quarterbacks: '2QB'}).replacement.QB.depth, 25);
  assert.equal(build().replacement.QB.depth, 13);
  assert.equal(valueFormatKey({quarterbacks: '2QB', ppr: 'Full PPR', tePremium: '+0.5'}), '12team_2qb_te_premium_full_ppr');
});

test('age transitions consume scored rates and remain finite', () => {
  const data = fixture({historical: [{...stats, season: 2024, games: 17, passing_yards: 4000}, {...stats, season: 2025, games: 17, passing_yards: 3000}]});
  data.history.players[`id:${player.player_id}`].birth_date = '1998-01-01';
  const row = build(data).rows[0];
  assert.ok(Number.isFinite(row.prior_ppg)); assert.ok(Number.isFinite(row.dynasty_points));
  assert.ok(row.prior_ppg < 8.83); assert.ok(row.age_samples.every(Number.isFinite));
});

test('real published inputs produce finite values, honest coverage, and a top index', () => {
  const read = file => JSON.parse(readFileSync(new URL(`../docs/data/${file}.json`, import.meta.url), 'utf8'));
  const inputs = read('player_value_inputs');
  const bundles = {inputs, rankings: read('rankings'), history: read('player_history'), news: read('player_news')};
  const board = buildValueBoard(bundles, {}, {now: Math.max(now, ...Object.values(bundles).map(bundle => Date.parse(bundle.generated_at)))});
  assert.ok(board.rows.length > 300); assert.ok(board.rows.filter(row => row.dynasty_index !== null).length > 300);
  const positiveSurplus = board.rows.some(row => row.ros_surplus > 0);
  assert.equal(Math.max(...board.rows.map(row => row.ros_index ?? 0)), positiveSurplus ? 10000 : 0);
  assert.ok(board.rows.every(row => row.projected_ppg === null || Number.isFinite(row.projected_ppg)));
  assert.ok(Object.values(board.replacement).every(item => !item.limited));
});

test('malformed ready flags, mismatched game identities and future evidence fail closed', () => {
  const input = fixture();
  const column = input.inputs.columns.indexOf('analysis_ready');
  input.inputs.rows[0][column] = 'true';
  assert.equal(build(input).rows[0].appearances, 0);
  const mismatch = fixture(); mismatch.inputs.games[0] = {...past, week: 1};
  assert.equal(build(mismatch).rows[0].appearances, 0);
  const newerHistory = fixture(); newerHistory.history.generated_at = '2026-10-01T00:00:00Z';
  assert.throws(() => build(newerHistory), /after the model timestamp/);
});
