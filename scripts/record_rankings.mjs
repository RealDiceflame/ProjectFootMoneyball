import {readFile, writeFile, rename} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildRankingBoard, RANKING_MODEL_VERSION} from '../docs/ranking-model.mjs';
import {applyProjectionModel} from '../docs/projection-model.mjs';
import {valueFormatKey} from '../docs/player-values.mjs';

export async function recordRankings(root, {now = Date.now()} = {}) {
  const data = {}, evidence = {};
  for (const [key, name] of Object.entries({rankings: 'rankings', history: 'player_history', news: 'player_news', inputs: 'ranking_inputs'})) {
    const content = await readFile(resolve(root, `docs/data/${name}.json`), 'utf8');
    data[key] = JSON.parse(content);
    evidence[key] = {path: `data/${name}.json`, generated_at: data[key].generated_at, sha256: createHash('sha256').update(content).digest('hex')};
  }
  const payload = {schema_version: 1, model_version: RANKING_MODEL_VERSION, season: data.inputs.season,
    generated_at: new Date(now).toISOString(), evidence, coverage: data.inputs.defense.coverage,
    source_health: {archive_checked_at: data.inputs.sources?.archive?.checked_at || null,
      schedule_checked_at: data.inputs.sources?.scores?.checked_at || null,
      pending_stats_game_ids: data.inputs.coverage?.pending_stats_game_ids || []}, formats: {}};
  for (const quarterbacks of ['1QB', '2QB']) for (const ppr of ['Standard', 'Half PPR', 'Full PPR']) for (const tePremium of ['None', '+0.5']) {
    const settings = {teams: 12, quarterbacks, ppr, tePremium, defenses: 'Include'};
    const ranked = Object.values(data.rankings.boards)[0].map(values => Object.fromEntries(data.rankings.columns.map((key, i) => [key, values[i]])));
    const draftRows = applyProjectionModel(ranked, data.history, data.news, settings, data.inputs.season).rows;
    const horizons = {};
    for (const horizon of ['draft', 'weekly', 'ros']) {
      const board = buildRankingBoard(data, settings, {now, horizon, draftRows});
      if (!board.rows.some(row => Number.isFinite(row.projected_points)) || board.rows.filter(row => row.pos === 'DST' && Number.isFinite(row.projected_points)).length !== 32)
        throw new Error('Incomplete player or defense forecasts; retaining the previous publication.');
      const columns = ['player_id', 'player', 'pos', 'team', 'overall_rank', 'position_rank', 'projected_points', 'projected_ppg', 'vorp', 'opponent', 'matchup_pct', 'eligible'];
      horizons[horizon] = {week: horizon === 'weekly' ? board.week : null, columns, rows: board.rows.map(row => columns.map(key => row[key] ?? null))};
    }
    payload.formats[valueFormatKey(settings)] = {settings, horizons};
  }
  const path = resolve(root, 'docs/data/ranking_forecasts.json');
  await writeFile(`${path}.tmp`, JSON.stringify(payload) + '\n');
  await rename(`${path}.tmp`, path);
  return {formats: Object.keys(payload.formats).length, horizons: 3, ...payload.coverage};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  recordRankings(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    .then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error); process.exitCode = 1;});
}
