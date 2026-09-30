// Responsive layout regressions. All requests stay on the local fixture server.
// LAYOUT_SCREENSHOTS writes homepage/rankings desktop/mobile screenshots and a report.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const widths = [1440, 390, 320, 768, 1024], findings = [];
let browser, server, base, gameId;

before(async () => {
  if (process.env.LAYOUT_SCREENSHOTS) await mkdir(process.env.LAYOUT_SCREENSHOTS, {recursive: true});
  const index = JSON.parse(await readFile(resolve(root, "data/game_stats/2026/index.json"), "utf8"));
  gameId = Object.keys(index.games)[0];
  assert.ok(gameId, "A published game is needed to exercise the real box score");
  server = createServer(async (request, response) => {
    try {
      const file = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
      if (!file.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
      response.setHeader("Content-Type", {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png"}[extname(file)] || "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.BROWSER_ENGINE || "chromium", channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await engines[engine].launch({headless: true, ...(engine === "chromium" && channel !== "chromium" ? {channel} : {})});
});
after(async () => {
  try {
    if (process.env.LAYOUT_SCREENSHOTS) await writeFile(resolve(process.env.LAYOUT_SCREENSHOTS, "layout-findings.json"), JSON.stringify(findings, null, 2));
  } finally {
    await browser?.close(); if (server) await new Promise(done => server.close(done));
  }
});

const pages = [
  ["index", "#home-injury-list article, #home-injury-list p"],
  ["rankings", "#table-body tr"], ["special-teams", "#special-body tr"],
  ["projection", "#projection-content:not(.hidden)"], ["survivor", "#survivor-content:not([hidden])"],
  ["league", "#league-results:not([hidden])"], ["odds", '#odds-games-shell[aria-busy="false"]'],
  ["stats", "#stats-results > *"], ["stats-leaders", "#stats-results table", "stats.html?view=leaders"],
  ["game", "#game-stats table"],
];

async function measure(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("dialog[open]"), scope = modal || document;
    const visible = element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        && (!element.checkVisibility || element.checkVisibility());
    };
    const label = element => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join(".")}`;
    const name = element => element.getAttribute("aria-label") || [...(element.labels || [])].map(node => node.textContent.trim()).join(" ")
      || (element.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim()
      || (!element.matches("input,select,textarea") && element.textContent.trim()) || element.getAttribute("title") || "";
    const scrollParent = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowX)) return parent;
      }
      return null;
    };
    const offenders = [...document.querySelectorAll("main *, header *, footer *")].filter(element => {
      if (!visible(element) || scrollParent(element)) return false;
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1;
    }).slice(0, 12).map(element => ({selector: label(element), text: name(element).slice(0, 55), width: Math.round(element.getBoundingClientRect().width)}));
    const controls = [...scope.querySelectorAll("button, input:not([type=hidden]), select, textarea, summary, .topnav a, a.button, .stats-views a, .home-primary, .home-secondary")].filter(visible);
    const smallControls = controls.flatMap(element => {
      let box = element.getBoundingClientRect();
      if (element.matches('input[type="checkbox"], input[type="radio"]') && element.labels?.length) box = element.labels[0].getBoundingClientRect();
      return box.width >= 43.5 && box.height >= 43.5 ? [] : [{selector: label(element), name: name(element).slice(0, 65), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10}];
    });
    const unlabeled = controls.filter(element => element.matches("input,select,textarea,button") && !name(element)).map(label);
    const nativeOverflow = controls.filter(element => element.matches("select") && element.scrollWidth > element.clientWidth + 1)
      .map(element => ({selector: label(element), width: element.clientWidth, contentWidth: element.scrollWidth}));
    const tables = [...scope.querySelectorAll('table, [role="table"]')].filter(visible).map(table => {
      const box = table.getBoundingClientRect(), parent = scrollParent(table), width = parent?.clientWidth ?? innerWidth;
      const overflowing = table.scrollWidth > width + 2 || box.width > width + 2;
      let reachable = !overflowing, keyboard = true;
      if (overflowing && parent) {
        const previous = parent.scrollLeft;
        parent.scrollLeft = parent.scrollWidth;
        const last = table.querySelector('tr > :last-child, [role="row"] > :last-child'), end = last?.getBoundingClientRect(), boundary = parent.getBoundingClientRect();
        reachable = parent.scrollLeft > 0 && (!end || end.right <= boundary.right + 2);
        keyboard = parent.tabIndex >= 0 && Boolean(parent.getAttribute("aria-label") || parent.getAttribute("aria-labelledby"));
        parent.scrollLeft = previous;
      }
      return {selector: label(table), parent: parent && label(parent), overflowing, reachable, keyboard};
    });
    const boards = [...document.querySelectorAll("#table-shell, #special-table-shell")].filter(visible).map(shell => {
      const row = shell.querySelector("tbody tr"), header = shell.querySelector("thead tr");
      if (!row) return null;
      const firstCells = [...row.children].slice(0, 3), previous = shell.scrollLeft;
      const leadingWidth = firstCells[0].getBoundingClientRect().width + firstCells[1].getBoundingClientRect().width;
      shell.scrollLeft = 300;
      const cells = firstCells.map(cell => cell.getBoundingClientRect()), headings = [...header.children].slice(0, 3).map(cell => cell.getBoundingClientRect());
      const sticky = firstCells.every(cell => getComputedStyle(cell).position === "sticky")
        && Math.abs(cells[0].left - shell.getBoundingClientRect().left) <= 2
        && cells.every((cell, index) => (index === 0 || Math.abs(cell.left - cells[index - 1].right) <= 2)
          && Math.abs(cell.left - headings[index].left) <= 2 && Math.abs(cell.right - headings[index].right) <= 2);
      shell.scrollLeft = previous;
      return {selector: label(shell), leadingWidth, sticky};
    }).filter(Boolean);
    const subtitle = document.querySelector(".brand small"), subtitleBox = subtitle.getBoundingClientRect();
    const subtitleRange = document.createRange(); subtitleRange.selectNodeContents(subtitle);
    const brand = {text: subtitle.textContent.trim(), visible: visible(subtitle),
      fullyVisible: [...subtitleRange.getClientRects()].every(box => box.left >= subtitleBox.left - 1
        && box.right <= subtitleBox.right + 1 && box.top >= subtitleBox.top - 1 && box.bottom <= subtitleBox.bottom + 1)
        && subtitleBox.left >= 0 && subtitleBox.right <= innerWidth + 1
        && subtitle.scrollWidth <= subtitle.clientWidth + 1 && subtitle.scrollHeight <= subtitle.clientHeight + 1,
      textOverflow: getComputedStyle(subtitle).textOverflow};
    const modalBox = modal?.getBoundingClientRect();
    return {viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, offenders,
      smallControlCount: smallControls.length, smallControls: smallControls.slice(0, 30), unlabeled, nativeOverflow, tables, boards, brand,
      modal: modal && {left: modalBox.left, right: modalBox.right, clientWidth: modal.clientWidth, scrollWidth: modal.scrollWidth}};
  });
}

function assertLayout(result, {boardColumns = true} = {}) {
  const {page: name, width} = result;
  assert.ok(result.documentWidth <= result.viewport + 1, `${name} at ${width}px overflows to ${result.documentWidth}px: ${JSON.stringify({elements: result.offenders, nativeSelects: result.nativeOverflow})}`);
  if (name === "index" || name === "index-expanded") {
    assert.equal(result.brand.text, "Be an Outlier. Know your Baseline.", `${name}: the homepage brand uses the exact subtitle`);
    assert.equal(result.brand.visible && result.brand.fullyVisible && result.brand.textOverflow !== "ellipsis", true,
      `${name} at ${width}px: the full subtitle must remain visible without clipping or ellipsis: ${JSON.stringify(result.brand)}`);
  }
  assert.deepEqual(result.unlabeled, [], "Every visible form control needs an accessible name");
  assert.deepEqual(result.tables.filter(table => !table.reachable || !table.keyboard), [], "Wide tables must scroll to the last column and be reachable by keyboard");
  if (width <= 1024) assert.equal(result.smallControlCount, 0, `Touch targets must be at least 44×44px: ${JSON.stringify(result.smallControls)}`);
  if (boardColumns) for (const board of result.boards) {
    if (width <= 1024) assert.ok(board.leadingWidth <= 180, `${board.selector}: the first two columns consume ${board.leadingWidth.toFixed(1)}px, hiding player identity`);
    if (width === 1440) assert.equal(board.sticky, true, `${board.selector}: sticky identity columns or their headers overlap after scrolling`);
  }
  if (result.modal) assert.ok(result.modal.left >= -1 && result.modal.right <= width + 1
    && result.modal.scrollWidth <= result.modal.clientWidth + 1, `Dialog is horizontally clipped: ${JSON.stringify(result.modal)}`);
}

for (const [name, ready, route] of pages) test(`${name}: responsive layout and reachable controls`, async t => {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, hasTouch: true});
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${base}/${route || `${name}.html${name === "game" ? `?game=${encodeURIComponent(gameId)}` : ""}`}`);
    await page.locator(ready).first().waitFor({state: "attached"});
    await page.locator(".lab-navigation").waitFor();
    await t.test("keyboard skip link reaches the main content", async () => {
      const skip = page.locator(".home-skip, .site-skip");
      // Windows WebKit omits native anchors from Tab order even without styles.
      // Chromium and Linux WebKit verify real first-stop navigation; Windows
      // still verifies that a focused skip link is visible and Enter targets main.
      if (process.platform === "win32" && process.env.BROWSER_ENGINE === "webkit") await skip.focus();
      else await page.keyboard.press("Tab");
      assert.equal(await skip.evaluate(element => element === document.activeElement), true, "Skip link is the first keyboard stop");
      const bounds = await skip.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0, "Focused skip link is visible");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement === document.querySelector("main"));
      await page.locator("main").evaluate(element => element.blur());
      await page.evaluate(() => scrollTo(0, 0));
    });
    for (const width of widths) await t.test(`${width}px`, async () => {
      await page.setViewportSize({width, height: 1000});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (process.env.LAYOUT_SCREENSHOTS && ["index", "rankings"].includes(name) && [390, 1440].includes(width)) {
        await page.screenshot({path: resolve(process.env.LAYOUT_SCREENSHOTS, `${name}-${width}.png`), fullPage: true});
      }
      const result = {page: name, width, ...await measure(page)}; findings.push(result);
      assertLayout(result);
      if (name === "index") {
        assert.equal(await page.locator(".home-hero").count(), 0, "The large homepage hero is removed");
        assert.equal(await page.getByRole("heading", {name: "OutlierBaseline", level: 1, exact: true}).count(), 1, "The homepage retains an accessible page heading");
        assert.equal(await page.locator("h1").count(), 1);
        assert.equal(await page.locator("#league-news-list .home-lead-story").count(), 1, "The news feed has a single editorial lead");
        const editorial = await page.evaluate(() => {
          const articles = [...document.querySelectorAll("#league-news-list .home-source-card")];
          const textFits = element => {
            const bounds = element.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(element);
            return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1
              && [...range.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
                && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1);
          };
          return {leadFirst: articles[0].classList.contains("home-lead-story"),
            headings: articles.map(article => article.querySelectorAll(".home-clip h3").length),
            leadSize: parseFloat(getComputedStyle(articles[0].querySelector("h3")).fontSize),
            rowSize: parseFloat(getComputedStyle(articles[1].querySelector("h3")).fontSize),
            readable: articles.every(article => textFits(article.querySelector("h3"))),
            updatesReadable: [...document.querySelectorAll(".home-updates h3, .home-updates p, .home-updates a")].every(textFits)};
        });
        assert.equal(editorial.leadFirst, true, "The newest story leads the reading order");
        assert.ok(editorial.headings.every(count => count === 1), "Each story retains one semantic headline");
        assert.ok(editorial.leadSize > editorial.rowSize, "The lead has a stronger type hierarchy than supporting news rows");
        assert.equal(editorial.readable, true, "News headlines wrap without clipping at every width");
        assert.equal(editorial.updatesReadable, true, "Compact announcements keep their copy and links fully visible");
        assert.deepEqual(await page.locator(".home-updates article h3").allTextContents(),
          ["League simulations", "Player history and draft analysis"], "Approved announcements remain without the archived league prototype");
        assert.deepEqual(await page.locator(".home-updates article a").evaluateAll(links => links.map(link => link.getAttribute("href"))),
          ["league.html#bracket-heading", "projection.html"], "Announcements use the approved destinations without a draft-round jump");
        assert.deepEqual(await page.locator(".home-updates article a").allTextContents(),
          ["View simulations ↗", "View player history ↗"], "Announcements use the approved link labels");
        assert.deepEqual(await page.locator(".home-feed-grid > *").evaluateAll(sections => sections.map(section => section.getAttribute("aria-labelledby"))),
          ["highlights-heading", "injury-heading", "explore-heading"], "Document and keyboard reading order is news, injuries, then tools");
        assert.deepEqual(await page.locator("#explore .home-tool-grid > a").evaluateAll(links => links.map(link => link.getAttribute("href"))),
          ["rankings.html", "special-teams.html", "projection.html", "survivor.html", "league.html", "odds.html"], "All six original tool destinations remain once, in order");
        assert.equal(await page.locator("#explore").count(), 1, "Explore tools is moved, not duplicated");
        assert.equal(await page.locator(".home-tool-grid > a").count(), 6);
        const compact = await page.evaluate(() => {
          const grid = document.querySelector("#explore .home-tool-grid");
          const cards = [...grid.children];
          const textFits = element => {
            const bounds = element.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(element);
            return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1
              && [...range.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
                && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1);
          };
          // Compare the same browser, text and available width against the former
          // category/padding/title-spacing treatment, without fixed pixel heights.
          const prior = grid.cloneNode(true);
          Object.assign(prior.style, {position: "absolute", visibility: "hidden", pointerEvents: "none",
            width: `${grid.getBoundingClientRect().width}px`, gap: "16px", left: "0", top: "0"});
          [...prior.children].forEach((card, index) => {
            card.style.padding = "20px";
            const category = document.createElement("span");
            category.textContent = ["FANTASY", "FANTASY", "LABS", "LABS", "LABS", "MARKETS"][index];
            category.style.fontSize = "11px"; category.style.letterSpacing = ".08em";
            card.prepend(category);
            Object.assign(card.querySelector("h3").style, {fontSize: "18px", margin: "16px 0 10px"});
            Object.assign(card.querySelector("p").style, {fontSize: "15px", lineHeight: "1.65", margin: "0"});
          });
          grid.parentElement.append(prior);
          try {
            return {height: grid.getBoundingClientRect().height, priorHeight: prior.getBoundingClientRect().height,
              children: cards.map(card => [...card.children].map(child => child.tagName)),
              textVisible: cards.every(card => [card.querySelector("h3"), card.querySelector("p")].every(element => element && textFits(element)))};
          } finally { prior.remove(); }
        });
        assert.deepEqual(compact.children, Array.from({length: 6}, () => ["H3", "P"]), "Each tool card contains its title and short description without a repeated category");
        assert.equal(compact.textVisible, true, "Every tool title and description remains fully visible without clipping");
        assert.ok(compact.height <= compact.priorHeight * .85,
          `Tool cards are meaningfully shorter than their prior category-card treatment: ${compact.height}px vs ${compact.priorHeight}px`);
        const scoreControls = await page.evaluate(() => {
          const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          return {previous: bounds("#score-prev"), next: bounds("#score-next"), pair: bounds(".home-score-arrows"), controls: bounds(".home-score-controls")};
        });
        assert.ok(Math.abs(scoreControls.previous.top - scoreControls.next.top) <= 1, "Scoreboard arrows always stay on the same row");
        assert.ok(scoreControls.previous.right <= scoreControls.next.left + 1, "Previous and next arrows retain their visual order");
        for (const button of [scoreControls.previous, scoreControls.next]) {
          assert.ok(button.width >= 43.5 && button.height >= 43.5, "Both scoreboard arrows retain 44px touch targets at every width");
          assert.ok(button.left >= scoreControls.pair.left - 1 && button.right <= scoreControls.pair.right + 1
            && button.top >= scoreControls.pair.top - 1 && button.bottom <= scoreControls.pair.bottom + 1,
          "Both scoreboard arrows fit inside their shared control group");
        }
        assert.ok(scoreControls.pair.left >= scoreControls.controls.left - 1 && scoreControls.pair.right <= scoreControls.controls.right + 1
          && scoreControls.pair.left >= -1 && scoreControls.pair.right <= width + 1, "The arrow pair fits inside the scoreboard controls and viewport");
        const {news, injuries, tools, cards, columns, areas, injuryArea} = await page.evaluate(() => ({
          news: document.querySelector(".home-highlights").getBoundingClientRect().toJSON(),
          injuries: document.querySelector(".home-injuries").getBoundingClientRect().toJSON(),
          tools: document.querySelector("#explore").getBoundingClientRect().toJSON(),
          cards: [...document.querySelectorAll("#explore .home-tool-grid > a")].map(card => card.getBoundingClientRect().toJSON()),
          columns: getComputedStyle(document.querySelector("#explore .home-tool-grid")).gridTemplateColumns.split(/\s+/).length,
          areas: getComputedStyle(document.querySelector(".home-feed-grid")).gridTemplateAreas,
          injuryArea: getComputedStyle(document.querySelector(".home-injuries")).gridArea,
        }));
        if (width <= 390) {
          assert.ok(news.y + news.height <= injuries.y + 1 && Math.abs(news.x - injuries.x) <= 1, "Phone layout stacks news before injuries");
          assert.ok(injuries.bottom <= tools.top + 1 && Math.abs(injuries.left - tools.left) <= 1, "Phone layout stacks tools after injuries");
          assert.equal(columns, 1, "Tool cards use one column on phones");
        } else {
          assert.ok(news.x + news.width <= injuries.x + 1 && Math.abs(news.y - injuries.y) <= 1, "Desktop and tablet layout places news to the left of injuries");
          assert.ok(news.width > injuries.width, "News receives the wider desktop column");
          assert.ok(Math.abs(tools.left - news.left) <= 1 && Math.abs(tools.width - news.width) <= 1,
            "Tools fill the same left column as news");
          assert.ok(Math.abs(tools.top - news.bottom) <= 2, "Tools start directly below news without waiting for the injury column");
          assert.equal(areas, '"news injuries" "tools injuries"', "The injury area spans both news and tools rows");
          assert.equal(injuryArea.split(" / ")[0], "injuries", "The injury section occupies its full two-row area");
          if (width >= 1024) assert.equal(columns, 2, "Desktop tool cards use two columns within the news column");
          else assert.ok([1, 2].includes(columns), "Tablet tool cards retain a readable one- or two-column layout");
        }
        assert.ok(cards.every(card => card.width > 0 && card.left >= tools.left - 1 && card.right <= tools.right + 1),
          "Every tool card fits inside its section");
        await page.locator("#league-news-list").focus();
        assert.equal(await page.locator("#league-news-list").evaluate(element => element === document.activeElement
          && parseFloat(getComputedStyle(element).outlineWidth) >= 2 && getComputedStyle(element).outlineStyle !== "none"), true,
        "The news scrolling region keeps a visible keyboard focus indicator");
        await page.locator(".home-highlights a").last().focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#injury-search").evaluate(element => element === document.activeElement), true,
          "Keyboard focus moves from news to the injury search");
        await page.locator("#injury-search").evaluate(element => element.blur());
        const sources = page.locator(".home-source-details");
        assert.equal(await sources.evaluate(element => element.open), false, "Sources and privacy starts collapsed");
        await sources.locator("summary").focus(); await page.keyboard.press("Enter");
        assert.equal(await sources.evaluate(element => {
          const paragraphs = [...element.querySelectorAll("p")];
          return element.open && paragraphs.length === 4 && paragraphs.every(paragraph => {
            const box = paragraph.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(paragraph);
            return box.width > 0 && box.height > 0 && paragraph.scrollWidth <= paragraph.clientWidth + 1
              && [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1
                && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
          });
        }), true, "Expanded source, license and privacy paragraphs remain readable without clipping");
        assert.equal(await sources.locator("a").count(), 6, "All existing attribution and privacy destinations remain available");
        assertLayout({page: "index-sources-expanded", width, ...await measure(page)});
        await page.keyboard.press("Enter");
        await page.evaluate(() => scrollTo(0, 0));
      }
      assert.deepEqual(errors, [], "No browser errors while laying out the page");
    });
    if (name === "index") await t.test("expanded reports keep tools directly below news", async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      const originalTop = await page.locator("#explore").evaluate(element => element.getBoundingClientRect().top + scrollY);
      for (let next = 0; next < 4 && await page.locator("#injury-more").isVisible(); next++) await page.locator("#injury-more").click();
      assert.ok(await page.locator("#home-injury-list article").count() > 8, "Exercise a sidebar taller than its initial compact view");
      const {newsBottom, toolsTop} = await page.evaluate(() => ({
        newsBottom: document.querySelector(".home-highlights").getBoundingClientRect().bottom + scrollY,
        toolsTop: document.querySelector("#explore").getBoundingClientRect().top + scrollY,
      }));
      assert.ok(Math.abs(toolsTop - newsBottom) <= 2, "Expanding the injury sidebar does not insert space between news and tools");
      assert.ok(Math.abs(toolsTop - originalTop) <= 2, "Expanding reports leaves the tools section in place");
      assertLayout({page: "index-expanded", width: 1440, ...await measure(page)});
    });
    if (name === "rankings") {
      for (const width of [1440, 390, 320, 768, 1024]) await t.test(`player profile and history at ${width}px`, async () => {
        await page.setViewportSize({width, height: 1000});
        await page.locator("#table-body .player-intel-button").first().click();
        await page.locator("#intel-dialog[open] .history-table-shell table").waitFor({state: "attached"});
        try {
          const result = {page: "rankings-profile", width, ...await measure(page)}; findings.push(result);
          assertLayout(result, {boardColumns: false});
          assert.ok(result.tables.length > 0, "A real player history table must be exercised");
        } finally { await page.getByRole("button", {name: "Close player report", exact: true}).click(); }
      });
    }
    if (name === "odds") await t.test("comparison columns can be scrolled using the keyboard", async () => {
      await page.setViewportSize({width: 320, height: 1000});
      const region = page.locator(".odds-comparison-scroll").first();
      await region.waitFor();
      assert.ok(await region.locator('[role="table"]').count(), "Exercise the rendered non-native comparison table");
      assert.equal(await region.evaluate(element => element.scrollWidth > element.clientWidth), true, "The narrow view really needs horizontal scrolling");
      await region.evaluate(element => { element.scrollLeft = 0; });
      await region.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector(".odds-comparison-scroll").scrollLeft > 0);
      assert.equal(await region.evaluate(element => element === document.activeElement), true, "The scrollable region retains keyboard focus");
    });
    if (["rankings", "special-teams", "odds"].includes(name)) {
      const search = {rankings: "#search", "special-teams": "#special-search", odds: "#odds-search"}[name];
      const empty = {rankings: "#empty-state", "special-teams": "#special-empty", odds: "#odds-empty"}[name];
      for (const width of [320, 390, 1024, 1440]) await t.test(`empty results at ${width}px`, async () => {
        await page.setViewportSize({width, height: 1000});
        await page.fill(search, "no-matching-player-or-team-layout-test");
        await page.locator(`${empty}:not(.hidden)`).waitFor();
        try {
          const result = {page: `${name}-empty`, width, ...await measure(page)}; findings.push(result);
          assertLayout(result);
          const box = await page.locator(empty).boundingBox();
          assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `Empty-state overlay fits inside the page: ${JSON.stringify(box)}`);
          for (const message of await page.locator(`${empty} > *`).all()) {
            const bounds = await message.boundingBox();
            assert.ok(bounds && bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `Each empty-state message and action is readable inside the page: ${JSON.stringify(bounds)}`);
          }
        } finally { await page.fill(search, ""); }
      });
    }
    assert.deepEqual(errors, [], "No browser errors while exercising responsive states");
  } finally { await context.close(); }
});
