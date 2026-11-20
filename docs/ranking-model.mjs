import {buildValueBoard, scoreValueStats} from './player-values.mjs?v=20261118-history1';
import {recalculateMarketMetrics} from './adp-import.mjs?v=20261105-no-mfl1';
import {validatePersonnel, defenderContext, personnelDefenseProjection, combineDefenseForecasts} from './defender-model.mjs?v=20261120-defenders2';

export const RANKING_MODEL_VERSION = 'personnel-defense-v2';
const positions = ['QB', 'RB', 'WR', 'TE', 'DST'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => finite(value) ? Math.round(value * 100) / 100 : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const unpack = (columns, rows) => rows.map(row => Object.fromEntries(columns.map((key, i) => [key, row[i]])));

export function validateRankingInputs(value) {
  return value?.schema_version === 1 && value.season_type === 'REG' && Number.isInteger(value.season)
    && Number.isFinite(Date.parse(value.generated_at)) && Date.parse(value.generated_at) <= Date.now() + 300000 && Array.isArray(value.games) && value.games.length > 0
    && Array.isArray(value.columns) && ['player_id', 'pos', 'game_id', 'analysis_ready', 'fumbles_lost_total'].every(key => value.columns.includes(key))
    && Array.isArray(value.rows) && value.rows.every(row => Array.isArray(row) && row.length === value.columns.length)
    && Array.isArray(value.coverage?.pending_stats_game_ids) && Number.isInteger(value.defense?.coverage?.current_season_games)
    && value.defense.coverage.current_season_games >= 0 && value.defense.coverage.teams === 32
    && value.defense?.schema_version === 2 && validatePersonnel(value.defense.personnel)
    && Array.isArray(value.defense.games) && value.defense.games.length > 0
    && value.defense.games.every(game => Number.isFinite(Date.parse(game.kickoff)) && Number.isInteger(game.season)
      && Array.isArray(game.teams) && game.teams.length === 2 && game.teams[0].team === game.teams[1].opponent
      && game.teams[1].team === game.teams[0].opponent && game.teams.every(row => row.stats && row.allowed));
}

// OB uses the full scoreboard total, explicitly not a platform-specific D/ST score.
export function pointsAllowedScore(points) {
  return !finite(points) || points < 0 ? null : points === 0 ? 10 : points <= 6 ? 7 : points <= 13 ? 4
    : points <= 20 ? 1 : points <= 27 ? 0 : points <= 34 ? -1 : -4;
}
const eventWeights = {def_sacks: 1, def_interceptions: 2, fumble_recovery_opp: 2, def_safeties: 2,
  def_punt_blocks: 2, def_pat_blocks: 2, def_fg_blocks: 2, def_tds: 6, special_teams_tds: 6, def_2pt_made: 2};
export function scoreDefense(row) {
  const keys = Object.keys(eventWeights), stats = row?.stats;
  const pa = pointsAllowedScore(row?.points_allowed);
  if (pa === null || !stats || keys.some(key => !finite(stats[key]) || stats[key] < 0)) return null;
  return pa + keys.reduce((total, key) => total + stats[key] * eventWeights[key], 0);
}

export function defensiveContext(inputs, settings, now) {
  // Bound the evidence to this season and the immediately preceding season.
  const observations = (inputs.defense?.games || []).filter(game => game.season <= inputs.season
    && game.season >= inputs.season - 1 && Date.parse(game.kickoff) < now && game.week <= 18)
    .flatMap(game => game.teams.map(row => ({...row, season: game.season, weight: game.season === inputs.season ? 1 : .35,
      kickoff: game.kickoff, game_id: game.game_id})));
  const league = {}, teams = {};
  const rate = (rows, getter) => {
    const items = rows.map(row => ({value: getter(row), weight: row.weight})).filter(row => finite(row.value));
    const weight = items.reduce((sum, row) => sum + row.weight, 0);
    return {value: weight ? items.reduce((sum, row) => sum + row.weight * row.value, 0) / weight : null,
      weight, games: items.length};
  };
  const allowed = (row, pos) => scoreValueStats({...row.allowed[pos], pos}, settings).points;
  for (const pos of positions.slice(0, 4)) league[pos] = rate(observations, row => allowed(row, pos));
  for (const team of new Set(observations.map(row => row.team))) {
    const rows = observations.filter(row => row.team === team), profile = {team, positions: {}};
    for (const pos of positions.slice(0, 4)) {
      const actual = rate(rows, row => allowed(row, pos)), baseline = league[pos].value;
      const factor = finite(actual.value) && baseline > 0 ? clamp((actual.value * actual.weight + baseline * 12) / (actual.weight + 12) / baseline, .9, 1.1) : 1;
      profile.positions[pos] = {factor, games: actual.games, allowed_ppg: round(actual.value), league_ppg: round(baseline)};
    }
    // Shrink volatile scoring events heavily; tiny samples cannot dominate.
    const smoothed = (getter, priorGames = 12) => {
      const sample = rate(rows, getter), population = rate(observations, getter);
      return population.value === null || sample.value === null ? null
        : (sample.value * sample.weight + population.value * priorGames) / (sample.weight + priorGames);
    };
    profile.events = Object.fromEntries(Object.keys(eventWeights).map(key => [key, smoothed(row => row.stats[key], /tds|2pt|safeties|blocks/.test(key) ? 32 : 12)]));
    profile.conceded = Object.fromEntries(['sacks_suffered', 'passing_interceptions', 'fumbles_lost_total'].map(key => [key, smoothed(row => row.stats[key])]));
    profile.allowed_score = smoothed(row => pointsAllowedScore(row.points_allowed));
    profile.offense_score = smoothed(row => pointsAllowedScore(row.points_scored));
    profile.games = rows.length;
    profile.observed_ppg = round(rate(rows, scoreDefense).value);
    teams[team] = profile;
  }
  return {teams, league};
}

export function matchupFactor(context, opponent, pos) {
  return context.teams[opponent]?.positions[pos] || {factor: 1, games: 0, allowed_ppg: null, league_ppg: context.league[pos]?.value ?? null};
}
export function defenseProjection(context, team, opponent = null) {
  const defense = context.teams[team], offense = context.teams[opponent];
  if (!defense || !finite(defense.allowed_score)) return null;
  let points = offense && finite(offense.offense_score) ? (defense.allowed_score + offense.offense_score) / 2 : defense.allowed_score;
  const counters = {def_sacks: 'sacks_suffered', def_interceptions: 'passing_interceptions', fumble_recovery_opp: 'fumbles_lost_total'};
  for (const [key, weight] of Object.entries(eventWeights)) {
    let value = defense.events[key];
    if (!finite(value)) return null;
    if (offense && counters[key] && finite(offense.conceded[counters[key]])) value = (value + offense.conceded[counters[key]]) / 2;
    points += value * weight;
  }
  return points;
}

export function upcomingGames(inputs, now) {
  return inputs.games.filter(game => game.week >= 1 && game.week <= 18 && Date.parse(game.kickoff) > now
    && !game.completed && !['cancelled', 'canceled', 'postponed', 'final', 'completed'].includes(game.status))
    .sort((a, b) => a.week - b.week || Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

export function buildRankingBoard({rankings, history, news, inputs}, settings = {}, {now = Date.now(), horizon = 'draft', week = null, draftRows = null} = {}) {
  if (!validateRankingInputs(inputs)) throw new Error('Ranking evidence is unavailable or incomplete.');
  if (!['draft', 'weekly', 'ros'].includes(horizon)) throw new Error('Unknown ranking horizon.');
  const values = buildValueBoard({rankings, history, news, inputs}, settings, {now});
  const context = defensiveContext(inputs, settings, now), future = upcomingGames(inputs, now);
  const selectedWeek = week === null ? future[0]?.week ?? null : Number(week);
  const base = new Map((draftRows || unpack(rankings.columns, Object.values(rankings.boards)[0])).filter(row => row.player_id).map(row => [row.player_id, row]));
  let rows = values.rows.map(player => {
    const saved = base.get(player.player_id) || {}, games = future.filter(game => [game.home, game.away].includes(player.team));
    // A full-season draft outlook updates its scoring rate, retaining the
    // existing games estimate. It is not this season's actual + future total.
    const rate = player.projected_ppg;
    const expectedGames = finite(saved.projection_expected_games) ? saved.projection_expected_games : 17;
    const forecasts = games.map(game => {
      const opponent = game.home === player.team ? game.away : game.home;
      const matchup = matchupFactor(context, opponent, player.pos), out = player.excluded_game_ids.includes(game.game_id);
      return {game_id: game.game_id, week: game.week, kickoff: game.kickoff, opponent, out,
        matchup_pct: round((matchup.factor - 1) * 100), defense_games: matchup.games,
        points: rate === null ? null : out ? 0 : round(Math.max(0, rate) * matchup.factor)};
    });
    const selected = horizon === 'weekly' ? forecasts.filter(game => game.week === selectedWeek) : forecasts;
    const points = horizon === 'draft' ? (rate === null ? null : Math.max(0, rate) * expectedGames)
      : player.remaining_games === null || rate === null ? null : selected.reduce((sum, game) => sum + game.points, 0);
    const eligible = horizon !== 'weekly' || selected.length > 0;
    const notes = [...player.notes];
    if (horizon === 'weekly' && !selected.length) notes.push('No unstarted game in this week (bye, already started, or schedule unavailable).');
    return {...saved, ...player, listed_team: saved.listed_team || saved.team || player.team, current_team: player.team,
      projected_ppg: rate, projected_points: round(points), projection_source: 'schedule_defense',
      projection_expected_games: horizon === 'draft' ? expectedGames : selected.length,
      projection_low: null, projection_high: null, projection_stddev: null,
      forecast_games: forecasts, eligible, notes, opponent: horizon === 'weekly' ? selected[0]?.opponent || '—' : 'Schedule',
      matchup_pct: round(mean(selected.map(game => game.matchup_pct))), model_version: RANKING_MODEL_VERSION,
      injuryStatus: player.injury, injury: player.injury.currentInjury,
      scoring_coverage: player.notes.some(note => note.includes('partial scoring')) ? 'core_only' : 'complete'};
  });
  const personnel = settings.defenses === 'Include' ? defenderContext(inputs, now) : null;
  if (settings.defenses === 'Include') for (const [team, profile] of Object.entries(context.teams)) {
    const games = future.filter(game => [game.home, game.away].includes(team));
    const forecasts = games.map(game => {
      const opponent = game.home === team ? game.away : game.home;
      const breakdown = personnelDefenseProjection(context, personnel, team, opponent, game, defenseProjection(context, team, opponent));
      return {game_id: game.game_id, week: game.week, kickoff: game.kickoff, opponent, points: round(breakdown.points), breakdown};
    });
    const selected = horizon === 'weekly' ? forecasts.filter(game => game.week === selectedWeek) : forecasts;
    const neutralBreakdown = personnelDefenseProjection(context, personnel, team, null, null, defenseProjection(context, team));
    const neutral = neutralBreakdown.points;
    const breakdown = combineDefenseForecasts(horizon === 'draft' ? Array(17).fill(neutralBreakdown) : selected.map(game => game.breakdown));
    const points = neutral === null || selected.some(game => game.points === null) ? null
      : horizon === 'draft' ? breakdown.points : selected.reduce((sum, game) => sum + game.points, 0);
    rows.push({player_id: `DST:${team}`, player: `${team} D/ST`, pos: 'DST', team, current_team: team, listed_team: team,
      projected_points: round(points), projected_ppg: round(neutral), appearances: profile.games,
      projection_expected_games: horizon === 'draft' ? 17 : selected.length,
      projection_source: 'schedule_defense', eligible: horizon !== 'weekly' || selected.length > 0,
      forecast_games: forecasts, defense_breakdown: breakdown, opponent: horizon === 'weekly' ? selected[0]?.opponent || '—' : 'Schedule',
      matchup_pct: null, adp: null, is_defense_forecast: true, draft_tag: 'OB D/ST', scoring_coverage: 'complete',
      notes: [inputs.defense.scoring, ...breakdown.notes]});
  }
  // Unrated players retain their place in the searchable board, never a fake rank.
  const teams = Number(settings.teams) || 12, counts = {QB: teams * (settings.quarterbacks === '2QB' ? 2 : 1), RB: Math.round(teams * 2.5), WR: Math.round(teams * 3.5), TE: teams, DST: teams};
  for (const pos of positions) {
    const group = rows.filter(row => row.pos === pos && row.eligible && finite(row.projected_points)).sort((a, b) => b.projected_points - a.projected_points || a.player.localeCompare(b.player));
    const replacement = group[Math.min(counts[pos], group.length - 1)]?.projected_points;
    rows.filter(row => row.pos === pos).forEach(row => {row.vorp = null; row.position_rank = null; row.overall_rank = null;});
    group.forEach((row, i) => {row.position_rank = `${pos}${i + 1}`; row.vorp = round(row.projected_points - replacement);});
  }
  rows.sort((a, b) => (b.vorp ?? -Infinity) - (a.vorp ?? -Infinity) || (b.projected_points ?? -Infinity) - (a.projected_points ?? -Infinity) || a.player.localeCompare(b.player));
  rows.forEach((row, i) => {row.overall_rank = row.vorp === null ? null : i + 1; row.value_vs_adp = null;});
  rows = horizon === 'draft' ? recalculateMarketMetrics(rows) : rows.map(row => ({...row, market_value: null, market_expected_points: null, value_vs_adp: null, draft_tag: row.is_defense_forecast ? 'OB D/ST' : 'FORECAST'}));
  return {model_version: RANKING_MODEL_VERSION, horizon, week: selectedWeek, season: inputs.season,
    as_of: new Date(now).toISOString(), generated_at: inputs.generated_at, rows, defense: context,
    weeks: [...new Set(future.map(game => game.week))], coverage: inputs.defense.coverage};
}
