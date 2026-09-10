import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {simulateLeague, playPostseason, DIVISIONS} from "../docs/league-model.mjs";
import {careerRelativeSamples, roundLineSegments} from "../docs/lab-charts.mjs";

const data = JSON.parse(readFileSync(new URL("../docs/data/survivor.json", import.meta.url)));
const now = Date.parse(data.generated_at);
test("league conservation, playoff quotas, sample bracket and repeatability", () => {
  const result = simulateLeague(data, {trials: 100, seed: 7, now});
  assert.deepEqual(result, simulateLeague(data, {trials: 100, seed: 7, now}));
  assert.equal(result.teams.length, 32); assert.equal(result.games.length, 272);
  const sum = key => result.teams.reduce((total, row) => total + row[key], 0);
  const wins = result.teams.reduce((total, row) => total + row.wins.mean, 0);
  assert.ok(Math.abs(wins - sum("losses")) < 1e-8);
  assert.ok(Math.abs(wins + sum("ties") / 2 - 272) < 1e-8);
  assert.ok(Math.abs(sum("points_for") - sum("points_against")) < 1e-8);
  for (const [key, expected] of Object.entries({division_probability: 8, playoff_probability: 14, bye_probability: 2, conference_probability: 2, champion_probability: 1})) assert.ok(Math.abs(sum(key) - expected) < 1e-8);
  result.teams.forEach(row => {
    assert.ok(Math.abs(row.wins.mean + row.losses + row.ties - 17) < 1e-8);
    assert.ok(row.champion_probability <= row.conference_probability && row.conference_probability <= row.playoff_probability);
  });
  assert.equal(result.example.postseason.rounds.length, 13);
  for (const conf of ["AFC", "NFC"]) {
    assert.equal(new Set(result.example.seeds[conf]).size, 7);
    const champions = Object.entries(result.example.divisions).filter(([division]) => division.startsWith(conf)).map(([, teams]) => teams[0]);
    assert.deepEqual(new Set(result.example.seeds[conf].slice(0, 4)), new Set(champions));
  }
});

test("completed results stay fixed; unfinished games are not called live forecasts", () => {
  const current = structuredClone(data), first = current.games[0];
  first.status = "final"; first.home_score = 31; first.away_score = 20; first.model = null;
  const clock = Date.parse(first.kickoff) + 7 * 3600000;
  const result = simulateLeague(current, {trials: 100, now: clock});
  const fixed = result.games.find(game => game.game_id === first.game_id);
  assert.equal(fixed.home_stats.mean, 31); assert.equal(fixed.home_stats.sd, 0); assert.equal(fixed.home_win, 1);
  first.status = "locked"; first.home_score = null; first.away_score = null;
  assert.ok(simulateLeague(current, {trials: 100, now: clock}).games.find(game => game.game_id === first.game_id).unresolved);
  assert.throws(() => simulateLeague({...data, games: data.games.slice(1)}, {trials: 100, now}), /complete/);
});

test("playoff bracket gives byes, reseeds, uses higher seed home and neutral Super Bowl", () => {
  const seeds = {AFC: ["BUF", "BAL", "HOU", "KC", "PIT", "MIA", "DEN"], NFC: ["PHI", "DET", "TB", "SF", "GB", "LA", "DAL"]};
  const result = playPostseason(seeds, (home, away, neutral) => ({home: neutral ? 20 : 17, away: neutral ? 17 : 24}));
  for (const conf of ["AFC", "NFC"]) {
    const wild = result.rounds.filter(game => game.conference === conf && game.round === "Wild card");
    assert.deepEqual(wild.map(game => [game.home_seed, game.away_seed]), [[2, 7], [3, 6], [4, 5]]);
    const division = result.rounds.filter(game => game.conference === conf && game.round === "Divisional");
    assert.deepEqual(division.map(game => [game.home_seed, game.away_seed]), [[1, 7], [5, 6]]);
  }
  assert.equal(result.rounds.at(-1).neutral, true);
  assert.equal(Object.values(DIVISIONS).flat().length, 32);
});

test("career-relative view compares each player's own observed peak and keeps thin histories out", () => {
  const samples = [10, 20, 10].map((ppg, i) => ({identity: "a", pos: "RB", games: 10, age: 22 + i, fantasy_points_per_game: ppg}));
  const result = careerRelativeSamples([...samples, {identity: "b", pos: "RB", games: 17, fantasy_points_per_game: 40}], "RB");
  assert.deepEqual(result.map(row => row.fantasy_points_per_game), [50, 100, 50]);
  assert.equal(samples[0].fantasy_points_per_game, 10);
  assert.deepEqual(roundLineSegments([{round: 1, pos: "RB", mean: 100, count: 2}, {round: 3, pos: "RB", mean: 90, count: 2}], "RB").map(part => part.length), [1, 1]);
});

test("new page controls, shared menus and historical default are wired", () => {
  const html = readFileSync(new URL("../docs/league.html", import.meta.url), "utf8"), js = readFileSync(new URL("../docs/league.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), id);
  const projection = readFileSync(new URL("../docs/projection.js", import.meta.url), "utf8");
  assert.match(projection, /roundSeason: params.get\("roundSeason"\) \|\| "all"/);
  for (const page of ["index", "projection", "survivor", "special-teams", "odds", "league"]) assert.match(readFileSync(new URL(`../docs/${page}.html`, import.meta.url), "utf8"), /site-nav.js/);
});
