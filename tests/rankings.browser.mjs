import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../docs/', import.meta.url));
let server, browser, base;
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
      if (!path.startsWith(root + sep) && !path.startsWith(resolve(root) + sep)) {response.writeHead(403).end(); return;}
      response.setHeader('Content-Type', {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json'}[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch {response.writeHead(404).end();}
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.BROWSER_ENGINE || 'chromium', channel = process.env.BROWSER_CHANNEL || 'msedge';
  browser = await engines[engine].launch({headless: true, ...(engine === 'chromium' && channel !== 'chromium' ? {channel} : {})});
});
after(async () => {await browser?.close(); if (server) await new Promise(done => server.close(done));});

test('rankings switch horizons, show defensive explanations and preserve draft selections on mobile', async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(`${base}/rankings.html?defenses=Include&horizon=weekly`);
  await page.waitForFunction(() => document.querySelector('#board-summary').textContent.includes('OB Schedule & Defense'));
  assert.equal(await page.locator('#ranking-horizon').inputValue(), 'weekly');
  assert.equal(await page.locator('#defenses').inputValue(), 'Include');
  assert.ok(await page.locator('#table-body tr').count() > 400);
  await page.locator('#search').fill('MIN D/ST');
  await page.getByRole('button', {name: 'Mark drafted: MIN D/ST', exact: true}).click();
  await page.getByRole('button', {name: 'Open player profile for MIN D/ST', exact: true}).click();
  assert.match(await page.locator('#intel-body').textContent(), /OB box-score D\/ST/);
  assert.match(await page.locator('#intel-body').textContent(), /Defenders behind this D\/ST forecast/);
  assert.ok(await page.locator('.defender-table-scroll tbody tr').count() > 10);
  assert.match(await page.locator('#intel-body').textContent(), /Team event prior \(20%\)/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await mkdir('artifacts/layout/rankings', {recursive: true});
  await page.screenshot({path: 'artifacts/layout/rankings/defenders-mobile.png', fullPage: true});
  await page.keyboard.press('Escape');
  await page.locator('#ranking-horizon').selectOption('ros');
  assert.match(await page.locator('#board-summary').textContent(), /Rest of season/);
  assert.equal(await page.getByRole('button', {name: 'Undo drafted: MIN D/ST', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.locator('#ranking-horizon').selectOption('draft');
  await page.locator('#search').fill('');
  await page.locator('#ppr').selectOption('Full PPR');
  assert.match(await page.locator('#ranking-model-note').textContent(), /full-season outlook/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, 'the table scrolls inside its container, not the page');
  await mkdir('artifacts/layout/rankings', {recursive: true});
  await page.screenshot({path: 'artifacts/layout/rankings/mobile.png', fullPage: true});
  assert.deepEqual(errors, []);
  await context.close();
});

test('unavailable forecast input is clearly labeled and never relabeled as weekly data', async () => {
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === '/data/ranking_inputs.json') return route.fulfill({json: {schema_version: 1}});
    return route.continue();
  });
  await page.goto(`${base}/rankings.html?horizon=weekly`);
  await page.waitForFunction(() => document.querySelector('#ranking-model-note').textContent.includes('unavailable'));
  assert.equal(await page.locator('#table-body tr').count(), 0);
  await page.locator('#ranking-horizon').selectOption('draft');
  assert.ok(await page.locator('#table-body tr').count() > 200);
  assert.match(await page.locator('#board-summary').textContent(), /Age Curve v1/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('stale personnel uses a clearly labeled team fallback without fabricated player contributions', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === '/data/ranking_inputs.json') {
      const inputs = JSON.parse(await readFile(resolve(root, 'data/ranking_inputs.json'), 'utf8'));
      inputs.defense.personnel.status.generated_at = new Date(Date.now() - 3 * 86400000).toISOString();
      return route.fulfill({json: inputs});
    }
    return route.continue();
  });
  await page.goto(`${base}/rankings.html?defenses=Include&horizon=ros`);
  await page.waitForFunction(() => document.querySelector('#ranking-model-note').textContent.includes('team fallback'));
  await page.locator('#search').fill('MIN D/ST');
  await page.getByRole('button', {name: 'Open player profile for MIN D/ST', exact: true}).click();
  assert.match(await page.locator('#intel-body').textContent(), /Team fallback is in use/);
  assert.equal(await page.locator('.defender-table-scroll tbody tr').count(), 0);
  await context.close();
});
