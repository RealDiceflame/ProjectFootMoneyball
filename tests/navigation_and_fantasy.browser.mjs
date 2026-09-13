// Run with Node's test runner. Install Playwright or set PLAYWRIGHT_MODULE to its module path.
// BROWSER_CHANNEL defaults to msedge; use chromium for Playwright's bundled browser.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
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

async function openPage(options = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, ...options});
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.goto(`${base}/fantasy.html`);
  await page.locator(".lab-navigation").waitFor();
  return {context, page};
}
const isOpen = locator => locator.evaluate(element => element.open);
const waitForOpen = (page, name, open) => page.waitForFunction(({name, open}) => [...document.querySelectorAll(".topnav > details")].find(group => group.querySelector("summary").textContent === name)?.open === open, {name, open});

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
