import test from "node:test";
import assert from "node:assert/strict";
import {scoreFantasyStats} from "../docs/fantasy-scoring.mjs";
import {fantasyPoints, historyAnalytics, historyKey} from "../docs/player-history.mjs";
import {scoreValueStats} from "../docs/player-values.mjs";
import {applyProjectionModel, buildPositionSamples, projectPlayer, reportForPlayer} from "../docs/projection-model.mjs";
import {applyPersonalAdp} from "../docs/adp-import.mjs";

const full = () => ({pos: "RB", passing_yards: 250, passing_tds: 2, passing_interceptions: 1,
  rushing_yards: -5, rushing_tds: 1, receptions: 4, receiving_yards: 40, receiving_tds: 1,
  fumbles_total: 8, fumbles_lost_total: 1, passing_2pt_conversions: 1,
  rushing_2pt_conversions: 1, receiving_2pt_conversions: 1, special_teams_tds: 1});

test("history, current values and canonical scoring agree across all reception formats and TE premium", () => {
  for (const [ppr, expected] of [["Standard", 41.5], ["Half PPR", 43.5], ["Full PPR", 45.5]]) {
    for (const pos of ["RB", "TE"]) for (const tePremium of ["Off", "+0.5"]) {
      const row = {...full(), pos}, settings = {ppr, tePremium};
      const points = expected + (pos === "TE" && tePremium === "+0.5" ? 2 : 0);
      assert.deepEqual(scoreFantasyStats(row, settings), {points, complete: true});
      assert.deepEqual(scoreValueStats(row, settings), {points, complete: true});
      assert.equal(fantasyPoints(row, settings), points);
    }
  }
});

test("lost fumbles never use total fumbles and known adjustments survive partial optional coverage", () => {
  const row = full(); row.passing_2pt_conversions = null;
  assert.deepEqual(scoreValueStats(row), {points: null, complete: false});
  assert.deepEqual(scoreValueStats(row, {}, {allowLegacy: true}), {points: 41.5, complete: false});
  assert.equal(row.passing_2pt_conversions, null, "coverage is not repaired by writing invented zeros");
  const negative = Object.fromEntries(Object.keys(full()).filter(key => key !== "pos").map(key => [key, 0]));
  negative.fumbles_lost_total = 2; negative.fumbles_total = 99;
  assert.equal(fantasyPoints(negative, {ppr: "Standard"}), -4);
  delete negative.fumbles_lost_total;
  assert.deepEqual(scoreValueStats(negative, {}, {allowLegacy: true}), {points: 0, complete: false});
  assert.equal(fantasyPoints({rushing_yards: 100, fumbles_lost_total: 1}), 8);
});

test("supplied unknown core statistics stay unknown while absent legacy categories are flagged", () => {
  for (const invalid of [null, undefined, "", "bad", true, false, NaN, Infinity]) {
    const row = {...full(), receptions: invalid};
    assert.equal(fantasyPoints(row, {ppr: "Full PPR"}), null);
    assert.equal(scoreValueStats(row, {}, {allowLegacy: true}).points, null);
  }
  assert.equal(fantasyPoints({...full(), rushing_tds: -1}), null);
  assert.deepEqual(scoreFantasyStats({rushing_yards: -20}, {}, {allowLegacy: true, allowSparseCore: true}), {points: -2, complete: false});
  assert.equal(scoreFantasyStats({rushing_yards: -20}, {}, {allowLegacy: true}).points, null);
  const result = historyAnalytics([{games: 10, ...full(), receptions: null}], {pos: "RB"}, {ppr: "Full PPR"});
  assert.equal(result.seasons[0].fantasy_points, null);
  assert.equal(result.seasons[0].fantasy_points_per_game, null);
  assert.equal(result.mean_per_game, null);
  assert.equal(result.seasons[0].scoring_complete, false);
});

test("unknown historical scoring cannot become a zero-rate position sample", () => {
  const row = {season: 2025, games: 10, ...full(), receptions: null};
  const columns = Object.keys(row), player = {player: "Test Runner", player_id: "00-0000001", pos: "RB", birth_date: "2000-01-01"};
  const history = {columns, players: {"id:00-0000001": {...player, seasons: [columns.map(key => row[key])]}}};
  assert.deepEqual(buildPositionSamples([player], history, {reports: {}}, {ppr: "Full PPR"}), []);
});

test("a season projection never fits its own season or future player statistics", () => {
  const player = {player: "Test Runner", player_id: "00-0000001", pos: "RB", team: "BUF", adp: 10, birth_date: "2000-01-01"};
  const past = {season: 2025, games: 10, ...full()}, columns = Object.keys(past);
  const record = {...player, seasons: [columns.map(key => past[key])]};
  const history = {columns, players: {"id:00-0000001": record}};
  const before = applyProjectionModel([player], history, {reports: {}}, {}, 2026);
  const expanded = structuredClone(history);
  for (const season of [2026, 2027]) {
    const later = {...past, season, rushing_yards: 100000};
    expanded.players["id:00-0000001"].seasons.push(columns.map(key => later[key]));
  }
  const after = applyProjectionModel([player], expanded, {reports: {}}, {}, 2026);
  assert.equal(after.rows[0].projected_points, before.rows[0].projected_points);
  assert.deepEqual(after.samples, before.samples);
});

test("historical TE premium follows the recorded season position", () => {
  const player = {player: "Converted Tight End", player_id: "00-0000001", pos: "TE", team: "BUF", birth_date: "2000-01-01"};
  const season = {season: 2025, games: 10, ...full(), pos: "WR"}, columns = Object.keys(season);
  const history = {columns, players: {"id:00-0000001": {...player, seasons: [columns.map(key => season[key])]}}};
  const settings = {ppr: "Full PPR", tePremium: "+0.5"};
  const projection = projectPlayer(player, history, {reports: {}}, settings, 2026);
  assert.equal(projection.projected_ppg, fantasyPoints(season, settings) / 10);
});

test("projection reports cannot cross known IDs, positions or ambiguous name/team fallbacks", () => {
  const player = {player: "Same Name", player_id: "00-0000001", team: "BUF", pos: "QB"};
  const other = {...player, player_id: "00-0000002", birth_date: "1990-01-01"};
  assert.equal(reportForPlayer({reports: {other}}, player), null);
  assert.equal(reportForPlayer({reports: {wrong: {...player, pos: "RB"}}}, player), null);
  const anonymous = {...player}; delete anonymous.player_id;
  assert.equal(reportForPlayer({reports: {a: other, b: {...other, player_id: "00-0000003"}}}, anonymous), null);
  const corrected = {...player, player: "Corrected Name", team: "KC"};
  assert.equal(reportForPlayer({reports: {corrected}}, player), corrected);
});

test("ADP imports reject conflicting explicit identities and positions", () => {
  const row = {player: "Known Player", player_id: "00-0000001", pos: "QB", team: "BUF", overall_rank: 10, adp: 80};
  for (const identity of [{playerId: "00-9999999", position: "QB"}, {playerId: row.player_id, position: "RB"}, {playerId: "", position: "RB"}]) {
    const imported = applyPersonalAdp([row], {entries: [{player: row.player, team: "BUF", adp: 1, ...identity}]});
    assert.equal(imported.matched, 0);
    assert.equal(imported.rows[0].adp, 80);
  }
  const exact = applyPersonalAdp([row], {entries: [{player: "New spelling", playerId: row.player_id, position: "QB", team: "KC", adp: 2}]});
  assert.equal(exact.matched, 1);
  assert.equal(exact.rows[0].adp, 2);
});

test("placeholder IDs and ambiguous source rows cannot attach another player’s ADP", () => {
  const first = {player: "First Runner", player_id: "-", pos: "RB", team: "BUF", overall_rank: 1, adp: 80};
  const second = {...first, player: "Other Runner", overall_rank: 2};
  const result = applyPersonalAdp([first, second], {entries: [{player: first.player, playerId: "-", position: "RB", team: "BUF", adp: 3}]});
  assert.equal(result.matched, 1);
  assert.equal(result.rows[0].adp, 3);
  assert.equal(result.rows[1].adp, 80);
  const ambiguous = applyPersonalAdp([{...first, player_id: "00-0000001"}, {...first, player_id: "00-0000002"}],
    {entries: [{player: first.player, playerId: "", position: "RB", team: "BUF", adp: 3}]});
  assert.equal(ambiguous.matched, 0);
  for (const id of ["-", "null", "undefined", "n/a"]) assert.equal(historyKey({...first, player_id: id}), "name:firstrunner|RB");
});
