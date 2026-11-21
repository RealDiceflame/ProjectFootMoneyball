import {createClient} from '@supabase/supabase-js';
import {canStart, authMessage, codeValid} from './policy.mjs';

const config = __ACCOUNT_CONFIG__;
const $ = id => document.getElementById(id);
// Codes are entered on this page. Never consume tokens or redirect targets from a URL.
if (location.search || location.hash) history.replaceState(null, '', '/');
if (canStart(config, location.origin)) start().catch(() => {
  $('auth-panel').hidden = true; $('signed-in').hidden = true; $('unavailable').hidden = false;
  $('status').textContent = 'Account access is temporarily unavailable. Please try again later.';
});

async function start() {
  // Sessions stay on the account origin; analytics and social scripts cannot read them.
  const client = createClient(config.supabaseUrl, config.publishableKey, {auth: {
    detectSessionInUrl: false, persistSession: true, autoRefreshToken: true,
    storage: window.localStorage, storageKey: 'ob-account-auth'
  }});
  let mode = 'signup', pendingEmail = '', busy = false, captchaToken = '', widget = null, nextSendAt = 0;
  const message = text => { $('status').textContent = text; };
  const ready = () => {
    const waiting = Date.now() < nextSendAt;
    $('submit').disabled = busy || !captchaToken || (mode !== 'verify' && waiting);
    $('resend').disabled = busy || !captchaToken || waiting;
    for (const id of ['mode-signup', 'mode-login', 'change-email', 'sign-out']) $(id).disabled = busy;
  };
  const resetCaptcha = () => {
    captchaToken = '';
    if (widget !== null) window.turnstile.reset(widget);
    ready();
  };
  function setMode(next) {
    mode = next; $('code').value = ''; message('');
    $('signed-in').hidden = true; $('auth-panel').hidden = false;
    const verify = next === 'verify';
    $('form-title').textContent = verify ? 'Check your email' : next === 'signup' ? 'Create your account' : 'Welcome back';
    $('submit').textContent = verify ? 'Verify and sign in' : next === 'signup' ? 'Send account code' : 'Send sign-in code';
    $('email').readOnly = verify;
    for (const id of ['code', 'code-label', 'code-help', 'resend', 'change-email']) $(id).hidden = !verify;
    $('code').required = verify; $('code').disabled = !verify;
    document.querySelector('.modes').hidden = verify;
    for (const id of ['signup', 'login']) $(`mode-${id}`).setAttribute('aria-pressed', String(next === id));
    resetCaptcha();
    if (verify) $('code').focus();
  }
  async function showVerifiedUser() {
    const {data, error} = await client.auth.getUser();
    if (error || !data.user?.email_confirmed_at) {
      await client.auth.signOut({scope: 'local'});
      setMode('login'); message('Please verify your email and sign in again.'); return false;
    }
    pendingEmail = ''; $('code').value = '';
    $('user-email').textContent = data.user.email || 'Verified account';
    $('signed-in').hidden = false; $('auth-panel').hidden = true; message(''); return true;
  }
  let creatingAccount = true;
  async function sendCode(email, shouldCreateUser) {
    const {error} = await client.auth.signInWithOtp({email, options: {shouldCreateUser, captchaToken}});
    if (error) throw error;
    pendingEmail = email; creatingAccount = shouldCreateUser;
    nextSendAt = Date.now() + 60000;
    setTimeout(ready, 60100);
    setMode('verify');
    message('If this address can receive an account email, a code is on its way. Check your inbox and Junk folder. Use the most recent code. You can request another in one minute.');
  }
  $('unavailable').hidden = true; $('privacy').hidden = false;
  $('support').textContent = config.supportEmail; $('support').href = `mailto:${encodeURIComponent(config.supportEmail)}`;
  for (const next of ['signup', 'login']) $(`mode-${next}`).addEventListener('click', () => { if (!busy) { pendingEmail = ''; setMode(next); } });
  $('change-email').addEventListener('click', () => { if (!busy) { pendingEmail = ''; setMode(creatingAccount ? 'signup' : 'login'); } });
  client.auth.onAuthStateChange(event => {
    // Do not await Auth here: the SDK holds a session lock.
    if (event === 'SIGNED_OUT') { pendingEmail = ''; $('user-email').textContent = ''; setMode('login'); }
  });
  async function perform(action) {
    busy = true; ready(); message('Working…');
    try { await action(); }
    catch (error) { message(authMessage(error)); }
    finally { $('code').value = ''; busy = false; resetCaptcha(); }
  }
  $('account-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !captchaToken) return;
    if (mode === 'verify') {
      const token = $('code').value.trim();
      if (!pendingEmail || !codeValid(token)) { message('Enter the numeric code from your latest email.'); return; }
      await perform(async () => {
        const {error} = await client.auth.verifyOtp({email: pendingEmail, token, type: 'email', options: {captchaToken}});
        if (error) throw error;
        await showVerifiedUser();
      });
    } else if (Date.now() >= nextSendAt) {
      const email = $('email').value.trim(), shouldCreateUser = mode === 'signup';
      await perform(() => sendCode(email, shouldCreateUser));
    }
  });
  $('resend').addEventListener('click', async () => {
    if (busy || !captchaToken || !pendingEmail || Date.now() < nextSendAt) return;
    await perform(() => sendCode(pendingEmail, creatingAccount));
  });
  $('sign-out').addEventListener('click', async () => {
    if (busy) return;
    busy = true; ready();
    try {
      const {error} = await client.auth.signOut({scope: 'global'});
      if (error) throw error;
      setMode('login'); message('You’re signed out.');
    } catch { message('We could not sign you out. Check your connection and try again.'); }
    finally { busy = false; ready(); }
  });
  setMode('signup');
  const {data} = await client.auth.getSession();
  if (data.session) await showVerifiedUser();

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
  script.addEventListener('load', () => {
    try {
      widget = window.turnstile.render('#security-check', {
        sitekey: config.turnstileSiteKey, theme: 'dark', size: 'flexible',
        callback: token => { captchaToken = token; ready(); },
        'expired-callback': () => { captchaToken = ''; ready(); },
        'error-callback': () => { captchaToken = ''; ready(); message('The security check could not load. Refresh this page to try again.'); }
      });
    } catch { message('The security check is unavailable. Please try again later.'); }
  });
  script.addEventListener('error', () => message('The security check could not load. Refresh this page to try again.'));
  document.head.append(script);
}
