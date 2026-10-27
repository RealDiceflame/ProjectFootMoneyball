import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {normalizeProjectionSettings} from "../docs/projection-model.mjs";
import {safeOddsUrl, predictionContractRows} from "../docs/odds-board.mjs";
import {snapshotAgeNote} from "../docs/lab-refresh.mjs";
import * as gameData from "../docs/game-data.mjs";
import {TEAM_NAMES, scoreDisplay, gameConditions} from "../docs/scores-data.mjs";

test("unsupported shared projection formats recover to published settings", () => {
  const defaults = {teams: "12", quarterbacks: "2QB", ppr: "Half PPR", tePremium: "+0.5"};
  assert.deepEqual(normalizeProjectionSettings({teams: "999", quarterbacks: "bad", ppr: "bogus", tePremium: "NaN"}), defaults);
  assert.deepEqual(normalizeProjectionSettings({teams: 8, quarterbacks: "1QB", ppr: "Standard", tePremium: "Off"}),
    {teams: "8", quarterbacks: "1QB", ppr: "Standard", tePremium: "Off"});
  assert.deepEqual(normalizeProjectionSettings(), defaults);
});

test("saved odds source links reject executable, non-HTTPS and credential URLs", () => {
  for (const url of [null, undefined, "", "javascript:alert(1)", "data:text/html,unsafe", "http://example.com", "//example.com", "/private", "https://user:secret@example.com"]) {
    assert.equal(safeOddsUrl(url), null);
  }
  assert.equal(safeOddsUrl("https://example.com/market?q=1"), "https://example.com/market?q=1");
});

test("prediction contracts require context for generic outcomes and preserve meaningful team labels", () => {
  const legacy = predictionContractRows([
    {label: "Under", probability: 0.93}, {label: " YES ", probability: 0.65},
    {label: "Over", question: "  ", probability: 0.6}, {label: "No", question: null, probability: 0.7},
  ]);
  assert.deepEqual(legacy, {rows: [], unavailable: 4});
  const identified = predictionContractRows([
    {label: "Under", question: "Jordan Love: Passing yards 245.5", probability: 0.55},
    {label: "Green Bay Packers", probability: 0.68},
    {label: "Carolina Panthers", probability: 0},
  ]);
  assert.deepEqual(identified, {rows: [
    {label: "Under", question: "Jordan Love: Passing yards 245.5", probability: 0.55},
    {label: "Green Bay Packers", question: null, probability: 0.68},
    {label: "Carolina Panthers", question: null, probability: 0},
  ], unavailable: 0});
  assert.deepEqual(predictionContractRows([{label: "Packers", probability: null},
    {label: "Packers", probability: 2}, {label: "", question: "Some question", probability: 0.3}]), {rows: [], unavailable: 3});
});

test("future snapshot clocks cannot masquerade as fresh team forecasts", () => {
  const now = Date.parse("2026-10-27T17:00:00Z");
  assert.equal(snapshotAgeNote("2026-10-27T16:00:00Z", now), "");
  assert.equal(snapshotAgeNote("2026-10-26T16:00:00Z", now), "Snapshot is over 24 hours old");
  for (const value of [null, "bad date", "2099-01-01T00:00:00Z"]) assert.equal(snapshotAgeNote(value, now), "Snapshot time unavailable");
  assert.deepEqual(gameData.gameSnapshotTime("2099-01-01T00:00:00Z", now), {valid: false, stale: true});
});

const archive = JSON.parse(readFileSync(new URL("../docs/data/game_stats/2026/2026_01_NE_SEA.json", import.meta.url)));
test("a score-feed fixture must agree with the URL’s week and teams", () => {
  assert.equal(gameData.validGameIdentity(archive.game, archive.game.game_id), true);
  for (const change of [{week: 2}, {away: "BUF"}, {home: "BAL"}]) {
    const modified = {...archive.game, ...change};
    assert.equal(gameData.validGameIdentity(modified, archive.game.game_id), false);
    assert.throws(() => gameData.unpackStats({...archive, game: modified}, archive.game.game_id), /Invalid game/);
  }
});

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.classes = new Set();
    this.classList = {add: key => this.classes.add(key), remove: key => this.classes.delete(key)};
  }
  set textContent(value) {this.text = String(value); this.children = [];}
  get textContent() {return (this.text || "") + this.children.map(child => child.textContent).join(" ");}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.text = ""; this.children = children;}
  setAttribute(key, value) {this[key] = value;}
}
async function gamePage(responses) {
  const nodes = new Map(), intervals = [];
  const document = {hidden: false, getElementById(id) {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);},
    createElement: tag => new Element(tag), addEventListener() {}};
  const context = vm.createContext({...gameData, TEAM_NAMES, scoreDisplay, gameConditions, document,
    location: {search: `?game=${archive.game.game_id}`}, URLSearchParams, Date, AbortSignal,
    teamMark: () => new Element("img"), setInterval(fn) {intervals.push(fn);},
    async fetch() {const result = responses.shift(); if (result instanceof Error) throw result;
      return result === null ? {status: 404, ok: false} : {status: 200, ok: true, json: async () => result};}});
  const source = readFileSync(new URL("../docs/game.js", import.meta.url), "utf8").replace(/^import[^\n]*\r?\n/gm, "");
  new vm.Script(source).runInContext(context);
  await new Promise(resolve => setImmediate(resolve));
  return {nodes, refresh: () => intervals[0]()};
}

test("score-feed 404 retains archived statistics with an honest recoverable warning", async () => {
  const board = {checked_at: new Date().toISOString(), games: [archive.game]};
  const view = await gamePage([null, archive, board, archive]);
  assert.match(view.nodes.get("game-stats").textContent, /Player box score/);
  assert.match(view.nodes.get("game-status").textContent, /Some data could not refresh/);
  await view.refresh();
  assert.doesNotMatch(view.nodes.get("game-status").textContent, /Some data could not refresh/);
});

test("a disappearing box score retains last good tables without suppressing a newer score", async () => {
  const board = {checked_at: new Date().toISOString(), games: [archive.game]};
  const next = {...board, games: [{...archive.game, home_score: 35, away_score: 28}]};
  const view = await gamePage([board, archive, next, null]);
  const tables = view.nodes.get("game-stats").children;
  await view.refresh();
  assert.equal(view.nodes.get("game-stats").children, tables);
  assert.match(view.nodes.get("game-summary").textContent, /35/);
  assert.match(view.nodes.get("game-status").textContent, /Some data could not refresh/);
});

test("valid box-score revisions without a content hash still update the displayed data", async () => {
  const first = structuredClone(archive), second = structuredClone(archive);
  delete first.content_sha256; delete second.content_sha256;
  const key = second.team_columns.findIndex(column => column === "passing_yards");
  assert.ok(key >= 0); second.teams[0][key] = 9876;
  const board = {checked_at: new Date().toISOString(), games: [archive.game]};
  const view = await gamePage([board, first, board, second]);
  assert.doesNotMatch(view.nodes.get("game-stats").textContent, /9,876/);
  await view.refresh();
  assert.match(view.nodes.get("game-stats").textContent, /9,876/);
});
