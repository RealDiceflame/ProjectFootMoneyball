import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import * as helpers from "../docs/home-data.mjs";

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.events = {}; this.dataset = {};
    this.value = ""; this.scrollTop = 0; this.classes = new Set();
    this.classList = {toggle: (key, enabled) => enabled ? this.classes.add(key) : this.classes.delete(key),
      add: key => this.classes.add(key)};
  }
  set textContent(value) {this.text = String(value); this.children = [];}
  get textContent() {return (this.text || "") + this.children.map(child => child.textContent).join(" ");}
  append(...children) {for (const child of children) {child.parent = this; this.children.push(child);}}
  replaceChildren(...children) {this.text = ""; this.children = []; this.append(...children);}
  remove() {this.parent.children = this.parent.children.filter(child => child !== this);}
  setAttribute(key, value) {this[key] = value;}
  addEventListener(key, handler) {(this.events[key] ||= []).push(handler);}
  fire(key) {return Promise.all((this.events[key] || []).map(handler => handler()));}
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const NOW = Date.parse("2026-10-27T17:00:00Z");
const bundle = () => ({season: 2026, generated_at: "2026-10-27T16:00:00Z", reports: {},
  league_news: {status: "ok", updated_at: "2026-10-27T16:00:00Z", items: [
    {title: "Saved source story", url: "https://www.espn.com/nfl/story/saved", published_at: "2026-10-27T15:00:00Z"},
  ]}});

function page(responses = [bundle()]) {
  const nodes = new Map(), intervals = [], timers = new Map(), head = new Element("head");
  const document = {hidden: false, head, events: {},
    getElementById(id) {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);},
    createElement: tag => new Element(tag), addEventListener(key, fn) {this.events[key] = fn;}};
  class Clock extends Date {static now() {return NOW;}}
  let requests = 0;
  const context = vm.createContext({...helpers, document, Date: Clock, AbortSignal,
    setTimeout(fn) {const id = {}; timers.set(id, fn); return id;}, clearTimeout(id) {timers.delete(id);},
    setInterval(fn) {intervals.push(fn);},
    async fetch() {requests++; const response = responses.shift(); if (response instanceof Error) throw response;
      return {ok: true, json: async () => response};}});
  const source = readFileSync(new URL("../docs/home.js", import.meta.url), "utf8").replace(/^import[^\n]*\r?\n/gm, "");
  new vm.Script(source).runInContext(context);
  return {nodes, head, timers, document, refresh: () => intervals[0](), requests: () => requests};
}

test("X stays unloaded until explicit action; concurrent clicks initialize once", async () => {
  const view = page(); await settle();
  const button = view.nodes.get("load-x-feed");
  assert.equal(view.head.children.length, 0, "initial rendering never contacts the widget");
  assert.equal(button.events.click.length, 1);
  const first = button.fire("click"), second = button.fire("click");
  assert.equal(view.head.children.length, 1);
  assert.equal(button.disabled, true);
  assert.equal(view.head.children[0].src, "https://platform.x.com/widgets.js");
  view.head.children[0].onload();
  await Promise.all([first, second]);
  assert.match(view.nodes.get("social-status").textContent, /If posts don’t appear/);
  assert.equal(button.textContent, "NFL feed enabled");
  await button.fire("click"); await view.refresh();
  assert.equal(view.head.children.length, 1, "refreshing news never reinserts a widget");
  assert.equal(view.timers.size, 0);
});

test("blocked or timed-out X scripts retain direct access and allow a clean retry", async () => {
  const view = page(); await settle();
  const button = view.nodes.get("load-x-feed");
  const first = button.fire("click"); view.head.children[0].onerror(); await first;
  assert.equal(button.disabled, false);
  assert.equal(view.head.children.length, 0);
  assert.match(view.nodes.get("social-status").textContent, /couldn’t load/);
  assert.match(view.nodes.get("x-feed").textContent, /View posts from @NFL/);
  const second = button.fire("click"); [...view.timers.values()][0](); await second;
  assert.equal(view.head.children.length, 0);
  assert.equal(button.disabled, false);
  const third = button.fire("click"); view.head.children[0].onload(); await third;
  assert.equal(button.disabled, true);
  assert.equal(view.head.children.length, 1);
});

test("initial controls are disabled until a valid saved feed is available", async () => {
  const view = page();
  for (const id of ["injury-search", "injury-filter", "injury-more"]) assert.equal(view.nodes.get(id).disabled, true);
  await settle();
  for (const id of ["injury-search", "injury-filter", "injury-more"]) assert.equal(view.nodes.get(id).disabled, false);
  assert.equal(view.nodes.get("injury-more").hidden, true);
});

test("saved timestamp refreshes preserve unchanged news links and recover outage status", async () => {
  const first = bundle(), next = {...first, generated_at: "2026-10-27T16:30:00Z"};
  const view = page([first, next, new Error("offline"), next]); await settle();
  const list = view.nodes.get("league-news-list"), content = list.children;
  list.scrollTop = 90;
  await view.refresh();
  assert.equal(list.children, content);
  assert.equal(list.scrollTop, 90);
  await view.refresh(); assert.match(view.nodes.get("league-news-status").textContent, /Showing saved data/);
  await view.refresh(); assert.doesNotMatch(view.nodes.get("league-news-status").textContent, /Showing saved data/);
  assert.equal(list.children, content);
});

test("changed source publication metadata updates cards even when title and saved time match", async () => {
  const first = bundle(), next = structuredClone(first);
  next.league_news.items[0].published_at = "2026-10-27T15:30:00Z";
  const view = page([first, next]); await settle();
  const list = view.nodes.get("league-news-list"), old = list.children;
  await view.refresh();
  assert.notEqual(list.children, old);
  const titleWrapper = list.children[0].children[0].children[0];
  assert.equal(titleWrapper.children[0].children[0].dateTime, next.league_news.items[0].published_at);
});

test("fresh saved snapshots disclose behind injury source and limited player coverage", async () => {
  const saved = bundle();
  saved.injury_context = {season: 2026, expected_week: 8, latest_report_season: 2026, latest_report_week: 7,
    valid_from: "2026-10-27T00:00:00Z", valid_until: "2026-11-03T00:00:00Z", status: "behind"};
  saved.reports.p = {player: "Saved Player", player_id: "p", pos: "RB", team: "BUF",
    injury: {season: 2026, week: 7, report_status: "Out"}};
  const view = page([saved]); await settle();
  assert.match(view.nodes.get("injury-freshness").textContent, /^Updated /);
  assert.match(view.nodes.get("injury-coverage").textContent, /1 saved player report · 0 current/);
  assert.match(view.nodes.get("injury-coverage").textContent, /Source behind · Latest report 2026 · Week 7; expected 2026 · Week 8/);
  assert.match(view.nodes.get("injury-coverage").textContent, /not every NFL player/);
  assert.doesNotMatch(view.nodes.get("home-injury-list").textContent, /RISK/);
  const current = helpers.injuryCoverage({}, [{current: true}]);
  assert.match(current.label, /1 current/);
  assert.equal(current.stale, false);
});
