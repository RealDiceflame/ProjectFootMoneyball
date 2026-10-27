import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import * as statsData from "../docs/stats-data.mjs";
import {TEAM_NAMES, scoreDisplay} from "../docs/scores-data.mjs";

const saved = JSON.parse(readFileSync(new URL("../docs/data/game_stats/2026/summary.json", import.meta.url)));
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.events = {}; this.value = ""; this.dataset = {};
    this.classes = new Set(); this.classList = {add: key => this.classes.add(key), remove: key => this.classes.delete(key)};
  }
  set textContent(value) {this.text = String(value); this.children = [];}
  get textContent() {return (this.text || "") + this.children.map(child => child.textContent).join(" ");}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.text = ""; this.children = children;}
  setAttribute(key, value) {this[key] = value;}
  addEventListener(key, handler) {this.events[key] = handler;}
}
async function page(query = "", responses = [{seasons: [2026]}, saved]) {
  const nodes = new Map(), requests = [], intervals = [];
  let clock = Date.parse(saved.checked_at) + 1000;
  const document = {hidden: false, events: {}, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);
  }, createElement: tag => new Element(tag), addEventListener(key, handler) {this.events[key] = handler;}};
  const location = {search: query, hash: ""}, urls = [];
  const history = {replaceState(state, unused, url) {urls.push(url); const parsed = new URL(url, "https://example.test/"); location.search = parsed.search; location.hash = parsed.hash;}};
  const notesSummary = new Element("summary"); notesSummary.focus = () => {document.activeElement = notesSummary;};
  document.getElementById("stats-source-notes").querySelector = () => notesSummary;
  class Clock extends Date {static now() {return clock;}}
  const context = vm.createContext({...statsData, TEAM_NAMES, document, location, history, URLSearchParams,
    Date: Clock, AbortSignal, teamMark: () => new Element("img"), scoreDisplay: game => scoreDisplay(game, clock),
    selectedGames: (summary, week) => statsData.selectedGames(summary, week, clock),
    periodOverview: (summary, week) => statsData.periodOverview(summary, week, clock),
    statsFreshness: checked => statsData.statsFreshness(checked, clock),
    setInterval(fn) {intervals.push(fn);}, async fetch(path) {
      requests.push(path); const value = responses.shift(); if (value instanceof Error) throw value;
      return {ok: true, json: async () => value};
    }});
  const source = readFileSync(new URL("../docs/stats.js", import.meta.url), "utf8").replace(/^import[^\n]*\r?\n/gm, "");
  new vm.Script(source).runInContext(context); await settle();
  return {nodes, document, urls, requests, notesSummary, responses,
    refresh: async () => {clock += 300001; await intervals[0]();}};
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);

test("shared stats links restore category and week and sidebar links use the same period", async () => {
  const view = await page("?view=leaders&week=1&category=Defense");
  assert.equal(view.nodes.get("stats-week").value, "1");
  assert.equal(view.nodes.get("stats-category").value, "Defense");
  assert.match(view.nodes.get("stats-results-heading").textContent, /Week 1 · Defense leaders/);
  assert.match(view.nodes.get("stats-results").textContent, /Sacks/);
  assert.doesNotMatch(view.nodes.get("stats-results").textContent, /Passing yards/);
  const current = new URL(view.urls.at(-1), "https://example.test/");
  assert.equal(current.searchParams.get("category"), "Defense");
  for (const link of descendants(view.nodes.get("stats-context")).filter(node => node.tagName === "a")) {
    const url = new URL(link.href, "https://example.test/");
    assert.equal(url.searchParams.get("week"), "1");
    assert.equal(url.searchParams.get("view"), "leaders");
    assert.ok(["Passing", "Rushing", "Receiving"].includes(url.searchParams.get("category")));
  }
});

test("an unplayed week clears selected-period leaders and shows zero published coverage", async () => {
  const snapshot = structuredClone(saved);
  for (const game of snapshot.games.filter(game => game.week === 18)) {
    game.stats_available = false; game.home_score = null; game.away_score = null;
  }
  snapshot.periods[18] = {game_count: 0, game_ids: [], leaders: Object.fromEntries(snapshot.metrics.map(metric => [metric.key, []]))};
  snapshot.periods.all.game_ids = snapshot.games.filter(game => game.stats_available).map(game => game.game_id);
  snapshot.periods.all.game_count = snapshot.periods.all.game_ids.length;
  const view = await page("", [{seasons: [2026]}, snapshot]);
  view.nodes.get("stats-week").value = "18"; view.nodes.get("stats-week").events.change();
  assert.match(view.nodes.get("stats-results-count").textContent, /^0 published games/);
  assert.match(view.nodes.get("stats-context").textContent, /No passing, rushing or receiving leaders recorded/);
  assert.equal(descendants(view.nodes.get("stats-context")).filter(node => node.className === "stats-spotlight").length, 0);
  assert.deepEqual(view.nodes.get("stats-overview").children.slice(0, 3).map(item => item.children[1].textContent), ["0", "0", "0"]);
  assert.equal(view.nodes.get("stats-results")["aria-busy"], "false");
});

test("unchanged refresh retains links and source-outage warning survives local selection changes", async () => {
  const updated = structuredClone(saved); updated.checked_at = new Date(Date.parse(saved.checked_at) + 60000).toISOString();
  const view = await page("?view=leaders", [{seasons: [2026]}, saved, updated, new Error("offline"), updated]);
  const results = view.nodes.get("stats-results").children, context = view.nodes.get("stats-context").children;
  await view.refresh();
  assert.equal(view.nodes.get("stats-results").children, results);
  assert.equal(view.nodes.get("stats-context").children, context);
  await view.refresh();
  assert.match(view.nodes.get("stats-status").textContent, /Showing the last loaded stats/);
  view.nodes.get("stats-category").value = "Defense"; view.nodes.get("stats-category").events.change();
  assert.match(view.nodes.get("stats-status").textContent, /Showing the last loaded stats/);
  assert.equal(view.nodes.get("stats-status").classes.has("stale"), true);
  await view.refresh();
  assert.doesNotMatch(view.nodes.get("stats-status").textContent, /Showing the last loaded stats/);
});

test("changing seasons never leaves another season’s contextual leaders visible", async () => {
  const view = await page("", [{seasons: [2026, 2025]}, saved, new Error("offline")]);
  assert.ok(descendants(view.nodes.get("stats-context")).some(node => node.className === "stats-spotlight"));
  view.nodes.get("stats-season").value = "2025";
  const pending = view.nodes.get("stats-season").events.change();
  assert.match(view.nodes.get("stats-context").textContent, /Loading this season/);
  assert.equal(view.nodes.get("stats-overview").children.length, 0);
  await pending;
  assert.match(view.nodes.get("stats-context").textContent, /Selected-season coverage and leaders are unavailable/);
  assert.match(view.nodes.get("stats-results-heading").textContent, /2025 · Results unavailable/);
  assert.equal(view.nodes.get("stats-results")["aria-busy"], "false");
  for (const id of ["view-games", "view-leaders"]) {
    const url = new URL(view.nodes.get(id).href, "https://example.test/");
    assert.equal(url.searchParams.get("season"), "2025", "unavailable-season tabs cannot navigate to stale results");
    assert.equal(url.searchParams.get("week"), statsData.defaultStatsWeek(saved));
  }
  assert.equal(new URL(view.urls.at(-1), "https://example.test/").searchParams.get("season"), "2025");
});

test("sources link opens and focuses the disclosure rather than a closed anchor", async () => {
  const view = await page(); let prevented = false;
  view.nodes.get("stats-sidebar").events.click({target: {closest: () => ({})}, preventDefault() {prevented = true;}});
  assert.equal(prevented, true);
  assert.equal(view.nodes.get("stats-source-notes").open, true);
  assert.equal(view.document.activeElement, view.notesSummary);
  assert.match(view.urls.at(-1), /#stats-source-notes$/);
  view.nodes.get("stats-week").events.change();
  assert.match(view.urls.at(-1), /#stats-source-notes$/, "polling and rendering retain the reading anchor");
});

test("published scorecards distinguish reported scores from box-score availability", async () => {
  const view = await page();
  const cards = view.nodes.get("stats-results").children;
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.match(card.textContent, /Reported score/);
    assert.doesNotMatch(card.textContent, /Final/);
    assert.match(card.textContent, /Player & team box score/);
  }
});
