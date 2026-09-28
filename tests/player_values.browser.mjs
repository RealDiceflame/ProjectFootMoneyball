import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {MODEL_VERSION, valueFormatKey} from "../docs/player-values.mjs";
import {observeRefreshChecks, waitForRefreshCheck, completedRefreshChecks} from "./helpers/refresh-clock.mjs";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
let server, browser, base, inputs, rankings, news;
before(async () => {
  [inputs, rankings, news] = await Promise.all(["player_value_inputs", "rankings", "player_news"].map(async name => JSON.parse(await readFile(resolve(root, `data/${name}.json`), "utf8"))));
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
  const engine = process.env.BROWSER_ENGINE || "chromium", channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await engines[engine].launch({headless: true, ...(engine === "chromium" && channel !== "chromium" ? {channel} : {})});
});
after(async () => {await browser?.close(); if (server) await new Promise(done => server.close(done));});

async function open({fixtures = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  const now = Date.now(); await page.clock.install({time: new Date(now)}); await observeRefreshChecks(page);
  const state = {revision: 0, inputs: structuredClone(inputs), rankings: structuredClone(rankings), news: structuredClone(news), badInputs: false, missingNews: false, archive: null, snapshots: new Map()};
  if (fixtures) {
    // The fixture's source time is explicit, and its added player has no evidence.
    state.inputs.generated_at = new Date(now).toISOString();
    const columns = state.rankings.columns;
    for (const rows of Object.values(state.rankings.boards)) rows.push(columns.map(key => ({player: "No Evidence Prospect", player_id: "00-9999999", pos: "WR", team: "BUF", projected_points: null, overall_rank: 999}[key] ?? null)));
  }
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    const json = value => route.fulfill({json: value});
    if (url.pathname === "/data/update_status.json") return json({completed_at: new Date(now + state.revision * 1000).toISOString()});
    if (fixtures && url.pathname === "/data/rankings.json") return json(state.rankings);
    if (fixtures && url.pathname === "/data/player_value_inputs.json") return json(state.badInputs ? {schema_version: 1} : state.inputs);
    if (fixtures && url.pathname === "/data/player_news.json") return state.missingNews ? route.fulfill({status: 503, body: "Unavailable"}) : json(state.news);
    if (state.archive && url.pathname === "/data/player_values/index.json") return json(state.archive);
    const filename = url.pathname.split("/").at(-1);
    if (url.pathname.startsWith("/data/player_values/") && state.snapshots.has(filename)) return json(state.snapshots.get(filename));
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem("project-foot-moneyball:drafted:v1", '["Keep This|BUF"]');
    localStorage.setItem("project-foot-moneyball:settings:v1", '{"teams":10}');
  });
  const tick = async () => {
    const previous = await completedRefreshChecks(page);
    state.revision++;
    await page.clock.fastForward(60000);
    await waitForRefreshCheck(page, previous);
  };
  return {page, context, state, errors, now, tick};
}
async function ready(page) {
  await page.goto(`${base}/values.html`);
  await page.locator("#values-rows tr").first().waitFor();
  await waitForRefreshCheck(page);
}
async function assertLayout(page, width) {
  await page.setViewportSize({width, height: 1000});
  await page.waitForFunction(() => [...document.querySelectorAll(".values-chart")].every(svg => Number(svg.dataset.points) > 8 || svg.getBoundingClientRect().width <= svg.closest(".values-chart-scroll").clientWidth + 1));
  const result = await page.evaluate(() => {
    const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && (!element.checkVisibility || element.checkVisibility());
    return {
      width: document.documentElement.scrollWidth,
      small: [...document.querySelectorAll("main button, main input, main select, main summary")].filter(visible).filter(element => element.getBoundingClientRect().height < 44).map(element => element.id || element.textContent),
      regions: [...document.querySelectorAll(".values-table-scroll, .values-chart-scroll")].filter(visible).filter(element => element.scrollWidth > element.clientWidth + 1).map(element => ({label: element.getAttribute("aria-label"), focus: element.tabIndex, right: element.getBoundingClientRect().right})),
      tinyChartLabels: [...document.querySelectorAll(".values-chart text")].filter(visible).filter(text => parseFloat(getComputedStyle(text).fontSize) * Math.hypot(text.getScreenCTM().a, text.getScreenCTM().b) < 12).map(text => text.textContent),
    };
  });
  assert.ok(result.width <= width, `Page overflows ${width}px: ${JSON.stringify(result)}`);
  assert.deepEqual(result.small, []);
  assert.deepEqual(result.tinyChartLabels, [], "Sparse phone charts fit without shrinking chart labels");
  assert.ok(result.regions.every(region => region.label && region.focus === 0 && region.right <= width + 1), "Wide data remains in named keyboard-scrollable regions");
}

test("real value board remains responsive and keeps original draft settings untouched", async () => {
  const {page, context, errors} = await open();
  try {
    await ready(page);
    assert.ok(await page.locator("#values-rows tr").count() > 100);
    for (const width of [1440, 1024, 768, 390, 320]) await assertLayout(page, width);
    await page.locator(".values-data-details").evaluate(element => {element.open = true;});
    await assertLayout(page, 320);
    const scroller = page.locator("#values-table-region");
    await scroller.evaluate(element => {element.scrollLeft = 0;});
    const visibleValue = await page.locator('#values-rows tr[aria-selected="true"] .values-mobile-value').evaluate(element => {
      const bounds = element.getBoundingClientRect(), region = element.closest(".values-table-scroll").getBoundingClientRect();
      return {text: element.textContent, width: bounds.width, left: bounds.left, right: bounds.right, regionLeft: region.left, regionRight: region.right};
    });
    assert.match(visibleValue.text, /Value [\d,]+ · PPG/);
    assert.ok(visibleValue.width > 0 && visibleValue.left >= visibleValue.regionLeft && visibleValue.right <= visibleValue.regionRight, `Player value is readable before horizontal scrolling: ${JSON.stringify(visibleValue)}`);
    await scroller.focus(); await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#values-table-region").scrollLeft > 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("project-foot-moneyball:drafted:v1")), '["Keep This|BUF"]');
    assert.equal(await page.evaluate(() => localStorage.getItem("project-foot-moneyball:settings:v1")), '{"teams":10}');
    assert.deepEqual(errors, []);
    if (process.env.VALUE_SCREENSHOTS) {
      await mkdir(process.env.VALUE_SCREENSHOTS, {recursive: true});
      for (const [width, name] of [[1440, "desktop"], [320, "mobile"]]) {
        await page.setViewportSize({width, height: 1000});
        await page.evaluate(() => scrollTo({top: 0, behavior: "instant"}));
        await page.screenshot({path: resolve(process.env.VALUE_SCREENSHOTS, `value-${name}.png`), fullPage: true});
      }
    }
  } finally {await context.close();}
});

test("history uses only genuine compatible captures and distinguishes missing from zero", async () => {
  const {page, context, state, now, errors} = await open({fixtures: true});
  try {
    const id = "00-0033280", format = valueFormatKey({ppr: "Half PPR"});
    const entries = Array.from({length: 4}, (_, index) => {
      const date = new Date(now - (3 - index) * 86400000).toISOString().slice(0, 10), as_of = `${date}T00:00:00.000Z`;
      return {date, as_of, path: `${date}.json`, season: index === 2 ? inputs.season - 1 : inputs.season, model_version: index === 1 ? "different-model" : MODEL_VERSION};
    });
    state.archive = {schema_version: 1, model_version: MODEL_VERSION, snapshots: entries};
    entries.forEach((entry, index) => state.snapshots.set(entry.path, {model_version: entry.model_version, season: index === 2 ? inputs.season - 1 : inputs.season, as_of: entry.as_of,
      formats: {[format]: {columns: ["player_id", "ros_index", "dynasty_index", "ros_points", "dynasty_points"], rows: [[id, index === 3 ? null : 5000, index === 3 ? 8000 : 4000, 150, 500]]}}}));
    await ready(page);
    await page.selectOption("#values-player", id);
    assert.equal(await page.locator("#values-history-chart circle").count(), 1);
    assert.equal(await page.locator("#values-history-chart polyline").count(), 0, "A single capture must not invent a trend");
    assert.match(await page.locator("#values-history-note").innerText(), /One real capture/);
    await page.getByRole("button", {name: "Dynasty · 3 years", exact: true}).click();
    assert.equal(await page.locator("#values-history-chart circle").count(), 2);
    await page.selectOption("#values-ppr", "Full PPR");
    assert.equal(await page.locator("#values-history-chart circle").count(), 0, "A different scoring format does not borrow old values");
    await page.fill("#values-search", "No Evidence Prospect");
    assert.equal(await page.locator("#values-rows tr").count(), 1);
    assert.equal(await page.locator("#values-rows td.values-index").innerText(), "—");
    await page.fill("#values-search", "");
    assert.ok(await page.locator("#values-rows td.values-index").evaluateAll(cells => cells.some(cell => cell.textContent === "0")), "Zero surplus remains a real displayed index");
    await page.selectOption("#values-position", "TE");
    await page.selectOption("#values-te-premium", "+0.5");
    assert.ok((await page.locator("#values-rows tr td:nth-child(3)").allTextContents()).every(value => value === "TE"));
    assert.equal(await page.inputValue("#values-player"), id, "Filtering the table does not discard the selected notebook");
    assert.deepEqual(errors, []);
  } finally {await context.close();}
});

test("refresh preserves controls and focus, retains good core data, and recovers optional news independently", async () => {
  const {page, context, state, tick, errors} = await open({fixtures: true});
  try {
    await ready(page);
    await page.selectOption("#values-quarterbacks", "2QB");
    await page.selectOption("#values-player", "00-0033280");
    await page.fill("#values-search", "Christian McCaffrey");
    await page.setViewportSize({width: 390, height: 1000});
    const initial = await page.locator("#values-rows td:nth-child(5)").innerText();
    const columns = state.inputs.columns, receptions = columns.indexOf("receptions"), player = columns.indexOf("player_id");
    state.inputs.rows.filter(row => row[player] === "00-0033280").forEach(row => {row[receptions] += 10;});
    await page.locator("#values-table-region").evaluate(element => {element.scrollLeft = 160;});
    await page.locator("#values-search").focus();
    await tick();
    assert.notEqual(await page.locator("#values-rows td:nth-child(5)").innerText(), initial);
    assert.equal(await page.inputValue("#values-quarterbacks"), "2QB");
    assert.equal(await page.inputValue("#values-player"), "00-0033280");
    assert.equal(await page.inputValue("#values-search"), "Christian McCaffrey");
    assert.equal(await page.locator("#values-search").evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator("#values-table-region").evaluate(element => element.scrollLeft), 160);
    const good = await page.locator("#values-rows").innerText();
    state.badInputs = true; await tick();
    assert.equal(await page.locator("#values-rows").innerText(), good);
    assert.match(await page.locator("#values-error").innerText(), /Update incomplete/);
    state.badInputs = false; state.missingNews = true; await tick();
    assert.match(await page.locator("#values-status").innerText(), /News unavailable/);
    assert.match(await page.locator("#values-rows td:last-child").innerText(), /unknown/);
    state.missingNews = false;
    const sourceTime = state.news.generated_at;
    state.news.generated_at = new Date(Date.now() + 86400000).toISOString();
    await tick();
    assert.match(await page.locator("#values-status").innerText(), /News unavailable/, "A future-dated optional source is isolated instead of blocking the board");
    state.news.generated_at = sourceTime; await tick();
    assert.equal(await page.locator("#values-error").isHidden(), true);
    assert.equal(await page.locator("#values-rows tr").count(), 1);
    assert.deepEqual(errors, []);
  } finally {await context.close();}
});
