import {classifyInjury} from './injury-status.mjs?v=20261120-defenders2';

export const DEFENDER_EVENTS = {def_sacks: 1, def_interceptions: 2, fumble_recovery_opp: 2, def_tds: 6};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const sum = values => values.reduce((a, b) => a + b, 0);
const events = () => Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, 0]));
const eventPoints = row => sum(Object.entries(DEFENDER_EVENTS).map(([key, weight]) => row[key] * weight));
const groups = ['DL', 'LB', 'DB', 'OTHER'];
export const defenderGroup = pos => /^(DE|DT|NT|DL|EDGE)$/.test(pos) ? 'DL'
  : /^(LB|ILB|OLB|MLB)$/.test(pos) ? 'LB' : /^(DB|CB|S|FS|SS)$/.test(pos) ? 'DB' : 'OTHER';

export function validatePersonnel(personnel) {
  const status = personnel?.status;
  if (!status || status.schema_version !== 1 || !Number.isFinite(Date.parse(status.generated_at))
    || !status.reports || typeof status.reports !== 'object' || Array.isArray(status.reports)
    || !Object.entries(status.reports).every(([id, row]) => row && row.player_id === id && typeof row.player === 'string'
      && typeof row.pos === 'string' && typeof row.team === 'string' && typeof row.status === 'string'
      && (row.injury === null || (row.injury && Number.isInteger(row.injury.season) && Number.isInteger(row.injury.week))))) return false;
  return personnel?.schema_version === 1 && Array.isArray(personnel.columns)
    && ['player_id', 'player', 'pos', 'team', 'defense_snaps', ...Object.keys(DEFENDER_EVENTS)].every(key => personnel.columns.includes(key))
    && Array.isArray(personnel.games) && personnel.games.every(game => Number.isFinite(Date.parse(game.kickoff))
      && Array.isArray(game.teams) && game.teams.length === 2 && game.teams.every(team => finite(team.defender_snap_total)
        && team.defender_snap_total > 0 && Array.isArray(team.rows) && team.rows.every(row => Array.isArray(row) && row.length === personnel.columns.length
          && ['defense_snaps', ...Object.keys(DEFENDER_EVENTS)].every(key => {
            const value = row[personnel.columns.indexOf(key)];
            return key !== 'defense_snaps' && value === null || finite(value) && value >= 0;
          }))))
    && personnel.status?.schema_version === 1 && personnel.status.reports && Array.isArray(personnel.coverage?.missing_snap_game_ids);
}

export function defenderContext(inputs, now) {
  const evidence = inputs.defense?.personnel;
  if (!validatePersonnel(evidence)) return null;
  const generated = Date.parse(evidence.status.generated_at), modified = Date.parse(evidence.status.sources?.roster?.http_last_modified);
  const rosterFresh = generated <= now + 300000 && now - generated <= 48 * 3600000
    && (!Number.isFinite(modified) || (modified <= now + 300000 && now - modified <= 7 * 86400000));
  const players = new Map(), teams = new Map();
  const cohorts = Object.fromEntries(groups.map(group => [group, Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, {count: 0, snaps: 0}]))]));
  // Participation must belong to a validated box in this snapshot, before now.
  const boxes = new Set(inputs.defense.games.filter(game => Date.parse(game.kickoff) < now).map(game => game.game_id));
  for (const game of evidence.games.filter(game => boxes.has(game.game_id) && game.season >= inputs.season - 1 && game.season <= inputs.season && Date.parse(game.kickoff) < now)) {
    const weight = game.season === inputs.season ? 1 : .35;
    for (const team of game.teams) {
      const rows = team.rows.map(row => Object.fromEntries(evidence.columns.map((key, i) => [key, row[i]])));
      const record = {...game, ...team, rows};
      if (!teams.has(team.team)) teams.set(team.team, []);
      teams.get(team.team).push(record);
      for (const row of rows) {
        if (!finite(row.defense_snaps) || row.defense_snaps <= 0) continue;
        const group = defenderGroup(row.pos);
        if (row.player_id) {
          if (!players.has(row.player_id)) players.set(row.player_id, []);
          players.get(row.player_id).push({...row, group, weight, kickoff: game.kickoff, game_id: game.game_id});
        }
        for (const key of Object.keys(DEFENDER_EVENTS)) if (finite(row[key]) && row[key] >= 0) {
          cohorts[group][key].count += weight * row[key];
          cohorts[group][key].snaps += weight * row.defense_snaps;
        }
      }
    }
  }
  for (const records of [...players.values(), ...teams.values()]) records.sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
  const leagueRates = Object.fromEntries(groups.map(group => [group, Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => {
    const cohort = cohorts[group][key];
    // Unusual positions share the overall prior; an absent cohort is unknown.
    const population = cohort.snaps ? cohort : {count: sum(groups.map(g => cohorts[g][key].count)), snaps: sum(groups.map(g => cohorts[g][key].snaps))};
    return [key, population.snaps ? population.count / population.snaps : null];
  }))]));
  const rates = new Map();
  for (const [id, records] of players) {
    const group = records[0].group;
    rates.set(id, Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => {
      const known = records.filter(row => finite(row[key])), prior = leagueRates[group][key], priorSnaps = key === 'def_tds' ? 2000 : 500;
      return [key, prior === null ? null : (sum(known.map(row => row[key] * row.weight)) + prior * priorSnaps)
        / (sum(known.map(row => row.defense_snaps * row.weight)) + priorSnaps)];
    })));
  }
  const seasonStartedAt = Math.min(...inputs.defense.games.filter(game => game.season === inputs.season).map(game => Date.parse(game.kickoff)));
  return {evidence, rosterFresh, players, teams, rates, leagueRates, now, season: inputs.season, seasonStartedAt};
}

function availability(person, context, game) {
  if (!game) return {out: false, label: 'Conditional full-season role'};
  const injury = classifyInjury(person, context.evidence.status, context.now);
  const matching = injury.current && person.injury?.week === game.week;
  if (matching && /^out$/i.test(person.injury.report_status || '')) return {out: true, label: `Out · Week ${game.week}`};
  const currentWeek = context.evidence.status.injury_context?.expected_week;
  if (game.week === currentWeek && ['RES', 'DEV', 'EXE', 'INA'].includes(person.status)
    && (person.status !== 'INA' || person.roster_week === currentWeek))
    return {out: true, label: `${person.status === 'RES' ? 'Reserve' : person.status === 'DEV' ? 'Practice squad' : 'Inactive/exempt'} · current week only`};
  if (matching && person.injury.report_status) return {out: false, label: `${person.injury.report_status} · no invented absence probability`};
  return {out: false, label: game.week !== currentWeek ? 'Conditional future availability' : 'No current game status · health unknown'};
}

export function projectDefenders(context, team, game = null) {
  if (!context || !context.rosterFresh) return {available: false, reason: 'Current defender roster is missing, stale or future-dated; team-event fallback.'};
  const recent = (context.teams.get(team) || []).slice(0, 3);
  if (!recent.length) return {available: false, reason: 'Defensive playing-time history unavailable; team-event fallback.'};
  const latest = Date.parse(recent[0].kickoff);
  // Prior-year rotations are useful in the off-season, but not as a current
  // in-season lineup after three weeks without a participation observation.
  if ((recent[0].season === context.season || context.now - context.seasonStartedAt > 21 * 86400000) && context.now - latest > 21 * 86400000)
    return {available: false, reason: 'Defensive playing-time evidence is more than 21 days old; team-event fallback.'};
  const budget = mean(recent.map(row => row.defender_snap_total)), plays = budget / 11;
  const groupBudgets = Object.fromEntries(groups.map(group => [group, mean(recent.map(game => sum(game.rows.filter(row => defenderGroup(row.pos) === group).map(row => row.defense_snaps))))]));
  const recentIds = new Set(recent.flatMap(row => row.rows.map(person => person.player_id)).filter(Boolean));
  const candidates = [];
  for (const [id, history] of context.players) {
    const person = context.evidence.status.reports[id];
    if (!person || person.team !== team || !['ACT', 'RES', 'DEV', 'INA', 'EXE'].includes(person.status)) continue;
    const moved = history[0].team !== team && latest - Date.parse(history[0].kickoff) <= 21 * 86400000;
    if (!recentIds.has(id) && !moved) continue;
    const group = history[0].group, rate = context.rates.get(id);
    if (Object.values(rate).some(value => value === null)) return {available: false, reason: 'Individual event evidence is incomplete; team-event fallback.'};
    const participation = history.filter(row => recent.some(game => game.game_id === row.game_id));
    const role = Math.min(plays, mean((participation.length ? participation : history.slice(0, 3)).map(row => row.defense_snaps)));
    candidates.push({player_id: id, player: person.player, pos: person.pos, group, role, rate, ...availability(person, context, game),
      role_basis: moved ? 'Transferred player; role inferred from previous team' : 'Recent observed rotation'});
  }
  const contributors = [], replacements = [];
  for (const group of groups) {
    const people = candidates.filter(person => person.group === group), total = sum(people.map(person => person.role));
    for (const person of people) person.snaps = person.out ? 0 : person.role * Math.min(1, groupBudgets[group] / (total || 1));
    let remaining = Math.max(0, groupBudgets[group] - sum(people.map(person => person.snaps)));
    // Reallocate lost snaps to observed teammates, capped at one full game per
    // player. Any unfilled workload is an explicit generic replacement bucket.
    const capacity = sum(people.filter(person => !person.out).map(person => plays - person.snaps));
    if (capacity > 0) for (const person of people.filter(person => !person.out)) person.snaps += Math.min(remaining, capacity) * (plays - person.snaps) / capacity;
    remaining = Math.max(0, groupBudgets[group] - sum(people.map(person => person.snaps)));
    for (const person of people) contributors.push({player_id: person.player_id, player: person.player, pos: person.pos, group, snaps: person.snaps,
      status: person.label, role_basis: person.role_basis, events: Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, person.rate[key] * person.snaps]))});
    if (remaining > 1e-8) {
      if (Object.values(context.leagueRates[group]).some(value => value === null)) return {available: false, reason: 'Replacement event evidence unavailable; team-event fallback.'};
      replacements.push({group, snaps: remaining, events: Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, context.leagueRates[group][key] * remaining]))});
    }
  }
  return {available: true, contributors, replacements, defender_snap_total: budget, estimated_team_plays: plays,
    latest_participation: recent[0].kickoff, recent_games: recent.map(game => game.game_id)};
}

export function personnelDefenseProjection(teamContext, context, team, opponent, game, fallback) {
  const lineup = projectDefenders(context, team, game), defense = teamContext.teams[team], offense = teamContext.teams[opponent];
  if (!finite(fallback)) return {points: null, mode: 'unrated', contributors: [], replacements: [], components: {}, notes: ['Required team scoring evidence unavailable.']};
  if (!lineup.available) return {points: fallback, mode: 'team_fallback', contributors: [], replacements: [],
    components: {team_fallback: fallback}, notes: [lineup.reason]};
  const counters = {def_sacks: 'sacks_suffered', def_interceptions: 'passing_interceptions', fumble_recovery_opp: 'fumbles_lost_total'};
  const factors = {}, priorEvents = events();
  for (const key of Object.keys(DEFENDER_EVENTS)) {
    const counter = counters[key], conceded = offense?.conceded[counter];
    const league = mean(Object.values(teamContext.teams).map(row => row.conceded[counter]).filter(finite));
    factors[key] = finite(conceded) && league > 0 ? Math.max(.75, Math.min(1.25, .5 + .5 * conceded / league)) : 1;
    priorEvents[key] = (finite(conceded) ? (defense.events[key] + conceded) / 2 : defense.events[key]) * .2;
  }
  // 80% comes from actual player rates and expected workloads, 20% from the
  // established team event prior. This is a forecast blend, not double counting.
  const scale = row => {
    const projected = Object.fromEntries(Object.keys(DEFENDER_EVENTS).map(key => [key, row.events[key] * factors[key] * .8]));
    return {...row, events: projected, points: eventPoints(projected)};
  };
  const contributors = lineup.contributors.map(scale), replacements = lineup.replacements.map(scale);
  const pa = offense && finite(offense.offense_score) ? (defense.allowed_score + offense.offense_score) / 2 : defense.allowed_score;
  const shared = {def_safeties: 2, def_punt_blocks: 2, def_pat_blocks: 2, def_fg_blocks: 2, special_teams_tds: 6, def_2pt_made: 2};
  const components = {named_defenders: sum(contributors.map(row => row.points)), replacement_defenders: sum(replacements.map(row => row.points)),
    team_event_prior: eventPoints(priorEvents), shared_team_and_special_teams: sum(Object.entries(shared).map(([key, weight]) => defense.events[key] * weight)), points_allowed: pa};
  return {...lineup, contributors, replacements, components, points: sum(Object.values(components)), mode: 'player_based', prior_events: priorEvents,
    notes: ['Player events supply 80% of sacks, interceptions, opponent fumble recoveries and defensive TDs; a 20% team prior steadies the estimate.',
      'Snaps describe expected playing time; event columns show the player’s weighted contribution to this team forecast.',
      'Points allowed, safeties, blocked kicks, special-teams TDs and conversions remain shared team estimates. Future availability is conditional.']};
}

export function combineDefenseForecasts(forecasts) {
  const contributors = new Map(), replacements = new Map(), components = {}, notes = new Set();
  for (const forecast of forecasts) {
    for (const [key, value] of Object.entries(forecast.components)) components[key] = (components[key] || 0) + value;
    for (const [records, target, key] of [[forecast.contributors, contributors, 'player_id'], [forecast.replacements, replacements, 'group']]) for (const row of records) {
      if (!target.has(row[key])) target.set(row[key], {...row, snaps: 0, points: 0, events: events(), statuses: new Set()});
      const total = target.get(row[key]);
      total.snaps += row.snaps; total.points += row.points;
      if (row.status) total.statuses.add(row.status);
      for (const event of Object.keys(DEFENDER_EVENTS)) total.events[event] += row.events[event];
    }
    forecast.notes.forEach(note => notes.add(note));
  }
  const finish = map => [...map.values()].map(({statuses, ...row}) => ({...row, status: [...statuses].join('; ')})).sort((a, b) => b.points - a.points);
  return {points: forecasts.some(row => row.points === null) ? null : sum(forecasts.map(row => row.points)), components,
    contributors: finish(contributors), replacements: finish(replacements), notes: [...notes], games: forecasts.length,
    mode: !forecasts.length ? 'no_games' : forecasts.every(row => row.mode === 'player_based') ? 'player_based' : 'team_fallback',
    latest_participation: forecasts.find(row => row.latest_participation)?.latest_participation || null};
}
