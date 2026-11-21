import {bestLineup} from './draft-calculator.mjs?v=20261121-draft1';

export const TRADE_VERSION = 'projection-trade-v1';
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const sum = values => values.reduce((a, b) => a + b, 0);
const round = value => Math.round(value * 100) / 100;
const unique = values => [...new Set(Array.isArray(values) ? values.filter(id => typeof id === 'string') : [])];

export function tradeSlots(raw = {}) {
  const defaults = {QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, SF: 0}, slots = {};
  for (const [pos, fallback] of Object.entries(defaults)) {
    const value = raw[pos] === undefined ? fallback : Number(raw[pos]);
    if (!Number.isInteger(value) || value < 0 || value > 4) throw Error('Starting slots must be whole numbers from 0 to 4.');
    slots[pos] = value;
  }
  if (sum(Object.values(slots)) < 1 || sum(Object.values(slots)) > 16) throw Error('Choose between 1 and 16 starting slots.');
  return slots;
}

function lineupTotal(roster, horizon, slots, weeks) {
  if (horizon !== 'ros') return bestLineup(roster.map(p => ({...p, projected_points: p[`${horizon}_points`]})), slots).points;
  // Pick the best eligible lineup each week; a known player's bye/out game adds no points.
  return sum(weeks.map(week => bestLineup(roster.map(p => ({...p, projected_points:
    sum((p.forecast_games || []).filter(g => g.week === week).map(g => g.points))})), slots).points));
}

export function compareTrade(board, input = {}) {
  const horizon = ['ros', 'draft', 'dynasty'].includes(input.horizon) ? input.horizon : 'ros';
  const byId = new Map(board.rows.filter(p => POSITIONS.includes(p.pos)).map(p => [p.player_id, p]));
  const ids = Object.fromEntries(['give', 'receive', 'retained', 'drops', 'adds'].map(key => [key, unique(input[key])]));
  const issues = [];
  if (ids.give.length > 8 || ids.receive.length > 8) issues.push('Compare up to eight players on each side.');
  if (ids.give.some(id => ids.receive.includes(id))) issues.push('A player cannot be on both sides of a trade.');
  const resolve = list => list.map(id => byId.get(id) || {player_id: id, player: 'Player unavailable in this season', pos: '?'});
  const packageFor = list => {
    const players = resolve(list), rated = players.every(p => Number.isFinite(p[`${horizon}_points`]) && Number.isFinite(p[`${horizon}_surplus`]));
    return {players, count: players.length, rated, points: rated ? round(sum(players.map(p => p[`${horizon}_points`]))) : null,
      surplus: rated ? round(sum(players.map(p => p[`${horizon}_surplus`]))) : null};
  };
  const give = packageFor(ids.give), receive = packageFor(ids.receive);
  if (!give.count || !receive.count) issues.push('Add at least one player to each side.');
  if (!give.rated || !receive.rated) issues.push('A selected player has no rated projection. No package advantage is calculated.');
  const result = {version: TRADE_VERSION, horizon, give, receive, issues,
    edge: issues.length ? null : round(receive.surplus - give.surplus), extra_roster_spots: receive.count - give.count, roster: null};
  if (!input.rosterComplete) return result;

  const rosterIssues = [...issues], slots = tradeSlots(input.slots), bench = Number(input.bench ?? 6);
  if (!Number.isInteger(bench) || bench < 0 || bench > 20) throw Error('Bench spots must be a whole number from 0 to 20.');
  const capacity = sum(Object.values(slots)) + bench;
  if (ids.retained.some(id => ids.give.includes(id) || ids.receive.includes(id))) rosterIssues.push('Other roster players cannot also be in the trade.');
  const beforeIds = unique([...ids.give, ...ids.retained]), incomingIds = unique([...ids.retained, ...ids.receive]);
  if (ids.drops.some(id => !incomingIds.includes(id))) rosterIssues.push('Choose drops from players you would hold after the trade.');
  if (ids.adds.some(id => beforeIds.includes(id) || incomingIds.includes(id))) rosterIssues.push('An available-player addition cannot already be on your roster or in this trade.');
  const afterIds = unique([...incomingIds.filter(id => !ids.drops.includes(id)), ...ids.adds]);
  const before = resolve(beforeIds), after = resolve(afterIds);
  if (before.length > capacity) rosterIssues.push(`Your current roster exceeds the ${capacity}-player limit. Check the lineup, bench, and player list.`);
  if (after.length > capacity) rosterIssues.push(`Choose ${after.length - capacity} more drop${after.length - capacity === 1 ? '' : 's'} or increase your roster limit.`);
  const known = [...before, ...after].every(p => Number.isFinite(p[`${horizon}_points`]) && (horizon !== 'ros' || Array.isArray(p.forecast_games) && p.forecast_games.every(g => Number.isInteger(g.week) && Number.isFinite(g.points))));
  if (!known) rosterIssues.push('A roster player has unknown projections. No lineup gain is calculated.');
  const weeks = [...new Set([...before, ...after].flatMap(p => (p.forecast_games || []).map(g => g.week)))].sort((a, b) => a - b);
  const beforePoints = rosterIssues.length ? null : round(lineupTotal(before, horizon, slots, weeks));
  const afterPoints = rosterIssues.length ? null : round(lineupTotal(after, horizon, slots, weeks));
  result.roster = {issues: rosterIssues, before, after, capacity, slots, bench, weeks,
    open_spots: Math.max(0, capacity - after.length), before_points: beforePoints, after_points: afterPoints,
    gain: beforePoints === null ? null : round(afterPoints - beforePoints)};
  return result;
}
