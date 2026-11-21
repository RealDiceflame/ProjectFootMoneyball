import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname} from 'node:path';
import {build} from 'esbuild';
import {ACCOUNT_ORIGIN as origin, AUTH_ORIGIN} from '../src/policy.mjs';

const engines = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = {enabled: true, origin, supabaseUrl: AUTH_ORIGIN, publishableKey: 'sb_publishable_test_fixture', turnstileSiteKey: '0xTestFixtureOnly', supportEmail: 'support@example.invalid'};
const user = {id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'member@example.invalid', email_confirmed_at: '2026-11-20T12:00:00Z', app_metadata: {provider: 'email'}, user_metadata: {}, created_at: '2026-11-20T12:00:00Z'};
const token = [Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url'), Buffer.from(JSON.stringify({sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated'})).toString('base64url'), 'test_signature_not_a_real_token'].join('.');
const session = {access_token: token, refresh_token: 'test_refresh_fixture', expires_in: 3600, token_type: 'bearer', user};
let browser, enabledBundle, headers;
before(async () => {
  const result = await build({entryPoints: [resolve(root, 'src/app.mjs')], bundle: true, write: false, target: ['es2022'], format: 'esm', define: {__ACCOUNT_CONFIG__: JSON.stringify(config)}});
  enabledBundle = result.outputFiles[0].text;
  headers = Object.fromEntries((await readFile(resolve(root, 'dist/_headers'), 'utf8')).trim().split('\n').slice(1).map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  const engine = process.env.BROWSER_ENGINE || 'chromium', channel = process.env.BROWSER_CHANNEL || 'msedge';
  browser = await engines[engine].launch({headless: true, ...(engine === 'chromium' && channel !== 'chromium' ? {channel} : {})});
});
after(async () => { await browser?.close(); });

async function open(options = {}) {
  const context = await browser.newContext({viewport: options.mobile ? {width: 375, height: 812} : {width: 1440, height: 1000}});
  const requests = [], errors = [], unexpected = [];
  await context.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin || url.origin === 'https://preview.pages.dev') {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'styles.css', 'app.js'].includes(name)) { await route.fulfill({status: 404, body: ''}); return; }
      const body = name === 'app.js' && !options.disabled ? enabledBundle : await readFile(resolve(root, 'dist', name));
      await route.fulfill({headers: {...headers, 'Content-Type': {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}[extname(name)]}, body}); return;
    }
    if (url.origin === 'https://challenges.cloudflare.com') {
      if (options.captchaFails) { await route.abort(); return; }
      await route.fulfill({contentType: 'text/javascript', body: `window.__captchaLoadedAt=location.href;window.turnstile={render(selector,opts){window.__solve=()=>opts.callback('fixture-captcha');window.__expire=()=>opts['expired-callback']();${options.manualCaptcha ? '' : 'setTimeout(window.__solve,0);'}return 'fixture-widget';},reset(){${options.manualCaptcha ? '' : 'setTimeout(window.__solve,0);'}}};`}); return;
    }
    if (url.origin === AUTH_ORIGIN) {
      const cors = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Content-Type': 'application/json'};
      if (request.method() === 'OPTIONS') { await route.fulfill({status: 204, headers: cors}); return; }
      const entry = {url, method: request.method(), body: request.postDataJSON()}; requests.push(entry);
      let response = options.api?.(entry);
      if (!response) {
        if (url.pathname.endsWith('/otp')) response = {status: 200, body: {}};
        else if (url.pathname.endsWith('/verify')) response = {status: 200, body: session};
        else if (url.pathname.endsWith('/user')) response = {status: 200, body: user};
        else if (url.pathname.endsWith('/logout')) response = {status: 204};
        else response = {status: 400, body: {message: 'Unexpected fixture endpoint'}};
      }
      await route.fulfill({status: response.status, headers: cors, ...(response.status === 204 ? {} : {body: JSON.stringify(response.body)})}); return;
    }
    unexpected.push(request.url()); await route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto((options.origin || origin) + (options.path || '/'));
  const close = async () => { assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); await context.close(); };
  return {page, context, requests, close};
}
async function ready(page) { await page.waitForFunction(() => !document.getElementById('submit').disabled); }
async function requestCode(page, login = false) {
  if (login) await page.locator('#mode-login').click();
  await page.locator('#email').fill(user.email); await ready(page); await page.locator('#submit').click();
  await page.locator('#code').waitFor();
}
async function verify(page) { await ready(page); await page.locator('#code').fill('12345678'); await page.locator('#submit').click(); }

test('disabled production build makes no authentication or CAPTCHA requests', async () => {
  const t = await open({disabled: true, path: '/?code=sensitive&next=https://evil.invalid/#access_token=secret'});
  assert.equal(await t.page.locator('#unavailable').isVisible(), true);
  assert.equal(await t.page.locator('#auth-panel').isVisible(), false);
  assert.equal(t.page.url(), origin + '/'); assert.equal(t.requests.length, 0);
  assert.equal(await t.page.evaluate(() => window.__captchaLoadedAt), undefined); await t.close();
});
test('an enabled bundle still refuses a preview host', async () => {
  const t = await open({origin: 'https://preview.pages.dev'});
  assert.equal(await t.page.locator('#unavailable').isVisible(), true); assert.equal(t.requests.length, 0); await t.close();
});
test('signup requires CAPTCHA and email-code verification before displaying an account', async () => {
  const t = await open(); await requestCode(t.page);
  const request = t.requests.find(r => r.url.pathname.endsWith('/otp'));
  assert.equal(request.body.gotrue_meta_security.captcha_token, 'fixture-captcha'); assert.equal(request.body.create_user, true);
  assert.equal(await t.page.locator('#signed-in').isVisible(), false);
  await verify(t.page); await t.page.locator('#signed-in').waitFor();
  const verification = t.requests.find(r => r.url.pathname.endsWith('/verify'));
  assert.equal(verification.body.type, 'email'); assert.equal(verification.body.token, '12345678');
  assert.equal(verification.body.gotrue_meta_security.captcha_token, 'fixture-captcha');
  assert.equal(await t.page.locator('#code').inputValue(), '');
  assert.equal(await t.page.evaluate(() => JSON.stringify(localStorage).includes('12345678')), false);
  assert.ok(t.requests.some(r => r.url.pathname.endsWith('/user')));
  assert.deepEqual(await t.page.evaluate(() => window.__violations), []); await t.close();
});
test('sign-in does not silently create accounts and sign-out removes the session', async () => {
  const t = await open(); await requestCode(t.page, true); await verify(t.page); await t.page.locator('#signed-in').waitFor();
  assert.equal(t.requests.find(r => r.url.pathname.endsWith('/otp')).body.create_user, false);
  assert.equal(await t.page.locator('#user-email').textContent(), user.email);
  await t.page.locator('#sign-out').click(); await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('signed out'));
  assert.equal(t.requests.find(r => r.url.pathname.endsWith('/logout')).url.searchParams.get('scope'), 'global');
  assert.equal(await t.page.evaluate(() => localStorage.getItem('ob-account-auth')), null); await t.close();
});
test('missing or expired CAPTCHA blocks submission', async () => {
  const t = await open({manualCaptcha: true}); await t.page.waitForFunction(() => !!window.__solve);
  assert.equal(await t.page.locator('#submit').isDisabled(), true);
  await t.page.evaluate(() => window.__solve()); await ready(t.page);
  await t.page.evaluate(() => window.__expire()); assert.equal(await t.page.locator('#submit').isDisabled(), true);
  assert.equal(t.requests.length, 0); await t.close();
});
test('a blocked CAPTCHA script fails closed', async () => {
  const t = await open({captchaFails: true}); await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('could not load'));
  assert.equal(await t.page.locator('#submit').isDisabled(), true); assert.equal(t.requests.length, 0); await t.close();
});
test('a server-rejected session never displays an authenticated account', async () => {
  const t = await open({api: r => r.url.pathname.endsWith('/user') ? {status: 401, body: {message: 'Invalid token', code: 'bad_jwt'}} : null});
  await requestCode(t.page); await verify(t.page); await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('verify your email'));
  assert.equal(await t.page.locator('#signed-in').isVisible(), false); await t.close();
});
test('expired or reused codes do not create an authenticated view', async () => {
  const t = await open({api: r => r.url.pathname.endsWith('/verify') ? {status: 403, body: {msg: 'Expired', error_code: 'otp_expired'}} : null});
  await requestCode(t.page); await verify(t.page); await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('could not be used'));
  assert.equal(await t.page.locator('#signed-in').isVisible(), false); assert.equal(await t.page.locator('#code').inputValue(), '');
  assert.equal(await t.page.evaluate(() => localStorage.getItem('ob-account-auth')), null); await t.close();
});
test('errors never reflect server content into the page', async () => {
  const t = await open({api: r => r.url.pathname.endsWith('/otp') ? {status: 400, body: {message: '<img src=x onerror=alert(1)>SECRET', code: 'unexpected'}} : null});
  await t.page.locator('#email').fill(user.email); await ready(t.page); await t.page.locator('#submit').click();
  await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('could not complete'));
  assert.equal((await t.page.locator('body').innerText()).includes('SECRET'), false); await t.close();
});
test('resend has a cooldown and requires a fresh bot check', async () => {
  const t = await open({manualCaptcha: true}); await t.page.waitForFunction(() => !!window.__solve);
  await t.page.evaluate(() => window.__solve()); await requestCode(t.page);
  assert.equal(await t.page.locator('#resend').isDisabled(), true);
  await t.page.clock.install(); await t.page.clock.fastForward(61000);
  assert.equal(await t.page.locator('#resend').isDisabled(), true);
  await t.page.evaluate(() => window.__solve()); assert.equal(await t.page.locator('#resend').isEnabled(), true);
  await t.page.locator('#resend').click(); await t.page.waitForFunction(() => document.getElementById('status').textContent.includes('a code is on its way'));
  assert.equal(t.requests.filter(r => r.url.pathname.endsWith('/otp')).length, 2); await t.close();
});
test('query and fragment tokens cannot sign the visitor in or redirect them', async () => {
  const t = await open({path: '/?code=foreign&next=https://evil.invalid/#access_token=foreign&refresh_token=foreign'}); await ready(t.page);
  assert.equal(t.page.url(), origin + '/'); assert.equal(t.requests.length, 0);
  assert.equal(await t.page.evaluate(() => window.__captchaLoadedAt), origin + '/');
  assert.equal(await t.page.locator('#signed-in').isVisible(), false); await t.close();
});
test('a saved session is checked with the server on reload', async () => {
  const t = await open(); await requestCode(t.page); await verify(t.page); await t.page.locator('#signed-in').waitFor();
  const before = t.requests.filter(r => r.url.pathname.endsWith('/user')).length;
  await t.page.reload(); await t.page.locator('#signed-in').waitFor();
  assert.ok(t.requests.filter(r => r.url.pathname.endsWith('/user')).length > before); await t.close();
});
test('strict headers block inline scripts and the mobile layout fits', async () => {
  const t = await open({mobile: true}); await ready(t.page);
  assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await t.page.evaluate(() => { const script = document.createElement('script'); script.textContent = 'window.__injected=true'; document.head.append(script); });
  await t.page.waitForFunction(() => window.__violations.includes('script-src-elem'));
  assert.equal(await t.page.evaluate(() => window.__injected), undefined);
  if (process.env.ACCOUNT_SCREENSHOTS) { await mkdir(process.env.ACCOUNT_SCREENSHOTS, {recursive: true}); await t.page.screenshot({path: resolve(process.env.ACCOUNT_SCREENSHOTS, 'signup-mobile.png'), fullPage: true}); }
  await t.close();
});
