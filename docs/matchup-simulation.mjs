import {classifyInjury} from './injury-status.mjs';
import {defenderContext, projectDefenders} from './defender-model.mjs?v=20261120-defenders2';
import {scoreDefense} from './ranking-model.mjs?v=20261120-defenders2';
import {scoreFantasyStats} from './fantasy-scoring.mjs?v=20261030-scoring1';

export const SIMULATION_VERSION = 'matchup-simulation-v1';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const sum = values => values.reduce((a, b) => a + b, 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const zone = y => y <= 10 ? 'goal' : y <= 20 ? 'red' : y <= 40 ? 'fg' : y <= 65 ? 'middle' : 'own';
const dkey = (down, distance, y) => `${down}|${distance <= 3 ? 'short' : distance <= 7 ? 'medium' : 'long'}|${zone(y)}`;
const hash = value => {let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0;};
export function seededRandom(seed) {let state = hash(seed); return () => {state += 0x6D2B79F5; let x = state; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296;};}
const histCache = new WeakMap();
const histTotals = new WeakMap();
function histogramTotal(histogram) {
  if (!histTotals.has(histogram)) histTotals.set(histogram, sum(histogram.map(row => row.at(-1))));
  return histTotals.get(histogram);
}
function sampleHistogram(histogram, random) {
  if (!histogram?.length) return null;
  if (!histCache.has(histogram)) {
    let total = 0;
    histCache.set(histogram, {ends: histogram.map(row => total += row.at(-1)), total});
  }
  const {ends, total} = histCache.get(histogram), target = random() * total;
  let low = 0, high = ends.length - 1;
  while (low < high) {const mid = (low + high) >> 1; if (target < ends[mid]) high = mid; else low = mid + 1;}
  return histogram[low];
}
function pick(weights, random) {
  const entries = Object.entries(weights).filter(([, weight]) => finite(weight) && weight > 0);
  let target = random() * sum(entries.map(([, weight]) => weight));
  for (const [key, weight] of entries) {target -= weight; if (target < 0) return key;}
  return entries.at(-1)?.[0] ?? null;
}
const normalize = weights => {const total = sum(Object.values(weights).filter(finite)); return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, total ? value / total : 0]));};
const zeros = () => Object.fromEntries(['passing_yards', 'passing_tds', 'passing_interceptions', 'rushing_yards', 'rushing_tds', 'receptions', 'receiving_yards', 'receiving_tds', 'fumbles_lost_total', 'passing_2pt_conversions', 'rushing_2pt_conversions', 'receiving_2pt_conversions', 'special_teams_tds', 'pass_attempts', 'completions', 'carries', 'targets', 'sacks_taken', 'field_goals', 'extra_points', 'def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds', 'def_safeties', 'def_punt_blocks', 'def_pat_blocks', 'def_fg_blocks', 'def_2pt_made'].map(key => [key, 0]));
const teamZeros = () => ({...zeros(), points: 0, plays: 0, pass_calls: 0, run_calls: 0, blitzes: 0, drives: 0, first_downs: 0, turnovers: 0});

export function validateSimulationInputs(value) {
  return value?.schema_version === 1 && value.model_version === SIMULATION_VERSION && Number.isInteger(value.season)
    && Number.isFinite(Date.parse(value.generated_at)) && Array.isArray(value.games) && value.games.length > 0
    && value.coverage?.used_games > 0 && value.league?.outcomes?.pass?.length > 0 && value.league?.outcomes?.run?.length > 0
    && value.players && value.teams && value.status?.reports && value.coaching?.teams;
}

export function gameEnvironment(game, now, overrides = {}) {
  const roof = overrides.roof || game.roof || 'unknown', indoor = ['dome', 'closed'].includes(roof);
  const keys = [`roof:${indoor ? 'indoor' : 'outdoor'}`], notes = [];
  if (game.surface) keys.push(`surface:${game.surface}`);
  if (game.stadium_id) keys.push(`stadium:${game.stadium_id}`);
  const weather = game.weather || {}, fetched = Date.parse(weather.captured_at || weather.checked_at || game.weather_checked_at), kickoff = Date.parse(game.kickoff);
  const start = Date.parse(weather.valid_at), end = Date.parse(weather.valid_until) || start + 3600000;
  const fresh = weather.status === 'forecast' && Number.isFinite(fetched) && fetched <= now + 300000 && now - fetched <= 24 * 3600000
    && start <= kickoff && kickoff < end;
  let wind = finite(overrides.wind) ? clamp(overrides.wind, 0, 80) : null;
  if (wind === null && fresh) {
    const values = String(weather.wind_speed || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (values.length) wind = sum(values) / values.length;
  }
  const temperature = finite(overrides.temperature) ? overrides.temperature : fresh && finite(weather.temperature) ? weather.temperature : null;
  if (!indoor) {
    if (wind !== null) keys.push(`wind:${wind >= 15 ? 'high' : wind >= 8 ? 'moderate' : 'light'}`);
    if (temperature !== null) keys.push(`temperature:${temperature <= 35 ? 'cold' : temperature >= 85 ? 'hot' : 'mild'}`);
    if (!fresh && !finite(overrides.wind) && !finite(overrides.temperature)) notes.push('Kickoff weather is unavailable or stale. This is a conditional neutral-weather simulation, not a weather forecast.');
  } else notes.push('Closed roof: external wind and temperature do not affect the simulation.');
  if (roof === 'unknown') notes.push('Roof status is unconfirmed. Outdoor conditions are a scenario assumption.');
  return {roof, indoor, wind: indoor ? null : wind, temperature: indoor ? null : temperature, source: overrides.wind != null || overrides.temperature != null || overrides.roof ? 'scenario' : fresh ? 'kickoff_forecast' : 'conditional', keys, notes};
}

export function prepareSimulation(inputs, rankingInputs, {now = Date.now()} = {}) {
  if (!validateSimulationInputs(inputs) || Date.parse(inputs.generated_at) > now + 300000) throw new Error('Simulation evidence unavailable or future-dated.');
  if (rankingInputs?.season !== inputs.season) throw new Error('Simulation and defender evidence seasons do not match.');
  const rosterTime = Date.parse(inputs.status.generated_at);
  if (!finite(rosterTime) || rosterTime > now + 300000 || now - rosterTime > 48 * 3600000) throw new Error('Current roster evidence is stale or future-dated.');
  if (now - Date.parse(inputs.generated_at) > 48 * 3600000) throw new Error('Simulation evidence is older than 48 hours.');
  return {inputs, rankingInputs, now, defenders: defenderContext(rankingInputs, now)};
}

function unavailable(person, inputs, game, now, scenario, excluded) {
  if (excluded.has(person.player_id)) return true;
  if (['CUT', 'RET', 'TRD', 'TRT', 'TRC'].includes(person.status)) return true;
  if (person.status === 'DEV') return true;
  if (scenario) return false;
  const health = classifyInjury(person, inputs.status, now), week = inputs.status.injury_context?.expected_week;
  return health.current && person.injury?.week === game.week && /^out$/i.test(person.injury.report_status || '')
    || game.week === week && (person.status === 'RES' || person.status === 'EXE' || person.status === 'INA' && person.roster_week === week);
}

function rosterFor(prepared, team, game, options) {
  const {inputs, now} = prepared, excluded = new Set(options.excluded || []), roster = [];
  const recent = (inputs.team_games[team] || []).slice(0, 3).map(game => game.game_id);
  for (const person of Object.values(inputs.status.reports)) {
    if (person.team !== team || !['QB', 'RB', 'FB', 'HB', 'WR', 'TE', 'K'].includes(person.pos)) continue;
    const evidence = inputs.players[person.player_id], history = [...(evidence?.games || [])].sort((a,b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
    const moved = history[0] && history[0].team !== team && now - Date.parse(history[0].kickoff) < 30 * 86400000;
    const appearances = moved ? history.slice(0, 3) : history.filter(row => recent.includes(row.game_id));
    const usage = {};
    for (const row of appearances) for (const [kind, count] of Object.entries(row.opportunities)) usage[kind] = (usage[kind] || 0) + count;
    const out = unavailable(person, inputs, game, now, options.draftScenario, excluded);
    roster.push({...person, pos: ['FB','HB'].includes(person.pos) ? 'RB' : person.pos, usage, out, profile: evidence?.profile,
      role_basis: moved ? 'Inferred from previous team usage' : appearances.length ? 'Recent observed opportunities' : 'No recent role evidence'});
  }
  const available = roster.filter(person => !person.out);
  const qb = available.filter(person => person.pos === 'QB').sort((a,b)=>(b.usage.pass || 0) - (a.usage.pass || 0))[0];
  const kicker = available.filter(person => person.pos === 'K').sort((a,b)=>(b.usage.fg || 0) - (a.usage.fg || 0))[0];
  const choose = (kind, random, subtype = null) => {
    const candidates = available.filter(person => kind === 'run' ? ['QB','RB','WR','TE'].includes(person.pos) : ['RB','WR','TE'].includes(person.pos));
    const weights = Object.fromEntries(candidates.map(person => [person.player_id, (person.usage[kind] || 0) + (subtype ? (person.usage[subtype] || 0) * 2 : 0)]));
    const id = pick(weights, random);
    return id ? candidates.find(person => person.player_id === id) : {player_id: `UNASSIGNED:${team}:${kind}`, player: `Unassigned ${team} ${kind === 'run' ? 'rusher' : 'receiver'}`, pos: kind === 'run' ? 'RB' : 'WR', team};
  };
  return {roster, available, choose,
    qb: qb?.usage.pass > 0 ? qb : {player_id: `UNASSIGNED:${team}:QB`, player: `Unassigned ${team} quarterback`, pos: 'QB', team},
    kicker: kicker?.usage.fg > 0 ? kicker : {player_id: `UNASSIGNED:${team}:K`, player: `Unassigned ${team} kicker`, pos: 'K', team}};
}

function sideProfiles(prepared, team, side, game) {
  const input = prepared.inputs, staff = input.coaching.teams[team] || {};
  const name = staff.roles?.head_coach?.name || game[game.home === team ? 'home_coach' : 'away_coach'];
  const caller = staff.play_callers?.[side], last = input.team_games[team]?.[0]?.kickoff;
  const newCaller = caller && Date.parse(caller.effective_from) > Date.parse(last);
  return {team: input.teams[`${side}|${team}`] || {}, coach: input.coaches[`${side}|${name}`] || {}, league: input.league,
    name, staff, newCaller, teamWeight: newCaller ? .2 : .55};
}

function mixCounters(profiles, field, key, allowed, fallback) {
  const baseline = profiles.league[field]?.[key] || fallback || {};
  const base = normalize(Object.fromEntries(allowed.map(name => [name, baseline[name] || 0]))), out = {...base};
  for (const [source, blend, prior] of [[profiles.team, profiles.teamWeight, 80], [profiles.coach, .15, 160]]) {
    const sample = source[field]?.[key] || {}, n = sum(allowed.map(name => sample[name] || 0));
    const reliability = n / (n + prior), distribution = normalize(Object.fromEntries(allowed.map(name => [name, sample[name] || 0])));
    for (const name of allowed) out[name] += blend * reliability * ((distribution[name] || 0) - (base[name] || 0));
  }
  return out;
}

function dropbackProbabilities(profiles, qb, blitz, sackFactor) {
  const names = ['attempt', 'sack', 'scramble'], pickCounts = (source, conditional) => Object.fromEntries(names.map(name => [name, source?.dropbacks?.[conditional ? `${blitz ? 'yes' : 'no'}:${name}` : name] || 0]));
  const league = normalize(pickCounts(profiles.league, true)), team = normalize(pickCounts(profiles.team, true)), own = normalize(pickCounts(qb?.profile, false));
  const result = Object.fromEntries(names.map(name => [name, .45 * (league[name] || 0) + .35 * (team[name] || league[name] || 0) + .2 * (own[name] || league[name] || 0)]));
  result.sack *= sackFactor;
  return result;
}

function outcome(prepared, offensive, defensive, person, qb, kind, subtype, y, coverage, environment, random) {
  const league = prepared.inputs.league, choices = [], add = (profile, key, weight, prior = 0) => {
    const histogram = profile?.outcomes?.[key];
    if (!histogram?.length) return;
    const count = histogramTotal(histogram);
    choices.push({histogram, weight: weight * count / (count + prior)});
  };
  const key = subtype || kind;
  add(league, `${key}|${zone(y)}`, .30, 0);
  add(league, key, .15, 0);
  add(offensive.team, key, .20, 100);
  add(defensive.team, key, .25, 100);
  add(person?.profile, key, .35, 70);
  if (kind === 'pass') add(qb?.profile, key, .10, 150);
  if (coverage && kind === 'pass') {add(defensive.team, `coverage:${coverage}`, .08, 150); add(league, `coverage:${coverage}`, .04, 300);}
  for (const env of environment.keys) add(prepared.inputs.environments[env], kind === 'fg' ? key : kind, env.startsWith('stadium:') ? .025 : .04, 200);
  if (!choices.length) add(league, kind, 1);
  const index = pick(Object.fromEntries(choices.map((choice, i) => [i, choice.weight])), random);
  const sample = index === null ? null : sampleHistogram(choices[Number(index)].histogram, random);
  if (!sample) throw new Error(`Missing empirical outcome evidence: ${kind}`);
  return sample;
}

function clockSeconds(profiles, action, random, remaining, scoreMargin) {
  const counts = profiles.team.clocks?.[action] || profiles.league.clocks?.[action] || profiles.league.clocks?.run;
  let seconds = Number(pick(counts, random) || 25);
  // Two-minute tempo is an explicit scenario rule, not a coach-specific fit.
  if (remaining <= 120 && scoreMargin <= 0) seconds = Math.min(seconds, 18);
  return clamp(seconds, 3, 50);
}

function prepareMatchup(prepared, game, options) {
  const input = prepared.inputs, names = [game.away, game.home];
  if (new Set(names).size !== 2 || names.some(team => !input.team_games[team])) throw new Error('Select two different teams with game evidence.');
  const environment = gameEnvironment(game, prepared.now, options.environment || {});
  const rosters = Object.fromEntries(names.map(team => [team, rosterFor(prepared, team, game, options)]));
  const offense = Object.fromEntries(names.map(team => [team, sideProfiles(prepared, team, 'offense', game)]));
  const defense = Object.fromEntries(names.map(team => [team, sideProfiles(prepared, team, 'defense', game)]));
  const lineups = Object.fromEntries(names.map(team => [team, projectDefenders(prepared.defenders, team, options.draftScenario ? null : game, {excluded: options.excluded || []})]));
  const neutral = Object.fromEntries(names.map(team => [team, projectDefenders(prepared.defenders, team, null)]));
  const rate = (lineup, event) => sum([...(lineup.contributors || []), ...(lineup.replacements || [])].map(person => person.events[event] || 0));
  const factors = Object.fromEntries(names.map(team => [team, Object.fromEntries(['def_sacks', 'def_interceptions', 'fumble_recovery_opp'].map(event => {
    const profile = defense[team].team.outcomes?.pass ? defense[team].team : input.league;
    const kinds = ['pass','run','sack','scramble'];
    const plays = sum(kinds.map(kind => histogramTotal(profile.outcomes[kind] || [])));
    const events = event === 'def_sacks' ? histogramTotal(profile.outcomes.sack || [])
      : sum(kinds.flatMap(kind => (profile.outcomes[kind] || []).map(row => row[event === 'def_interceptions' ? 2 : 3] * row.at(-1))));
    const expected = lineups[team].estimated_team_plays, historicalRate = events / plays;
    // Current individual rates and redistributed playing time drive 80% of
    // the rate adjustment; the historical unit rate supplies the remaining 20%.
    const factor = lineups[team].available && historicalRate > 0 && expected > 0 ? .2 + .8 * rate(lineups[team], event) / expected / historicalRate : 1;
    return [event, clamp(factor, .5, 1.5)];
  }))]));
  return {names, environment, rosters, offense, defense, lineups, neutral, factors};
}

export function simulateGame(prepared, game, {seed = game.game_id, traceLimit = 0, matchupContext = null, ...options} = {}) {
  const random = seededRandom(seed), input = prepared.inputs;
  const {names, environment, rosters, offense, defense, lineups, factors} = matchupContext || prepareMatchup(prepared, game, options);
  const totals = Object.fromEntries(names.map(team => [team, teamZeros()])), people = {}, trace = [];
  const personStats = person => people[person.player_id] ||= {...zeros(), player_id: person.player_id, player: person.player, pos: person.pos, team: person.team};
  const add = (person, key, value = 1) => {personStats(person)[key] += value;};
  const defender = (team, event) => {
    const candidates = [...(lineups[team].contributors || []), ...(lineups[team].replacements || []).map(row => ({...row,
      player_id: `UNASSIGNED:${team}:${row.group}`, player: `Unassigned ${team} ${row.group}`, pos: row.group, team}))];
    const chosen = pick(Object.fromEntries(candidates.filter(row => row.snaps > 0).map(row => [row.player_id, row.events[event] || 0])), random);
    const person = candidates.find(row => row.player_id === chosen);
    return person ? {...person, team} : {player_id: `UNASSIGNED:${team}:defense`, player: `Unassigned ${team} defender`, pos: 'IDP', team};
  };
  const start = () => clamp(Number(pick(input.league.starts, random) || 70), 20, 95);
  let owner = random() < .5 ? names[0] : names[1], initial = owner, y = start(), down = 1, distance = Math.min(10, y);
  let clock = 3600, overtime = false, plays = 0, overtimePossessions = new Set(), ended = false;
  totals[owner].drives++;
  const other = team => names.find(name => name !== team);
  function possession(team, field = start()) {
    if (overtime) overtimePossessions.add(owner);
    owner = team; y = clamp(field, 1, 99); down = 1; distance = Math.min(10, y); totals[owner].drives++;
    if (overtime && overtimePossessions.size === 2 && totals[names[0]].points !== totals[names[1]].points) ended = true;
  }
  function conversion(team) {
    const choices = input.league.conversions, twoN = sum(Object.values(choices.two || {})), xpN = sum(Object.values(choices.xp || {}));
    const two = random() < twoN / (twoN + xpN || 1), record = two ? choices.two : choices.xp;
    if (random() >= (record?.good || 0) / (sum(Object.values(record || {})) || 1)) return;
    totals[team].points += two ? 2 : 1;
    if (two) {
      const receiver = rosters[team].choose('target', random);
      add(rosters[team].qb, 'passing_2pt_conversions'); add(receiver, 'receiving_2pt_conversions');
      totals[team].passing_2pt_conversions++; totals[team].receiving_2pt_conversions++;
    } else {add(rosters[team].kicker, 'extra_points'); totals[team].extra_points++;}
  }
  function touchdown(team, isDefensive = false) {
    totals[team].points += 6;
    // A first-possession offensive TD still gives the opponent an opportunity.
    // Once both teams have possessed, a lead ends the game without a needless try.
    if (overtime && (isDefensive || overtimePossessions.size >= 1 && totals[team].points > totals[other(team)].points)) {ended = true; return;}
    conversion(team); possession(other(team));
    // Kickoff return touchdowns remain a separate unit component where the
    // current returner's role is not known. Never assign a fabricated player.
    const rate = (input.league.returns?.kickoff_tds || 0) / (input.league.returns?.kickoffs || 1);
    if (!ended && random() < rate) {
      const returning = owner; totals[returning].special_teams_tds++; totals[returning].points += 6;
      conversion(returning); possession(other(returning));
    }
  }
  while (!ended && plays < 400) {
    if (clock <= 0) {
      if (!overtime && totals[names[0]].points === totals[names[1]].points) {clock = 600; possession(random() < .5 ? names[0] : names[1]); overtime = true; overtimePossessions.clear();}
      else break;
    }
    const attacking = owner, defending = other(owner), a = totals[attacking], d = totals[defending], o = offense[attacking], de = defense[defending];
    const before = clock, halfRemaining = !overtime && clock > 1800 ? clock - 1800 : clock;
    const beforeY = y, margin = a.points - d.points, qb = rosters[attacking].qb;
    const allowed = down === 4 ? ['run', 'pass', 'fg', 'punt', 'penalty'] : halfRemaining <= 12 && y <= 40 ? ['run', 'pass', 'fg', 'penalty'] : ['run', 'pass', 'penalty'];
    const fallback = {run: .40, pass: .57, penalty: .03, fg: down === 4 && y <= 40 ? .55 : 0, punt: down === 4 && y > 40 ? .75 : 0};
    const decisions = mixCounters(o, 'decisions', dkey(down, distance, y), allowed, fallback);
    const passShift = clamp(Number(options.passShift?.[attacking]) || 0, -.3, .3);
    decisions.pass = Math.max(.01, (decisions.pass || 0) + passShift); decisions.run = Math.max(.01, (decisions.run || 0) - passShift);
    if (halfRemaining <= 120 && margin < 0) decisions.pass *= 2;
    if (!overtime && clock < 120 && margin > 0) decisions.run *= 2;
    if (y + 17 > 70) decisions.fg = 0;
    const action = pick(decisions, random) || 'pass';
    const elapsed = Math.min(halfRemaining, clockSeconds(o, action, random, halfRemaining, margin));
    clock -= elapsed; plays++; a.plays++;
    let kind = action, subtype = null, gain = 0, receiver = null, rusher = null, resultLabel = action, turnover = false;
    const blitzCounts = de.team.blitz?.yes != null ? de.team.blitz : de.league.blitz;
    const blitz = random() < clamp((blitzCounts.yes || 0) / (sum(Object.values(blitzCounts)) || 1) + (Number(options.blitzShift?.[defending]) || 0), .02, .8);
    const coverage = pick(de.team.coverage || de.league.coverage, random);
    if (action === 'pass') {
      a.pass_calls++; if (blitz) d.blitzes++;
      kind = pick(dropbackProbabilities(de, qb, blitz, factors[defending].def_sacks), random);
      if (kind === 'attempt') {
        kind = 'pass';
        const types = Object.keys(input.league.types.pass || {});
        subtype = pick(mixCounters(o, 'types', 'pass', types, input.league.types.pass), random);
        receiver = rosters[attacking].choose('target', random, subtype);
      } else if (kind === 'scramble') rusher = qb;
    } else if (action === 'run') {
      a.run_calls++;
      subtype = pick(mixCounters(o, 'types', 'run', Object.keys(input.league.types.run), input.league.types.run), random);
      rusher = rosters[attacking].choose('run', random, subtype);
    }
    const target = receiver || rusher || (action === 'fg' ? rosters[attacking].kicker : qb);
    const label = action === 'fg' ? `fg_${Math.floor((y + 17) / 10)}` : subtype;
    let sample;
    // Reweight complete empirical outcomes, preserving yards/turnover correlation.
    // Rejection sampling changes rare-event rates when the available lineup changes.
    const eventFactors = factors[defending], ceiling = Math.max(1, eventFactors.def_interceptions, eventFactors.fumble_recovery_opp);
    do {sample = outcome(prepared, o, de, target, qb, kind, label, y, coverage, environment, random);}
    while (random() * ceiling > (sample[2] ? eventFactors.def_interceptions : sample[3] ? eventFactors.fumble_recovery_opp : 1));
    gain = sample[0];
    if (action === 'penalty') {
      y = clamp(y - gain, 1, 99); distance = sample[9] ? Math.min(10, y) : clamp(distance - gain, 1, 99);
      if (sample[9]) {down = 1; a.first_downs++;}
      resultLabel = `${gain > 0 ? 'defensive' : 'offensive'} penalty`;
    } else if (action === 'fg') {
      if (sample[8]) d.def_fg_blocks++;
      if (sample[6]) {a.points += 3; a.field_goals++; add(target, 'field_goals'); resultLabel = 'field goal'; possession(defending);}
      else {resultLabel = sample[8] ? 'blocked field goal' : 'missed field goal'; possession(defending, Math.min(80, 100 - y - 7));}
    } else if (action === 'punt') {
      if (sample[8]) d.def_punt_blocks++;
      const field = 100 - y + gain;
      if (field <= 0) {d.special_teams_tds++; resultLabel = 'punt return touchdown'; touchdown(defending, true);}
      else possession(defending, field >= 100 ? 80 : field);
    } else {
      if (kind === 'pass') {add(qb, 'pass_attempts'); add(receiver, 'targets'); a.pass_attempts++; a.targets++;}
      if (kind === 'sack') {d.def_sacks++; a.sacks_taken++; add(qb, 'sacks_taken'); add(defender(defending, 'def_sacks'), 'def_sacks');}
      if (sample[2]) {
        add(qb, 'passing_interceptions'); a.passing_interceptions++; d.def_interceptions++; a.turnovers++;
        const interceptor = defender(defending, 'def_interceptions'); add(interceptor, 'def_interceptions');
        const field = 100 - y + sample[5] - sample[4]; turnover = true;
        if (field <= 0) {d.def_tds++; add(interceptor, 'def_tds'); touchdown(defending, true); resultLabel = 'interception return touchdown';}
        else {possession(defending, field); resultLabel = 'interception';}
      } else {
        if (kind === 'pass' && !sample[1]) gain = 0;
        gain = Math.min(y, gain);
        if (kind === 'pass' && sample[1]) {add(qb, 'completions'); add(qb, 'passing_yards', gain); add(receiver, 'receptions'); add(receiver, 'receiving_yards', gain); a.passing_yards += gain; a.receiving_yards += gain; a.completions++; a.receptions++;}
        if (rusher) {add(rusher, 'carries'); add(rusher, 'rushing_yards', gain); a.rushing_yards += gain; a.carries++;}
        if (sample[3]) {
          const carrier = receiver || rusher || qb; add(carrier, 'fumbles_lost_total'); a.fumbles_lost_total++; a.turnovers++; d.fumble_recovery_opp++;
          const recovering = defender(defending, 'fumble_recovery_opp'); add(recovering, 'fumble_recovery_opp');
          const field = 100 - (y - gain) - sample[4]; turnover = true;
          if (field <= 0) {d.def_tds++; add(recovering, 'def_tds'); touchdown(defending, true); resultLabel = 'fumble return touchdown';}
          else {possession(defending, field); resultLabel = 'lost fumble';}
        } else if (y - gain <= 0) {
          if (receiver) {add(qb, 'passing_tds'); add(receiver, 'receiving_tds'); a.passing_tds++; a.receiving_tds++;}
          else if (rusher) {add(rusher, 'rushing_tds'); a.rushing_tds++;}
          touchdown(attacking); resultLabel = 'touchdown';
        } else if (y - gain >= 100) {d.points += 2; d.def_safeties++; possession(defending); resultLabel = 'safety'; if (overtime) ended = true;}
        else {
          y -= gain;
          if (gain >= distance) {down = 1; distance = Math.min(10, y); a.first_downs++;}
          else {down++; distance -= gain;}
          if (down > 4) {possession(defending, 100 - y); resultLabel = 'turnover on downs';}
          else resultLabel = kind === 'pass' && !sample[1] ? 'incomplete pass' : kind;
        }
      }
    }
    if (trace.length < traceLimit) trace.push({offense: attacking, defense: defending, seconds_remaining: before, yards_to_goal: beforeY,
      action, play_type: subtype || kind, blitz: action === 'pass' ? blitz : null, coverage_prior: action === 'pass' ? coverage : null,
      player: (receiver || rusher || qb).player, result: resultLabel, yards: gain, turnover, away_score: totals[game.away].points, home_score: totals[game.home].points});
    if (!overtime && before > 1800 && clock === 1800) possession(other(initial));
    if (overtime && overtimePossessions.size === 2 && totals[names[0]].points !== totals[names[1]].points) ended = true;
  }
  if (plays >= 400) throw new Error('Simulation exceeded its play limit; refusing a truncated forecast.');
  for (const team of names) {
    const pointsAllowed = totals[other(team)].points;
    totals[team].points_allowed = pointsAllowed;
    totals[team].fantasy_points = scoreDefense({stats: totals[team], points_allowed: pointsAllowed});
  }
  return {game_id: game.game_id, teams: totals, players: Object.values(people), trace, overtime, environment,
    rosters: Object.fromEntries(names.map(team => [team, [...rosters[team].roster.map(({profile, ...person}) => person),
      ...(lineups[team].contributors || []).map(person => ({...person, team, out: person.snaps === 0}))]])),
    coaches: Object.fromEntries(names.map(team => [team, {head_coach: offense[team].name, ...input.coaching.teams[team],
      tendency_basis: 'Head-coach tenure and observed team tendencies. Coordinator-specific effects are not separately identifiable without verified tenure history.'}]))};
}

export function fantasyScore(player, settings = {}) {
  return player.pos === 'K' ? player.field_goals * 3 + player.extra_points : scoreFantasyStats(player, settings).points;
}
export function percentile(sorted, fraction) {return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;}

export function runMatchup(prepared, game, {iterations = 1000, seed = game.game_id, settings = {}, retainSamples = false, ...options} = {}) {
  if (!Number.isInteger(iterations) || iterations < 100 || iterations > 10000) throw new Error('Choose 100–10,000 simulated games.');
  const players = new Map(), teams = Object.fromEntries([game.away, game.home].map(team => [team, {totals: teamZeros(), scores: [], fantasy: []}]));
  const matchupContext = prepareMatchup(prepared, game, options);
  let first, homeWins = 0, ties = 0, overtime = 0;
  for (let run = 0; run < iterations; run++) {
    const result = simulateGame(prepared, game, {...options, matchupContext, seed: `${seed}:${run}`, traceLimit: run === 0 ? 30 : 0});
    first ||= result; overtime += result.overtime;
    homeWins += result.teams[game.home].points > result.teams[game.away].points;
    ties += result.teams[game.home].points === result.teams[game.away].points;
    for (const [team, row] of Object.entries(result.teams)) {
      for (const [key, value] of Object.entries(row)) if (finite(value)) teams[team].totals[key] = (teams[team].totals[key] || 0) + value;
      teams[team].scores.push(row.points); teams[team].fantasy.push(row.fantasy_points);
    }
    for (const player of result.players) {
      if (!players.has(player.player_id)) players.set(player.player_id, {player_id: player.player_id, player: player.player, pos: player.pos, team: player.team, stats: zeros(), samples: new Float64Array(iterations), ...(retainSamples ? {base: new Float64Array(iterations), catches: new Float64Array(iterations)} : {})});
      const record = players.get(player.player_id);
      for (const key of Object.keys(record.stats)) record.stats[key] += player[key] || 0;
      record.samples[run] = fantasyScore(player, settings) ?? 0;
      if (retainSamples) {record.base[run] = fantasyScore(player, {ppr: 'Standard', tePremium: 'Off'}) ?? 0; record.catches[run] = player.receptions;}
    }
  }
  for (const roster of Object.values(first.rosters)) for (const person of roster) if (!players.has(person.player_id))
    players.set(person.player_id, {player_id: person.player_id, player: person.player, pos: person.pos, team: person.team, stats: zeros(), samples: new Float64Array(iterations), role_basis: person.role_basis, out: person.out});
  for (const roster of Object.values(first.rosters)) for (const person of roster) {
    const record = players.get(person.player_id); record.role_basis = person.role_basis; record.out = person.out;
  }
  const finish = samples => {const sorted = [...samples].sort((a,b)=>a-b); return {mean: sum(sorted) / iterations, low: percentile(sorted, .1), median: percentile(sorted, .5), high: percentile(sorted, .9)};};
  return {schema_version: 1, model_version: SIMULATION_VERSION, game_id: game.game_id, iterations, seed, settings, generated_at: new Date(prepared.now).toISOString(),
    home_win_probability: homeWins / iterations, away_win_probability: (iterations - homeWins - ties) / iterations, tie_probability: ties / iterations, overtime_probability: overtime / iterations,
    teams: Object.fromEntries(Object.entries(teams).map(([team, row]) => [team, {stats: Object.fromEntries(Object.entries(row.totals).map(([key, value]) => [key, value / iterations])), score: finish(row.scores), fantasy: finish(row.fantasy)}])),
    players: [...players.values()].map(({samples, base, catches, stats, ...person}) => ({...person, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, value / iterations])),
      fantasy: ['QB','RB','WR','TE','K'].includes(person.pos) ? finish(samples) : null})).sort((a,b)=>(b.fantasy?.mean || 0)-(a.fantasy?.mean || 0)),
    ...(retainSamples ? {samples: {players: [...players.values()].map(({player_id, base, catches}) => ({player_id, base, catches})),
      defenses: Object.fromEntries(Object.entries(teams).map(([team, row]) => [team, row.fantasy]))}} : {}),
    environment: first.environment, coaches: first.coaches, trace: first.trace,
    notes: ['Experimental empirical play simulation; intervals are conditional 10th–90th percentiles, not calibrated guarantees.',
      'Routes and coverage are prior-season team evidence; no receiver–cornerback or blocker–rusher assignment is asserted.',
      'Available defenders’ event rates and redistributed playing time drive 80% of the pressure/turnover rate adjustment; 20% retains the historical team rate. Adjustments are capped at 0.5–1.5 times baseline.',
      'Recent observed usage sets offensive roles. Players without role evidence are not assumed to be starters. Unassigned production is shown explicitly.',
      'Kicker scoring: 3 points per field goal and 1 per extra point. Individual defenders show event projections, not an unspecified IDP scoring system.',
      'This version projects defensive sacks, interceptions, recoveries and touchdowns. Tackles, assists, forced fumbles and exact coverage assignments are not modeled.',
      'Wind, temperature, surface and venue use empirical historical mixtures. Rain/snow, altitude and exact timeout decisions are not separately fitted.',
      'Coaching effects use observed team/head-coach tendencies. Unknown coordinator tenure and play-calling duties remain labeled unknown.',
      ...first.environment.notes]};
}
