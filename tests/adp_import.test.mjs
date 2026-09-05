import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPersonalAdp,
  buildPersonalAdp,
  inspectAdpText,
  marketDraftTag,
  parseDelimitedText,
  recalculateMarketMetrics,
} from "../docs/adp-import.mjs";

test("parses quoted CSV and detects 4for4 Yahoo ADP", () => {
  const csv = [
    '"ADP","Position","Player","Team","Sleeper","Y!"',
    '"1","RB-01","Jahmyr Gibbs","DET","1.3","1.4"',
    '"2","WR-01","Ja\'Marr Chase","CIN","3.0","3.4"',
  ].join("\r\n");
  const parsed = inspectAdpText(csv);
  assert.equal(parsed.preferredColumn, "Y!");
  const snapshot = buildPersonalAdp(parsed, "Y!", { fileName: "4for4.csv", snapshotDate: "2026-09-04" });
  assert.equal(snapshot.provider, "Yahoo");
  assert.deepEqual(snapshot.entries[0], {
    player: "Jahmyr Gibbs",
    playerId: "",
    team: "DET",
    position: "RB",
    adp: 1.4,
  });
});

test("supports tab-separated generic ADP files", () => {
  const parsed = inspectAdpText("Name\tTeam\tPos\tMy Room ADP\nPuka Nacua\tLAR\tWR\t4.5");
  assert.equal(parsed.preferredColumn, "My Room ADP");
  assert.equal(parseDelimitedText("Player,ADP\n\"Smith, John\",22")[1][0], "Smith, John");
});

test("prefers the overall-pick column in round-based ADP exports", () => {
  const csv = [
    "ADP,Overall,Name,Position,Team,Times Drafted",
    "1.01,1.4,Jahmyr Gibbs,RB,DET,1903",
    "1.03,2.8,Puka Nacua,WR,LAR,321",
  ].join("\n");
  const parsed = inspectAdpText(csv);
  assert.equal(parsed.preferredColumn, "Overall");
  const snapshot = buildPersonalAdp(parsed, parsed.preferredColumn, { fileName: "half-ppr.csv" });
  assert.deepEqual(snapshot.entries.map(entry => entry.adp), [1.4, 2.8]);
});

test("matches imported players by name and position without collapsing names", () => {
  const rows = [
    { player: "Josh Allen", player_id: "qb-1", pos: "QB", team: "BUF", listed_team: "BUF", current_team: "BUF", overall_rank: 4, adp: 8 },
    { player: "Josh Allen", player_id: "edge-1", pos: "WR", team: "JAX", listed_team: "JAX", current_team: "JAX", overall_rank: 40, adp: 50 },
  ];
  const snapshot = {
    provider: "Yahoo",
    entries: [{ player: "Josh Allen", playerId: "", team: "BUF", position: "QB", adp: 2.5 }],
  };
  const result = applyPersonalAdp(rows, snapshot);
  assert.equal(result.matched, 1);
  assert.equal(result.rows[0].adp, 2.5);
  assert.equal(result.rows[0].Yahoo, 2.5);
  assert.equal(result.rows[0].source_count, 1);
  assert.equal(result.rows[0].adp_spread, null);
  assert.equal(result.rows[0].adp_stddev, null);
  assert.equal(result.rows[1].adp, 50);
});

test("recalculates position market expectations and draft tags", () => {
  const rows = [
    { player: "A", pos: "RB", projected_points: 300, adp: 1, overall_rank: 1 },
    { player: "B", pos: "RB", projected_points: 200, adp: 50, overall_rank: 20 },
    { player: "C", pos: "RB", projected_points: 170, adp: 100, overall_rank: 60 },
  ];
  const result = recalculateMarketMetrics(rows);
  assert.ok(Number.isFinite(result[0].market_expected_points));
  assert.ok(Number.isFinite(result[0].market_value));
  assert.equal(result[1].value_vs_adp, undefined);
  assert.equal(marketDraftTag(50), "TARGET");
  assert.equal(marketDraftTag(25), "VALUE");
  assert.equal(marketDraftTag(-20), "REACH");
  assert.equal(marketDraftTag(0), "FAIR");
  assert.equal(marketDraftTag(Number.NaN), "NO MARKET");
});
