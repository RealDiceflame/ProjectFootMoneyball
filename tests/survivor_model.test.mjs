import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fixture, playable, probability, sanitizeState, validatePlan, minimumAssignment, suggestPlan, survivalPath, simulatePlans} from "../docs/survivor-model.mjs";

const now = Date.parse("2026-09-01T12:00:00Z");
const game = (week, home, away, homeWin, tie = 0) => ({game_id: `${week}-${home}-${away}`, week, home, away,
  kickoff: "2026-12-01T20:00:00Z", status: "scheduled", model: {home_win: homeWin, away_win: 1 - homeWin - tie, tie}});
const data = {teams: ["A", "B", "C", "D"].map(team => ({team})), games: [game(1, "A", "C", .9), game(1, "B", "D", .8), game(2, "A", "C", .99), game(2, "B", "D", .55)]};
const state = (extra = {}) => ({start: 1, end: 2, used: [], picks: {}, ties: false, ...extra});

test("assignment saves a scarce high-probability team for the right week", () => {
  const result = suggestPlan(data, state(), now);
  assert.deepEqual(result.picks, {1: "B", 2: "A"});
  assert.equal(validatePlan(data, state({picks: result.picks}), now).length, 0);
  assert.equal(survivalPath(data, state({picks: result.picks})).at(-1).cumulative, .8 * .99);
});

test("assignment agrees with exhaustive permutations for rectangular matrices", () => {
  const permute = (list, count) => count ? list.flatMap((x, i) => permute(list.filter((_, j) => i !== j), count - 1).map(tail => [x, ...tail])) : [[]];
  for (let seed = 1; seed < 25; seed++) {
    const costs = Array.from({length: 3}, (_, i) => Array.from({length: 5}, (_, j) => ((seed * (i + 7) * (j + 3) + i * j) % 37) / 10));
    const result = minimumAssignment(costs);
    const cost = result.reduce((sum, j, i) => sum + costs[i][j], 0);
    const exact = Math.min(...permute([0, 1, 2, 3, 4], 3).map(path => path.reduce((sum, j, i) => sum + costs[i][j], 0)));
    assert.ok(Math.abs(cost - exact) < 1e-9);
  }
  assert.equal(minimumAssignment([[1], [2]]), null);
  assert.deepEqual(minimumAssignment([]), []);
});

test("used teams, duplicates, missing weeks, byes, and kickoff locks", () => {
  assert.ok(validatePlan(data, state({picks: {1: "A", 2: "A"}}), now).some(e => e.includes("already used")));
  assert.ok(validatePlan(data, state({used: ["A"], picks: {1: "A", 2: "B"}}), now).length);
  assert.ok(validatePlan(data, state({picks: {1: "B"}}), now).some(e => e.includes("week 2")));
  const bye = {...data, games: data.games.filter(g => !(g.week === 2 && g.home === "A"))};
  assert.ok(validatePlan(bye, state({picks: {1: "B", 2: "A"}}), now).some(e => e.includes("available forecast")));
  assert.equal(playable(data.games[0], Date.parse(data.games[0].kickoff)), false);
  assert.equal(playable({...data.games[0], status: "locked"}, now), false);
  assert.equal(survivalPath(data, state({picks: {2: "A"}})).at(-1).cumulative, null);
});

test("fill keeps manual picks; fresh comparison frees only picks inside range", () => {
  assert.deepEqual(suggestPlan(data, state({picks: {1: "A"}}), now).picks, {1: "A", 2: "B"});
  const fresh = suggestPlan(data, state({picks: {1: "A", 3: "B"}}), now, false);
  assert.equal(fresh.picks[3], "B");
  assert.notEqual(fresh.picks[1], "B");
  assert.notEqual(fresh.picks[2], "B");
  assert.ok(suggestPlan(data, state({used: ["A", "B", "C"]}), now).errors.length);
  assert.deepEqual(suggestPlan(data, state({picks: {1: "B", 2: "A"}}), now).picks, {1: "B", 2: "A"});
});

test("storage sanitation discards unknown teams, weeks, and malformed options", () => {
  const clean = sanitizeState({start: -1, end: 99, ties: "true", used: ["A", "A", "alien"], picks: {1: "B", 2: "alien", 80: "A"}}, data, now);
  assert.deepEqual(clean, {start: 1, end: 18, ties: false, used: ["A"], picks: {1: "B"}});
  assert.equal(sanitizeState(null, data, now).start, 1);
});

test("tie rules and shared outcomes prevent opposing wins", () => {
  const single = {...data, games: [game(1, "A", "B", .6, .02)]};
  assert.equal(probability(single.games[0], "A", true), .62);
  const a = state({end: 1, picks: {1: "A"}}), b = state({end: 1, picks: {1: "B"}});
  const result = simulatePlans(single, [a, b, a], {now, trials: 20000, seed: 42});
  assert.deepEqual(result.plans[0], result.plans[2]);
  assert.ok(result.plans[0].survival + result.plans[1].survival <= 1);
  assert.ok(Math.abs(result.plans[0].survival - .6) < .015);
  assert.deepEqual(result, simulatePlans(single, [a, b, a], {now, trials: 20000, seed: 42}));
  const tieOnly = {...single, games: [game(1, "A", "B", 0, 1)]};
  const ties = simulatePlans(tieOnly, [{...a, ties: true}, a], {now, trials: 100});
  assert.equal(ties.plans[0].survival, 1); assert.equal(ties.plans[1].survival, 0);
});

test("simulations reject invalid plans and compare like-for-like windows", () => {
  assert.throws(() => simulatePlans(data, [state()], {now}), /valid plans/);
  assert.throws(() => simulatePlans(data, [], {now}), /valid plans/);
  const complete = state({picks: {1: "B", 2: "A"}});
  assert.throws(() => simulatePlans(data, [complete], {now, trials: 0}), /count/);
  assert.throws(() => simulatePlans(data, [complete, {...complete, end: 1}], {now}), /same week range/);
});

test("published remaining-season path has unique eligible teams", () => {
  const published = JSON.parse(readFileSync(new URL("../docs/data/survivor.json", import.meta.url), "utf8"));
  const clock = Date.parse(published.generated_at), defaults = sanitizeState(null, published, clock);
  const result = suggestPlan(published, defaults, clock);
  if (!published.games.some(g => playable(g, clock))) {
    assert.ok(result.errors.length);
    return;
  }
  assert.deepEqual(result.errors, []);
  const weeks = defaults.end - defaults.start + 1;
  assert.equal(Object.keys(result.picks).length, weeks);
  assert.equal(new Set(Object.values(result.picks)).size, weeks);
  assert.deepEqual(validatePlan(published, {...defaults, picks: result.picks}, clock), []);
  for (const [week, team] of Object.entries(result.picks)) assert.ok(playable(fixture(published, team, week), clock));
});

test("navigation, page controls, and imported modules stay connected", () => {
  const html = readFileSync(new URL("../docs/survivor.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../docs/survivor.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), `Missing control: ${id}`);
  for (const page of ["index", "projection", "special-teams", "odds"]) {
    assert.match(readFileSync(new URL(`../docs/${page}.html`, import.meta.url), "utf8"), /href="survivor.html"/);
  }
  assert.match(html, /survivor\.js\?v=[\w-]+/);
  assert.match(html, /survivor\.css\?v=[\w-]+/);
  assert.match(js, /initMatchup\(data\)/);
  const matchup = readFileSync(new URL("../docs/matchup.js", import.meta.url), "utf8");
  for (const [, id] of matchup.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), `Missing matchup control: ${id}`);
  for (const name of ["matchup.js", "matchup-model.mjs"]) {
    const code = readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
    for (const [, module] of code.matchAll(/from "(\.\/[^"?]+)(?:\?[^"\n]*)?"/g)) {
      assert.ok(readFileSync(new URL(`../docs/${module}`, import.meta.url), "utf8").length);
    }
  }
});
