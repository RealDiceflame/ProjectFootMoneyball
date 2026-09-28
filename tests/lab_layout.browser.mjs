// Local saved snapshots only. Browser environment options match the other browser suites.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const widths = [320, 390, 768, 1024, 1025, 1440];
let server, browser, base;
before(async () => {
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

async function open(path) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({time: new Date("2026-09-27T16:00:00Z")});
  await page.goto(`${base}/${path}.html`);
  return {context, page, errors};
}

async function layout(page, name, width) {
  await page.setViewportSize({width, height: 1000});
  const issues = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`Page width ${document.documentElement.scrollWidth} exceeds viewport ${innerWidth}`);
    for (const region of document.querySelectorAll("main .age-chart-shell, main .round-map-shell, main .survivor-table-scroll")) {
      const box = region.getBoundingClientRect();
      if (!box.height || !box.width || region.scrollWidth <= region.clientWidth + 1) continue;
      if (region.tabIndex < 0 || region.getAttribute("role") !== "region" || !region.getAttribute("aria-label")) problems.push(`Unlabeled or unfocusable scroll region: ${region.id || region.className}`);
      if (box.left < 0 || box.right > innerWidth + 1) problems.push(`Scroll region escapes page: ${region.id || region.className}`);
    }
    for (const control of document.querySelectorAll("main select, main button, main summary, main input:not([type=checkbox])")) {
      const box = control.getBoundingClientRect();
      if (!box.height || !box.width) continue;
      if (box.height < 44) problems.push(`Small target ${control.id || control.textContent}: ${box.height}`);
      if (!control.closest(".survivor-table-scroll") && (box.left < 0 || box.right > innerWidth + 1)) problems.push(`Control escapes page: ${control.id || control.textContent}`);
    }
    for (const text of document.querySelectorAll(".model-age-chart text, .round-points-chart text, .matchup-distribution text, .simulation-chart text")) {
      if (!text.getBoundingClientRect().height) continue;
      const transform = text.getScreenCTM();
      const rendered = parseFloat(getComputedStyle(text).fontSize) * Math.hypot(transform.a, transform.b);
      if (rendered < 12) problems.push(`Unreadable chart label '${text.textContent}': ${rendered}px`);
    }
    return problems;
  });
  assert.deepEqual(issues, [], `${name} at ${width}px`);
  if (process.env.BROWSER_SCREENSHOTS && [390, 1024, 1440].includes(width)) {
    await mkdir(process.env.BROWSER_SCREENSHOTS, {recursive: true});
    await page.screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, `${name}-${width}.png`), fullPage: true});
    await page.evaluate(() => scrollTo({top: 0, behavior: "instant"}));
    await page.screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, `${name}-${width}-top.png`)});
    if (name === "projection") await page.locator("#age-chart").screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, `${name}-${width}-chart.png`)});
  }
}

test("Projection keeps wide graphs and its capital table inside labeled regions at every breakpoint", async () => {
  const {page, context, errors} = await open("projection");
  try {
    await page.locator("#age-chart svg").waitFor();
    await page.selectOption("#model-position", "WR");
    await page.selectOption("#round-map-season", "2024");
    const selected = await page.inputValue("#model-player");
    for (const width of widths) await layout(page, "projection", width);
    assert.equal(await page.inputValue("#model-player"), selected);
    assert.equal(await page.inputValue("#round-map-season"), "2024");
    await page.setViewportSize({width: 320, height: 1000});
    await page.locator("#age-chart").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#age-chart").scrollLeft > 0);
    assert.equal(await page.locator("#round-map tbody tr").count(), 15);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Projection native dropdowns contain long labels across platform fonts without losing choices", async () => {
  const {page, context, errors} = await open("projection");
  try {
    await page.locator("#age-chart svg").waitFor();
    await page.selectOption("#model-position", "WR");
    const selections = [];
    for (const selector of ["#model-player", "#age-view", "#round-map-season"]) {
      const options = await page.locator(`${selector} option`).evaluateAll(items => items.map(option => ({value: option.value, label: option.textContent})));
      const longest = options.reduce((chosen, option) => option.label.length > chosen.label.length ? option : chosen);
      await page.selectOption(selector, longest.value);
      selections.push({selector, options, value: longest.value});
    }
    // Linux and Windows native controls measure the same labels differently.
    // Exercise wider glyphs as well as the platform default, without reducing
    // text size or relaxing the whole-page overflow assertion.
    for (const font of ["system-ui", "Arial", "monospace"]) {
      const fontStyle = await page.addStyleTag({content: `.projection-page select { font-family: ${font}; }`});
      for (const width of [320, 390]) await layout(page, `projection-select-${font}`, width);
      await fontStyle.evaluate(element => element.remove());
    }
    for (const {selector, options, value} of selections) {
      assert.equal(await page.inputValue(selector), value);
      assert.deepEqual(await page.locator(`${selector} option`).evaluateAll(items => items.map(option => ({value: option.value, label: option.textContent}))), options);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Survivor and matchup controls, expanded sections, and simulated results remain usable on phones", async () => {
  const {page, context, errors} = await open("survivor");
  try {
    await page.locator("#survivor-content").waitFor({state: "visible"});
    // Native select text must not enlarge WebKit's page overflow even when its
    // own bounding rectangle fits. Exercise the long scheduled-game value too.
    const gameOptions = await page.locator("#matchup-game option").evaluateAll(options => options.map(option => ({value: option.value, label: option.textContent})));
    const longestGame = gameOptions.reduce((longest, option) => option.label.length > longest.label.length ? option : longest);
    await page.selectOption("#matchup-game", longestGame.value);
    for (const width of [390, 320]) await layout(page, "survivor-scheduled", width);
    assert.equal(await page.inputValue("#matchup-game"), longestGame.value);
    assert.equal(await page.locator("#matchup-game option").count(), gameOptions.length);
    await page.selectOption("#start-week", "4");
    await page.selectOption("#end-week", "5");
    await page.click("#fill-plan");
    await page.click("#simulate-plan");
    await page.selectOption("#matchup-mode", "custom");
    await page.selectOption("#matchup-home", "BUF");
    await page.selectOption("#matchup-away", "KC");
    await page.locator("main details").evaluateAll(details => details.forEach(detail => { detail.open = true; }));
    const saved = await page.evaluate(() => localStorage.getItem("outlierbaseline-survivor-v1-2026"));
    for (const width of widths) await layout(page, "survivor", width);
    assert.equal(await page.inputValue("#matchup-home"), "BUF");
    assert.equal(await page.inputValue("#matchup-away"), "KC");
    assert.equal(await page.evaluate(() => localStorage.getItem("outlierbaseline-survivor-v1-2026")), saved);
    assert.equal(await page.locator("#survivor-matrix tbody tr").count(), 32);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("League results preserve team, week, seed, and complete examples across narrow and wide layouts", async () => {
  const {page, context, errors} = await open("league");
  try {
    await page.locator("#league-results").waitFor({state: "visible"});
    await page.selectOption("#league-team", "BUF");
    await page.selectOption("#league-week", "4");
    await page.selectOption("#league-example-select", "1");
    const seed = await page.inputValue("#league-seed");
    await page.locator("main details").evaluateAll(details => details.forEach(detail => { detail.open = true; }));
    for (const width of widths) await layout(page, "league", width);
    assert.equal(await page.inputValue("#league-team"), "BUF");
    assert.equal(await page.inputValue("#league-week"), "4");
    assert.equal(await page.inputValue("#league-example-select"), "1");
    assert.equal(await page.inputValue("#league-seed"), seed);
    assert.equal(await page.locator("#league-example-games tbody tr").count(), 272);
    assert.equal(await page.locator(".league-playoff-game").count(), 12);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
