import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {historicalRoundExpectations} from "../docs/draft-capital.mjs";

const bundle = {
  columns: ["season", "player_id", "player", "pos", "adp", "games", "rushing_yards", "receptions", "receiving_yards"],
  seasons: [2020, 2021], years: {
    2020: {rows: [[2020, "past", "Past Runner", "RB", 12, 16, 1000, 20, 100], [2020, "tight", "Tight End", "TE", 13, 16, 0, 60, 600]], coverage: {adp_players: 3, matched: 2, missing_stats: 1}},
    2021: {rows: [[2021, "past", "Past Runner", "RB", 24, 17, 800, 30, 200], [2021, "other", "Other Runner", "RB", 12, 17, 1200, 10, 100]], coverage: {adp_players: 2, matched: 2}},
  },
};
const settings = {teams: 12, ppr: "Standard", tePremium: "Off", quarterbacks: "1QB"};

test("historical rounds use the same year's ADP and actual season points", () => {
  const summary = historicalRoundExpectations(bundle, settings);
  const one = summary.cells.find(c => c.round === 1 && c.pos === "RB");
  const two = summary.cells.find(c => c.round === 2 && c.pos === "RB");
  assert.equal(one.mean, 120); assert.equal(one.count, 2); assert.equal(one.season_count, 2);
  assert.equal(two.mean, 100); assert.equal(two.count, 1);
  assert.equal(summary.in_rounds, 4);
  assert.ok(Math.abs(one.stddev - Math.sqrt(200)) < 1e-9);
  assert.equal(summary.coverage.missing_stats, 1);
});

test("year filters and team-count boundaries do not mix observations", () => {
  const year = historicalRoundExpectations(bundle, settings, "2020");
  assert.equal(year.in_rounds, 2);
  assert.deepEqual(year.seasons, [2020]);
  assert.equal(year.cells.find(c => c.round === 1 && c.pos === "RB").mean, 110);
  const eight = historicalRoundExpectations(bundle, {...settings, teams: 8}, "2020");
  assert.equal(eight.cells.find(c => c.round === 1 && c.pos === "RB").count, 0);
  assert.equal(eight.cells.find(c => c.round === 2 && c.pos === "RB").count, 1);
  assert.equal(historicalRoundExpectations(bundle, settings, "2016").in_rounds, 0);
});

test("PPR and season-specific TE scoring recalculate; QB count cannot rewrite history", () => {
  const full = historicalRoundExpectations(bundle, {...settings, ppr: "Full PPR", tePremium: "+0.5"}, "2020");
  assert.equal(full.cells.find(c => c.round === 2 && c.pos === "TE").mean, 150);
  assert.deepEqual(historicalRoundExpectations(bundle, {...settings, quarterbacks: "2QB"}), historicalRoundExpectations(bundle, settings));
});

test("duplicates and malformed rows are excluded without adding zero seasons", () => {
  const duplicate = structuredClone(bundle);
  duplicate.years[2020].rows.push(bundle.years[2020].rows[0], [2021, "wrong-year", "Wrong", "RB", 1, 17], [2020, "no-adp", "No ADP", "RB", null, 17]);
  const summary = historicalRoundExpectations(duplicate, settings);
  assert.equal(summary.in_rounds, 4);
  assert.equal(summary.cells.find(c => c.round === 1 && c.pos === "TE").mean, null);
  assert.equal(summary.cells.find(c => c.round === 2 && c.pos === "TE").stddev, null);
});

test("published dataset covers every maintained season and leaves current projections separate", () => {
  const data = JSON.parse(readFileSync(new URL("../docs/data/draft_capital_history.json", import.meta.url), "utf8"));
  const summary = historicalRoundExpectations(data, {...settings, ppr: "Half PPR", tePremium: "+0.5"});
  assert.equal(summary.seasons.length, 10);
  assert.ok(summary.rows.length > 2800);
  assert.ok(summary.in_rounds > 1000);
  assert.ok(summary.rows.every(row => !Object.hasOwn(row, "projected_points")));
  for (const season of data.seasons) assert.ok(historicalRoundExpectations(data, settings, season).in_rounds > 50);
});
