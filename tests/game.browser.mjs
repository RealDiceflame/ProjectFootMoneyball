// Exercise archived observations and source outages without contacting providers.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {historicalStatsFixture} from "./helpers/historical-stats.mjs";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
let browser, server, base, saved, scores, gameId, now;
before(async () => {
  const index = JSON.parse(await readFile(resolve(root, "data/game_stats/2026/index.json"), "utf8"));
  gameId = Object.keys(index.games)[0];
  saved = JSON.parse(await readFile(resolve(root, `data/game_stats/2026/${gameId}.json`), "utf8"));
  scores = JSON.parse(await readFile(resolve(root, "data/scores.json"), "utf8"));
  now = Math.max(Date.parse(scores.checked_at) || 0, Date.parse(index.checked_at), Date.parse(saved.updated_at));
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
  const engine = process.env.BROWSER_ENGINE || "chromium", channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await engines[engine].launch({headless: true, ...(engine === "chromium" && channel !== "chromium" ? {channel} : {})});
});
after(async () => { await browser?.close(); if (server) await new Promise(done => server.close(done)); });

async function open({invalid = false, missingScores = false, missingStats = false, historical = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const state = {bundle: historical?historicalStatsFixture().bundle:structuredClone(saved), board: structuredClone(scores), missingScores, missingStats, requests: 0};
  const selectedId=state.bundle.game.game_id;
  state.board.checked_at = new Date(now).toISOString();
  if (!state.board.games.some(game => game.game_id === selectedId)) state.board.games.push(structuredClone(state.bundle.game));
  const name = "QA <img src=x onerror=alert(1)>";
  const row = state.bundle.players.find(row => row[state.bundle.player_columns.indexOf("team")] === state.bundle.game.away
    && row[state.bundle.player_columns.indexOf("player_id")]);
  for (const [key, value] of Object.entries({player_display_name: name, passing_yards: -2, passing_tds: 0, passing_interceptions: null, def_sacks: 0.5})) {
    const index = state.bundle.player_columns.indexOf(key);
    assert.ok(index >= 0, `Saved fixture contains ${key}`);
    row[index] = value;
  }
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === "/data/scores.json") {
      state.requests++;
      return state.missingScores ? route.fulfill({status: 404, body: "Unavailable"}) : route.fulfill({json: state.board});
    }
    if (url.pathname === `/data/game_stats/${state.bundle.season}/${selectedId}.json`) {
      return state.missingStats ? route.fulfill({status: 404, body: "Pending"}) : route.fulfill({json: state.bundle});
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({time: new Date(now)});
  await page.goto(`${base}/game.html?game=${invalid ? "invalid-game" : selectedId}`);
  return {page, context, state, errors, name};
}

test("box scores keep missing, zero, negative and fractional observations distinct", async () => {
  const {page, context, errors, name} = await open();
  try {
    const passing = page.locator('.game-stat-category[data-group="Passing"] .game-stat-team[data-side="away"]');
    await passing.locator("table").waitFor();
    const labels = await passing.locator("thead th").allTextContents();
    const cells = await passing.getByRole("row").filter({hasText: name}).locator("th, td").allTextContents();
    assert.equal(cells[labels.indexOf("Passing yards")], "-2");
    assert.equal(cells[labels.indexOf("Passing TDs")], "0");
    assert.equal(cells[labels.indexOf("Passing interceptions")], "—");
    const defense = page.locator('.game-stat-category[data-group="Defense"] .game-stat-team[data-side="away"]');
    const defenseLabels = await defense.locator("thead th").allTextContents();
    const defenseCells = await defense.getByRole("row").filter({hasText: name}).locator("th, td").allTextContents();
    assert.equal(defenseCells[defenseLabels.indexOf("Sacks")], "0.5");
    assert.equal(await passing.locator("tbody img, tbody script").count(), 0, "Source names remain inert text");
    const download = page.getByRole("link", {name: "Download game data", exact: true});
    assert.equal(await download.getAttribute("href"), `data/game_stats/2026/${gameId}.json`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a missing scoreboard is disclosed while archived box scores remain usable and recover", async () => {
  const {page, context, state, errors} = await open({missingScores: true});
  try {
    await page.locator("#game-stats table").first().waitFor();
    await page.waitForFunction(() => document.querySelector("#game-status").textContent.includes("could not refresh"));
    const original = await page.locator("#game-stats").innerHTML();
    const download = page.getByRole("link", {name: "Download game data", exact: true});
    await download.focus();
    state.missingScores = false;
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => !document.querySelector("#game-status").textContent.includes("could not refresh"));
    assert.equal(await page.locator("#game-stats").innerHTML(), original);
    assert.equal(await download.evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("pending and invalid games offer truthful recovery instead of empty statistics", async () => {
  for (const invalid of [false, true]) {
    const {page, context, state, errors} = await open({missingStats: true, invalid});
    try {
      if (invalid) {
        await page.waitForFunction(() => document.querySelector("#game-status").textContent.includes("Choose a game"));
        assert.equal(state.requests, 0, "Invalid game identifiers do not fetch unrelated data");
      } else {
        await page.waitForFunction(() => document.querySelector("#game-stats").textContent.includes("pending"));
        assert.equal(await page.locator("#game-summary .game-team").count(), 2);
      }
      assert.equal(await page.locator("#game-stats table").count(), 0);
      assert.match(await page.getByRole("navigation", {name: "Related game research"}).getByRole("link", {name: "All game results"}).getAttribute("href"), /^stats\.html/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test("historical game archives remain usable without a current-season scoreboard",async()=>{
  const {page,context,errors}=await open({historical:true,missingScores:true});
  try{
    await page.locator("#game-stats table").first().waitFor();
    assert.match(await page.locator("#game-heading").innerText(),/Oakland Raiders at San Diego Chargers/);
    const status=await page.locator("#game-status").innerText();
    assert.match(status,/2016 historical regular-season archive/);
    assert.match(status,/Historical statistics may be corrected/);
    assert.doesNotMatch(status,/Some data could not refresh|Score refresh is delayed/);
    assert.equal(await page.locator("#game-summary img").count(),0);
    assert.equal(await page.getByRole("link",{name:"Download game data",exact:true}).getAttribute("href"),"data/game_stats/2016/2016_01_OAK_SD.json");
    for(const id of ["game-results-link","game-leaders-link"]){
      const link=new URL(await page.locator(`#${id}`).getAttribute("href"),base);
      assert.equal(link.searchParams.get("season"),"2016");
      assert.equal(link.searchParams.get("week"),"1");
    }
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
