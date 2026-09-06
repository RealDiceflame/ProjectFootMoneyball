import assert from "node:assert/strict";
import test from "node:test";

import { mergeSpecialTeams, specialTeamRows } from "../docs/live-board.mjs";

const payload = {
  columns: ["overall_rank", "player", "team", "pos", "position_rank", "adp", "source_count", "adp_stddev", "Sleeper", "MFL"],
  rows: [
    [1, "Seattle Seahawks", "SEA", "DST", "DST1", 2.2, 2, 1.0, 2.9, 1.5],
    [2, "Brandon Aubrey", "DAL", "K", "K1", 3.4, 2, 2.0, 4.8, 2.0],
    [3, "Los Angeles Rams", "LAR", "DST", "DST2", 4.0, 1, null, 4.0, null],
    [4, "Retired Kicker", null, "K", "K2", 5.0, 1, null, 5.0, null],
  ],
};

test("special-team switches independently include active kickers and defenses", () => {
  assert.deepEqual(specialTeamRows(payload, { kickers: "Off", defenses: "Off" }), []);
  assert.deepEqual(specialTeamRows(payload, { kickers: "Include", defenses: "Off" }).map(row => row.player), ["Brandon Aubrey"]);
  assert.deepEqual(specialTeamRows(payload, { kickers: "Off", defenses: "Include" }).map(row => row.player), ["Seattle Seahawks", "Los Angeles Rams"]);
});

test("special-team rows normalize teams and remain clearly market-ranked", () => {
  const rows = specialTeamRows(payload, { kickers: "Off", defenses: "Include" });
  assert.equal(rows[1].team, "LA");
  assert.equal(rows[1].draft_tag, "MARKET");
  assert.equal(rows[1].projected_points, null);
});

test("market ADP slots place special teams into the live board", () => {
  const players = [
    { player: "Player One", overall_rank: 1, adp: 1.5 },
    { player: "Player Two", overall_rank: 2, adp: 2.8 },
    { player: "Player Three", overall_rank: 3, adp: 3.2 },
  ];
  const special = specialTeamRows(payload, { kickers: "Include", defenses: "Include" });
  const merged = mergeSpecialTeams(players, special);
  assert.deepEqual(merged.map(row => row.player), ["Player One", "Player Two", "Seattle Seahawks", "Player Three", "Brandon Aubrey", "Los Angeles Rams"]);
  assert.deepEqual(merged.map(row => row.overall_rank), [1, 2, 3, 4, 5, 6]);
});
