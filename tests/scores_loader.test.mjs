import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {TEAM_NAMES, scoreboardGames, defaultScoreWeek, scoreDisplay, scoreboardStale, gameConditions} from "../docs/scores-data.mjs";

const loader = readFileSync(new URL("../docs/scores.js", import.meta.url), "utf8")
  .replace(/^import[^\n]*\r?\n/gm, "");
const initialNow = Date.parse("2026-09-13T18:00:00Z");
const firstGame = {game_id:"2026_01_BUF_BAL", week:1, home:"BAL", away:"BUF",
  gameday:"2026-09-13", kickoff:"2026-09-13T17:00:00Z", home_score:0, away_score:14};
const snapshot = (games = [firstGame], now = initialNow) => ({
  season:2026, checked_at:new Date(now).toISOString(), games,
});
const response = data => ({ok:true, json:async () => data});

// Only the DOM operations used by the loader are needed; no browser or network runs.
class EventTargetStub {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({type, target:this});
    // Visibility handlers start an asynchronous load without returning its promise.
    await new Promise(resolve => setImmediate(resolve));
  }
}

class ElementStub extends EventTargetStub {
  children = [];
  value = "";
  disabled = false;
  ownText = "";
  constructor(tagName) {
    super(); this.tagName = tagName;
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      contains: name => classes.has(name),
      toggle(name, enabled) {
        if (enabled === undefined) enabled = !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  set textContent(value) {this.ownText = String(value); this.children = [];}
  get textContent() {return this.ownText + this.children.map(child => child.textContent).join("");}
  append(...children) {this.children.push(...children);}
  setAttribute(name, value) {this[name] = value;}
  replaceChildren(...children) {this.ownText = ""; this.children = [...children];}
}

async function page(...initialResponses) {
  const clock = {now:initialNow}, queue = [...initialResponses], calls = [], intervals = [];
  const list = new ElementStub("section"), select = new ElementStub("select"), status = new ElementStub("p");
  select.disabled = true;
  const elements = new Map([["score-games", list], ["score-week", select], ["score-status", status]]);
  const document = Object.assign(new EventTargetStub(), {
    hidden:false,
    getElementById: id => elements.get(id),
    createElement: tag => new ElementStub(tag),
  });
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [clock.now]));}
    static now() {return clock.now;}
  }
  const context = vm.createContext({
    document, Date:ClockDate, TEAM_NAMES, scoreboardGames, gameConditions,
    teamMark: team => new ElementStub("img"),
    defaultScoreWeek: games => defaultScoreWeek(games, clock.now),
    scoreDisplay: game => scoreDisplay(game, clock.now),
    scoreboardStale: bundle => scoreboardStale(bundle, clock.now),
    AbortSignal:{timeout: milliseconds => ({timeout:milliseconds})},
    setInterval(callback, milliseconds) {intervals.push({callback, milliseconds}); return intervals.length;},
    async fetch(url, options) {
      calls.push({url, options});
      assert.ok(queue.length, "Every fetch should have a mocked response");
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  await new vm.Script(loader, {filename:"docs/scores.js"}).runInContext(context);
  return {clock, queue, calls, intervals, list, select, status, document,
    refresh: async () => {await intervals[0].callback();},
  };
}

const cards = view => view.list.children.filter(child => child.tagName === "a");
const scores = card => card.children.filter(child => child.tagName === "div")
  .map(row => row.children[1].textContent);

test("all sixteen games remain visible with venue/weather and clickable box scores", async () => {
  const real=JSON.parse(readFileSync(new URL("../docs/data/scores.json",import.meta.url),"utf8"));
  const week=real.games.filter(game=>game.week===1);
  const view=await page(response(snapshot(week)));
  assert.equal(cards(view).length,16);
  for (const card of cards(view)) {
    assert.match(card.href,/^game.html\?game=2026_01_/);
    assert.ok(card.children.some(node=>node.className==="home-score-location"&&node.textContent));
    assert.ok(card.children.some(node=>node.className==="home-score-weather"&&node.textContent));
  }
});

test("score loader displays its first snapshot and schedules shared-file refreshes", async () => {
  const view = await page(response(snapshot()));
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].url, "data/scores.json");
  assert.equal(view.calls[0].options.cache, "no-store");
  assert.equal(view.calls[0].options.signal.timeout, 15000);
  assert.deepEqual(view.intervals.map(interval => interval.milliseconds), [60000]);
  assert.equal(view.select.disabled, false);
  assert.equal(view.select.value, "1");
  assert.equal(cards(view).length, 1);
  assert.equal(cards(view)[0].children[0].textContent, "Reported score");
  assert.deepEqual(scores(cards(view)[0]), ["14", "0"]);
  assert.match(view.list.textContent, /Bills14Ravens0/);
  assert.match(view.status.textContent, /^Checked /);
  assert.equal(view.status.classList.contains("stale"), false);
});

for (const [kind, failure] of [
  ["network", () => new Error("Connection lost")],
  ["HTTP", () => ({ok:false, json:async () => {throw new Error("Must not read failed response");}})],
  ["JSON read", () => ({ok:true, json:async () => {throw new SyntaxError("Incomplete JSON");}})],
  ["invalid snapshot", () => response({season:2026, checked_at:"invalid", games:[firstGame]})],
]) {
  test(`${kind} failure retains the last good scoreboard and marks refresh unavailable`, async () => {
    const view = await page(response(snapshot()));
    const previousContent = view.list.textContent;
    view.queue.push(failure());
    await view.refresh();
    assert.equal(view.calls.length, 2);
    assert.equal(view.list.textContent, previousContent);
    assert.deepEqual(scores(cards(view)[0]), ["14", "0"]);
    assert.equal(view.select.disabled, false);
    assert.equal(view.select.value, "1");
    assert.match(view.status.textContent, /Refresh unavailable/);
    assert.equal(view.status.classList.contains("stale"), true);
  });
}

test("an initial failure recovers on the next successful refresh", async () => {
  const view = await page(new Error("Offline"));
  assert.equal(view.select.disabled, true);
  assert.equal(cards(view).length, 0);
  assert.equal(view.status.textContent, "Scores temporarily unavailable");
  assert.equal(view.list.textContent, "Please try again later.");
  assert.equal(view.status.classList.contains("stale"), true);
  view.queue.push(response(snapshot([{...firstGame, home_score:7}])));
  await view.refresh();
  assert.equal(view.calls.length, 2);
  assert.equal(view.select.disabled, false);
  assert.deepEqual(scores(cards(view)[0]), ["14", "7"]);
  assert.doesNotMatch(view.status.textContent, /unavailable/);
  assert.equal(view.status.classList.contains("stale"), false);
});

test("a hidden document pauses polling and refreshes when visible after a minute", async () => {
  const view = await page(response(snapshot()));
  view.document.hidden = true;
  view.clock.now += 60000;
  view.queue.push(response(snapshot([{...firstGame, away_score:21}], view.clock.now)));
  await view.refresh();
  await view.document.dispatch("visibilitychange");
  assert.equal(view.calls.length, 1);
  assert.deepEqual(scores(cards(view)[0]), ["14", "0"]);
  view.document.hidden = false;
  await view.document.dispatch("visibilitychange");
  assert.equal(view.calls.length, 2);
  assert.deepEqual(scores(cards(view)[0]), ["21", "0"]);
  await view.document.dispatch("visibilitychange");
  assert.equal(view.calls.length, 2, "Repeated visibility events within a minute must not refetch");
});

test("manual week selection survives refresh when the automatic current week changes", async () => {
  const second = {...firstGame, game_id:"2026_02_BUF_BAL", week:2,
    gameday:"2026-09-20", kickoff:"2026-09-20T17:00:00Z", home_score:null, away_score:null};
  const third = {...firstGame, game_id:"2026_03_BUF_BAL", week:3,
    gameday:"2026-09-24", kickoff:"2026-09-25T00:15:00Z", home_score:null, away_score:null};
  const view = await page(response(snapshot([firstGame, second, third])));
  assert.equal(view.select.value, "1");
  view.select.value = "2";
  await view.select.dispatch("change");
  assert.equal(cards(view)[0].children[0].textContent, "Scheduled");
  view.clock.now = Date.parse("2026-09-24T18:00:00Z");
  assert.equal(defaultScoreWeek([firstGame, second, third], view.clock.now), 3);
  view.queue.push(response(snapshot([firstGame, {...second, home_score:7, away_score:24}, third], view.clock.now)));
  await view.refresh();
  assert.equal(view.select.value, "2");
  assert.deepEqual(view.select.children.map(option => option.value), ["1", "2", "3"]);
  assert.equal(cards(view).length, 1);
  assert.deepEqual(scores(cards(view)[0]), ["24", "7"]);
});

test("null and malformed games are ignored on first load and refresh", async () => {
  const malformed = [null, {}, "bad row", {...firstGame, game_id:"bad-team", home:"invalid"},
    {...firstGame, game_id:"bad-week", week:19}, {...firstGame, game_id:"same-team", home:"BUF"}];
  const view = await page(response(snapshot([...malformed, firstGame, firstGame])));
  assert.equal(cards(view).length, 1);
  assert.deepEqual(scores(cards(view)[0]), ["14", "0"]);
  assert.equal(view.status.classList.contains("stale"), false);
  view.queue.push(response(snapshot([null, {...firstGame, home_score:10}, ...malformed])));
  await view.refresh();
  assert.equal(cards(view).length, 1);
  assert.deepEqual(scores(cards(view)[0]), ["14", "10"]);
  assert.doesNotMatch(view.status.textContent, /unavailable/);
  view.queue.push(response(snapshot(malformed)));
  await view.refresh();
  assert.deepEqual(scores(cards(view)[0]), ["14", "10"], "An all-invalid response must retain good scores");
  assert.match(view.status.textContent, /Refresh unavailable/);
});
