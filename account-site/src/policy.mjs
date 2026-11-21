export const ACCOUNT_ORIGIN = 'https://accounts.outlierbaseline.com';
export const AUTH_ORIGIN = 'https://qkjilmduizxsytylbkxx.supabase.co';

export function configErrors(config) {
  const errors = [];
  if (config.origin !== ACCOUNT_ORIGIN) errors.push('Use the dedicated account origin.');
  if (config.supabaseUrl !== AUTH_ORIGIN) errors.push('Unexpected authentication project.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey || '')) errors.push('A public publishable key is required.');
  if (!/^0x[\w-]{10,}$/.test(config.turnstileSiteKey || '')) errors.push('A production Turnstile site key is required.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.supportEmail || '')) errors.push('A public support email is required.');
  return errors;
}

export function canStart(config, origin) {
  return config.enabled === true && origin === ACCOUNT_ORIGIN && configErrors(config).length === 0;
}

export const codeValid = value => /^[0-9]{6,10}$/.test(value);

export function authMessage(error) {
  if (error?.status === 429 || error?.code === 'over_request_rate_limit' || error?.code === 'over_email_send_rate_limit') {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (error?.code === 'captcha_failed') return 'The security check expired. Please complete it again.';
  if (error?.code === 'otp_expired') return 'That code could not be used. It may be expired, already used, or replaced. Request a new code.';
  return 'We could not complete that request. Check your details and try again, or contact account support.';
}

export const securityHeaders = {
  'Content-Security-Policy': `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src ${AUTH_ORIGIN} https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests`,
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow'
};
