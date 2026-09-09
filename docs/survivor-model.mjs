// Pure survivor rules, assignment, and simulation. No fantasy scoring inputs.
export function fixture(data, team, week) {
  return data.games.find(g => g.week === Number(week) && (g.home === team || g.away === team));
}

export function playable(game, now = Date.now()) {
  return Boolean(game?.model && game.status === "scheduled" && Date.parse(game.kickoff) > now);
}

export function probability(game, team, tiesSurvive = false) {
  if (!game?.model || ![game.home, game.away].includes(team)) return null;
  const p = game.model[game.home === team ? "home_win" : "away_win"];
  const tie = game.model.tie;
  if (![p, tie].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  return Math.min(1, p + (tiesSurvive ? tie : 0));
}

export function sanitizeState(raw, data, now = Date.now()) {
  const teams = new Set(data.teams.map(t => t.team));
  const next = data.games.filter(g => playable(g, now)).map(g => g.week);
  const fallback = next.length ? Math.min(...next) : 18;
  const week = n => Number.isInteger(n) && n >= 1 && n <= 18;
  const start = week(raw?.start) ? raw.start : fallback;
  const picks = Object.fromEntries(Object.entries(raw?.picks ?? {}).filter(([w, t]) =>
    week(Number(w)) && teams.has(t)));
  return {start, end: week(raw?.end) && raw.end >= start ? raw.end : 18,
    ties: raw?.ties === true, used: [...new Set((Array.isArray(raw?.used) ? raw.used : []).filter(t => teams.has(t)))], picks};
}

export function validatePlan(data, state, now = Date.now(), allowMissing = false) {
  const errors = [];
  if (!Number.isInteger(state.start) || !Number.isInteger(state.end) || state.start < 1 || state.end > 18 || state.end < state.start) {
    return ["Choose a valid week range."];
  }
  const seen = new Set(state.used);
  // Picks outside the displayed range still reserve those teams.
  for (const [week, team] of Object.entries(state.picks)) {
    if (seen.has(team)) errors.push(`${team} is already used or picked in another week.`);
    seen.add(team);
    if (Number(week) < state.start || Number(week) > state.end) continue;
    const game = fixture(data, team, week);
    if (!playable(game, now) || probability(game, team, state.ties) === null) errors.push(`Week ${week}: ${team} has no available forecast (bye, started game, or missing data).`);
  }
  if (!allowMissing) for (let w = state.start; w <= state.end; w++) {
    if (!state.picks[w]) errors.push(`Choose a team for week ${w}.`);
  }
  return [...new Set(errors)];
}

// Rectangular Hungarian assignment: each week gets a different team. Minimizing
// -log(p) maximizes the product of fixed weekly survival probabilities.
export function minimumAssignment(costs) {
  const n = costs.length, m = costs[0]?.length ?? 0;
  if (!n) return [];
  if (m < n || costs.some(row => row.length !== m)) return null;
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0);
  const p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const min = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const value = costs[i0 - 1][j - 1] - u[i0] - v[j];
        if (value < min[j]) { min[j] = value; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      if (!Number.isFinite(delta)) return null;
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}

export function suggestPlan(data, state, now = Date.now(), keepPicks = true) {
  const picks = Object.fromEntries(Object.entries(state.picks).filter(([w]) =>
    keepPicks || Number(w) < state.start || Number(w) > state.end));
  const errors = validatePlan(data, {...state, picks}, now, true);
  if (errors.length) return {errors};
  const reserved = new Set([...state.used, ...Object.values(picks)]);
  const teams = data.teams.map(t => t.team).filter(t => !reserved.has(t));
  const weeks = [];
  for (let w = state.start; w <= state.end; w++) if (!picks[w]) weeks.push(w);
  const forbidden = 1e6;
  const costs = weeks.map(w => teams.map(team => {
    const game = fixture(data, team, w), p = probability(game, team, state.ties);
    return playable(game, now) && p > 0 ? -Math.log(p) : forbidden;
  }));
  const assignment = minimumAssignment(costs);
  if (!assignment || assignment.some((j, i) => costs[i][j] >= forbidden)) {
    return {errors: ["There are not enough eligible teams to fill this range. Shorten the range or free a reserved team."]};
  }
  assignment.forEach((j, i) => { picks[weeks[i]] = teams[j]; });
  return {picks, errors: []};
}

export function survivalPath(data, state) {
  let cumulative = 1;
  return Array.from({length: state.end - state.start + 1}, (_, i) => {
    const week = state.start + i, team = state.picks[week];
    const p = probability(fixture(data, team, week), team, state.ties);
    cumulative = cumulative !== null && p !== null ? cumulative * p : null;
    return {week, team, probability: p, cumulative};
  });
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function simulatePlans(data, states, {trials = 20000, seed = 2026, now = Date.now()} = {}) {
  if (!Number.isInteger(trials) || trials < 1 || trials > 100000) throw new Error("Invalid simulation count.");
  if (!states.length || states.some(s => validatePlan(data, s, now).length)) throw new Error("Complete valid plans before simulating.");
  if (states.some(s => s.start !== states[0].start || s.end !== states[0].end)) throw new Error("Compare the same week range.");
  const plans = states.map(s => survivalPath(data, s).map(row => ({...row, game: fixture(data, row.team, row.week)})));
  const games = [...new Map(plans.flat().map(row => [row.game.game_id, row.game])).values()];
  const random = seededRandom(seed), counts = plans.map(p => p.map(() => 0));
  for (let trial = 0; trial < trials; trial++) {
    // One outcome per GAME, shared across plans (opposing teams cannot both win).
    const outcomes = new Map(games.map(g => {
      const r = random();
      return [g.game_id, r < g.model.home_win ? g.home : r < g.model.home_win + g.model.away_win ? g.away : "tie"];
    }));
    plans.forEach((plan, j) => {
      let alive = true;
      plan.forEach((row, i) => {
        const result = outcomes.get(row.game.game_id);
        alive = alive && (result === row.team || (states[j].ties && result === "tie"));
        if (alive) counts[j][i]++;
      });
    });
  }
  return {trials, seed, plans: counts.map((row, j) => ({
    byWeek: row.map(n => n / trials), survival: row.at(-1) / trials,
    expected: survivalPath(data, states[j]).at(-1).cumulative
  }))};
}
