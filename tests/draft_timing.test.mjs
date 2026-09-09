import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {draftTiming} from "../docs/draft-timing.mjs";
import {historicalRoundExpectations} from "../docs/draft-capital.mjs";

const current = (id, pos, adp, points) => ({player_id: id, pos, adp, projected_points: points});
function historicalRows(drops = [30, 30, 30, 30, 30], pos = "RB") {
  return drops.flatMap((drop, y) => [0, 1].flatMap(i => [
    {player_id: `early-${y}-${i}`, pos, season: 2016 + y, adp: 1 + i, actual_points: 150 + drop},
    {player_id: `late-${y}-${i}`, pos, season: 2016 + y, adp: 13 + i, actual_points: 150},
  ]));
}
const cell = (result, round, pos) => result.rounds.find(r => r.round === round).cells.find(c => c.pos === pos);

test("timing chooses the cost of waiting, not the highest raw scoring position", () => {
  const result = draftTiming([current("q1", "QB", 1, 350), current("q2", "QB", 13, 345),
    current("r1", "RB", 2, 240), current("r2", "RB", 14, 200)]);
  assert.deepEqual(result.rounds[0].priorities, ["RB"]);
  assert.equal(cell(result, 1, "RB").drop, 40);
  assert.equal(cell(result, 1, "QB").drop, 5);
  assert.equal(result.positions.find(p => p.pos === "RB").largest_drop.round, 1);
});

test("near ties share priorities while small changes create none", () => {
  const result = draftTiming([current("r1", "RB", 1, 200), current("r2", "RB", 13, 170),
    current("w1", "WR", 2, 225), current("w2", "WR", 14, 198)]);
  assert.deepEqual(new Set(result.rounds[0].priorities), new Set(["RB", "WR"]));
  const flat = draftTiming([current("r1", "RB", 1, 200), current("r2", "RB", 13, 195)]);
  assert.deepEqual(flat.rounds[0].priorities, []);
});

test("later improvement is preserved and missing/end rounds are not zero-filled", () => {
  const result = draftTiming([current("a", "RB", 1, 120), current("b", "RB", 13, 150), current("c", "TE", 1, 250)]);
  assert.equal(cell(result, 1, "RB").drop, -30);
  assert.equal(cell(result, 1, "RB").signal, false);
  assert.equal(cell(result, 1, "TE").drop, null);
  assert.equal(cell(result, 1, "TE").status, "missing");
  assert.equal(cell(result, 15, "RB").status, "beyond_map");
});

test("wait horizon and league size change the actual compared rounds", () => {
  const rows = [current("a", "RB", 1, 240), current("b", "RB", 13, 200), current("c", "RB", 25, 180)];
  assert.equal(cell(draftTiming(rows, {waitRounds: 2}), 1, "RB").drop, 60);
  assert.equal(cell(draftTiming(rows, {teams: 16}), 1, "RB").drop, 40);
  assert.equal(cell(draftTiming(rows, {waitRounds: 2}), 14, "RB").status, "beyond_map");
});

test("historical signals require enough seasons, distinct players and consistent direction", () => {
  const enough = draftTiming(historicalRows(), {historical: true});
  assert.equal(cell(enough, 1, "RB").signal, true);
  assert.equal(cell(enough, 1, "RB").years, 5);
  assert.equal(cell(enough, 1, "RB").declining_years, 5);
  assert.equal(cell(draftTiming(historicalRows([30]), {historical: true}), 1, "RB").status, "limited");
  const mixed = draftTiming(historicalRows([100, 100, -10, -10, -10]), {historical: true});
  assert.equal(cell(mixed, 1, "RB").status, "mixed");
  assert.deepEqual(mixed.rounds[0].priorities, []);
  const samePlayers = historicalRows().map(r => ({...r, player_id: r.adp <= 12 ? "a" : "b"}));
  assert.equal(cell(draftTiming(samePlayers, {historical: true}), 1, "RB").status, "limited");
});

test("paired-year weighting excludes unmatched years and does not favor busy draft years", () => {
  const rows = historicalRows([20, 20, 20, 20, 20]);
  rows.push({player_id: "unmatched", pos: "RB", season: 2010, adp: 1, actual_points: 900});
  for (let i = 0; i < 20; i++) rows.push({player_id: `extra${i}`, pos: "RB", season: 2016, adp: 1, actual_points: 170});
  const result = cell(draftTiming(rows, {historical: true}), 1, "RB");
  assert.equal(result.drop, 20);
  assert.equal(result.now_mean, 170);
  assert.equal(result.years, 5);
  const disjoint = rows.map(r => ({...r, season: r.adp > 12 ? r.season + 50 : r.season}));
  assert.equal(cell(draftTiming(disjoint, {historical: true}), 1, "RB").drop, null);
});

test("invalid data and duplicate player-seasons cannot manufacture a signal", () => {
  const rows = historicalRows();
  const valid = draftTiming(rows, {historical: true});
  const dirty = [...rows, rows[0], {...rows[0], player_id: "invalid", actual_points: null}, {...rows[0], player_id: "blank-adp", adp: ""}, {...rows[0], player_id: "no-year", season: null}];
  assert.deepEqual(draftTiming(dirty, {historical: true}), valid);
  assert.throws(() => draftTiming([], {waitRounds: 0}), /Invalid/);
  assert.throws(() => draftTiming([], {teams: 0}), /Invalid/);
  assert.deepEqual(draftTiming([]).rounds[0].priorities, []);
});

test("published historical signals are reproducible and format rescoring reaches the comparisons", () => {
  const bundle = JSON.parse(readFileSync(new URL("../docs/data/draft_capital_history.json", import.meta.url), "utf8"));
  const plain = historicalRoundExpectations(bundle, {teams: 12, ppr: "Standard", tePremium: "Off"});
  const premium = historicalRoundExpectations(bundle, {teams: 12, ppr: "Full PPR", tePremium: "+0.5"});
  const a = draftTiming(plain.rows, {historical: true}), b = draftTiming(premium.rows, {historical: true});
  assert.notEqual(cell(a, 8, "TE").drop, cell(b, 8, "TE").drop);
  assert.deepEqual(a, draftTiming(plain.rows, {historical: true}));
  for (const round of a.rounds) for (const c of round.cells) if (c.priority) {
    assert.ok(c.signal && c.drop >= 10 && c.years >= 5);
    assert.ok(c.declining_years / c.years >= 2 / 3);
  }
});
