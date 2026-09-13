// Run with Node's test runner. Install Playwright or set PLAYWRIGHT_MODULE to its module path.
// BROWSER_CHANNEL defaults to msedge; use chromium for Playwright's bundled browser.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {STORAGE_KEY} from "../docs/fantasy-leagues.mjs";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
let browser, server, base;
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
      if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
      const target = path === resolve(root) ? resolve(root, "index.html") : path;
      const types = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png"};
      response.setHeader("Content-Type", types[extname(target)] || "application/octet-stream");
      response.end(await readFile(target));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await chromium.launch({headless: true, ...(channel === "chromium" ? {} : {channel})});
});
after(async () => { await browser?.close(); if (server) await new Promise(done => server.close(done)); });

async function openPage(options = {}, pathname = "/fantasy.html") {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, ...options});
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.goto(`${base}${pathname}`);
  await page.locator(".lab-navigation").waitFor();
  return {context, page};
}
const isOpen = locator => locator.evaluate(element => element.open);
const waitForOpen = (page, name, open) => page.waitForFunction(({name, open}) => [...document.querySelectorAll(".topnav > details")].find(group => group.querySelector("summary").textContent === name)?.open === open, {name, open});

async function screenshot(page, name) {
  if (!process.env.BROWSER_SCREENSHOTS) return;
  await mkdir(process.env.BROWSER_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, name), fullPage: true});
}

test("desktop hover menus group all labs, stay open over links, switch and dismiss", async () => {
  const {context, page} = await openPage();
  try {
    assert.deepEqual(await page.locator(".topnav > details > summary").allTextContents(), ["Fantasy", "Labs", "Betting"]);
    const labs = page.locator(".topnav > details").nth(1);
    assert.equal(await isOpen(labs), false);
    await labs.locator("summary").hover(); await waitForOpen(page, "Labs", true);
    assert.deepEqual(await labs.locator("h2").allTextContents(), ["Projection Lab", "Simulation Lab"]);
    assert.equal(await labs.locator("a").count(), 6);
    await labs.getByRole("link", {name: "Head-to-head matchup"}).hover();
    assert.equal(await isOpen(labs), true);
    await page.getByRole("heading", {name: "Your leagues. One home."}).hover({position: {x: 10, y: 10}});
    await waitForOpen(page, "Labs", false);
    await labs.locator("summary").hover();
    await page.locator(".topnav > details").last().locator("summary").hover();
    await waitForOpen(page, "Betting", true); await waitForOpen(page, "Labs", false);
    await page.getByRole("heading", {name: "Your leagues. One home."}).click();
    await waitForOpen(page, "Betting", false);
    // Mouse-click focus on a previous tab must not disable later hover navigation.
    await page.locator(".topnav > details").first().locator("summary").click();
    await labs.locator("summary").hover(); await waitForOpen(page, "Labs", true);
  } finally { await context.close(); }
});

test("keyboard links keep their focus, Escape closes without reopening, and Tab can leave", async () => {
  const {context, page} = await openPage();
  try {
    const labs = page.locator(".topnav > details").nth(1), summary = labs.locator("summary");
    await summary.focus(); await page.keyboard.press("Enter"); await waitForOpen(page, "Labs", true);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Player age & scoring");
    await page.getByRole("heading", {name: "Your leagues. One home."}).hover({position: {x: 10, y: 10}});
    // Focused keyboard links must not disappear when the mouse leaves.
    await page.waitForTimeout(300); assert.equal(await isOpen(labs), true);
    await page.keyboard.press("Escape"); await waitForOpen(page, "Labs", false);
    assert.equal(await summary.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Space"); await waitForOpen(page, "Labs", true);
    await labs.locator("a").last().focus(); await page.keyboard.press("Tab");
    await waitForOpen(page, "Labs", false);
  } finally { await context.close(); }
});

test("mobile uses tap, fits the viewport, and follows grouped links", async () => {
  const {context, page} = await openPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  try {
    const labs = page.locator(".topnav > details").nth(1);
    assert.equal(await isOpen(labs), false);
    await labs.locator("summary").tap(); await waitForOpen(page, "Labs", true);
    assert.ok(await labs.getByRole("link", {name: "Team game forecasts"}).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await labs.locator("summary").tap(); await waitForOpen(page, "Labs", false);
    await labs.locator("summary").tap();
    await labs.getByRole("link", {name: "Draft capital map"}).tap();
    await page.waitForURL("**/projection.html#round-map-heading");
    assert.equal(await page.locator(".topnav .current-lab > summary").textContent(), "Labs");
  } finally { await context.close(); }
});

test("create, edit, reload and copy a league without changing draft-board storage", async () => {
  const {context, page} = await openPage();
  try {
    await page.evaluate(() => localStorage.setItem("project-foot-moneyball:drafted:v1", '["keep-this-pick"]'));
    await page.getByLabel("League name", {exact: true}).fill("Sunday friends");
    await page.getByLabel("Number of teams").selectOption("10");
    await page.getByRole("combobox", {name: /^Points per reception/}).selectOption("1");
    await page.getByLabel("Extra points per TE reception").selectOption("0.5");
    await page.getByLabel("Superflex", {exact: true}).fill("1");
    await page.getByRole("button", {name: "Create local setup"}).click();
    await page.waitForFunction(() => document.querySelectorAll("#saved-leagues article").length === 1);
    assert.equal(await page.getByLabel("Number of teams").isDisabled(), true);
    await page.getByLabel("Team 1", {exact: true}).fill("The Outliers");
    await page.getByRole("button", {name: "Save local changes"}).click();
    await page.reload(); await page.locator("#saved-leagues article").waitFor();
    let saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY));
    assert.equal(saved.leagues[0].teams.length, 10); assert.equal(saved.leagues[0].teams[0].name, "The Outliers");
    assert.equal(saved.leagues[0].scoring.ppr, 1); assert.equal(saved.leagues[0].roster.SUPERFLEX, 1);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", {name: "Export backup", exact: true}).click();
    const download = await downloadEvent;
    assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), saved);
    await page.locator("#backup-file").setInputFiles({name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(saved))});
    await page.waitForFunction(() => document.querySelectorAll("#saved-leagues article").length === 2);
    const copies = JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY));
    assert.notEqual(copies.leagues[0].id, copies.leagues[1].id);
    await page.locator("#backup-file").setInputFiles({name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{")});
    await page.locator("#hub-error").waitFor({state: "visible"});
    assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)), copies);
    assert.equal(await page.evaluate(() => localStorage.getItem("project-foot-moneyball:drafted:v1")), '["keep-this-pick"]');
  } finally { await context.close(); }
});

test("bad stored data and cross-tab conflicts are not overwritten", async () => {
  const {context, page} = await openPage();
  try {
    await page.evaluate(key => localStorage.setItem(key, "broken saved data"), STORAGE_KEY);
    await page.reload(); await page.locator("#hub-error").waitFor({state: "visible"});
    await page.getByLabel("League name", {exact: true}).fill("Do not overwrite");
    await page.getByRole("button", {name: "Create local setup"}).click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), "broken saved data");
    await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY); await page.reload();
    await page.getByLabel("League name", {exact: true}).fill("Unsaved form");
    await page.evaluate(key => localStorage.setItem(key, '{"schema_version":1,"mode":"local-prototype","leagues":[]}'), STORAGE_KEY);
    await page.getByRole("button", {name: "Create local setup"}).click();
    assert.match(await page.locator("#hub-error").textContent(), /Another tab/);
    assert.equal(JSON.parse(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).leagues.length, 0);
  } finally { await context.close(); }
});

test("homepage links, injury filters, automatic X loading and mobile layout work", async () => {
  const {context, page} = await openPage({}, "/");
  try {
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).origin !== base) external.push(request.url()); });
    await page.reload(); await page.locator("#home-injury-list article").first().waitFor();
    assert.deepEqual(errors, []);
    await page.waitForFunction(() => document.querySelector("#social-status").textContent.includes("could not load"));
    assert.equal(external.filter(url => url === "https://platform.x.com/widgets.js").length, 1);
    assert.ok(external.every(url => ["platform.x.com", "static.www.nfl.com"].includes(new URL(url).hostname)));
    assert.equal(await page.locator("#load-x-feed").count(), 0);
    assert.equal(await page.locator("#x-feed .twitter-timeline").getAttribute("data-dnt"), "true");
    assert.equal(await page.locator(".home-nav-link").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".topnav .current-lab").count(), 0);
    assert.equal(await page.locator("#home-injury-list article").count(), 8);
    assert.equal(await page.locator("#selected-source-cards .home-source-card").count(), 4);
    assert.deepEqual(await page.locator("#selected-source-cards .home-player-summary strong").allTextContents(),
      ["Lamar Jackson", "Derrick Henry", "David Montgomery", "Malik Nabers"]);
    assert.equal(await page.locator("#selected-source-cards .home-clip").nth(2).getAttribute("href"),
      "https://www.espn.com/video/clip/_/id/49931282/david-montgomery-scores-3rd-td-game");
    assert.equal(await page.locator("#selected-source-cards .home-clip").nth(3).getAttribute("href"),
      "https://www.cbssports.com/watch/fantasy-football/video/malik-nabers-fantasy-outlook-and-injury-status");
    assert.equal(await page.locator("#selected-source-cards .home-portrait").count(), 4);
    assert.equal(await page.locator(".home-highlights .home-injury-detail, .home-highlights .home-badge").count(), 0);
    assert.doesNotMatch(await page.locator("#selected-source-cards .home-card-players").allTextContents().then(rows => rows.join(" ")), /injury|questionable|probable|RISK/i);
    await page.locator("#injury-more").click();
    assert.equal(await page.locator("#home-injury-list article").count(), 16);
    const player = await page.locator("#home-injury-list h3").first().textContent();
    await page.locator("#injury-search").fill(player);
    assert.equal(await page.locator("#home-injury-list article").count(), 1);
    const source = page.locator("#home-injury-list article a").first();
    assert.match(await source.getAttribute("href"), /^https:\/\/www.espn.com\//);
    assert.equal(await source.getAttribute("target"), "_blank");
    await page.locator("#injury-search").fill("");
    await page.locator("#injury-filter").selectOption("risk");
    assert.ok((await page.locator("#home-injury-list .home-badge").allTextContents()).every(value => value === "RISK"));
    await page.locator("#injury-search").fill("no-such-player");
    assert.match(await page.locator("#home-injury-list").textContent(), /No reports match/);
    await page.locator("#injury-search").fill(""); await page.locator("#injury-filter").selectOption("all");
    const internal = await page.locator('a[href]').evaluateAll(links => [...new Set(links.filter(a => a.origin === location.origin).map(a => a.href))]);
    for (const url of internal) {
      const response = await context.request.get(url);
      assert.equal(response.status(), 200, url);
      const hash = new URL(url).hash.slice(1);
      if (hash) assert.ok((await response.text()).includes(`id="${hash}"`), url);
    }
    await screenshot(page, "home-desktop.png");
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({width, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `home width ${width}`);
    }
    await page.setViewportSize({width: 390, height: 844}); await screenshot(page, "home-mobile.png");
    assert.equal(external.filter(url => url === "https://platform.x.com/widgets.js").length, 1);
    assert.ok(external.every(url => ["platform.x.com", "static.www.nfl.com"].includes(new URL(url).hostname)));
    assert.equal(await page.getByRole("link", {name: "Open NFL on X ↗", exact: true}).getAttribute("href"), "https://x.com/NFL");
  } finally { await context.close(); }
});

test("automatic X embed initializes once when the widget script is available", async () => {
  const {context, page} = await openPage();
  try {
    let widgetRequests = 0;
    await context.route("https://platform.x.com/widgets.js", route => {
      widgetRequests++;
      return route.fulfill({contentType: "text/javascript", body: 'document.querySelector("#x-feed").dataset.widgetTestLoaded = "true";'});
    });
    await page.goto(base + "/");
    await page.waitForFunction(() => document.querySelector("#social-status").textContent.startsWith("X content requested."));
    assert.equal(widgetRequests, 1);
    assert.equal(await page.locator("#x-feed").getAttribute("data-widget-test-loaded"), "true");
    assert.equal(await page.locator("#x-feed .twitter-timeline").getAttribute("href"), "https://x.com/NFL");
    assert.equal(await page.locator("#x-feed .twitter-timeline").getAttribute("data-dnt"), "true");
    assert.equal(await page.locator("#load-x-feed").count(), 0);
  } finally { await context.close(); }
});

test("homepage gracefully isolates an unavailable injury snapshot", async () => {
  const {context, page} = await openPage({}, "/");
  try {
    await context.route("**/data/player_news.json", route => route.fulfill({status: 503, body: "unavailable"}));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#injury-count").textContent === "Reports unavailable");
    assert.match(await page.locator("#injury-freshness").textContent(), /No current injury status can be inferred/);
    assert.equal(await page.locator("#home-injury-list article").count(), 0);
    assert.equal(await page.locator("#injury-filter").isDisabled(), true);
    assert.equal(await page.locator("#selected-source-cards .home-clip").count(), 4);
    assert.match(await page.locator("#selected-source-cards").textContent(), /Player details unavailable/);
    assert.equal(await page.locator("#selected-source-cards img").count(), 0);
    assert.ok(await page.getByRole("link", {name: "Explore player rankings", exact: false}).isVisible());
    assert.ok(await page.getByRole("link", {name: "Simulate the season", exact: true}).isVisible());
  } finally { await context.close(); }
});

test("moving rankings preserves draft picks and settings across Home navigation", async () => {
  const {context, page} = await openPage({}, "/rankings.html");
  try {
    await page.locator(".draft-toggle").first().waitFor();
    await page.locator("#teams").selectOption("10");
    await page.locator(".draft-toggle").first().click();
    const saved = await page.evaluate(() => ({
      picks: localStorage.getItem("project-foot-moneyball:drafted:v1"),
      settings: localStorage.getItem("project-foot-moneyball:settings:v1"),
    }));
    assert.equal(JSON.parse(saved.picks).length, 1);
    await page.locator(".home-nav-link").click(); await page.waitForURL(base + "/");
    await page.getByRole("link", {name: "Explore player rankings", exact: false}).click();
    await page.waitForURL("**/rankings.html"); await page.locator(".draft-toggle").first().waitFor();
    assert.equal(await page.locator("#teams").inputValue(), "10");
    assert.equal(await page.locator(".topnav .current-lab > summary").textContent(), "Fantasy");
    assert.deepEqual(await page.evaluate(() => ({
      picks: localStorage.getItem("project-foot-moneyball:drafted:v1"),
      settings: localStorage.getItem("project-foot-moneyball:settings:v1"),
    })), saved);
    assert.equal(await page.locator(".draft-toggle[aria-pressed=true]").count(), 1);
  } finally { await context.close(); }
});

const waitForRun = (page, run) => page.waitForFunction(run => document.querySelector("#league-progress").textContent.startsWith(`Run ${run}:`), run, {timeout: 60000});
const seasonView = page => page.evaluate(() => ({
  games: document.querySelector("#league-example-games").textContent,
  records: document.querySelector("#league-example-records").textContent,
  bracket: document.querySelector("#league-bracket").textContent,
}));
test("real worker runs complete seasons, switches examples, draws fresh seeds and replays fixed seeds", async () => {
  const {context, page} = await openPage({}, "/league.html");
  try {
    await waitForRun(page, 1);
    assert.equal(await page.locator("#league-error").isVisible(), false);
    assert.match(await page.locator("#league-progress").textContent(), /2,000 complete seasons/);
    assert.equal(await page.locator("#league-example-select option").count(), 20);
    assert.equal(await page.locator("#league-example-games tbody tr").count(), 272);
    assert.equal(await page.locator("#league-example-records tbody tr").count(), 32);
    const seed1 = await page.locator("#league-seed").inputValue(), example1 = await seasonView(page);
    const aggregate = await page.locator("#league-divisions").textContent();
    await page.locator("#league-next-example").click();
    assert.equal(await page.locator("#league-example-select").inputValue(), "1");
    assert.notDeepEqual(await seasonView(page), example1);
    assert.equal(await page.locator("#league-divisions").textContent(), aggregate);
    await page.locator("#league-example-select").selectOption("0");
    assert.deepEqual(await seasonView(page), example1);
    await page.locator("#league-run").click(); await waitForRun(page, 2);
    assert.notEqual(await page.locator("#league-seed").inputValue(), seed1);
    assert.notDeepEqual(await seasonView(page), example1);
    await page.locator("#league-fixed-seed").check(); await page.locator("#league-seed").fill("2026");
    await page.locator("#league-run").click(); await waitForRun(page, 3);
    const fixed = await seasonView(page), fixedAggregate = await page.locator("#league-divisions").textContent();
    await page.locator("#league-run").click(); await waitForRun(page, 4);
    assert.deepEqual(await seasonView(page), fixed);
    assert.equal(await page.locator("#league-divisions").textContent(), fixedAggregate);
    assert.match(await page.locator("#league-progress").textContent(), /fixed-seed mode/);
    await page.locator("#league-seed").fill("0"); await page.locator("#league-run").click();
    assert.match(await page.locator("#league-error").textContent(), /whole-number seed/);
    // A invalid new seed must not start a worker or silently change the previous result.
    assert.deepEqual(await seasonView(page), fixed);
    await page.locator("#league-seed").fill("2026"); await page.locator("#league-fixed-seed").uncheck();
    for (const [trials, run] of [["5000", 5], ["10000", 6]]) {
      await page.locator("#league-trials").selectOption(trials);
      await page.locator("#league-run").click(); await waitForRun(page, run);
      assert.match(await page.locator("#league-progress").textContent(), new RegExp(Number(trials).toLocaleString() + " complete seasons"));
      assert.equal(await page.locator("#league-example-games tbody tr").count(), 272);
    }
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#league-example-select").selectOption("19");
    assert.match(await page.locator("#league-example-note").textContent(), /trial 10,000 of 10,000/);
    await screenshot(page, "league-mobile.png");
  } finally { await context.close(); }
});

test("an incomplete worker response is never displayed as a completed simulation", async () => {
  const {context, page} = await openPage();
  try {
    await context.route("**/league-worker.mjs?*", route => route.fulfill({
      contentType: "text/javascript", body: 'onmessage = () => postMessage({result:{trials:2000,games:[],examples:[]}});',
    }));
    await page.goto(base + "/league.html");
    await page.locator("#league-error").waitFor({state: "visible"});
    assert.match(await page.locator("#league-progress").textContent(), /did not finish; no partial run/);
    assert.equal(await page.locator("#league-results").isVisible(), false);
    assert.equal(await page.locator("#league-run").isDisabled(), false);
  } finally { await context.close(); }
});
