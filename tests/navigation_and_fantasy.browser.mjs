// Run with Node's test runner. Install Playwright or set PLAYWRIGHT_MODULE to its module path.
// BROWSER_CHANNEL defaults to msedge; use chromium for Playwright's bundled browser.
// BROWSER_ENGINE=webkit runs the same touch regressions in Playwright's WebKit.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {STORAGE_KEY} from "../docs/fantasy-leagues.mjs";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
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
  const engine = process.env.BROWSER_ENGINE || "chromium";
  assert.ok(["chromium", "webkit"].includes(engine), `Unsupported browser engine: ${engine}`);
  const channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await engines[engine].launch({headless: true, ...(engine === "chromium" && channel !== "chromium" ? {channel} : {})});
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
const navGroup = (page, name) => page.locator(".lab-navigation details").filter({has: page.locator("summary", {hasText: new RegExp(`^${name}$`)})});
const waitForOpen = (page, name, open) => page.waitForFunction(({name, open}) => [...document.querySelectorAll(".lab-navigation details")].find(group => group.querySelector("summary").textContent === name)?.open === open, {name, open});
const mobileOptions = {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true};
const waitForMobileMenu = (page, expanded) => page.waitForFunction(expanded => document.querySelector(".site-nav-toggle")?.getAttribute("aria-expanded") === String(expanded), expanded);
const assertNoOverflow = async (page, label) => assert.equal(await page.evaluate(() =>
  document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".lab-navigation details[open] .lab-nav-menu")].every(menu => {
    const bounds = menu.getBoundingClientRect();
    return bounds.left >= -1 && bounds.right <= innerWidth + 1;
  })), true, label);
// Windows Playwright WebKit skips even plain, unstyled native anchors with Tab
// and Alt+Tab. Focus one explicitly to test our focus handling in that runtime;
// Chromium still verifies the real Tab entry order. Both use Tab to leave links.
const focusFirstNavLink = async (page, group) => {
  if (process.platform === "win32" && process.env.BROWSER_ENGINE === "webkit") await group.locator("a").first().focus();
  else await page.keyboard.press("Tab");
};

async function screenshot(page, name) {
  if (!process.env.BROWSER_SCREENSHOTS) return;
  await mkdir(process.env.BROWSER_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, name), fullPage: true});
}

test("desktop hover menus group all labs, stay open over links, switch and dismiss", async () => {
  const {context, page} = await openPage();
  try {
    assert.deepEqual(await page.locator(".site-nav-links > details > summary").allTextContents(), ["Stats", "Fantasy", "Labs", "Betting"]);
    assert.equal(await page.locator(".site-nav-toggle").isVisible(), false);
    assert.equal(await page.locator("#site-nav-links").isVisible(), true);
    const labs = navGroup(page, "Labs");
    assert.equal(await isOpen(labs), false);
    await labs.locator("summary").hover(); await waitForOpen(page, "Labs", true);
    assert.deepEqual(await labs.locator("h2").allTextContents(), ["Projection Lab", "Simulation Lab"]);
    assert.equal(await labs.locator("a").count(), 6);
    await labs.getByRole("link", {name: "Head-to-head matchup"}).hover();
    assert.equal(await isOpen(labs), true);
    await page.getByRole("heading", {name: "Your leagues. One home."}).hover({position: {x: 10, y: 10}});
    await waitForOpen(page, "Labs", false);
    await labs.locator("summary").hover();
    await navGroup(page, "Betting").locator("summary").hover();
    await waitForOpen(page, "Betting", true); await waitForOpen(page, "Labs", false);
    await page.getByRole("heading", {name: "Your leagues. One home."}).click();
    await waitForOpen(page, "Betting", false);
    // Mouse-click focus on a previous tab must not disable later hover navigation.
    await navGroup(page, "Stats").locator("summary").click();
    await labs.locator("summary").hover(); await waitForOpen(page, "Labs", true);
  } finally { await context.close(); }
});

test("keyboard links keep their focus, Escape closes without reopening, and Tab can leave", async () => {
  const {context, page} = await openPage();
  try {
    const labs = navGroup(page, "Labs"), summary = labs.locator("summary");
    await summary.focus(); await page.keyboard.press("Enter"); await waitForOpen(page, "Labs", true);
    await focusFirstNavLink(page, labs);
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

test("mobile navigation starts collapsed, expands full-width groups, and fits phones, tablets and desktop", async () => {
  const {context, page} = await openPage(mobileOptions);
  try {
    const toggle = page.locator(".site-nav-toggle"), panel = page.locator("#site-nav-links");
    assert.equal(await toggle.getAttribute("aria-controls"), "site-nav-links");
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({width, height: 844});
      await waitForMobileMenu(page, false);
      assert.equal(await page.locator(".lab-navigation details[open]").count(), 0);
      assert.equal(await toggle.isVisible(), width <= 1024);
      assert.equal(await panel.isVisible(), width > 1024);
      if (width <= 1024) {
        assert.equal(await toggle.textContent(), "Menu");
        await toggle.tap(); await waitForMobileMenu(page, true);
        assert.equal(await toggle.textContent(), "Close menu");
        assert.equal(await page.locator(".home-nav-link").isVisible(), true);
      }
      await assertNoOverflow(page, `closed groups at ${width}px`);
      for (const name of ["Stats", "Fantasy", "Labs", "Betting"]) {
        const group = navGroup(page, name);
        await group.locator("summary").tap(); await waitForOpen(page, name, true);
        // Native details emits toggle asynchronously after the open property changes.
        await page.waitForFunction(() => document.querySelectorAll(".lab-navigation details[open]").length === 1);
        assert.equal(await page.locator(".lab-navigation details[open]").count(), 1);
        await assertNoOverflow(page, `${name} expanded at ${width}px`);
        if (width <= 1024) {
          const groupBox = await group.boundingBox();
          const panelContentWidth = await panel.evaluate(element => {
            const style = getComputedStyle(element);
            return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          });
          assert.ok(Math.abs(groupBox.width - panelContentWidth) <= 2, `${name} fills the mobile panel content area`);
        }
      }
      await screenshot(page, `navigation-${width}.png`);
      if (process.env.BROWSER_SCREENSHOTS) await page.locator(".topbar").screenshot({path: resolve(process.env.BROWSER_SCREENSHOTS, `navigation-header-${width}.png`)});
      if (width <= 1024) {
        await toggle.tap(); await waitForMobileMenu(page, false);
        assert.equal(await panel.isVisible(), false);
        assert.equal(await page.locator(".lab-navigation details[open]").count(), 0);
      }
    }
  } finally { await context.close(); }
});

test("mobile navigation keeps a tapped category in place until its click", async () => {
  const {context, page} = await openPage(mobileOptions);
  try {
    await page.locator(".site-nav-toggle").tap();
    await page.evaluate(() => {
      window.navTapTrace = [];
      let pressed = null;
      document.addEventListener("pointerdown", event => {
        const summary = event.target.closest(".lab-navigation summary");
        if (summary) pressed = {summary, top: summary.getBoundingClientRect().top};
      }, true);
      document.addEventListener("pointerup", () => {
        if (pressed) window.navTapTrace.push({phase: "pointerup", name: pressed.summary.textContent, movement: pressed.summary.getBoundingClientRect().top - pressed.top});
      }, true);
      document.addEventListener("click", event => {
        if (pressed) {
          window.navTapTrace.push({phase: "click", intended: pressed.summary.textContent, actual: event.target.closest("summary")?.textContent});
          pressed = null;
        }
      }, true);
    });
    for (const name of ["Stats", "Fantasy", "Labs", "Betting", "Stats"]) {
      // A touch must reset keyboard modality before focus transfers categories.
      await page.keyboard.press("Shift");
      await navGroup(page, name).locator("summary").tap(); await waitForOpen(page, name, true);
      await page.waitForFunction(() => document.querySelectorAll(".lab-navigation details[open]").length === 1);
      assert.equal(await page.locator(".lab-navigation details[open]").count(), 1);
    }
    const trace = await page.evaluate(() => window.navTapTrace);
    assert.equal(trace.filter(event => event.phase === "click").length, 5);
    for (const event of trace) {
      if (event.phase === "pointerup") assert.ok(Math.abs(event.movement) < 1, `${event.name} moved ${event.movement}px before click`);
      else assert.equal(event.actual, event.intended, "The click reaches the category pressed at pointerdown");
    }
  } finally { await context.close(); }
});

test("mobile navigation preserves the link through pointerdown and null-relatedTarget focusout", async () => {
  const {context, page} = await openPage(mobileOptions, "/projection.html");
  try {
    await page.locator(".site-nav-toggle").tap();
    const labs = navGroup(page, "Labs"), summary = labs.locator("summary");
    await summary.tap(); await waitForOpen(page, "Labs", true);
    await summary.focus();
    await page.keyboard.press("Shift");
    const link = labs.getByRole("link", {name: "Draft capital map", exact: true});
    assert.equal(await link.getAttribute("href"), "projection.html#round-map-heading");
    // Safari can report no related target during touch focus transfer. The browser
    // still has to deliver the subsequent click to this visible, native link.
    await link.dispatchEvent("pointerdown", {pointerType: "touch", bubbles: true});
    await summary.dispatchEvent("focusout", {relatedTarget: null, bubbles: true});
    await page.waitForTimeout(250);
    assert.equal(await isOpen(labs), true);
    assert.equal(await link.isVisible(), true);
    await link.tap();
    await page.waitForURL(base + "/projection.html#round-map-heading");
    await waitForMobileMenu(page, false);
    assert.equal(await isOpen(labs), false);
  } finally { await context.close(); }
});

test("mobile navigation follows all 14 native destinations with actual taps", async () => {
  const {context, page} = await openPage(mobileOptions);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const destinations = [
    ["Stats", "Game results", "stats.html"],
    ["Stats", "League leaders", "stats.html?view=leaders", "/stats.html"],
    ["Fantasy", "Player rankings", "rankings.html"],
    ["Fantasy", "Kickers & D/ST", "special-teams.html"],
    ["Fantasy", "Player values", "values.html"],
    ["Fantasy", "My leagues · prototype", "fantasy.html"],
    ["Labs", "Player age & scoring", "projection.html"],
    ["Labs", "Draft capital map", "projection.html#round-map-heading", "/projection.html"],
    ["Labs", "Head-to-head matchup", "survivor.html#matchup-heading", "/survivor.html"],
    ["Labs", "Team game forecasts", "league.html#team-games-heading", "/league.html"],
    ["Labs", "League, playoffs & Super Bowl", "league.html"],
    ["Labs", "Survivor planner", "survivor.html#rules-heading", "/survivor.html"],
    ["Betting", "Weekly odds", "odds.html"],
    [null, "Home", "./"],
  ];
  try {
    assert.equal(await page.locator(".lab-navigation a").count(), destinations.length);
    for (const [category, name, href, start = "/fantasy.html"] of destinations) {
      await page.goto(base + start); await page.locator(".lab-navigation").waitFor();
      await page.locator(".site-nav-toggle").tap(); await waitForMobileMenu(page, true);
      if (category) { await navGroup(page, category).locator("summary").tap(); await waitForOpen(page, category, true); }
      const link = page.locator(".lab-navigation").getByRole("link", {name, exact: true});
      assert.equal(await link.getAttribute("href"), href, `${name} keeps its native href`);
      await link.tap();
      await page.waitForURL(new URL(href, base + start).href);
      await page.locator(".lab-navigation").waitFor(); await waitForMobileMenu(page, false);
      assert.equal(await page.locator("#site-nav-links").isVisible(), false, `${name} closes the panel`);
      assert.equal(await page.locator(".lab-navigation details[open]").count(), 0, `${name} closes its group`);
      if (category) assert.equal(await page.locator(".topnav .current-lab > summary").textContent(), category);
      else assert.equal(await page.locator(".home-nav-link").getAttribute("aria-current"), "page");
    }
    assert.deepEqual(errors, [], "Navigation does not produce browser errors");
  } finally { await context.close(); }
});

test("mobile navigation ignores scrolling and cancelled touches and preserves outside link activation", async () => {
  const {context, page} = await openPage(mobileOptions);
  try {
    await page.locator(".site-nav-toggle").tap();
    await navGroup(page, "Labs").locator("summary").tap(); await waitForOpen(page, "Labs", true);
    const heading = page.getByRole("heading", {name: "Your leagues. One home."});
    const start = {pointerType: "touch", pointerId: 11, clientX: 30, clientY: 30, bubbles: true};
    await heading.dispatchEvent("pointerdown", start);
    await heading.dispatchEvent("pointermove", {...start, clientY: 55});
    await heading.dispatchEvent("pointerup", {...start, clientY: 55});
    await waitForMobileMenu(page, true); assert.equal(await isOpen(navGroup(page, "Labs")), true);
    await heading.dispatchEvent("pointerdown", start);
    await heading.dispatchEvent("pointercancel", start);
    await heading.dispatchEvent("pointerup", start);
    await waitForMobileMenu(page, true); assert.equal(await isOpen(navGroup(page, "Labs")), true);
    const link = page.locator("footer").getByRole("link", {name: "Return to player rankings"});
    assert.equal(await link.getAttribute("href"), "rankings.html");
    await link.evaluate(element => element.addEventListener("pointerup", () => {
      sessionStorage.setItem("nav-test-panel-at-outside-link-pointerup", document.querySelector(".site-nav-toggle").getAttribute("aria-expanded"));
    }, {once: true}));
    await link.tap(); await page.waitForURL(base + "/rankings.html");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("nav-test-panel-at-outside-link-pointerup")), "true", "The panel remains in place until the outside link receives its click");
    await waitForMobileMenu(page, false);
  } finally { await context.close(); }
});

test("mobile navigation supports keyboard Escape, outside dismissal, and responsive reset", async () => {
  const {context, page} = await openPage(mobileOptions);
  try {
    const toggle = page.locator(".site-nav-toggle"), panel = page.locator("#site-nav-links");
    const labs = navGroup(page, "Labs"), summary = labs.locator("summary");
    await toggle.focus(); await page.keyboard.press("Enter"); await waitForMobileMenu(page, true);
    await summary.focus(); await page.keyboard.press("Enter"); await waitForOpen(page, "Labs", true);
    await focusFirstNavLink(page, labs);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Player age & scoring");
    await page.keyboard.press("Escape"); await waitForOpen(page, "Labs", false);
    assert.equal(await summary.evaluate(element => element === document.activeElement), true);
    await waitForMobileMenu(page, true);
    await page.keyboard.press("Escape"); await waitForMobileMenu(page, false);
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
    await toggle.tap(); await summary.tap(); await waitForOpen(page, "Labs", true);
    await page.getByRole("heading", {name: "Your leagues. One home."}).tap();
    await waitForMobileMenu(page, false); await waitForOpen(page, "Labs", false);
    await toggle.focus(); await page.keyboard.press("Enter");
    await navGroup(page, "Betting").locator("summary").focus();
    await page.keyboard.press("Enter"); await focusFirstNavLink(page, navGroup(page, "Betting")); await page.keyboard.press("Tab");
    await waitForMobileMenu(page, false); await waitForOpen(page, "Betting", false);
    await toggle.tap(); await summary.tap(); await waitForOpen(page, "Labs", true);
    await page.setViewportSize({width: 1280, height: 844});
    await waitForMobileMenu(page, false); await waitForOpen(page, "Labs", false);
    assert.equal(await toggle.isVisible(), false); assert.equal(await panel.isVisible(), true);
    await summary.tap(); await waitForOpen(page, "Labs", true);
    await page.setViewportSize({width: 390, height: 844});
    await waitForMobileMenu(page, false); await waitForOpen(page, "Labs", false);
    assert.equal(await toggle.isVisible(), true); assert.equal(await panel.isVisible(), false);
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
    await page.waitForFunction(() => document.querySelector("#social-status").textContent.includes("X feed unavailable"));
    assert.equal(external.filter(url => url === "https://platform.x.com/widgets.js").length, 1);
    assert.ok(external.every(url => ["platform.x.com", "static.www.nfl.com", "a.espncdn.com"].includes(new URL(url).hostname)));
    assert.equal(await page.locator("#load-x-feed").count(), 0);
    assert.equal(await page.locator("#x-feed .twitter-timeline").getAttribute("data-dnt"), "true");
    assert.equal(await page.locator(".home-nav-link").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".topnav .current-lab").count(), 0);
    assert.equal(await page.locator("#home-injury-list article").count(), 4);
    assert.equal(await page.locator("#selected-source-cards").count(), 0);
    assert.ok(await page.locator("#league-news-list .home-source-card").count() > 0);
    assert.equal(await page.locator("#league-news-list").getAttribute("tabindex"), "0");
    assert.ok(await page.locator("#league-news-list .home-clip").evaluateAll(links => links.every(link => ["www.espn.com","espn.com","sports.yahoo.com"].includes(new URL(link.href).hostname))));
    assert.equal(await page.locator(".home-highlights .home-injury-detail, .home-highlights .home-badge").count(), 0);
    assert.doesNotMatch(await page.locator("#league-news-list .home-card-players").allTextContents().then(rows => rows.join(" ")), /injury|questionable|probable|RISK/i);
    await page.locator("#injury-more").click();
    assert.equal(await page.locator("#home-injury-list article").count(), 8);
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
    assert.ok(external.every(url => ["platform.x.com", "static.www.nfl.com", "a.espncdn.com"].includes(new URL(url).hostname)));
    assert.equal(await page.getByRole("link", {name: "Open NFL on X ↗", exact: true}).getAttribute("href"), "https://x.com/NFL");
  } finally { await context.close(); }
});

test("homepage header Explore tools link scrolls and focuses its section using the keyboard", async () => {
  const {context, page} = await openPage({}, "/");
  try {
    const startUrl = page.url(), link = page.getByRole("link", {name: "Explore tools", exact: true});
    assert.equal(await link.getAttribute("href"), "#explore");
    assert.equal(await link.isVisible(), true);
    await page.evaluate(() => { scrollTo(0, 0); window.homeExploreDocument = document; });
    await link.focus(); await page.keyboard.press("Enter");
    await page.waitForURL(`${startUrl}#explore`);
    await page.waitForFunction(() => {
      const heading = document.querySelector("#explore-heading").getBoundingClientRect();
      return document.activeElement === document.querySelector("#explore") && scrollY > 0
        && heading.top >= -1 && heading.bottom <= innerHeight + 1;
    });
    assert.equal(await page.evaluate(() => window.homeExploreDocument === document), true, "The jump retains the existing homepage document");
    const section = page.locator("#explore"), bounds = await page.locator("#explore-heading").boundingBox();
    assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= 1001, "The tools section heading is visible after the jump");
    assert.deepEqual(await section.locator(".home-tool-grid > a").evaluateAll(links => links.map(link => link.getAttribute("href"))),
      ["rankings.html", "special-teams.html", "projection.html", "survivor.html", "league.html", "odds.html"], "All six tools remain available at the jump target");
  } finally { await context.close(); }
});

test("homepage editorial lead follows the newest valid story while preserving sources and matched player identity", async () => {
  const {context, page} = await openPage(mobileOptions, "/");
  let newsUnavailable = false;
  const stories = [
    {title: "The league prepares for the next round", url: "https://www.espn.com/nfl/story/lead-no-player", published_at: "2026-09-13T17:50:00Z"},
    {title: "Lamar Jackson discusses practice", url: "https://sports.yahoo.com/nfl/article/lamar-practice.html", published_at: "2026-09-13T17:30:00Z"},
    {title: "Week one results around the league", url: "https://www.espn.com/nfl/story/results", published_at: "2026-09-13T17:00:00Z"},
  ];
  const bundle = {season: 2026, generated_at: "2026-09-13T18:00:00Z",
    injury_context: {season: 2026, expected_week: 1, valid_from: "2026-09-08T04:00:00Z", valid_until: "2026-09-15T04:00:00Z"},
    reports: {lamar: {player: "Lamar Jackson", player_id: "00-0034796", pos: "QB", team: "BAL", headline_name_ambiguous: false,
      injury: {name: "Knee", report_status: "Questionable", practice_status: "Limited", week: 1},
      events: [{category: "Injury", source: {url: "https://www.espn.com/nfl/team/injuries/_/name/bal"}}],
      headshot_url: "https://static.www.nfl.com/image/upload/league/editorial-test"}},
    league_news: {status: "ok", updated_at: "2026-09-13T18:00:00Z", attempted_at: "2026-09-13T18:00:00Z",
      items: [stories[2], {title: "Reject this unsafe newer story", url: "javascript:alert(1)", published_at: "2026-09-13T17:59:00Z"}, stories[0], stories[1]]}};
  const list = page.locator("#league-news-list"), lead = list.locator(".home-lead-story"), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await context.route("**/data/player_news.json", route => newsUnavailable
      ? route.fulfill({status: 503, body: "unavailable"}) : route.fulfill({json: bundle}));
    await page.clock.install({time: new Date("2026-09-13T18:00:00Z")});
    await page.reload(); await lead.waitFor();
    assert.equal(await lead.count(), 1, "Exactly one story receives lead treatment");
    assert.equal(await list.locator(".home-source-card").first().evaluate(element => element.classList.contains("home-lead-story")), true);
    assert.deepEqual(await list.locator(".home-clip").evaluateAll(links => links.map(link => link.getAttribute("href"))), stories.map(story => story.url));
    assert.deepEqual(await list.locator(".home-clip time").evaluateAll(times => times.map(time => time.getAttribute("datetime"))), stories.map(story => story.published_at));
    assert.deepEqual(await list.getByRole("heading", {level: 3}).allTextContents(), stories.map(story => story.title));
    assert.equal(await lead.locator(".home-card-players, img").count(), 0, "An unmatched lead remains complete without an invented player or image");
    assert.match(await lead.innerText(), /ESPN/);
    const named = list.locator(".home-source-card").nth(1);
    assert.match(await named.innerText(), /Yahoo Sports/);
    assert.equal(await named.locator(".home-player-summary strong").textContent(), "Lamar Jackson");
    assert.equal(await named.locator(".player-profile-trigger").count(), 0, "Unpublished player pop-outs stay out of the homepage release");
    assert.match(await named.locator(".home-card-players").innerText(), /BAL · QB/);
    assert.equal(await named.locator(".home-portrait").count(), 1, "A matched player retains the portrait fallback");
    assert.doesNotMatch(await list.locator(".home-card-players").allTextContents().then(rows => rows.join(" ")), /Knee|Questionable|RISK/);
    const injury = page.locator("#home-injury-list article").first();
    for (const detail of ["Lamar Jackson", "BAL · QB", "Knee · Questionable", "Current report", "Practice: Limited", "2026 · Week 1", "REPORTED"]) {
      assert.ok((await injury.innerText()).includes(detail), `Compact injury rows preserve ${detail}`);
    }
    assert.equal(await injury.getByRole("link", {name: "Team injury source ↗", exact: true}).getAttribute("href"), "https://www.espn.com/nfl/team/injuries/_/name/bal");
    assert.equal(await list.locator(".home-clip").evaluateAll(links => links.every(link => link.target === "_blank"
      && link.relList.contains("noopener") && link.relList.contains("noreferrer"))), true);

    const newest = {title: "Lamar Jackson looks ahead to the next game", url: "https://www.espn.com/nfl/story/new-lead", published_at: "2026-09-13T18:00:00Z"};
    bundle.generated_at = bundle.league_news.updated_at = bundle.league_news.attempted_at = "2026-09-13T18:01:00Z";
    bundle.league_news.items.push(newest);
    await page.clock.fastForward(60001);
    await page.waitForFunction(url => document.querySelector("#league-news-list .home-lead-story .home-clip")?.getAttribute("href") === url, newest.url);
    assert.equal(await lead.count(), 1, "A fresh snapshot promotes a single new lead");
    assert.equal(await lead.locator(".home-player-summary strong").textContent(), "Lamar Jackson");
    assert.match(await lead.locator(".home-card-players").innerText(), /BAL · QB/);
    const leadPortrait = await lead.locator(".home-portrait").boundingBox();
    const rowPortrait = await list.locator(".home-source-card:not(.home-lead-story) .home-portrait").first().boundingBox();
    assert.ok(leadPortrait.width > rowPortrait.width && leadPortrait.height > rowPortrait.height,
      "A matched lead gives its roster portrait a larger area than supporting rows");
    assert.deepEqual(await list.locator(".home-clip").evaluateAll(links => links.map(link => link.getAttribute("href"))), [newest.url, ...stories.map(story => story.url)]);
    await screenshot(page, "home-editorial-matched-lead-390.png");
    newsUnavailable = true;
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => document.querySelector("#league-news-status")?.textContent.includes("Refresh unavailable"));
    assert.equal(await lead.count(), 1, "A refresh outage retains the saved lead");
    assert.equal(await lead.locator(".home-clip").getAttribute("href"), newest.url);
    newsUnavailable = false;
    bundle.generated_at = bundle.league_news.updated_at = bundle.league_news.attempted_at = "2026-09-13T18:02:00Z";
    bundle.league_news.items = [];
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => document.querySelector("#league-news-status")?.textContent === "No recent stories available");
    assert.equal(await lead.count(), 0, "An empty feed does not retain an outdated featured story");
    assert.equal(await list.locator(".home-source-card").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("homepage scoreboard arrows scroll in both directions and week selection resets the ticker", async () => {
  const {context, page} = await openPage(mobileOptions, "/");
  const bundle = JSON.parse(await readFile(resolve(root, "data/scores.json"), "utf8"));
  try {
    await page.locator("#score-games .home-score-card").first().waitFor();
    const previous = page.getByRole("button", {name: "Previous games", exact: true});
    const next = page.getByRole("button", {name: "Next games", exact: true});
    const week = page.getByRole("combobox", {name: "Scoreboard week", exact: true});
    assert.equal(await previous.getAttribute("aria-controls"), "score-games");
    assert.equal(await next.getAttribute("aria-controls"), "score-games");
    assert.equal(await previous.isDisabled(), true, `Initial ticker position: ${await page.locator("#score-games").evaluate(element => element.scrollLeft)}`);
    assert.equal(await next.isEnabled(), true);
    await next.tap();
    await page.waitForFunction(() => document.querySelector("#score-games").scrollLeft > 0 && !document.querySelector("#score-prev").disabled);
    await previous.tap();
    await page.waitForFunction(() => document.querySelector("#score-games").scrollLeft <= 1 && document.querySelector("#score-prev").disabled);
    await next.tap();
    await page.waitForFunction(() => document.querySelector("#score-games").scrollLeft > 0);
    const oldWeek = await week.inputValue();
    const selectedWeek = await week.locator("option").evaluateAll((options, oldWeek) => options.find(option => option.value !== oldWeek).value, oldWeek);
    await week.selectOption(selectedWeek);
    await page.waitForFunction(() => document.querySelector("#score-games").scrollLeft <= 1 && document.querySelector("#score-prev").disabled);
    const expected = bundle.games.filter(game => game.week === Number(selectedWeek)).map(game => game.game_id).sort();
    assert.deepEqual(await page.locator("#score-games .home-score-card").evaluateAll(cards => cards.map(card => card.dataset.gameId).sort()), expected,
      "Selecting another week replaces the ticker with all games from that week");
    assert.equal(await week.inputValue(), selectedWeek);
    assert.equal(await next.isEnabled(), true);
    for (let step = 0; step < expected.length && await next.isEnabled(); step++) {
      const before = await page.locator("#score-games").evaluate(element => element.scrollLeft);
      await next.tap();
      await page.waitForFunction(before => document.querySelector("#score-games").scrollLeft > before + 1
        || document.querySelector("#score-next").disabled, before);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    assert.equal(await next.isDisabled(), true, "Next disables at the final game");
    assert.equal(await previous.isEnabled(), true, "Previous remains usable at the end");
    assert.equal(await page.locator("#score-games").evaluate(element => element.lastElementChild.getBoundingClientRect().right
      <= element.getBoundingClientRect().right + 1), true, "The final game is fully reachable");
    const end = await page.locator("#score-games").evaluate(element => element.scrollLeft);
    await previous.tap();
    await page.waitForFunction(end => document.querySelector("#score-games").scrollLeft < end - 1
      && !document.querySelector("#score-next").disabled, end);
  } finally { await context.close(); }
});

test("homepage injury paging shows four at a time, resets filters, and preserves expansion through refreshes", async () => {
  const {context, page} = await openPage({}, "/");
  const names = Array.from({length: 13}, (_, index) => `Report ${String(index + 1).padStart(2, "0")}`);
  let unavailable = false;
  const bundle = {season: 2026, generated_at: "2026-09-13T18:00:00Z",
    injury_context: {season: 2026, expected_week: 1, valid_from: "2026-09-08T04:00:00Z", valid_until: "2026-09-15T04:00:00Z"},
    reports: Object.fromEntries(names.map((player, index) => [player, {player, player_id: `paging-${index}`, pos: "RB", team: "BUF",
      injury: {name: "Knee", report_status: index < 7 ? "Out" : "Questionable", week: 1}}])),
    league_news: {status: "ok", items: []}};
  const reports = page.locator("#home-injury-list article"), more = page.getByRole("button", {name: "Show more reports", exact: true});
  const clickMoreReports = async expected => {
    await more.click();
    await page.waitForFunction(expected => document.querySelectorAll("#home-injury-list article").length === expected, expected);
  };
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await context.route("**/data/player_news.json", route => unavailable
      ? route.fulfill({status: 503, body: "unavailable"}) : route.fulfill({json: bundle}));
    await page.clock.install({time: new Date("2026-09-13T18:00:00Z")});
    await page.reload(); await reports.first().waitFor();
    assert.equal(await reports.count(), 4, "Initial view shows only four reports");
    assert.equal(await page.locator("#injury-count").textContent(), "13 matching reports", "Total count still includes every report");
    assert.equal(await more.isVisible(), true);
    await more.focus(); await page.keyboard.press("Enter");
    assert.equal(await reports.count(), 8, "The keyboard can reveal the next four reports");
    await clickMoreReports(12); assert.equal(await reports.count(), 12);
    await clickMoreReports(13); assert.equal(await reports.count(), 13, "A partial final page remains reachable");
    assert.deepEqual(await page.locator("#home-injury-list h3").allTextContents(), names, "Every report appears exactly once");
    assert.equal(await more.isVisible(), false, "Show more hides when all matches are visible");

    await page.locator("#injury-search").fill("Report");
    assert.equal(await reports.count(), 4, "Changing search resets the visible page without losing matching reports");
    assert.equal(await more.isVisible(), true);
    await clickMoreReports(8); assert.equal(await reports.count(), 8);
    await page.locator("#injury-filter").selectOption("risk");
    assert.equal(await reports.count(), 4, "Changing availability resets the visible page");
    assert.equal(await page.locator("#injury-count").textContent(), "7 matching reports");
    assert.deepEqual(await page.locator("#home-injury-list .home-badge").allTextContents(), Array(4).fill("RISK"));
    await clickMoreReports(7); assert.equal(await reports.count(), 7);
    assert.equal(await more.isVisible(), false);
    await page.locator("#injury-filter").selectOption("all");
    assert.equal(await reports.count(), 4, "Returning to all statuses also resets the visible page");
    await page.locator("#injury-search").fill("");
    await clickMoreReports(8); assert.equal(await reports.count(), 8);

    bundle.generated_at = "2026-09-13T18:01:00Z";
    for (const report of Object.values(bundle.reports)) report.injury.name = "Ankle";
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => document.querySelector("#home-injury-list")?.textContent.includes("Ankle"));
    assert.equal(await reports.count(), 8, "A new saved snapshot preserves the expanded count");
    unavailable = true;
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => document.querySelector("#injury-freshness")?.textContent.includes("Refresh unavailable"));
    assert.equal(await reports.count(), 8, "A failed refresh retains the expanded reports");
    assert.deepEqual(await page.locator("#home-injury-list h3").allTextContents(), names.slice(0, 8));
    assert.equal(await more.isEnabled(), true, "Saved reports remain usable during an outage");
    unavailable = false;
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => !document.querySelector("#injury-freshness")?.textContent.includes("Refresh unavailable"));
    assert.equal(await reports.count(), 8, "Recovery with an unchanged snapshot also retains the expanded count");
    await clickMoreReports(12); assert.equal(await reports.count(), 12, "Paging continues from the retained position");
    assert.deepEqual(errors, []);
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
    await page.waitForFunction(() => document.querySelector("#x-feed").dataset.widgetTestLoaded === "true");
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
    assert.match(await page.locator("#injury-freshness").textContent(), /Injury reports temporarily unavailable/);
    assert.equal(await page.locator("#home-injury-list article").count(), 0);
    assert.equal(await page.locator("#injury-filter").isDisabled(), true);
    assert.equal(await page.locator("#league-news-list .home-clip").count(), 0);
    assert.match(await page.locator("#league-news-status").textContent(), /temporarily unavailable/);
    assert.equal(await page.getByRole("link", {name: "ESPN NFL ↗", exact: true}).getAttribute("href"), "https://www.espn.com/nfl/");
    assert.ok(await page.locator("#explore").getByRole("link", {name: /Player rankings/}).isVisible());
    assert.ok(await page.locator("#explore").getByRole("link", {name: /League simulations/}).isVisible());
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
    await page.locator("#explore").getByRole("link", {name: /Player rankings/}).click();
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
