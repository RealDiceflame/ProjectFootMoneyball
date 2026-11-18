import assert from "node:assert/strict";
import test from "node:test";

import {
  ageChangeFactor,
  ageOnSeptemberFirst,
  applyProjectionModel,
  buildPositionSamples,
  positionAgeCurve,
  projectPlayer,
  projectionSummary,
  roundPositionExpectations,
} from "../docs/projection-model.mjs";

const settings = { teams: "12", quarterbacks: "1QB", ppr: "Standard", tePremium: "Off" };

const history = {
  columns: ["season", "team", "games", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fumbles_total"],
  players: {
    "id:runner-1": { seasons: [
      [2025, "BUF", 15, 1200, 10, 30, 250, 2, 1],
      [2024, "BUF", 17, 1000, 8, 25, 200, 1, 1],
    ] },
    "id:runner-2": { seasons: [
      [2025, "KC", 17, 900, 7, 40, 350, 2, 1],
      [2024, "KC", 16, 800, 6, 35, 300, 2, 1],
    ] },
  },
};

const news = {
  reports: {
    "runner one|BUF": { player: "Runner One", player_id: "runner-1", pos: "RB", team: "BUF", listed_team: "BUF", birth_date: "2001-02-14" },
    "runner two|KC": { player: "Runner Two", player_id: "runner-2", pos: "RB", team: "KC", listed_team: "KC", birth_date: "1999-10-10" },
  },
};

const players = [
  { player: "Runner One", player_id: "runner-1", team: "BUF", pos: "RB", projected_points: 300, adp: 10, is_rookie: false },
  { player: "Runner Two", player_id: "runner-2", team: "KC", pos: "RB", projected_points: 250, adp: 20, is_rookie: false },
];

test("calculates a player's football-season age on September 1", () => {
  assert.equal(ageOnSeptemberFirst("2000-08-31", 2026), 26);
  assert.equal(ageOnSeptemberFirst("2000-09-02", 2026), 25);
  assert.equal(ageOnSeptemberFirst(null, 2026), null);
});

test("builds position age samples and a smoothed mean with standard deviation", () => {
  const samples = buildPositionSamples(players, history, news, settings);
  assert.equal(samples.length, 4);
  assert.deepEqual([...new Set(samples.map(sample => sample.pos))], ["RB"]);
  const curve = positionAgeCurve(samples, "RB");
  assert.ok(curve.length >= 3);
  assert.ok(curve.every(point => Number.isFinite(point.mean)));
  assert.ok(curve.some(point => Number.isFinite(point.stddev)));
});

test("learns bounded age changes from consecutive player seasons", () => {
  const samples = [
    { identity: "a", pos: "WR", season: 2024, age: 23, games: 17, fantasy_points_per_game: 10 },
    { identity: "a", pos: "WR", season: 2025, age: 24, games: 17, fantasy_points_per_game: 12 },
    { identity: "b", pos: "WR", season: 2024, age: 23, games: 16, fantasy_points_per_game: 8 },
    { identity: "b", pos: "WR", season: 2025, age: 24, games: 16, fantasy_points_per_game: 9 },
  ];
  const result = ageChangeFactor(samples, "WR", 24);
  assert.equal(result.count, 2);
  assert.ok(result.factor > 1 && result.factor <= 1.12);
});

test("projects per-game production, availability, and a season total instead of copying a 17-game pace", () => {
  const samples = buildPositionSamples(players, history, news, settings);
  const projection = projectPlayer(players[0], history, news, settings, 2026, samples);
  assert.equal(projection.age, 25);
  assert.equal(projection.history_seasons, 2);
  assert.ok(projection.expected_games < 17);
  assert.ok(projection.projected_points < projection.projected_17_game_pace);
  assert.ok(Number.isFinite(projection.projected_ppg));
  assert.equal(projection.source, "age_curve");
});

test("re-ranks modeled players and summarizes season points by draft round", () => {
  const modeled = applyProjectionModel(players, history, news, settings, 2026).rows;
  assert.deepEqual(modeled.map(row => row.overall_rank), [1, 2]);
  assert.ok(modeled.every(row => Number.isFinite(row.projected_ppg)));
  assert.deepEqual(new Set(modeled.map(row => row.position_rank)), new Set(["RB1", "RB2"]));
  const rounds = roundPositionExpectations(modeled, 12, 2);
  const firstRoundRb = rounds.find(item => item.round === 1 && item.pos === "RB");
  const secondRoundRb = rounds.find(item => item.round === 2 && item.pos === "RB");
  assert.equal(firstRoundRb.count, 1);
  assert.equal(secondRoundRb.count, 1);
  assert.ok(Number.isFinite(firstRoundRb.mean));
});

test("historical careers contribute to age curves without entering the live draft board", () => {
  const expanded = structuredClone(history);
  expanded.players["id:past-runner"] = {
    player: "Past Runner", player_id: "past-runner", pos: "RB", birth_date: "1994-01-01", is_ranked: false,
    seasons: [[2021, "BUF", 16, 1000, 8, 40, 300, 2, 0], [2020, "BUF", 16, 1400, 10, 40, 400, 2, 0]],
  };
  expanded.players["id:unknown-birthday"] = {
    player: "Unknown Birthday", player_id: "unknown-birthday", pos: "RB", is_ranked: false,
    seasons: [[2021, "BUF", 16, 1000, 8, 40, 300, 2, 0]],
  };
  const model = applyProjectionModel(players, expanded, news, settings, 2026);
  const pastSamples = model.samples.filter(row => row.identity === "id:past-runner");
  assert.equal(pastSamples.length, 2);
  assert.deepEqual(pastSamples.map(row => row.age), [27, 26]);
  assert.ok(pastSamples.every(row => row.is_historical));
  assert.equal(model.samples.length, 6);
  assert.equal(model.rows.length, players.length);
  assert.ok(model.rows.every(row => row.player_id !== "past-runner"));
  assert.ok(ageChangeFactor(pastSamples, "RB", 27).factor < 1);
  assert.ok(!model.samples.some(row => row.identity === "id:past-runner" && row.season > 2021));
});

test("archive identities supply birth dates and season positions without double counting", () => {
  const expanded = structuredClone(history);
  expanded.players["id:runner-1"] = {
    ...expanded.players["id:runner-1"], ...players[0], birth_date: "2001-02-14", is_ranked: true,
  };
  expanded.players["name:runnerone|RB"] = expanded.players["id:runner-1"];
  assert.equal(buildPositionSamples(players, expanded, news, settings).length, 4);
  assert.equal(projectPlayer(players[0], expanded, {}, settings, 2026).age, 25);
  const changedPosition = {
    columns: ["season", "team", "games", "receptions", "receiving_yards", "pos"],
    players: { "id:hybrid": {
      player: "Hybrid", player_id: "hybrid", pos: "TE", birth_date: "1990-01-01", is_ranked: false,
      seasons: [[2021, "BUF", 16, 50, 500, "TE"], [2020, "BUF", 16, 50, 500, "QB"]],
    } },
  };
  const samples = buildPositionSamples([], changedPosition, {}, { ppr: "Half PPR", tePremium: "+0.5" });
  assert.deepEqual(samples.map(row => row.pos), ["TE", "QB"]);
  assert.deepEqual(samples.map(row => row.fantasy_points), [100, 75]);
});

test("verified two-way receiving history enters WR age samples without inventing one-season variation", () => {
  const hunter = {player: "Travis Hunter", player_id: "00-0040718", pos: "WR", projected_points: 120.9, adp: 160.1};
  const bundle = {columns: ["season", "pos", "games", "receptions", "receiving_yards", "receiving_tds"],
    players: {"id:00-0040718": {...hunter, birth_date: "2003-05-18", is_ranked: true,
      seasons: [[2025, "CB", 7, 28, 298, 1]]}}};
  const original = structuredClone(bundle);
  const model = applyProjectionModel([hunter], bundle, {}, {...settings, ppr: "Half PPR"}, 2026);
  assert.equal(model.samples.length, 1);
  assert.deepEqual([model.samples[0].pos, model.samples[0].age, model.samples[0].fantasy_points], ["WR", 22, 49.8]);
  const row = model.rows[0];
  assert.equal(row.age, 23);
  assert.equal(row.projection_source, "age_curve");
  assert.equal(row.projection_history_seasons, 1);
  assert.equal(row.age_change_sample, 0);
  assert.equal(row.projection_stddev, null);
  assert.equal(row.projection_low, null);
  assert.equal(row.projection_high, null);
  assert.ok(row.projected_points < row.projected_17_game_pace);
  assert.deepEqual(bundle, original);

  const nameOnly = {columns: bundle.columns, players: {"name:travishunter|WR": {
    player: hunter.player, pos: "WR", birth_date: "2003-05-18", seasons: [[2025, "CB", 7, 28, 298, 1]],
  }}};
  assert.deepEqual(buildPositionSamples([], nameOnly, {}, settings, 2026), []);
  const inconsistent = structuredClone(bundle);
  inconsistent.players["id:00-0040718"].player_id = "different-person";
  assert.deepEqual(buildPositionSamples([hunter], inconsistent, {}, settings, 2026), []);
});

test("known-age missing history retains and explains the existing baseline", () => {
  const player = {...players[0], projected_points: 170};
  const row = applyProjectionModel([player], {players: {}}, news, settings, 2026).rows[0];
  assert.equal(row.age, 25);
  assert.equal(row.projected_points, 170);
  assert.equal(row.projected_ppg, 10);
  assert.equal(row.projection_history_seasons, 0);
  assert.equal(row.projection_source, "existing_baseline");
  assert.equal(row.projection_stddev, null);
  const summary = projectionSummary(row);
  assert.equal(summary.label, "Saved baseline");
  assert.match(summary.explanation, /No usable NFL season history/);
  assert.doesNotMatch(summary.explanation, /Age data is unavailable/);
  assert.equal(summary.ageDetail, "No age adjustment applied");

  const rookie = applyProjectionModel([{...player, is_rookie: true}], {players: {}}, news, settings, 2026).rows[0];
  assert.equal(projectionSummary(rookie).label, "Rookie market");
  const noAge = applyProjectionModel([player], history, {}, settings, 2026).rows[0];
  assert.equal(noAge.projection_source, "recent_form");
  assert.match(projectionSummary(noAge).explanation, /Age data is unavailable/);
});
