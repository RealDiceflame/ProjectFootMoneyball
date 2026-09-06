import assert from "node:assert/strict";
import test from "node:test";

import {
  fantasyPoints,
  historyAnalytics,
  historyKey,
  historyRows,
  sampleStandardDeviation,
  volatilityLabel,
} from "../docs/player-history.mjs";

test("uses stable player IDs and name-position fallback keys", () => {
  assert.equal(historyKey({ player: "Josh Allen", player_id: "00-0034857", pos: "QB" }), "id:00-0034857");
  assert.equal(historyKey({ player: "No ID Runner Jr.", pos: "RB" }), "name:noidrunner|RB");
});

test("maps compact season arrays into named history rows", () => {
  const bundle = {
    columns: ["season", "team", "games"],
    players: { "id:1": { seasons: [[2025, "BUF", 17]] } },
  };
  assert.deepEqual(historyRows(bundle, { player_id: "1" }), [{ season: 2025, team: "BUF", games: 17 }]);
});

test("recalculates historical points for PPR and TE premium settings", () => {
  const stats = {
    pos: "TE", passing_yards: 0, passing_tds: 0, passing_interceptions: 0,
    rushing_yards: 10, rushing_tds: 1, receptions: 50, receiving_yards: 600,
    receiving_tds: 5, fumbles_total: 1,
  };
  assert.equal(fantasyPoints(stats, { ppr: "Standard", tePremium: "Off" }), 95);
  assert.equal(fantasyPoints(stats, { ppr: "Half PPR", tePremium: "+0.5" }), 145);
});

test("measures season scoring variation and combines it with ADP disagreement", () => {
  const rows = [
    { season: 2024, games: 10, receiving_yards: 1000 },
    { season: 2025, games: 10, receiving_yards: 2000 },
  ];
  const analytics = historyAnalytics(
    rows,
    { pos: "WR", adp: 50, adp_stddev: 10, source_count: 3 },
    { ppr: "Standard", tePremium: "Off" },
  );
  assert.equal(analytics.seasons[0].fantasy_points, 100);
  assert.equal(analytics.mean_per_game, 15);
  assert.ok(Math.abs(analytics.player_stddev - Math.sqrt(50)) < 0.0001);
  assert.equal(analytics.market_cv, 0.2);
  assert.equal(analytics.volatility_score, 39);
  assert.equal(analytics.volatility_label, "Moderate");
  assert.deepEqual(analytics.basis, ["history", "market"]);
  assert.equal(analytics.expected_points, 255);
});

test("handles limited history without inventing a player standard deviation", () => {
  assert.equal(sampleStandardDeviation([10]), null);
  const analytics = historyAnalytics(
    [{ season: 2025, games: 10, receiving_yards: 1000 }],
    { pos: "WR", adp: 50, adp_stddev: 10, source_count: 2 },
    { ppr: "Standard", tePremium: "Off" },
  );
  assert.equal(analytics.player_stddev, null);
  assert.equal(analytics.volatility_score, 20);
  assert.deepEqual(analytics.basis, ["market"]);
  assert.equal(volatilityLabel(null), "Not rated");
});
