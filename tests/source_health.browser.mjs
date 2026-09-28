// Exercise the real shared footer in a browser; all fixture requests stay local.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const now = Date.parse('2026-09-28T12:00:00Z');
let browser, server, base;
before(async () => {
  const source = await readFile(new URL('../docs/site-nav.js', import.meta.url), 'utf8');
  server = createServer((request, response) => {
    if (request.url === '/site-nav.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(source); return;
    }
    if (request.url === '/health.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main>Source health fixture</main><footer></footer><script type="module" src="site-nav.js"></script>');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.BROWSER_ENGINE || 'chromium';
  const channel = process.env.BROWSER_CHANNEL || 'msedge';
  browser = await engines[engine].launch({headless: true, ...(engine === 'chromium' && channel !== 'chromium' ? {channel} : {})});
});
after(async () => {await browser?.close(); if (server) await new Promise(done => server.close(done));});

test('shared footer distinguishes downloaded and cached MFL season aggregates from no available ADP', async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage(), errors = [];
  let state = 'fallback';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname !== '/data/update_status.json') return route.continue();
    return route.fulfill({json: {status: state === 'cached' ? 'partial_failure' : 'success', execution_status: 'success',
      completed_at: new Date(now).toISOString(), sources: {rankings: {status: 'success', providers: {
        Yahoo: {status: 'manual', data_updated_at: '2026-08-29', timestamp_kind: 'snapshot'},
        MFL: {status: state, actual_period: 'ALL', requested_period: 'RECENT', reason_code: 'no_recent_drafts',
          data_updated_at: '2026-09-28', timestamp_kind: 'snapshot'},
      }}}}});
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({time: new Date(now)});
  try {
    await page.goto(`${base}/health.html`);
    const footer = page.locator('.site-refresh-status');
    await page.waitForFunction(() => document.querySelector('.site-refresh-status')?.textContent.includes('MFL: season-aggregate ADP'));
    assert.equal(await footer.count(), 1);
    assert.equal(await footer.evaluate(node => node.open), false);
    await footer.locator('summary').click();
    let text = await footer.innerText();
    assert.match(text, /MFL: season-aggregate ADP; recent drafts unavailable; snapshot captured/);
    assert.match(text, /Yahoo: manual import/);
    assert.doesNotMatch(text, /no ADP snapshot available|backup feed|primary feed was not used|reload/i);
    state = 'cached';
    await page.clock.fastForward(600001);
    await page.waitForFunction(() => document.querySelector('.site-refresh-status')?.textContent.includes('saved season-aggregate ADP retained'));
    text = await footer.innerText();
    assert.match(text, /MFL: saved season-aggregate ADP retained; recent drafts unavailable; snapshot captured/);
    assert.doesNotMatch(text, /no ADP snapshot available|source data dated/);
    assert.equal(await footer.evaluate(node => node.open), true);
    assert.deepEqual(errors, []);
  } finally {await context.close();}
});
