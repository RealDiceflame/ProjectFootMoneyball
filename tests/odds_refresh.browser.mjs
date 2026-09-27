// Same isolated local-server and fake-clock harness as labs_refresh.browser.mjs.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {observeRefreshChecks, waitForRefreshCheck, completedRefreshChecks} from "./helpers/refresh-clock.mjs";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const now = Date.parse("2026-09-27T16:00:00Z");
let browser, server, base, original;
before(async () => {
  original = JSON.parse(await readFile(resolve(root, "data/nfl_odds.json"), "utf8"));
  original.has_sportsbooks = true;
  original.generated_at = new Date(now).toISOString();
  original.source_health = {sportsbooks: {status: "success", freshness: "current", last_success: new Date(now).toISOString(), selected_provider: "The Odds API"}};
  original.sources.sportsbooks = {name: "The Odds API"};
  original.prediction_markets = [{id: "test", title: "Test NFL market", url: "https://polymarket.com/", volume: 100, contracts: [{label: "Yes", probability: 0.5}]}];
  for (const game of original.games) game.rows = [{provider: "DraftKings", provider_key: "draftkings", provider_kind: "sportsbook", provider_url: "https://sportsbook.draftkings.com/", market: "Moneyline", selection: game.home, price: 150, line: null, updated_at: new Date(now).toISOString(), is_best: false}];
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
      if (!path.startsWith(resolve(root) + sep)) {response.writeHead(403).end(); return;}
      response.setHeader("Content-Type", {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}[extname(path)] || "application/octet-stream");
      response.end(await readFile(path));
    } catch {response.writeHead(404).end();}
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await chromium.launch({headless: true, ...(channel === "chromium" ? {} : {channel})});
});
after(async () => {await browser?.close(); if (server) await new Promise(done => server.close(done));});

test("odds refresh preserves filters and focus, labels cached quotes, retains good data on failures, and recovers", async () => {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage(), errors = [];
  let value = structuredClone(original), revision = 0;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === "/data/update_status.json") return route.fulfill({json: {status: "success", completed_at: new Date(now + revision * 1000).toISOString(), sources: {}}});
    if (url.pathname === "/data/nfl_odds.json") return value === "HTTP_ERROR" ? route.fulfill({status: 503, body: "unavailable"}) : route.fulfill({json: value});
    return route.continue();
  });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({time: new Date(now)});
  await observeRefreshChecks(page);
  const tick = async () => {
    await waitForRefreshCheck(page);
    const previous = await completedRefreshChecks(page);
    revision++; await page.clock.fastForward(60001);
    await waitForRefreshCheck(page, previous);
  };
  try {
    await page.goto(`${base}/odds.html`);
    await waitForRefreshCheck(page);
    await page.locator("#odds-games .odds-game-card").first().waitFor();
    const week = original.weeks[1] || original.weeks[0], game = original.games.find(game => game.week === week);
    await page.selectOption("#odds-week", String(week));
    await page.selectOption("#odds-provider", "draftkings");
    await page.fill("#odds-search", game.home_name);
    await page.locator("#odds-search").focus();
    assert.equal(await page.locator("#odds-games .odds-game-card").count(), 1);
    assert.equal(await page.locator("#sportsbook-connection").evaluate(node => node.classList.contains("connected")), true);

    value.source_health.sportsbooks.status = "cached";
    value.source_health.sportsbooks.freshness = "stale";
    value.generated_at = new Date(now + 1000).toISOString();
    const changed = value.games.find(item => item.game_id === game.game_id);
    changed.rows[0].price = 175; changed.rows[0].retained = true;
    await tick();
    await page.waitForFunction(() => document.querySelector("#odds-games").textContent.includes("+175"));
    assert.equal(await page.inputValue("#odds-week"), String(week));
    assert.equal(await page.inputValue("#odds-provider"), "draftkings");
    assert.equal(await page.inputValue("#odds-search"), game.home_name);
    assert.equal(await page.evaluate(() => document.activeElement.id), "odds-search");
    assert.equal(await page.locator("#sportsbook-connection").evaluate(node => node.classList.contains("connected")), false);
    assert.match(await page.locator("#sportsbook-connection").textContent(), /Saved sportsbook comparisons/);
    assert.match(await page.locator("#odds-games").textContent(), /Saved/);
    const preserved = await page.locator("#odds-games").innerHTML();
    const healthy = structuredClone(value);

    value = "HTTP_ERROR";
    await tick();
    await page.waitForFunction(() => document.querySelector("#odds-status").textContent.includes("Refresh unavailable"));
    assert.equal(await page.locator("#odds-games").innerHTML(), preserved);

    value = structuredClone(healthy);
    value.prediction_markets[0].contracts = {};
    await tick();
    await page.waitForFunction(() => document.querySelector("#odds-status").textContent.includes("Refresh unavailable"));
    assert.equal(await page.locator("#odds-games").innerHTML(), preserved);
    assert.equal(await page.inputValue("#odds-search"), game.home_name);

    value = structuredClone(healthy);
    value.source_health.sportsbooks.status = "success";
    value.source_health.sportsbooks.freshness = "current";
    value.games.find(item => item.game_id === game.game_id).rows[0].price = 190;
    value.games.find(item => item.game_id === game.game_id).rows[0].retained = false;
    await tick();
    await page.waitForFunction(() => document.querySelector("#odds-games").textContent.includes("+190"));
    assert.equal(await page.locator("#sportsbook-connection").evaluate(node => node.classList.contains("connected")), true);
    assert.doesNotMatch(await page.locator("#odds-status").textContent(), /Refresh unavailable/);
    assert.equal(await page.inputValue("#odds-week"), String(week));
    assert.equal(await page.inputValue("#odds-provider"), "draftkings");
    assert.equal(await page.inputValue("#odds-search"), game.home_name);
    assert.deepEqual(errors, []);
  } finally {await context.close();}
});
