// Run with node --test; set PLAYWRIGHT_MODULE to a Playwright installation if needed.
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
const originals = {}, draftedKey = "project-foot-moneyball:drafted:v1", personalKey = "outlierbaseline:personal-adp:v1";
let browser, server, base;

before(async () => {
  for (const key of ["rankings", "player_history", "player_news", "player_intel", "special_teams"]) {
    originals[key] = JSON.parse(await readFile(resolve(root, "data", `${key}.json`), "utf8"));
  }
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

async function open(path, prepare = () => {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const values = structuredClone(originals), requests = {}, errors = [];
  // Injury tests supply their own small, explicit news fixture. Other tests do
  // not depend on the changing injury designations in checked-in snapshots.
  values.player_news = {season: 2026, generated_at: new Date(now).toISOString(), reports: {}};
  prepare(values);
  let revision = 0, heldManifest = null;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort(); // No upstream provider traffic.
    const key = /^\/data\/(.+)\.json$/.exec(url.pathname)?.[1];
    if (key) requests[key] = (requests[key] || 0) + 1;
    if (key === "update_status") {
      if (heldManifest) {
        const held = heldManifest; heldManifest = null;
        held.started(); await held.gate;
      }
      return route.fulfill({json: {completed_at: new Date(now + revision * 1000).toISOString()}});
    }
    if (Object.hasOwn(values, key)) {
      if (values[key] === "NETWORK_ERROR") return route.abort("failed");
      if (values[key] === "BAD_JSON") return route.fulfill({contentType: "application/json", body: "{invalid"});
      return route.fulfill({json: values[key]});
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({time: new Date(now)});
  await observeRefreshChecks(page);
  await page.goto(`${base}/${path}`);
  await waitForRefreshCheck(page);
  return {context, page, values, requests, errors, holdManifest: () => {
    let started, release;
    const reached = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    heldManifest = {started, gate};
    return {reached, release};
  }, tick: async (changed = true, duration = 60001) => {
    await waitForRefreshCheck(page);
    const previous = await completedRefreshChecks(page);
    if (changed) revision++;
    await page.clock.fastForward(duration);
    await waitForRefreshCheck(page, previous);
  }};
}

function rankedPlayer(data, position = "RB", index = 0) {
  const rows = data.boards["12team_2qb_te_premium_half_ppr"];
  return rows.filter(row => row[data.columns.indexOf("pos")] === position)
    .map(row => Object.fromEntries(data.columns.map((key, i) => [key, row[i]])))[index];
}
function changeRankedValue(data, player, column, value) {
  for (const rows of Object.values(data.boards)) {
    const row = rows.find(row => row[data.columns.indexOf("player")] === player);
    if (row) row[data.columns.indexOf(column)] = value;
  }
}
const selectedRow = page => page.locator("#table-body tr").first();
const sourceRecovered = page => page.waitForFunction(() => !document.querySelector("#source-status").textContent.includes("unavailable"));

test("rankings refresh preserves room settings, search, filters, sort, drafted state and imported personal ADP", async () => {
  const board = await open("rankings.html"), {page, context, values, errors} = board;
  try {
    await page.waitForFunction(() => document.querySelectorAll("#table-body tr").length > 0);
    const player = rankedPlayer(values.rankings);
    await page.selectOption("#teams", "10");
    await page.selectOption("#quarterbacks", "1QB");
    await page.selectOption("#ppr", "Full PPR");
    await page.selectOption("#te-premium", "Off");
    await page.selectOption("#kickers", "Include");
    await page.selectOption("#defenses", "Include");
    await page.click("#import-adp");
    await page.locator("#adp-file").setInputFiles({name: "my-test-adp.csv", mimeType: "text/csv",
      buffer: Buffer.from(`Player,Team,Position,ADP\n${player.player},${player.team},${player.pos},12.3\n`)});
    await page.waitForFunction(() => !document.querySelector("#apply-adp").disabled);
    await page.click("#apply-adp");
    await page.fill("#search", player.player);
    await page.click('#position-filters [data-position="RB"]');
    await page.fill('#table-head [data-filter="overall_rank"]', "<999");
    await page.selectOption('#table-head [data-filter="team"]', player.team);
    await selectedRow(page).locator(".draft-toggle").click();
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "true", `After draft click: ${await page.evaluate(key => localStorage.getItem(key), draftedKey)}`);
    await page.selectOption('#table-head [data-filter="drafted"]', "yes");
    await page.click('#table-head [data-sort="Sleeper"]');
    await page.click('#table-head [data-sort="Sleeper"]');
    await page.locator('#table-head [data-filter="overall_rank"]').focus();
    await page.evaluate(() => { document.querySelector("#table-shell").scrollLeft = 310; window.scrollTo({top: 200, behavior: "instant"}); window.savedBoardRow = document.querySelector("#table-body tr"); });
    const saved = await page.evaluate(([drafted, personal]) => ({drafted: localStorage.getItem(drafted), personal: localStorage.getItem(personal),
      scrollX: document.querySelector("#table-shell").scrollLeft, scrollY}), [draftedKey, personalKey]);
    assert.match(saved.personal, /my-test-adp.csv/);
    assert.equal(await page.locator("#table-body tr").count(), 1, `${await page.locator("#board-summary").textContent()} stored=${saved.drafted}`);
    assert.equal(await selectedRow(page).locator(".personal-adp-value").count() > 0, true, await selectedRow(page).textContent());
    assert.equal(await selectedRow(page).locator(".personal-adp-value").first().textContent(), "12.3");
    // Hold an unchanged manifest deterministically: the next simulated minute
    // cannot start before this real request has finished and the poller settles.
    const held = board.holdManifest();
    let tickFinished = false;
    const unchangedTick = board.tick(false).then(() => { tickFinished = true; });
    try {
      await held.reached;
      assert.equal(await page.evaluate(() => window.labRefreshChecks.pending.size), 1);
      assert.equal(tickFinished, false, "tick waits for an in-flight unchanged manifest");
    } finally { held.release(); }
    await unchangedTick;
    assert.equal(await page.evaluate(() => window.savedBoardRow === document.querySelector("#table-body tr")), true);
    changeRankedValue(values.rankings, player.player, "Sleeper", 444.4);
    await board.tick();
    await page.waitForFunction(() => document.querySelector("#table-body").textContent.includes("444.4"));
    assert.equal(await page.inputValue("#search"), player.player);
    assert.equal(await page.locator("#position-filters .active").getAttribute("data-position"), "RB");
    for (const [id, value] of Object.entries({teams: "10", quarterbacks: "1QB", ppr: "Full PPR", "te-premium": "Off", kickers: "Include", defenses: "Include"})) assert.equal(await page.inputValue(`#${id}`), value);
    for (const [filter, value] of Object.entries({overall_rank: "<999", team: player.team, drafted: "yes"})) assert.equal(await page.inputValue(`#table-head [data-filter="${filter}"]`), value);
    assert.equal(await page.locator('#table-head [data-sort="Sleeper"] .sort-indicator').textContent(), "▼");
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(await selectedRow(page).locator(".personal-adp-value").first().textContent(), "12.3");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.filter), "overall_rank");
    assert.deepEqual(await page.evaluate(([drafted, personal]) => ({drafted: localStorage.getItem(drafted), personal: localStorage.getItem(personal),
      scrollX: document.querySelector("#table-shell").scrollLeft, scrollY}), [draftedKey, personalKey]), saved);
    const goodData = structuredClone(values.rankings), goodHtml = await page.locator("#table-body").innerHTML();
    for (const invalid of [{projection_season: 2026, columns: [], boards: {}}, "BAD_JSON", "NETWORK_ERROR"]) {
      values.rankings = invalid;
      await board.tick();
      await page.waitForFunction(() => document.querySelector("#source-status").textContent.includes("Refresh unavailable"));
      assert.equal(await page.locator("#table-body").innerHTML(), goodHtml);
      values.rankings = structuredClone(goodData);
      await board.tick(false); // Recovery must retry even when the manifest has not changed again.
      await sourceRecovered(page);
      assert.equal(await page.locator("#table-body").innerHTML(), goodHtml);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("rankings use only current injury badges and risk, retain news through an outage, and recover changed reports", async () => {
  const players = [rankedPlayer(originals.rankings), rankedPlayer(originals.rankings, "RB", 1), rankedPlayer(originals.rankings, "RB", 2)];
  const keys = players.map(player => `${player.player.toLowerCase()}|${player.team}`);
  const board = await open("rankings.html", values => {
    values.player_news = {season: 2026, generated_at: new Date(now).toISOString(), player_count: 3,
      injury_context: {season: 2026, expected_week: 3, valid_from: "2026-09-22T04:00:00Z", valid_until: "2026-09-29T04:00:00Z",
        status: "current", teams: players.map(player => player.team)}, reports: {}};
    players.forEach((player, i) => {
      const status = i === 2 ? "Questionable" : "Out", week = i === 1 ? 1 : 3;
      values.player_news.reports[keys[i]] = {...player, current_team: player.team, signal: "risk",
        injury: {season: 2026, week, name: "Knee", injuries: ["Knee"], status, report_status: status, severity: "risk"},
        events: [{category: "Injury", severity: "risk", date: `Week ${week}`, title: "Knee report", detail: status,
          source: {title: "Source", url: "https://www.espn.com/nfl/"}}]};
    });
  });
  const {page, context, values, errors} = board;
  const row = player => page.locator("#table-body tr").filter({has: page.locator(".player-name", {hasText: player.player})});
  try {
    await page.waitForFunction(() => document.querySelectorAll("#table-body tr").length > 0);
    assert.equal(await row(players[0]).locator(".status-injury-risk").count(), 1);
    assert.equal(await row(players[0]).locator(".tag-risk").count(), 1);
    assert.equal(await row(players[1]).locator(".status-history").count(), 1);
    assert.equal(await row(players[1]).locator(".status-injury-risk, .status-injury, .tag-risk").count(), 0);
    assert.match(await row(players[1]).locator(".status-history").getAttribute("title"), /unknown/);
    assert.equal(await row(players[2]).locator(".status-injury").count(), 1);
    assert.equal(await row(players[2]).locator(".tag-risk, .status-injury-risk").count(), 0);
    const savedNews = structuredClone(values.player_news);
    values.player_news = "NETWORK_ERROR";
    await board.tick();
    await page.waitForFunction(() => document.querySelector("#source-status").textContent.includes("injuries/news"));
    assert.equal(await row(players[0]).locator(".status-injury-risk").count(), 1);
    values.player_news = savedNews;
    values.player_news.reports[keys[0]].injury.week = 2;
    values.player_news.generated_at = new Date(now + 1000).toISOString();
    await board.tick(false);
    await page.waitForFunction(name => [...document.querySelectorAll("#table-body tr")].find(row => row.querySelector(".player-name")?.textContent === name)?.querySelector(".status-history"), players[0].player);
    await sourceRecovered(page);
    assert.equal(await row(players[0]).locator(".tag-risk, .status-injury-risk").count(), 0);
    assert.match(await row(players[0]).locator(".status-history").textContent(), /Week 2/);
    const until = Date.parse(values.player_news.injury_context.valid_until);
    await board.tick(false, until - await page.evaluate(() => Date.now()) + 60001);
    await page.waitForFunction(name => [...document.querySelectorAll("#table-body tr")].find(row => row.querySelector(".player-name")?.textContent === name)?.querySelector(".status-history"), players[2].player);
    assert.equal(await row(players[2]).locator(".status-injury, .status-injury-risk").count(), 0, "A report expires even without a newer manifest");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("special-teams refresh preserves search, position, filters, sorting and drafted picks through failures and recovery", async () => {
  const board = await open("special-teams.html"), {page, context, values, errors} = board;
  try {
    await page.waitForFunction(() => document.querySelectorAll("#special-body tr").length > 0);
    const columns = values.special_teams.columns;
    const dataRow = values.special_teams.rows.find(row => row[columns.indexOf("pos")] === "K");
    const name = dataRow[columns.indexOf("player")];
    await page.fill("#special-search", name);
    await page.click('#special-positions [data-position="K"]');
    await page.fill('#special-head [data-filter="adp"]', ">0");
    await page.locator("#special-body .draft-toggle").click();
    assert.equal(await page.locator("#special-body .draft-toggle").getAttribute("aria-pressed"), "true", `After draft click: ${await page.evaluate(key => localStorage.getItem(key), draftedKey)}`);
    await page.selectOption('#special-head [data-filter="drafted"]', "yes");
    await page.click('#special-head [data-sort="Sleeper"]');
    await page.click('#special-head [data-sort="Sleeper"]');
    await page.locator('#special-head [data-filter="adp"]').focus();
    const drafted = await page.evaluate(key => localStorage.getItem(key), draftedKey);
    dataRow[columns.indexOf("adp")] = 987.6;
    await board.tick();
    await page.waitForFunction(() => document.querySelector("#special-body").textContent.includes("987.6")).catch(async error => {
      throw new Error(`${error.message}; status=${await page.locator("#special-status").textContent()}; table=${await page.locator("#special-body").textContent()}; requests=${JSON.stringify(board.requests)}`);
    });
    assert.equal(await page.inputValue("#special-search"), name);
    assert.equal(await page.locator("#special-positions .active").getAttribute("data-position"), "K");
    assert.equal(await page.inputValue('#special-head [data-filter="adp"]'), ">0");
    assert.equal(await page.inputValue('#special-head [data-filter="drafted"]'), "yes");
    assert.equal(await page.locator('#special-head [data-sort="Sleeper"] .sort-indicator').textContent(), "▼");
    assert.equal(await page.locator("#special-body .draft-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftedKey), drafted);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.filter), "adp");
    const goodData = structuredClone(values.special_teams), goodHtml = await page.locator("#special-body").innerHTML();
    for (const invalid of [{columns: ["player"], rows: []}, "BAD_JSON", "NETWORK_ERROR"]) {
      values.special_teams = invalid;
      await board.tick();
      await page.waitForFunction(() => document.querySelector("#special-status").textContent.includes("Refresh unavailable"));
      assert.equal(await page.locator("#special-body").innerHTML(), goodHtml);
      values.special_teams = structuredClone(goodData);
      await board.tick(false);
      await page.waitForFunction(() => !document.querySelector("#special-status").textContent.includes("unavailable"));
      assert.equal(await page.locator("#special-body").innerHTML(), goodHtml);
    }
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftedKey), drafted);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("rankings keep a drafted player when refreshed roster teams change without losing the legacy stored key", async () => {
  const board = await open("rankings.html"), {page, context, values, errors} = board;
  try {
    await page.waitForFunction(() => document.querySelectorAll("#table-body tr").length > 0);
    const player = rankedPlayer(values.rankings), oldKey = `${player.player.toLowerCase()}|${player.team}`;
    assert.ok(player.player_id, "Fixture must have a stable player ID");
    await page.fill("#search", player.player);
    await selectedRow(page).locator(".draft-toggle").click();
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "true");
    const newTeam = player.team === "BUF" ? "KC" : "BUF";
    changeRankedValue(values.rankings, player.player, "team", newTeam);
    await board.tick();
    await page.waitForFunction(team => document.querySelector("#table-body .team-cell")?.textContent === team, newTeam);
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "true");
    const saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), draftedKey));
    assert.ok(saved.includes(oldKey), "Original saved draft identity remains recoverable");
    assert.ok(saved.includes(`${player.player.toLowerCase()}|${newTeam}`));
    assert.equal(await page.inputValue("#search"), player.player);
    await selectedRow(page).locator(".draft-toggle").click();
    const undone = JSON.parse(await page.evaluate(key => localStorage.getItem(key), draftedKey));
    assert.equal(undone.includes(oldKey), false); assert.equal(undone.includes(`${player.player.toLowerCase()}|${newTeam}`), false);
    await page.reload();
    await waitForRefreshCheck(page);
    await page.waitForFunction(() => document.querySelectorAll("#table-body tr").length > 0);
    await page.fill("#search", player.player);
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "false");
    changeRankedValue(values.rankings, player.player, "Sleeper", 555.5);
    await board.tick();
    await page.waitForFunction(() => document.querySelector("#table-body").textContent.includes("555.5"));
    assert.equal(await selectedRow(page).locator(".draft-toggle").getAttribute("aria-pressed"), "false", "Undo must survive reload and later updates");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("special teams keep a uniquely identified drafted kicker after a team transfer", async () => {
  const board = await open("special-teams.html"), {page, context, values, errors} = board;
  try {
    await page.waitForFunction(() => document.querySelectorAll("#special-body tr").length > 0);
    const columns = values.special_teams.columns, dataRow = values.special_teams.rows.find(row => row[columns.indexOf("pos")] === "K");
    const player = dataRow[columns.indexOf("player")], team = dataRow[columns.indexOf("team")], oldKey = `${player.toLowerCase()}|${team}`;
    await page.fill("#special-search", player);
    await page.locator("#special-body .draft-toggle").click();
    const newTeam = team === "BUF" ? "KC" : "BUF";
    dataRow[columns.indexOf("team")] = newTeam;
    await board.tick();
    await page.waitForFunction(team => document.querySelector("#special-body tr")?.children[3]?.textContent === team, newTeam);
    assert.equal(await page.locator("#special-body .draft-toggle").getAttribute("aria-pressed"), "true");
    const saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), draftedKey));
    assert.ok(saved.includes(oldKey)); assert.ok(saved.includes(`${player.toLowerCase()}|${newTeam}`));
    await page.locator("#special-body .draft-toggle").click();
    const undone = JSON.parse(await page.evaluate(key => localStorage.getItem(key), draftedKey));
    assert.equal(undone.includes(oldKey), false); assert.equal(undone.includes(`${player.toLowerCase()}|${newTeam}`), false);
    await page.reload();
    await waitForRefreshCheck(page);
    await page.waitForFunction(() => document.querySelectorAll("#special-body tr").length > 0);
    await page.fill("#special-search", player);
    dataRow[columns.indexOf("adp")] = 765.4;
    await board.tick();
    await page.waitForFunction(() => document.querySelector("#special-body").textContent.includes("765.4"));
    assert.equal(await page.locator("#special-body .draft-toggle").getAttribute("aria-pressed"), "false", "Undo must survive reload and later updates");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
