import {readFile, writeFile, rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareSimulation, runMatchup, SIMULATION_VERSION} from '../docs/matchup-simulation.mjs';

const root = resolve(import.meta.dirname || new URL('..', import.meta.url).pathname, '..');
const read = async name => JSON.parse(await readFile(resolve(root, `docs/data/${name}.json`), 'utf8'));
const inputs = await read('simulation_inputs'), rankings = await read('ranking_inputs');
const now = Date.now(), prepared = prepareSimulation(inputs, rankings, {now});
const iterations = Number(process.env.SIMULATION_ITERATIONS || 200);
const round = n => Math.round(n * 10000) / 10000;
const compact = result => ({
  players: result.players.filter(p => ['QB','RB','WR','TE','K'].includes(p.pos) && !p.player_id.startsWith('UNASSIGNED:')).map(p => ({
    player_id: p.player_id, player: p.player, pos: p.pos, team: p.team, role_basis: p.role_basis || 'Recent observed opportunities', out: p.out || false,
    stats: Object.fromEntries(Object.entries(p.stats).map(([k,v]) => [k, round(v)]))})),
  defenses: Object.fromEntries(Object.entries(result.teams).map(([team, row]) => [team, round(row.fantasy.mean)])),
  unassigned_points: round(result.players.filter(p => p.player_id.startsWith('UNASSIGNED:')).reduce((sum,p) => sum + (p.fantasy?.mean || 0), 0)),
});
const games = [], draft = new Map();
function addDraft(row, points = null) {
  if (!draft.has(row.player_id)) draft.set(row.player_id, {...row, stats: {}, points: points === null ? null : 0, games: 0});
  const target = draft.get(row.player_id); target.games++;
  if (points !== null) target.points += points;
  else for (const [key, value] of Object.entries(row.stats)) target.stats[key] = (target.stats[key] || 0) + value;
}
for (const [index, game] of inputs.games.entries()) {
  // Full-season draft is a current-roster scenario over the schedule, never
  // past actual points plus future forecasts or leaked historical weather.
  const full = compact(runMatchup(prepared, {...game, weather: null}, {iterations, seed: `draft:${game.game_id}`, draftScenario: true}));
  full.players.forEach(row => addDraft(row));
  for (const [team, points] of Object.entries(full.defenses)) addDraft({player_id: `DST:${team}`, player: `${team} D/ST`, team, pos: 'DST'}, points);
  if (Date.parse(game.kickoff) > now) {
    const result = compact(runMatchup(prepared, game, {iterations, seed: `forecast:${game.game_id}`}));
    games.push({...game, ...result});
  }
  if (index % 32 === 0) console.log(`Simulated ${index + 1}/${inputs.games.length} fixtures`);
}
if (inputs.games.length !== 272 || draft.size < 400 || [...draft.values()].filter(p => p.pos === 'DST' && p.games === 17).length !== 32)
  throw new Error('Incomplete simulation publication; keeping the previous snapshot.');
const payload = {schema_version: 1, model_version: SIMULATION_VERSION, season: inputs.season, generated_at: new Date(now).toISOString(),
  evidence_generated_at: inputs.generated_at, evidence_sha256: createHash('sha256').update(await readFile(resolve(root, 'docs/data/simulation_inputs.json'))).digest('hex'),
  iterations, games, draft: [...draft.values()], coverage: inputs.coverage, license_url: inputs.license_url, attribution: inputs.attribution,
  notes: ['Experimental simulated means; forecast accuracy has not been established.', 'Full-season means use current roles in 17 schedule games with neutral weather and conditional availability.',
    'Weekly and ROS include only unstarted games. No future injury return dates are invented.', 'Kickers: 3 per field goal, 1 per extra point. D/ST: OB full-scoreboard scoring.',
    'Unknown offensive roles remain unrated. Unassigned production stays outside named-player rankings.']};
payload.stat_columns = ['passing_yards','passing_tds','passing_interceptions','rushing_yards','rushing_tds','receptions','receiving_yards','receiving_tds','fumbles_lost_total','passing_2pt_conversions','rushing_2pt_conversions','receiving_2pt_conversions','special_teams_tds','field_goals','extra_points'];
for (const row of [...payload.draft, ...payload.games.flatMap(game => game.players)]) if (row.pos !== 'DST')
  row.stats = payload.stat_columns.map(key => round(row.stats[key]));
const path = resolve(root, 'docs/data/simulation_forecasts.json');
await writeFile(`${path}.tmp`, JSON.stringify(payload) + '\n'); await rename(`${path}.tmp`, path);
console.log(JSON.stringify({games: games.length, draft_players: draft.size, iterations}));
