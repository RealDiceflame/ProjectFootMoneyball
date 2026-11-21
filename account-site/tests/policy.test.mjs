import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ACCOUNT_ORIGIN, AUTH_ORIGIN, canStart, configErrors, codeValid, authMessage, securityHeaders} from '../src/policy.mjs';

const valid = {enabled: true, origin: ACCOUNT_ORIGIN, supabaseUrl: AUTH_ORIGIN, publishableKey: 'sb_publishable_test_fixture', turnstileSiteKey: '0xTestFixtureOnly', supportEmail: 'support@example.invalid'};
test('unconfigured or disabled builds and other hosts cannot start Auth', async () => {
  assert.equal(canStart(valid, ACCOUNT_ORIGIN), true);
  const production = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  assert.equal(canStart(production, ACCOUNT_ORIGIN), false);
  for (const origin of ['https://outlierbaseline.com', 'https://preview.pages.dev', 'https://accounts.outlierbaseline.com.evil.invalid', 'http://accounts.outlierbaseline.com']) assert.equal(canStart(valid, origin), false);
  for (const field of ['origin', 'supabaseUrl', 'publishableKey', 'turnstileSiteKey', 'supportEmail']) assert.equal(canStart({...valid, [field]: ''}, ACCOUNT_ORIGIN), false);
  assert.equal(canStart({...valid, enabled: 'true'}, ACCOUNT_ORIGIN), false);
});
test('private keys and Turnstile testing keys are rejected', () => {
  for (const key of ['sb_secret_example', 'eyJhbGciOiJIUzI1NiJ9.fake', 'service_role']) assert.ok(configErrors({...valid, publishableKey: key}).length);
  for (const key of ['1x00000000000000000000AA', '2x00000000000000000000AB', '']) assert.ok(configErrors({...valid, turnstileSiteKey: key}).length);
});
test('codes accept supported numeric lengths without silently altering values', () => {
  for (const value of ['123456', '12345678', '0123456789']) assert.equal(codeValid(value), true);
  for (const value of ['12345', '12345678901', '123abc', '１２３４５６', ' 123456']) assert.equal(codeValid(value), false);
});
test('untrusted server errors are not reflected into user messages', () => {
  assert.equal(authMessage({message: 'SECRET <script>evil</script>', code: 'unknown'}).includes('SECRET'), false);
  assert.match(authMessage({status: 429}), /wait/);
});
test('account policy blocks frames, inline scripts, plugins, form navigation and referrer leakage', () => {
  const csp = securityHeaders['Content-Security-Policy'];
  for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) assert.ok(csp.includes(directive));
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal(securityHeaders['Referrer-Policy'], 'no-referrer');
  assert.equal(securityHeaders['Cache-Control'], 'no-store');
});
