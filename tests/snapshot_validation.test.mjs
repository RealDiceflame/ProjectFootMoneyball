import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateRankings, validateReports, validateHistory, validateSpecialTeams, validateOdds} from "../docs/snapshot-validation.mjs";

const cases = [["rankings", validateRankings], ["player_news", validateReports],
  ["player_intel", validateReports], ["player_history", validateHistory],
  ["special_teams", validateSpecialTeams], ["nfl_odds", validateOdds]];

test("saved snapshots pass validation and malformed top-level responses fail closed", () => {
  for (const [name, validate] of cases) {
    const fixture = JSON.parse(readFileSync(new URL(`../docs/data/${name}.json`, import.meta.url), "utf8"));
    assert.equal(validate(fixture), true, name);
    for (const bad of [null, undefined, false, [], "unavailable", {}]) assert.equal(validate(bad), false, name);
  }
});

test("news arrays and nested player history must be renderable before replacing saved state", () => {
  for (const report of [null, [], {events: {}}, {events: [null]}, {sources: "bad"}, {injury: []}]) {
    assert.equal(validateReports({reports: {player: report}}), false);
  }
  assert.equal(validateReports({reports: {player: {events: [], injury: null}}}), true);
  for (const seasons of ["invalid", {}, [[2025]], [null]]) {
    assert.equal(validateHistory({columns: ["season", "games", "pos"], players: {player: {player: "Name", pos: "QB", seasons}}}), false);
  }
  assert.equal(validateHistory({columns: ["season", "games", "pos"], players: {player: {player: "Name", pos: "QB", seasons: [[2025, 17, "QB"]]}}}), true);
});

test("partial board rows, duplicated columns, and malformed odds are rejected", () => {
  const columns = ["player", "team", "pos", "projected_points", "overall_rank"];
  assert.equal(validateRankings({projection_season: 2026, columns, boards: {test: [["Name", "BUF", "QB", 300, 1]]}}), true);
  assert.equal(validateRankings({projection_season: 2026, columns, boards: {test: [["Name"]]}}), false);
  assert.equal(validateRankings({projection_season: 2026, columns: [...columns, "player"], boards: {test: [["Name", "BUF", "QB", 300, 1, "Name"]]}}), false);
  assert.equal(validateOdds({weeks: [3], games: [{game_id: "a", home: "BUF", away: "MIA", week: 3, rows: null}]}), false);
  for (const prediction_markets of [null, {}, [{contracts: {}}], [{contracts: [{label: "BUF", probability: 10}]}]]) {
    assert.equal(validateOdds({weeks: [3], games: [], prediction_markets}), false);
  }
  assert.equal(validateOdds({weeks: [3], games: [], prediction_markets: [{title: "Winner", contracts: [{label: "BUF", probability: .5}]}]}), true);
});
