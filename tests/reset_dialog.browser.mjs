// Exercise the real rankings dialog with saved local snapshots, never upstream APIs.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const draftedKey = "project-foot-moneyball:drafted:v1";
let browser, server, base;

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const file = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
      if (!file.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
      response.setHeader("Content-Type", {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}[extname(file)] || "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.BROWSER_ENGINE || "chromium", channel = process.env.BROWSER_CHANNEL || "msedge";
  browser = await engines[engine].launch({headless: true, ...(engine === "chromium" && channel !== "chromium" ? {channel} : {})});
});
after(async () => { await browser?.close(); if (server) await new Promise(done => server.close(done)); });

test("reset confirmation has an accessible name and description, and keyboard cancellation preserves picks", async () => {
  const context = await browser.newContext();
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(`${base}/rankings.html`);
    await page.locator("#table-body .draft-toggle").first().click();
    const saved = await page.evaluate(key => localStorage.getItem(key), draftedKey);
    assert.equal(JSON.parse(saved).length, 1, "Start with a real saved draft pick");
    const opener = page.getByRole("button", {name: "Reset draft", exact: true});
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {name: "Clear every drafted player?", exact: true});
    await dialog.waitFor({state: "visible"});
    assert.equal(await dialog.evaluate(element => document.getElementById(element.getAttribute("aria-describedby"))?.textContent),
      "This only resets this browser. Your rankings and league settings stay available.");
    assert.equal(await dialog.getByRole("button", {name: "Keep my draft", exact: true}).evaluate(element => element === document.activeElement), true,
      "The safe cancellation action receives initial keyboard focus");
    await page.keyboard.press("Escape");
    await dialog.waitFor({state: "hidden"});
    assert.equal(await opener.evaluate(element => element === document.activeElement), true, "Closing returns keyboard focus to Reset draft");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftedKey), saved, "Escape leaves saved picks intact");
    assert.equal(await page.locator('.draft-toggle[aria-pressed="true"]').count(), 1);
  } finally { await context.close(); }
});
