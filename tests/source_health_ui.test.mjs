import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.classes = new Set(); this.events = {}; this.classList = {add: name => this.classes.add(name), remove: name => this.classes.delete(name), toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name)}; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return [this.text || "", ...this.children.map(child => child.textContent)].join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ""; this.children = nodes; }
  addEventListener(name, action) { this.events[name] = action; }
}

function script(name, globals = {}) {
  const nodes = new Map();
  const document = {querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); }, createElement: tag => new Element(tag)};
  const context = vm.createContext({document, Date, startAutoRefresh() {}, ...globals});
  const source = readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8").replace(/^import\s[\s\S]*?;\r?\n/gm, "");
  new vm.Script(source).runInContext(context);
  return context;
}

function nav(globals = {}) {
  return script("site-nav.js", {document: {querySelector: () => null}, location: {pathname: "/odds.html"}, ...globals});
}

test("source labels explain manual, historical, unconfigured and empty market states", () => {
  const view = nav();
  assert.match(view.sourceHealthText({status: "manual", data_updated_at: "2026-08-29"}), /manual import; updated only when a snapshot is imported/);
  assert.match(view.sourceHealthText({status: "historical"}), /historical archive; completed-season data, no live update expected/);
  assert.match(view.sourceHealthText({status: "not_configured"}), /no provider request was made/);
  assert.match(view.sourceHealthText({status: "no_upcoming_markets"}), /request succeeded with no matching markets/);
  assert.match(view.sourceHealthText({status: "fallback", selected_provider: "SportsGameOdds"}), /backup feed in use; SportsGameOdds/);
  const snapshot = view.sourceHealthText({status: "success", timestamp_kind: "snapshot", data_updated_at: "2026-09-27"});
  assert.match(snapshot, /snapshot captured/);
  assert.doesNotMatch(snapshot, /source data dated/);
});

test("cached provider status is independent from a successfully executed job", () => {
  const view = nav();
  const message = view.sourceHealthText({status: "cached", execution_status: "success", last_success: "2026-09-20T12:00:00Z"});
  assert.match(message, /saved data retained after a failed refresh/);
  assert.match(message, /refresh job completed/);
  assert.match(message, /last successful check/);
  assert.match(view.sourceHealthText({status: "behind", season: 2026, expected_week: 4, latest_report_season: 2025, latest_report_week: 18}), /expected 2026 week 4, latest report 2025 week 18/);
});

test("an empty recent draft window is explained without calling it a failed request", () => {
  const view = nav();
  const saved = view.sourceHealthText({status: "cached", reason_code: "no_recent_drafts", data_updated_at: "2026-09-24", timestamp_kind: "snapshot"});
  assert.match(saved, /no recent qualifying drafts; keeping the previous ADP snapshot/);
  assert.match(saved, /snapshot captured/);
  assert.doesNotMatch(saved, /failed refresh/);
  assert.match(view.sourceHealthText({status: "failed", reason_code: "no_recent_drafts"}), /no ADP snapshot available/);
});

test("forecast coverage and provider failures remain separate", () => {
  const view = nav();
  const pending = view.sourceHealthText({status: "success", pending_count: 2, failed_count: 0});
  assert.match(pending, /2 kickoff forecasts not yet published/);
  assert.doesNotMatch(pending, /requests failed/);
  const failed = view.sourceHealthText({status: "partial_failure", pending_count: 1, failed_count: 3, retained_count: 2});
  assert.match(failed, /3 forecast requests failed/);
  assert.match(failed, /2 saved kickoff forecasts retained/);
});

test("collapsible status renders per-provider details without reload advice and recovers from errors", async () => {
  const footer = new Element("footer"), callbacks = [];
  let fail = false;
  nav({
    document: {querySelector: selector => selector === "footer" ? footer : null, createElement: tag => new Element(tag)},
    setInterval: callback => callbacks.push(callback),
    fetch: async () => {
      if (fail) throw new Error("offline");
      return {ok: true, json: async () => ({completed_at: new Date().toISOString(), status: "partial_failure", execution_status: "success", sources: {rankings: {status: "partial_failure", execution_status: "success", providers: {Yahoo: {status: "manual"}, Sleeper: {status: "cached"}}}}})};
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(footer.children.length, 1);
  assert.equal(footer.children[0].tagName, "details");
  assert.match(footer.textContent, /some sources need attention/);
  assert.match(footer.textContent, /Yahoo: manual import/);
  assert.match(footer.textContent, /Sleeper: saved data retained/);
  assert.doesNotMatch(footer.textContent, /reload/i);
  fail = true; await callbacks[0]();
  assert.match(footer.textContent, /status unavailable/);
  fail = false; await callbacks[0]();
  assert.match(footer.textContent, /Yahoo: manual import/);
});

const now = Date.parse("2026-09-27T12:00:00Z");
const payload = (status, overrides = {}) => ({has_sportsbooks: true, games: [], sources: {sportsbooks: {name: "The Odds API"}}, source_health: {sportsbooks: {status, freshness: "current", last_success: new Date(now).toISOString(), ...overrides}}});

test("odds explains primary and working backup snapshots without claiming live connection", () => {
  const view = script("odds.js");
  const primary = view.sportsbookConnection(payload("success"), {now});
  assert.equal(primary.connected, true);
  assert.match(primary.title, /comparison snapshot/);
  assert.match(primary.detail, /displayed prices are saved quotes/);
  const backup = view.sportsbookConnection(payload("fallback", {selected_provider: "SportsGameOdds"}), {now});
  assert.equal(backup.connected, true);
  assert.match(backup.title, /SportsGameOdds backup comparison snapshot/);
  assert.doesNotMatch(primary.title + primary.detail + backup.title + backup.detail, /\blive\b|\bconnected\b/i);
});

test("cached, old, legacy and browser-failed odds never show connected state", () => {
  const view = script("odds.js");
  const cases = [
    [payload("cached"), {now}],
    [payload("fallback", {last_success: "2026-09-26T12:00:00Z"}), {now}],
    [payload("success"), {now, refreshFailed: true}],
    [{has_sportsbooks: true, games: [], sources: {sportsbooks: {name: "The Odds API"}}}, {now}],
    [{...payload("success"), games: [{rows: [{provider_kind: "sportsbook", retained: true}]}]}, {now}],
  ];
  for (const [data, options] of cases) {
    const copy = view.sportsbookConnection(data, options);
    assert.equal(copy.connected, false);
    assert.match(copy.title, /Saved sportsbook comparisons/);
    assert.doesNotMatch(copy.title + copy.detail, /\blive\b|\bconnected\b/i);
  }
});

test("unconfigured, failed and empty sportsbook results have distinct messages", () => {
  const view = script("odds.js");
  for (const [status, expected] of [["not_configured", /not configured/], ["no_upcoming_markets", /No upcoming sportsbook markets/], ["failed", /refresh unavailable/]]) {
    const copy = view.sportsbookConnection({...payload(status), has_sportsbooks: false}, {now});
    assert.equal(copy.connected, false);
    assert.match(copy.title, expected);
  }
});
