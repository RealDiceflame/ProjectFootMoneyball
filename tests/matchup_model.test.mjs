import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {matchupForecast, simulateMatchup, matchupMarkets, upcomingGames, summarize} from "../docs/matchup-model.mjs";

const now = Date.parse("2026-09-09T12:00:00Z");
const game = {game_id: "g", week: 1, home: "BUF", away: "KC", neutral: false, kickoff: "2026-09-10T20:00:00Z", status: "scheduled",
  model: {home_points: 25, away_points: 21, home_win: .6, away_win: .398, tie: .002}};
const data = {season: 2026, league_points: 23, home_advantage: 2, training: {tie_probability: .002},
  teams: [{team: "BUF", offense: 2, defense: 1}, {team: "KC", offense: 0, defense: 1}], games: [game],
  simulation: {residuals: Array.from({length: 120}, (_, i) => [i % 21 - 10, (i * 7) % 23 - 11, 1 + i / 120])}};
const choice = {home: "BUF", away: "KC", neutral: false};
const quote = (selection, market, line, extras = {}) => ({selection, market, line, price: -110, provider: "Example", provider_key: "example", provider_kind: "sportsbook", provider_url: "https://example.com", updated_at: "2026-09-09T11:00:00Z", ...extras});
const odds = rows => ({season: 2026, games: [{...game, rows}]});

test("home field, opponent defense, neutral symmetry and team identity", () => {
  const home = matchupForecast(data, "BUF", "KC"), neutral = matchupForecast(data, "BUF", "KC", true);
  assert.equal(home.home_points - neutral.home_points, 1);
  assert.equal(home.away_points - neutral.away_points, -1);
  const reverse = matchupForecast(data, "KC", "BUF", true);
  assert.equal(neutral.home_points, reverse.away_points);
  assert.equal(neutral.away_points, reverse.home_points);
  const strongerDefense = structuredClone(data); strongerDefense.teams[1].defense += 3;
  assert.equal(matchupForecast(strongerDefense, "BUF", "KC").home_points, home.home_points - 3);
  assert.throws(() => matchupForecast(data, "BUF", "BUF"), /different/);
  assert.throws(() => matchupForecast(data, "UNKNOWN", "KC"), /different/);
});

test("reproducible score scenarios: probabilities, ranges, SD and histogram mass", () => {
  const result = simulateMatchup(data, choice, {now});
  assert.deepEqual(result, simulateMatchup(data, choice, {now}));
  assert.ok(Math.abs(Object.values(result.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.ok(Math.abs(result.outcomes.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.ok(Math.abs(result.probabilities.tie - .002) < .0015);
  assert.equal(result.probabilities.tie, result.outcomes[3]);
  assert.ok(Math.abs(result.stats.margin.mean - (result.stats.home.mean - result.stats.away.mean)) < 1e-10);
  assert.ok(Math.abs(result.stats.total.mean - (result.stats.home.mean + result.stats.away.mean)) < 1e-10);
  for (const [key, stat] of Object.entries(result.stats)) {
    assert.ok(stat.sd > 0 && stat.p10 <= stat.p50 && stat.p50 <= stat.p90);
    assert.ok(Math.abs(result.histograms[key].reduce((sum, bin) => sum + bin.probability, 0) - 1) < 1e-10);
    if (key !== "margin") assert.ok(result.histograms[key][0].start >= 0);
  }
  assert.equal(summarize([1, 2, 3]).mean, 2);
  assert.ok(Math.abs(summarize([1, 2, 3]).sd - Math.sqrt(2 / 3)) < 1e-10);
});

test("scheduled games lock at kickoff, and invalid residuals fail rather than inventing variation", () => {
  assert.equal(upcomingGames(data, now).length, 1);
  assert.equal(upcomingGames(data, Date.parse(game.kickoff)).length, 0);
  assert.throws(() => simulateMatchup(data, {...choice, game_id: "g"}, {now: Date.parse(game.kickoff)}), /started/);
  assert.throws(() => simulateMatchup(data, {...choice, neutral: true, game_id: "g"}, {now}), /schedule/);
  assert.throws(() => simulateMatchup({...data, simulation: {}}, choice, {now}), /variation/);
  assert.throws(() => simulateMatchup({...data, simulation: {residuals: [[0, 0, -1]]}}, choice, {now}), /variation/);
  assert.throws(() => simulateMatchup(data, choice, {trials: 2, now}), /count/);
});

test("neutral identical teams do not acquire a systematic home advantage", () => {
  const equal = structuredClone(data); equal.teams[0].offense = 0;
  const result = simulateMatchup(equal, {...choice, neutral: true}, {now});
  assert.ok(Math.abs(result.probabilities.home - result.probabilities.away) < .02);
});

test("market pairs match the actual fixture, orientation, week, line and quote age", () => {
  const pair = [quote("BUF", "Spread", -3.5), quote("KC", "Spread", 3.5)];
  assert.equal(matchupMarkets(data, odds(pair), choice, now).status, "available");
  assert.equal(matchupMarkets(data, odds(pair), {...choice, neutral: true}, now).status, "not_this_week");
  assert.equal(matchupMarkets(data, odds(pair), {home: "KC", away: "BUF"}, now).status, "not_this_week");
  for (const rows of [pair.slice(0, 1), [pair[0], {...pair[1], line: 4}], [pair[0], {...pair[1], provider_key: "different"}],
    pair.map(row => ({...row, updated_at: "2026-09-07T11:00:00Z"})),
    pair.map(row => ({...row, updated_at: "2026-09-10T11:00:00Z"})),
    [pair[0], {...pair[1], updated_at: "2026-09-09T08:00:00Z"}],
    pair.map(row => ({...row, line: null}))]) {
    assert.equal(matchupMarkets(data, odds(rows), choice, now).books.length, 0);
  }
  const moved = odds(pair); moved.games[0].kickoff = "2026-09-11T20:00:00Z";
  assert.equal(matchupMarkets(data, moved, choice, now).status, "unavailable");
  assert.equal(matchupMarkets(data, odds(pair), choice, Date.parse(game.kickoff)).status, "not_this_week");
  const later = {...data, games: [{...game, week: 2, game_id: "later", kickoff: "2026-09-18T20:00:00Z"}]};
  assert.equal(matchupMarkets(later, odds(pair), choice, now).status, "not_this_week");
});

test("reference data never masquerades as a current quote, and unsafe links are removed", () => {
  const rows = [quote("BUF", "Moneyline", null), quote("KC", "Moneyline", null)].map(row => ({...row,
    provider_kind: "reference", updated_at: null, provider_url: "javascript:alert(1)"}));
  const result = matchupMarkets(data, odds(rows), choice, now);
  assert.equal(result.status, "no_current_quotes");
  assert.equal(result.books[0].kind, "reference"); assert.equal(result.books[0].url, null);
  assert.equal(matchupMarkets(data, null, choice, now).status, "unavailable");
});

test("published snapshot supports real matchup distributions without changing survivor forecasts", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../docs/data/survivor.json", import.meta.url)));
  const before = JSON.stringify(snapshot.games), original = snapshot.games.find(g => g.status === "scheduled");
  assert.ok(snapshot.simulation.residuals.length >= 100);
  const asOf = Date.parse(original.kickoff) - 3600000;
  const result = simulateMatchup(snapshot, {...original}, {now: asOf});
  assert.equal(result.forecast.home_points, original.model.home_points);
  assert.equal(result.forecast.away_points, original.model.away_points);
  assert.ok(result.stats.margin.sd > 5 && result.stats.margin.sd < 30);
  assert.equal(JSON.stringify(snapshot.games), before);
});
