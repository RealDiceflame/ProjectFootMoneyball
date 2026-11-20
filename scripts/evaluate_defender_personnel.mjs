import {readFileSync, writeFileSync} from 'node:fs';
import {defensiveContext, defenseProjection, scoreDefense} from '../docs/ranking-model.mjs';
import {defenderContext, personnelDefenseProjection} from '../docs/defender-model.mjs';
const inputs = JSON.parse(readFileSync(new URL('../docs/data/ranking_inputs.json', import.meta.url)));
const rows = [], columns = inputs.defense.personnel.columns;
for (const week of [...new Set(inputs.defense.games.filter(game => game.season === inputs.season).map(game => game.week))].sort((a,b)=>a-b)) {
  const targets = inputs.defense.games.filter(game => game.season === inputs.season && game.week === week);
  const cutoff = Math.min(...targets.map(game => Date.parse(game.kickoff))) - 1;
  const reports = {};
  for (const game of inputs.defense.personnel.games.filter(game => Date.parse(game.kickoff) < cutoff).sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff))) for (const team of game.teams) for (const values of team.rows) {
    const row = Object.fromEntries(columns.map((key,i)=>[key,values[i]]));
    if (row.player_id) reports[row.player_id] = {player_id: row.player_id, player: row.player, pos: row.pos, team: row.team, status: 'ACT', roster_week: week, injury: null};
  }
  const evidence = {...inputs, defense: {...inputs.defense, personnel: {...inputs.defense.personnel, status: {
    schema_version: 1, season: inputs.season, generated_at: new Date(cutoff).toISOString(), reports,
    injury_context: {season: inputs.season, expected_week: week, status: 'unavailable'}}}}};
  const context = defensiveContext(evidence, {}, cutoff), personnel = defenderContext(evidence, cutoff);
  for (const game of targets) for (const team of game.teams) {
    const actual = scoreDefense(team), previous = defenseProjection(context, team.team, team.opponent);
    const forecast = personnelDefenseProjection(context, personnel, team.team, team.opponent, game, previous);
    if (actual !== null && previous !== null && forecast.mode === 'player_based') rows.push({week, game_id: game.game_id, team: team.team, actual, previous, personnel: forecast.points});
  }
}
const summarize = data => ({team_games: data.length, previous_mae: data.reduce((s,r)=>s+Math.abs(r.previous-r.actual),0)/data.length,
  personnel_mae: data.reduce((s,r)=>s+Math.abs(r.personnel-r.actual),0)/data.length,
  previous_bias: data.reduce((s,r)=>s+r.previous-r.actual,0)/data.length, personnel_bias: data.reduce((s,r)=>s+r.personnel-r.actual,0)/data.length});
const report = {description: 'Untuned retrospective diagnostic. Each week freezes game evidence before its earliest kickoff. Rosters are inferred only from preceding observed participation; no actual as-of injury/roster feeds are available. Corrected archives are not original vintages. This is not a validation of availability accuracy or a basis for parameter selection.',
  all: summarize(rows), first_five_weeks: summarize(rows.filter(r=>r.week<=5)), later_weeks: summarize(rows.filter(r=>r.week>5)), rows};
writeFileSync(new URL('../documentation/defender-evaluation-2026.json', import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,rows:undefined},null,2));
