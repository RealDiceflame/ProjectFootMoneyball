import assert from "node:assert/strict";
import test from "node:test";

import { fantasyPoints, historyKey, historyRows } from "../docs/player-history.mjs";

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
