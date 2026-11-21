import {scoreFantasyStats} from './fantasy-scoring.mjs?v=20261030-scoring1';
export function validateSimulationForecasts(value) {
  return value?.schema_version === 1 && value.model_version === 'matchup-simulation-v1' && Number.isFinite(Date.parse(value.generated_at))
    && Array.isArray(value.draft) && value.draft.length > 400 && Array.isArray(value.games)
    && value.games.every(game => Number.isFinite(Date.parse(game.kickoff)) && Array.isArray(game.players) && game.defenses);
}
const finite = Number.isFinite, round = n => finite(n) ? Math.round(n * 100) / 100 : null;
export function buildSimulationBoard(bundle, baseRows, settings, {horizon = 'draft', week = null, now = Date.now()} = {}) {
  if (!validateSimulationForecasts(bundle) || Date.parse(bundle.generated_at) > now + 300000) return {rows: [], week, unavailable: true};
  const future = bundle.games.filter(game => Date.parse(game.kickoff) > now), selectedWeek = week || Math.min(...future.map(game => game.week));
  const selected = horizon === 'weekly' ? future.filter(game => game.week === selectedWeek) : future;
  const base = new Map(baseRows.filter(p => p.player_id).map(p => [p.player_id, p])), rows = new Map();
  function add(person, game = null, defensePoints = null) {
    if (person.pos === 'DST' && settings.defenses !== 'Include' || person.pos === 'K' && settings.kickers !== 'Include') return;
    const known = person.pos === 'DST' || person.role_basis !== 'No recent role evidence';
    const stats = Array.isArray(person.stats) ? Object.fromEntries(bundle.stat_columns.map((key,i)=>[key,person.stats[i]])) : person.stats;
    const points = person.pos === 'DST' ? (defensePoints ?? person.points) : person.pos === 'K'
      ? stats.field_goals * 3 + stats.extra_points : scoreFantasyStats({...stats, pos: person.pos}, settings).points;
    if (!rows.has(person.player_id)) rows.set(person.player_id, {...base.get(person.player_id), player_id: person.player_id, player: person.player, team: person.team,
      current_team: person.team, listed_team: person.team, pos: person.pos, projected_points: known && finite(points) ? 0 : null,
      forecast_games: [], projection_expected_games: 0, notes: bundle.notes, model_version: bundle.model_version,
      confidence: known ? 'Experimental play simulation' : 'No recent role evidence', appearances: null, scoring_coverage: 'complete',
      is_simulation: true, is_defense_forecast: false, market_value: null, market_expected_points: null, matchup_pct: null, eligible: known});
    const row = rows.get(person.player_id);
    if (row.projected_points !== null) row.projected_points += points;
    row.projection_expected_games += horizon === 'draft' ? person.games : 1;
    if (game) row.forecast_games.push({week: game.week, opponent: game.home === person.team ? game.away : game.home, points: round(points), out: person.out});
    if (person.out && horizon === 'weekly') row.eligible = false;
  }
  if (horizon === 'draft') bundle.draft.forEach(p => add(p));
  else for (const game of selected) {
    game.players.forEach(p => add(p, game));
    for (const [team, points] of Object.entries(game.defenses)) add({player_id: `DST:${team}`, player: `${team} D/ST`, team, pos: 'DST'}, game, points);
  }
  // Preserve searchable byes, bench players and players whose new role is unknown.
  for (const person of bundle.draft) if (!rows.has(person.player_id)) {
    add({...person, role_basis: 'No recent role evidence'}, null, 0);
    const row = rows.get(person.player_id);
    if (row) {row.projected_points = null; row.projection_expected_games = 0; row.eligible = false; row.confidence = 'No unstarted game or no observed role';}
  }
  const result = [...rows.values()];
  for (const row of result) {
    row.projected_points = round(row.projected_points); row.projected_ppg = row.projected_points === null ? null : round(row.projected_points / row.projection_expected_games);
    row.opponent = horizon === 'weekly' ? row.forecast_games[0]?.opponent || '—' : 'Schedule';
    row.vorp = row.position_rank = row.overall_rank = row.value_vs_adp = null; row.draft_tag = 'SIMULATION';
  }
  const teams = Number(settings.teams) || 12, counts = {QB: teams * (settings.quarterbacks === '2QB' ? 2 : 1), RB: Math.round(teams * 2.5), WR: Math.round(teams * 3.5), TE: teams, K: teams, DST: teams};
  for (const [pos, count] of Object.entries(counts)) {
    const group = result.filter(p => p.pos === pos && p.eligible && finite(p.projected_points)).sort((a,b) => b.projected_points-a.projected_points || a.player.localeCompare(b.player));
    const replacement = group[Math.min(count, group.length-1)]?.projected_points;
    group.forEach((p,i) => {p.vorp = round(p.projected_points-replacement); p.position_rank = `${pos}${i+1}`;});
  }
  result.sort((a,b) => (b.vorp ?? -Infinity)-(a.vorp ?? -Infinity) || a.player.localeCompare(b.player));
  result.forEach((p,i) => {if (p.vorp !== null) p.overall_rank=i+1;});
  return {rows: result, week: finite(selectedWeek) ? selectedWeek : null, model_version: bundle.model_version, generated_at: bundle.generated_at,
    stale: now - Date.parse(bundle.evidence_generated_at) > 48*3600000};
}
