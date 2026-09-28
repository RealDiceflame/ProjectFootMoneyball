import {ageOnSeptemberFirst, ageChangeFactor} from './projection-model.mjs';
import {classifyInjury} from './injury-status.mjs';

// Versioned, deliberately transparent research model. Never fit a past value
// snapshot with today's injuries, rankings, or knowledge of later results.
export const MODEL_VERSION = 'production-value-v1';
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const CORE = ['passing_yards', 'passing_tds', 'passing_interceptions', 'rushing_yards',
  'rushing_tds', 'receptions', 'receiving_yards', 'receiving_tds'];
const EXTRA = ['fumbles_lost_total', 'passing_2pt_conversions', 'rushing_2pt_conversions',
  'receiving_2pt_conversions', 'special_teams_tds'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const idOf = row => typeof row?.player_id === 'string' && /^00-\d{7}$/.test(row.player_id.trim()) ? row.player_id.trim() : '';
const unpack = (columns = [], rows = []) => rows.map(values => Object.fromEntries(columns.map((key, i) => [key, values[i]])));

export function normalizeValueSettings(settings = {}) {
  return {teams: 12, quarterbacks: settings.quarterbacks === '2QB' ? '2QB' : '1QB',
    ppr: ['Standard', 'Half PPR', 'Full PPR'].includes(settings.ppr) ? settings.ppr : 'Half PPR',
    tePremium: settings.tePremium === '+0.5' ? '+0.5' : 'None'};
}

export function valueFormatKey(settings = {}) {
  const s = normalizeValueSettings(settings);
  const scoring = {Standard: 'standard', 'Half PPR': 'half_ppr', 'Full PPR': 'full_ppr'}[s.ppr];
  return `12team_${s.quarterbacks.toLowerCase()}_${s.tePremium === '+0.5' ? 'te_premium_' : ''}${scoring}`;
}

export function scoreValueStats(row, settings = {}, {allowLegacy = false} = {}) {
  if (!CORE.every(key => finite(row?.[key]))) return {points: null, complete: false};
  const complete = EXTRA.every(key => finite(row?.[key]));
  if (!complete && !allowLegacy) return {points: null, complete: false};
  const s = normalizeValueSettings(settings), n = key => finite(row[key]) ? Number(row[key]) : 0;
  const ppr = {Standard: 0, 'Half PPR': 0.5, 'Full PPR': 1}[s.ppr];
  const bonus = row.pos === 'TE' && s.tePremium === '+0.5' ? 0.5 : 0;
  let points = n('passing_yards') * .04 + n('passing_tds') * 4 - n('passing_interceptions') * 2
    + n('rushing_yards') * .1 + n('rushing_tds') * 6 + n('receptions') * (ppr + bonus)
    + n('receiving_yards') * .1 + n('receiving_tds') * 6;
  // Legacy priors are explicitly core-only. Total fumbles are never substituted
  // for lost fumbles. Do not mix a partial subset of the optional adjustments.
  if (complete) points += -n('fumbles_lost_total') * 2 + 2 * (n('passing_2pt_conversions')
    + n('rushing_2pt_conversions') + n('receiving_2pt_conversions')) + n('special_teams_tds') * 6;
  return {points, complete};
}

function reportIndex(news) {
  const reports = new Map();
  for (const report of Object.values(news?.reports || {})) {
    const id = idOf(report);
    if (id && POSITIONS.includes(report.pos)) reports.set(`${id}|${report.pos}`, report);
  }
  return reports;
}

function historicalContext(history, reports, season, settings) {
  const byId = new Map(), samples = [];
  for (const [key, record] of Object.entries(history?.players || {})) {
    const id = idOf(record);
    if (!id || key !== `id:${id}` || !POSITIONS.includes(record.pos)) continue;
    const report = reports.get(`${id}|${record.pos}`);
    const birth = record.birth_date || report?.birth_date;
    const rows = unpack(history.columns, record.seasons).filter(row => Number.isInteger(Number(row.season))
      && Number(row.season) < season && Number(row.games) > 0);
    byId.set(id, {record, rows, birth});
    for (const row of rows) {
      const scored = scoreValueStats({...row, pos: record.pos}, settings, {allowLegacy: true});
      const age = ageOnSeptemberFirst(birth, Number(row.season));
      if (scored.points !== null && row.games >= 4 && finite(age) && age >= 20 && age <= 45)
        samples.push({identity: id, pos: record.pos, season: Number(row.season), age,
          games: Number(row.games), fantasy_points_per_game: scored.points / Number(row.games)});
    }
  }
  const factors = new Map();
  const ageFactor = (pos, age) => {
    const key = `${pos}|${age}`;
    if (!factors.has(key)) factors.set(key, ageChangeFactor(samples, pos, age));
    return factors.get(key);
  };
  return {byId, samples, ageFactor};
}

function priorForPlayer(player, context, season, settings, birth) {
  const source = context.byId.get(player.player_id);
  if (!source || source.record.pos !== player.pos) return {ppg: null, seasons: [], legacy: false};
  let total = 0, weight = 0, legacy = false;
  const seasons = [];
  for (const row of source.rows) {
    const gap = season - Number(row.season);
    if (gap < 1 || gap > 3) continue; // Calendar years, not the last three nonempty rows.
    const scored = scoreValueStats({...row, pos: player.pos}, settings, {allowLegacy: true});
    if (scored.points === null) continue;
    let rate = scored.points / Number(row.games);
    if (birth) for (let year = Number(row.season) + 1; year <= season; year++) {
      const age = ageOnSeptemberFirst(birth, year);
      if (finite(age)) rate *= context.ageFactor(player.pos, age).factor;
    }
    const w = [0, 5, 3, 2][gap] * Math.min(Number(row.games) / 12, 1);
    total += rate * w; weight += w; legacy ||= !scored.complete;
    seasons.push(Number(row.season));
  }
  return {ppg: weight ? total / weight : null, seasons: [...new Set(seasons)].sort(), legacy};
}

function usableGame(game, season, now) {
  const key = String(game?.game_id || '');
  const explicitSeason = game.season == null ? Number(key.split('_')[0]) : Number(game.season);
  return explicitSeason === season && (!game.season_type || game.season_type === 'REG')
    && Number(game.week) >= 1 && Number(game.week) <= 18 && Number.isFinite(Date.parse(game.kickoff))
    && Date.parse(game.kickoff) > now && !['cancelled', 'canceled', 'postponed'].includes(String(game.status).toLowerCase());
}

export function buildValueBoard({rankings = {}, history = {}, news = {}, inputs} = {}, settings = {}, {now = Date.now()} = {}) {
  if (!inputs || inputs.schema_version !== 1 || inputs.season_type !== 'REG'
    || !Number.isInteger(inputs.season) || !Array.isArray(inputs.columns) || !Array.isArray(inputs.rows)
    || !Array.isArray(inputs.games)) throw new Error('Current-season value inputs are unavailable or invalid.');
  if (!Number.isFinite(now)) throw new Error('A valid model timestamp is required.');
  const s = normalizeValueSettings(settings), season = inputs.season, format = valueFormatKey(s);
  for (const bundle of [inputs, rankings, history, news]) {
    if (bundle?.generated_at && Date.parse(bundle.generated_at) > now + 300000)
      throw new Error('A contributing snapshot is dated after the model timestamp.');
  }
  const reports = reportIndex(news), context = historicalContext(history, reports, season, s);
  const universe = new Map(), observations = new Map(), gameMap = new Map(inputs.games.map(game => [game.game_id, game]));
  const board = rankings.boards?.[format] || Object.values(rankings.boards || {})[0] || [];
  for (const row of unpack(rankings.columns, board)) {
    const id = idOf(row);
    if (id && POSITIONS.includes(row.pos)) universe.set(id, {...row, player_id: id});
  }
  // Last occurrence wins if an input contains a corrected version of a game row.
  const unique = new Map();
  for (const row of unpack(inputs.columns, inputs.rows)) {
    const id = idOf(row), game = gameMap.get(row.game_id);
    if (!id || !POSITIONS.includes(row.pos) || !game || row.analysis_ready !== true || game.analysis_ready !== true
      || Number(String(row.game_id).split('_')[0]) !== season || Number(row.week) > 18
      || Number(row.week) !== Number(game.week) || ![game.home, game.away].includes(row.team)
      || (row.opponent && row.opponent !== (game.home === row.team ? game.away : game.home))
      || !Number.isFinite(Date.parse(row.kickoff)) || Date.parse(row.kickoff) !== Date.parse(game.kickoff)
      || Date.parse(row.kickoff) > now) continue;
    if (!universe.has(id)) universe.set(id, {...row, player_id: id});
    if (universe.get(id).pos !== row.pos) continue;
    unique.set(`${id}|${row.game_id}`, row);
  }
  for (const row of unique.values()) {
    const list = observations.get(row.player_id) || []; list.push(row); observations.set(row.player_id, list);
  }
  const newsTime = Date.parse(news.generated_at);
  const currentRoster = news.season === season && Number.isFinite(newsTime) && newsTime <= now + 300000 && now - newsTime <= 7 * 86400000;
  const rows = [];
  for (const player of universe.values()) {
    const notes = [], all = (observations.get(player.player_id) || []).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const report = reports.get(`${player.player_id}|${player.pos}`);
    const team = (currentRoster && report?.current_team) || all.at(-1)?.team || player.team || null;
    const birth = report?.birth_date || context.byId.get(player.player_id)?.birth;
    const age = ageOnSeptemberFirst(birth, season);
    const prior = priorForPlayer(player, context, season, s, birth);
    const weekly = all.map(row => ({...row, points: scoreValueStats(row, s).points})).filter(row => row.points !== null);
    const n = weekly.length, current = mean(weekly.map(row => row.points));
    const rate = prior.ppg === null ? current : current === null ? prior.ppg : prior.ppg + n / (n + 8) * (current - prior.ppg);
    const scheduleKnown = Boolean(team && inputs.games.some(game => game.home === team || game.away === team));
    const upcoming = inputs.games.filter(game => usableGame(game, season, now) && (game.home === team || game.away === team));
    const injury = classifyInjury(report, news, now);
    const status = String(injury.currentInjury?.report_status || injury.currentInjury?.status || '');
    // Only a current Out designation can rule out a specific forthcoming fixture.
    // IR and Doubtful are warnings: this model has no return-date/absence model.
    const excluded = injury.current && Number(injury.injury?.season) === season && /^out$/i.test(status)
      ? upcoming.filter(game => Number(game.week) === Number(injury.injury.week)).map(game => game.game_id) : [];
    const available = scheduleKnown ? upcoming.length - excluded.length : null;
    const ros = rate !== null && available !== null ? Math.max(0, rate) * available : null;
    const futureFactors = [1, 2].map(offset => finite(age) ? context.ageFactor(player.pos, age + offset) : {factor: 1, count: 0});
    const year1 = rate === null ? null : Math.max(0, rate) * futureFactors[0].factor * 17;
    const year2 = year1 === null ? null : year1 * futureFactors[1].factor;
    if (!scheduleKnown) notes.push('Current team schedule unavailable; remaining-season value is not rated.');
    if (prior.legacy) notes.push('Some historical priors contain core scoring only; missing fumble-loss/2-point data were not invented.');
    if (!finite(age)) notes.push('Birth date unavailable; no age adjustment.');
    if (!currentRoster) notes.push('Current roster snapshot unavailable; team uses the latest archived appearance or saved ranking.');
    if (!injury.current) notes.push('Current injury status unknown; absence is not proof of health.');
    if (injury.current && /^(ir|injured reserve|reserve\/injured|doubtful)$/i.test(status)) notes.push('Availability risk: no return date is modeled; projections are a conditional playing scenario.');
    if (excluded.length) notes.push('Current Out report excludes its matching upcoming game only; later availability is unknown.');
    if (all.length !== n) notes.push(`${all.length - n} incomplete scoring observations excluded.`);
    if (n < 4) notes.push('Early sample; recorded stat appearances are not every active game.');
    if (rate === null) notes.push('No usable recent-season prior or current scoring observation; not rated.');
    rows.push({player_id: player.player_id, player: player.player, pos: player.pos, team,
      headshot_url: report?.headshot_url || null, age: finite(age) ? age : null,
      projected_ppg: round(rate), prior_ppg: round(prior.ppg), current_ppg: round(current),
      appearances: n, prior_seasons: prior.seasons, recent_ppg: round(mean(weekly.slice(-2).map(row => row.points))),
      targets_per_game: round(mean(weekly.filter(row => finite(row.targets)).map(row => Number(row.targets)))),
      carries_per_game: round(mean(weekly.filter(row => finite(row.carries)).map(row => Number(row.carries)))),
      weekly: weekly.map(row => ({week: Number(row.week), game_id: row.game_id, points: round(row.points), provisional: row.provisional})),
      remaining_games: scheduleKnown ? upcoming.length : null, available_games: available,
      injury, excluded_game_ids: excluded, ros_points: round(ros),
      dynasty_points: ros === null ? null : round(ros + .85 * year1 + .85 ** 2 * year2),
      future_year_points: [round(year1), round(year2)], age_samples: futureFactors.map(item => item.count),
      confidence: n >= 8 && prior.ppg !== null ? 'More observed games' : n ? 'Early sample' : 'Prior only', notes});
  }
  const depths = {QB: s.quarterbacks === '2QB' ? 25 : 13, RB: 25, WR: 37, TE: 13};
  const replacement = {};
  for (const pos of POSITIONS) {
    const group = rows.filter(row => row.pos === pos && row.projected_ppg !== null).sort((a, b) => b.projected_ppg - a.projected_ppg);
    const selected = group[Math.min(depths[pos] - 1, group.length - 1)];
    replacement[pos] = {depth: depths[pos], ppg: selected ? Math.max(0, selected.projected_ppg) : null,
      player_id: selected?.player_id || null, population: group.length, limited: group.length < depths[pos]};
  }
  for (const row of rows) {
    const baseline = replacement[row.pos].ppg;
    // The reference rate is held fixed across future years. Dynasty is ROS plus
    // two 17-game playing scenarios, not a retirement or future-roster forecast.
    row.ros_surplus = row.ros_points === null || baseline === null ? null : round(row.ros_points - baseline * row.remaining_games);
    row.dynasty_surplus = row.ros_surplus === null ? null : round(row.ros_surplus
      + .85 * (row.future_year_points[0] - baseline * 17) + .85 ** 2 * (row.future_year_points[1] - baseline * 17));
  }
  for (const horizon of ['ros', 'dynasty']) {
    const maximum = Math.max(0, ...rows.map(row => row[`${horizon}_surplus`] ?? 0));
    for (const row of rows) row[`${horizon}_index`] = row[`${horizon}_surplus`] === null ? null
      : maximum > 0 ? Math.round(10000 * Math.max(0, row[`${horizon}_surplus`]) / maximum) : 0;
    const ordered = [...rows].sort((a, b) => (b[`${horizon}_surplus`] ?? -Infinity) - (a[`${horizon}_surplus`] ?? -Infinity)
      || a.player.localeCompare(b.player));
    ordered.forEach((row, i) => {row[`rank_${horizon}`] = row[`${horizon}_surplus`] === null ? null : i + 1;});
  }
  return {model_version: MODEL_VERSION, season, as_of: new Date(now).toISOString(), format_key: format,
    settings: s, rows, coverage: inputs.coverage || {}, replacement, sources: inputs.sources,
    assumptions: [
      'Experimental relative production index, not KeepTradeCut consensus, trade currency, or a calibrated forecast. Zero means no positive modeled starter-replacement surplus, not no player value.',
      '12-team reference: next QB after 12/24 starters, RB25, WR37, TE13. No flex allocation. Scarcity changes with 1QB/2QB; PPR and TE premium change scoring.',
      'Prior: last three calendar seasons weighted 5/3/2 with games reliability and historical age transitions. Current PPG blends with eight prior-equivalent games. No ADP input.',
      'Only archived, analysis-ready stat appearances count. Missing player rows are not zero-point active games. Reported results use an eight-hour delay where the source has no final flag.',
      'Current Out removes only its matching future fixture. Questionable and Probable do not lower value. IR/Doubtful warn but no return date is invented; all other future games are conditional playing scenarios.',
      'Dynasty = remaining-season points + 0.85 × next 17-game season + 0.85² × the following 17-game season. Age factors describe returning players, not retirement likelihood. Future roles, injuries and schedule strength are not modeled.',
      'Snapshots are actually recorded values, not reconstructed past consensus. Indices are normalized within each dated population; compare projected points too.'
    ]};
}
