// Score-level scenarios, separate from the survivor planner's normal-margin approximation.
import {seededRandom, playable} from "./survivor-model.mjs?v=1";

const finite = value => typeof value === "number" && Number.isFinite(value);
const HOUR = 3600000;

export function upcomingGames(data, now = Date.now()) {
  return data.games.filter(game => playable(game, now)).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

export function matchupForecast(data, home, away, neutral = false) {
  const h = data.teams.find(team => team.team === home), a = data.teams.find(team => team.team === away);
  if (!h || !a || home === away) throw new Error("Choose two different NFL teams.");
  if (![data.league_points, data.home_advantage, h.offense, h.defense, a.offense, a.defense].every(finite)) {
    throw new Error("Team scoring estimates are unavailable.");
  }
  const advantage = neutral ? 0 : data.home_advantage / 2;
  return {home, away, neutral, home_points: Math.max(3, data.league_points + h.offense - a.defense + advantage),
    away_points: Math.max(3, data.league_points + a.offense - h.defense - advantage)};
}

function weightedPool(rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) throw new Error("Not enough scoring variation to simulate this matchup.");
  let cumulative = 0;
  return rows.map(row => ({...row, cumulative: cumulative += row.weight / total}));
}

function sample(pool, random) {
  const draw = random();
  let low = 0, high = pool.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (draw <= pool[middle].cumulative) high = middle; else low = middle + 1;
  }
  return pool[low];
}

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b), n = values.length;
  if (!n || values.some(value => !finite(value))) throw new Error("Invalid simulated scores.");
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const quantile = p => {
    const index = (n - 1) * p, lower = Math.floor(index);
    return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
  };
  return {mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n),
    p10: quantile(.1), p50: quantile(.5), p90: quantile(.9)};
}

export function histogram(values, width = 4) {
  const counts = new Map();
  for (const value of values) {
    const start = Math.floor(value / width) * width;
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  const first = Math.min(...counts.keys()), last = Math.max(...counts.keys());
  return Array.from({length: Math.round((last - first) / width) + 1}, (_, i) => {
    const start = first + i * width;
    return {start, end: start + width - 1, probability: (counts.get(start) ?? 0) / values.length};
  });
}

export function simulateMatchup(data, choice, {trials = 20000, seed = 2026, now = Date.now()} = {}) {
  if (!Number.isInteger(trials) || trials < 100 || trials > 100000) throw new Error("Invalid simulation count.");
  const forecast = matchupForecast(data, choice.home, choice.away, choice.neutral === true);
  if (choice.game_id) {
    const scheduled = data.games.find(game => game.game_id === choice.game_id);
    if (!playable(scheduled, now) || scheduled.home !== choice.home || scheduled.away !== choice.away || scheduled.neutral !== forecast.neutral) {
      throw new Error("This game has started or its schedule changed. Choose another game or a hypothetical matchup.");
    }
    if (![scheduled.model.home_points, scheduled.model.away_points].every(finite)) throw new Error("Scheduled scores are unavailable.");
    forecast.home_points = scheduled.model.home_points;
    forecast.away_points = scheduled.model.away_points;
  }
  const errors = data.simulation?.residuals;
  if (!Array.isArray(errors) || errors.length < 100 || errors.some(row => !Array.isArray(row) || row.length !== 3 || !row.every(finite) || row[2] <= 0)) {
    throw new Error("Historical scoring variation is unavailable. The next successful data update will restore simulations.");
  }
  const tie = data.training?.tie_probability;
  if (!finite(tie) || tie < 0 || tie > .1) throw new Error("The tie estimate is invalid.");
  const weightSum = errors.reduce((sum, row) => sum + row[2], 0);
  const means = [0, 1].map(side => errors.reduce((sum, row) => sum + row[side] * row[2], 0) / weightSum);
  // Center held-out errors, preserving their within-game pairing and recency weights.
  // Neutral sites symmetrize the error roles as well as removing home advantage.
  const scenarios = errors.flatMap(([h, a, weight]) => {
    const offsets = [[h - means[0], a - means[1]]];
    if (forecast.neutral) offsets.push([a - means[1], h - means[0]]);
    return offsets.map(([dh, da]) => ({home: Math.max(0, Math.round(forecast.home_points + dh)),
      away: Math.max(0, Math.round(forecast.away_points + da)), weight: weight / offsets.length}));
  });
  const decisive = weightedPool(scenarios.filter(row => row.home !== row.away));
  const tied = weightedPool(scenarios.map(row => ({home: Math.round((row.home + row.away) / 2),
    away: Math.round((row.home + row.away) / 2), weight: row.weight})));
  const random = seededRandom(seed), scores = {home: [], away: [], margin: [], total: []};
  const counts = {home: 0, away: 0, tie: 0};
  const outcomes = [0, 0, 0, 0, 0, 0, 0]; // Away 15+, 8–14, 1–7; tie; home 1–7, 8–14, 15+.
  for (let i = 0; i < trials; i++) {
    const row = sample(random() < tie ? tied : decisive, random), margin = row.home - row.away;
    scores.home.push(row.home); scores.away.push(row.away); scores.margin.push(margin); scores.total.push(row.home + row.away);
    counts[margin > 0 ? "home" : margin < 0 ? "away" : "tie"]++;
    const bucket = margin < -14 ? 0 : margin < -7 ? 1 : margin < 0 ? 2 : margin === 0 ? 3 : margin <= 7 ? 4 : margin <= 14 ? 5 : 6;
    outcomes[bucket]++;
  }
  return {forecast, trials, seed, probabilities: Object.fromEntries(Object.entries(counts).map(([key, n]) => [key, n / trials])),
    stats: Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, summarize(values)])),
    histograms: Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, histogram(values, key === "margin" ? 3 : 4)])),
    outcomes: outcomes.map(n => n / trials)};
}

const validPrice = row => finite(row?.price) && Math.abs(row.price) >= 100;
const safeUrl = value => { try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; } };

// Never attach a line by team names alone: require the same fixture, venue and kickoff.
export function matchupMarkets(data, odds, choice, now = Date.now()) {
  const upcoming = upcomingGames(data, now), week = upcoming[0]?.week;
  const game = upcoming.find(g => (choice.game_id ? g.game_id === choice.game_id : true)
    && g.home === choice.home && g.away === choice.away && g.neutral === (choice.neutral === true)
    && g.week === week && Date.parse(g.kickoff) - now <= 8 * 24 * HOUR);
  if (!game) return {status: "not_this_week", books: [], game: null};
  if (!odds || odds.season !== data.season || !Array.isArray(odds.games)) return {status: "unavailable", books: [], game};
  const saved = odds.games.find(g => g.game_id === game.game_id && g.home === game.home && g.away === game.away
    && Date.parse(g.kickoff) === Date.parse(game.kickoff));
  if (!saved) return {status: "unavailable", books: [], game};
  const groups = new Map();
  for (const row of Array.isArray(saved.rows) ? saved.rows : []) {
    if (!row || typeof row !== "object") continue;
    if (!["sportsbook", "exchange", "reference"].includes(row.provider_kind) || !row.provider_key || !validPrice(row)) continue;
    const age = now - Date.parse(row.updated_at);
    if (row.provider_kind !== "reference" && (!Number.isFinite(age) || age < 0 || age > 48 * HOUR)) continue;
    if (!["Moneyline", "Spread", "Total"].includes(row.market)) continue;
    if (row.market !== "Moneyline" && (!finite(row.line) || (row.market === "Total" && row.line <= 0))) continue;
    const key = `${row.provider_kind}:${row.provider_key}`;
    if (!groups.has(key)) groups.set(key, {provider: row.provider || row.provider_key, kind: row.provider_kind,
      url: safeUrl(row.provider_url), rows: [], markets: {}});
    groups.get(key).rows.push(row);
  }
  for (const book of groups.values()) {
    for (const market of ["Moneyline", "Spread", "Total"]) {
      const rows = book.rows.filter(row => row.market === market).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const selections = market === "Total" ? ["Over", "Under"] : [game.home, game.away];
      for (const first of rows.filter(row => row.selection === selections[0])) {
        const second = rows.find(row => row.selection === selections[1]
          && (market === "Moneyline" || (market === "Spread" ? Math.abs(row.line + first.line) < 1e-8 : row.line === first.line))
          && (book.kind === "reference" || Math.abs(Date.parse(row.updated_at) - Date.parse(first.updated_at)) <= HOUR));
        if (second) { book.markets[market] = [first, second]; break; }
      }
    }
    delete book.rows;
  }
  const books = [...groups.values()].filter(book => Object.keys(book.markets).length);
  return {status: books.some(book => book.kind !== "reference") ? "available" : "no_current_quotes", books, game, generated_at: odds.generated_at};
}
