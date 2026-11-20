// Retrospective event-order component evaluation, NOT as-of-vintage backtesting.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {defensiveContext, matchupFactor, scoreDefense, defenseProjection} from '../docs/ranking-model.mjs';
import {scoreValueStats} from '../docs/player-values.mjs';

const games = JSON.parse(await readFile(process.argv[2], 'utf8'));
const season = Number(process.argv[3] || 2025);
const settings = {ppr: 'Half PPR', tePremium: 'None'};
const errors = Object.fromEntries(['QB', 'RB', 'WR', 'TE', 'DST'].map(pos => [pos, {n: 0, baseline: 0, model: 0}]));
// Freeze the information set before each NFL week, including Thursday results.
for (let week = 1; week <= 18; week++) {
  const targets = games.filter(game => game.season === season && game.week === week);
  if (!targets.length) continue;
  const cutoff = Math.min(...targets.map(game => Date.parse(game.kickoff)));
  const context = defensiveContext({season, defense: {games}}, settings, cutoff);
  for (const game of targets) for (const row of game.teams) {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const actual = scoreValueStats({...row.allowed[pos], pos}, settings).points;
      const baseline = context.league[pos]?.value;
      if (actual === null || !Number.isFinite(baseline)) continue;
      const predicted = baseline * matchupFactor(context, row.team, pos).factor;
      errors[pos].n++; errors[pos].baseline += Math.abs(actual - baseline); errors[pos].model += Math.abs(actual - predicted);
    }
    const actual = scoreDefense(row), neutral = defenseProjection(context, row.team), matchup = defenseProjection(context, row.team, row.opponent);
    if ([actual, neutral, matchup].every(Number.isFinite)) {
      errors.DST.n++; errors.DST.baseline += Math.abs(actual - neutral); errors.DST.model += Math.abs(actual - matchup);
    }
  }
}
const results = Object.fromEntries(Object.entries(errors).map(([pos, value]) => [pos, {observations: value.n,
  baseline_mae: value.n ? value.baseline / value.n : null, model_mae: value.n ? value.model / value.n : null,
  improvement_pct: value.baseline ? 100 * (value.baseline - value.model) / value.baseline : null}]));
const report = {evaluated_at: new Date().toISOString(), season, settings, results,
  scope: 'Defensive component only: position-total points allowed vs league average; D/ST matchup vs team-only forecast. Not an evaluation of individual player rankings or draft accuracy.',
  limitations: 'Current corrected archives, not original publication vintages. All target-week games excluded from evidence. Fixed parameters, no fitting on evaluation season. MAE is average absolute point error; lower is better.'};
console.log(JSON.stringify(report, null, 2));
if (process.argv[4]) await writeFile(resolve(process.argv[4]), JSON.stringify(report, null, 2) + '\n');
