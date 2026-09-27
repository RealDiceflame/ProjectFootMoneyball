// Run with node --test; set PLAYWRIGHT_MODULE to a Playwright installation if needed.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {simulateLeague} from "../docs/league-model.mjs";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const now = Date.parse("2026-09-27T16:00:00Z");
const originals = {};
let browser, server, base, leagueResult;
before(async () => {
  for (const key of ["rankings", "player_history", "player_news", "draft_capital_history", "survivor", "nfl_odds"]) originals[key] = JSON.parse(await readFile(resolve(root, "data", `${key}.json`), "utf8"));
  leagueResult = simulateLeague(originals.survivor, {trials: 100, seed: 42, now});
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
      if (!path.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
      response.setHeader("Content-Type", {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}[extname(path)] || "application/octet-stream");
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await chromium.launch({headless: true, ...(channel === "chromium" ? {} : {channel})});
});
after(async () => { await browser?.close(); if (server) await new Promise(done => server.close(done)); });

async function open(path, {fakeWorker = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const values = structuredClone(originals), requests = {}, errors = [];
  let revision = 0, manifestGate = null;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort(); // Never contact upstream providers in tests.
    const key = /^\/data\/(.+)\.json$/.exec(url.pathname)?.[1];
    if (key) requests[key] = (requests[key] || 0) + 1;
    if (key === "update_status") {
      if (manifestGate) {
        const gate = manifestGate; manifestGate = null;
        gate.requested(); await gate.released;
      }
      return route.fulfill({json: {completed_at: new Date(now + revision * 1000).toISOString()}});
    }
    if (Object.hasOwn(values, key)) {
      if (values[key] === "HTTP_ERROR") return route.fulfill({status: 503, body: "temporarily unavailable"});
      return route.fulfill({json: values[key]});
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({time: new Date(now)});
  await page.addInitScript(() => {
    // Observe the real poller's watchdog rather than guessing when its fetch /
    // JSON / render chain has settled. The helper clears this timer in finally,
    // including manifest-only checks and rejected snapshots. Keep the timer's
    // behavior unchanged so aborted requests remain part of the test coverage.
    const setTimeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
    const checks = window.labRefreshChecks = {started: 0, pending: new Set()};
    window.setTimeout = (callback, delay, ...args) => {
      const id = setTimeout(callback, delay, ...args);
      if (delay === 15000) { checks.started++; checks.pending.add(id); }
      return id;
    };
    window.clearTimeout = id => { checks.pending.delete(id); return clearTimeout(id); };
  });
  if (fakeWorker) await page.addInitScript(() => {
    window.labWorkers = [];
    window.Worker = class {
      constructor() { window.labWorkers.push(this); }
      postMessage(message) { this.message = structuredClone(message); }
      terminate() { this.terminated = true; }
    };
  });
  await page.goto(`${base}/${path}`);
  const settled = () => page.waitForFunction(() => window.labRefreshChecks.started > 0 && window.labRefreshChecks.pending.size === 0);
  await settled();
  return {context, page, values, requests, errors, holdNextManifest: () => {
    let requested, release;
    const started = new Promise(resolve => { requested = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    manifestGate = {requested, released};
    return {started, release};
  }, tick: async (changed = true) => {
    await settled();
    const previousChecks = await page.evaluate(() => window.labRefreshChecks.started);
    if (changed) revision++;
    await page.clock.fastForward(60001);
    await page.waitForFunction(previous => window.labRefreshChecks.started > previous && window.labRefreshChecks.pending.size === 0, previousChecks);
  }};
}

test("projection replaces changed snapshots while retaining player, format, season, chart controls and focus", async () => {
  const lab = await open("projection.html"), {page, context, values, errors} = lab;
  try {
    await page.waitForFunction(() => !document.querySelector("#projection-content").classList.contains("hidden"));
    await page.selectOption("#model-position", "WR");
    await page.selectOption("#model-teams", "10");
    await page.selectOption("#round-map-season", "2024");
    await page.selectOption("#round-map-wait", "2");
    await page.selectOption("#age-view", "career");
    const player = await page.locator("#model-player option").nth(2).getAttribute("value");
    await page.selectOption("#model-player", player);
    await page.locator("#model-player").focus();
    const count = await page.locator("#model-player option").count();
    await page.evaluate(() => { window.scrollTo({top: 250, behavior: "instant"}); window.originalChart = document.querySelector("#age-chart svg"); });
    // Reproduce a slow manifest response without sleeping: a fake minute must
    // not finish until its actual poll has settled, even with no changed data.
    const heldManifest = lab.holdNextManifest();
    let tickFinished = false;
    const unchangedTick = lab.tick(false).then(() => { tickFinished = true; });
    try {
      await heldManifest.started;
      assert.equal(await page.evaluate(() => window.labRefreshChecks.pending.size), 1);
      assert.equal(tickFinished, false, "tick waits for the in-flight manifest check");
    } finally { heldManifest.release(); }
    await unchangedTick;
    assert.equal(await page.evaluate(() => window.originalChart === document.querySelector("#age-chart svg")), true, "unchanged manifest does not rebuild charts");
    values.rankings.projection_season++;
    await lab.tick();
    await page.waitForFunction(season => document.querySelector("#projection-status").textContent.startsWith(`${season} model`), values.rankings.projection_season);
    assert.equal(await page.inputValue("#model-player"), player);
    assert.equal(await page.inputValue("#model-teams"), "10");
    assert.equal(await page.inputValue("#round-map-season"), "2024");
    assert.equal(await page.inputValue("#round-map-wait"), "2");
    assert.equal(await page.inputValue("#age-view"), "career");
    assert.equal(await page.locator("#model-player option").count(), count);
    assert.equal(await page.evaluate(() => document.activeElement.id), "model-player");
    assert.equal(await page.evaluate(() => scrollY), 250);
    const displayed = await page.locator("#projection-content").innerHTML();
    values.rankings = {boards: {}};
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#projection-status").textContent.includes("Refresh delayed"));
    assert.equal(await page.locator("#projection-content").innerHTML(), displayed);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("survivor refresh keeps saved picks, week and matchup controls, preserves focus, and rejects malformed forecasts", async () => {
  const lab = await open("survivor.html"), {page, context, values, errors} = lab;
  try {
    await page.locator("#survivor-content").waitFor({state: "visible"});
    await page.selectOption("#start-week", "4");
    await page.selectOption("#end-week", "5");
    await page.selectOption("#tie-rule", "survive");
    await page.click("#fill-plan");
    await page.click("#simulate-plan");
    await page.selectOption("#matchup-mode", "custom");
    await page.selectOption("#matchup-home", "BUF");
    await page.selectOption("#matchup-away", "KC");
    await page.selectOption("#matchup-venue", "neutral");
    await page.selectOption("#matchup-chart-metric", "total");
    const before = await page.evaluate(() => localStorage.getItem("outlierbaseline-survivor-v1-2026"));
    const firstPick = page.getByLabel("Pick for week 4", {exact: true});
    const pick = await firstPick.inputValue();
    await firstPick.focus();
    const summary = await page.locator("#matchup-summary").textContent();
    values.survivor.teams.find(team => team.team === "BUF").offense += 4;
    values.survivor.generated_at = new Date(now + 1000).toISOString();
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#simulation-results [data-refresh-note]"));
    assert.equal(await page.evaluate(() => localStorage.getItem("outlierbaseline-survivor-v1-2026")), before);
    assert.equal(await firstPick.inputValue(), pick);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Pick for week 4");
    assert.equal(await page.inputValue("#start-week"), "4");
    assert.equal(await page.inputValue("#end-week"), "5");
    assert.equal(await page.inputValue("#tie-rule"), "survive");
    for (const [key, value] of Object.entries({mode: "custom", home: "BUF", away: "KC", venue: "neutral", "chart-metric": "total"})) assert.equal(await page.inputValue(`#matchup-${key}`), value);
    assert.equal(await page.locator("#start-week option").count(), 18);
    assert.equal(await page.locator("#matchup-home option").count(), 32);
    assert.notEqual(await page.locator("#matchup-summary").textContent(), summary);
    const good = await page.locator("#team-ratings").textContent();
    values.survivor.games.find(game => game.model).model.home_win = 4;
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#survivor-status").textContent.includes("Refresh delayed"));
    assert.equal(await page.locator("#team-ratings").textContent(), good);
    assert.equal(await page.evaluate(() => localStorage.getItem("outlierbaseline-survivor-v1-2026")), before);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("matchup refresh updates odds and retains the previous market on a failed response", async () => {
  const lab = await open("survivor.html"), {page, context, values, errors} = lab;
  try {
    await page.locator("#matchup-odds-table").waitFor();
    const gameId = await page.inputValue("#matchup-game");
    const game = values.nfl_odds.games.find(game => game.game_id === gameId);
    assert.ok(game, "selected fixture has a saved odds snapshot");
    const market = await page.locator("#matchup-market").textContent();
    game.rows.forEach(row => { if (row.market === "Moneyline") row.price = row.price > 0 ? 555 : -555; });
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#matchup-market").textContent.includes("555"));
    assert.notEqual(await page.locator("#matchup-market").textContent(), market);
    assert.equal(await page.inputValue("#matchup-game"), gameId);
    const table = await page.locator("#matchup-odds-table").textContent();
    values.nfl_odds = "HTTP_ERROR";
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#matchup-market").textContent.includes("Odds refresh delayed"));
    assert.equal(await page.locator("#matchup-odds-table").textContent(), table);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("league stages updates during a run and only an explicit new run consumes the latest snapshot", async () => {
  const lab = await open("league.html", {fakeWorker: true}), {page, context, values, errors} = lab;
  // The worker is controlled here to exercise overlap deterministically; model correctness is tested separately.
  const finish = () => page.evaluate(result => {
    const worker = window.labWorkers.at(-1);
    worker.onmessage({data: {result: {...result, trials: worker.message.options.trials, seed: worker.message.options.seed}}});
  }, leagueResult);
  try {
    await page.waitForFunction(() => window.labWorkers?.[0]?.message);
    const oldDate = values.survivor.generated_at;
    const seed = await page.inputValue("#league-seed");
    values.survivor.generated_at = new Date(now + 1000).toISOString();
    values.survivor.teams[0].offense += 1;
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#league-status").textContent.includes("ready after this run"));
    assert.equal(await page.evaluate(() => window.labWorkers[0].message.data.generated_at), oldDate);
    assert.equal(await page.inputValue("#league-seed"), seed);
    await finish();
    await page.waitForFunction(() => document.querySelector("#league-status").textContent.includes("Results use the previous snapshot"));
    assert.equal(await page.evaluate(() => window.labWorkers.length), 1);
    await page.selectOption("#league-team", "BUF");
    await page.selectOption("#league-week", "4");
    await page.selectOption("#league-example-select", "1");
    const output = await page.locator("#league-summary").innerHTML();
    await page.locator("#league-team").focus();
    values.survivor.generated_at = new Date(now + 3600000).toISOString();
    await lab.tick();
    await page.waitForFunction(timestamp => document.querySelector("#league-status").textContent.includes(new Date(timestamp).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"})), values.survivor.generated_at);
    assert.equal(await page.inputValue("#league-team"), "BUF");
    assert.equal(await page.inputValue("#league-week"), "4");
    assert.equal(await page.inputValue("#league-example-select"), "1");
    assert.equal(await page.evaluate(() => document.activeElement.id), "league-team");
    assert.equal(await page.locator("#league-team option").count(), 33);
    assert.equal(await page.locator("#league-week option").count(), 19);
    assert.equal(await page.locator("#league-summary").innerHTML(), output);
    assert.equal(await page.evaluate(() => window.labWorkers.length), 1);
    await page.check("#league-fixed-seed");
    await page.fill("#league-seed", "12345");
    await page.click("#league-run");
    await page.waitForFunction(() => window.labWorkers.length === 2);
    assert.equal(await page.evaluate(() => window.labWorkers[1].message.data.generated_at), values.survivor.generated_at);
    assert.equal(await page.evaluate(() => window.labWorkers[1].message.options.seed), 12345);
    await finish();
    assert.equal(await page.locator("#league-status").textContent().then(text => text.includes("previous snapshot")), false);
    values.survivor = {teams: []};
    await lab.tick();
    await page.waitForFunction(() => document.querySelector("#league-status").textContent.includes("Refresh delayed"));
    assert.equal(await page.evaluate(() => window.labWorkers.length), 2);
    assert.equal(await page.inputValue("#league-seed"), "12345");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
