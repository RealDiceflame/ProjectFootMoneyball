# OutlierBaseline account service

Account creation and sign-in only. No league/trade uploads, profile tables, payments, or changes to the private statistics schema. Registration is **not launched**: `config.json` deliberately has `enabled: false` and no public support address yet.

## Existing setup — continue it

The October setup already connected **Resend SMTP** to Supabase using `noreply@auth.outlierbaseline.com`. Signup-confirmation and sign-in templates were changed to email codes. The owner confirmed successful sign-in, used-code rejection, and expiry checks in October. The initial invitation went to Junk; inbox placement remains a real delivery concern. Do not replace those templates with links or create a second email provider.

On November 21, public DNS still had the sending-domain DKIM record, return-path SPF/MX records and root DMARC policy (`p=none`). DNS presence is not a current SMTP delivery test. The existing Turnstile public key is reused. Live Supabase requests with a missing or invalid CAPTCHA token were rejected with HTTP 400 / `captcha_failed`. Those probes used an invalid email address and `create_user: false`; no email was sent or account created. Auth still contains one confirmed account.

## Behavior and protections

- The official, pinned Supabase SDK requests and verifies one-time email codes. Sign-in uses `shouldCreateUser: false`; only the create-account mode allows new accounts.
- A successful `getUser()` response with verified email is required before showing an authenticated account. The page never treats browser-stored user metadata as authorization.
- Request and verification require fresh Turnstile tokens. Failed or expired checks prevent submission. A one-minute resend cooldown reduces accidental repeats; Supabase's server-side limits remain authoritative.
- Codes are held only long enough to submit; they are cleared after attempts and never saved, logged or put into URLs. Query/fragment tokens and external redirect parameters are ignored and removed before third-party code loads.
- Supabase session tokens use its standard browser storage on **accounts.outlierbaseline.com**. The main analytics site's scripts cannot access that origin's storage. There are no ads, analytics or social embeds in the account service. JavaScript on this origin can access session tokens, so preserving the strict script policy is essential.
- Sign-out requests global refresh-token revocation and clears the SDK session on success. Existing access tokens may remain valid until expiry; no private data API is exposed by this release. Future user-data features must enforce authorization in the database/server, including revoked-session behavior where required.
- The bundled `_headers` file supplies CSP (including frame protection), HSTS, no-referrer, nosniff, no-store and restricted browser permissions. These headers are for **Cloudflare Pages static hosting**, not GitHub Pages or arbitrary local servers.
- The browser config accepts only the project's public publishable key. SMTP credentials, Turnstile secrets, database passwords and service-role keys never belong here.
- All `ob_stats` tables remain private. The November audit found no SELECT grants for `anon` or `authenticated`, and all underlying tables had RLS enabled. No migration is required for accounts alone.

## Build and test

Requires Node 22+:

```sh
cd account-site
npm ci --ignore-scripts
npm run build
npm test
npx --no-install playwright install chromium webkit
BROWSER_CHANNEL=chromium npm run test:browser
BROWSER_ENGINE=webkit npm run test:browser
```

On Windows, set environment variables using PowerShell; the browser tests default to installed Edge. The output is `account-site/dist`. Tests serve a separately compiled, enabled fixture at the exact account origin with intercepted Auth and CAPTCHA requests; **no real email or account is created**. They also verify the actual disabled production bundle. These tests do not replace real delivery/registration checks.

`Test account security` builds and audits dependencies, then runs Chromium and WebKit checks on pull requests and weekly. `Security code scan` checks active Python/JavaScript code; historical `archive/` code and generated data are excluded. Dependabot proposes package/action updates for review. No updates auto-merge. Secret scanning, push protection, vulnerability alerts and automatic security-fix pull requests were enabled in repository settings on November 21.

## Complete launch configuration

1. Reopen the **existing** [Supabase SMTP settings](https://supabase.com/dashboard/project/qkjilmduizxsytylbkxx/auth/smtp) and [Resend dashboard](https://resend.com/domains). Verify the saved connection and sending-domain status without revealing or replacing credentials. Confirm current email quota/rate limits and the saved numeric-code templates.
2. Prepare a Cloudflare Pages project from this repository, root `account-site`, build `npm ci --ignore-scripts && npm run build`, output `dist`, supported Node 22+. Keep the disabled configuration during setup. Bind `accounts.outlierbaseline.com` in Pages before adding its DNS record. Preserve the existing analytics and sending-domain records.
3. Verify the existing Turnstile widget's allowed hostnames. A root hostname covers its subdomains. Before launch, restrict it to the actual account host when practical and remove the old temporary `127.0.0.1` entry. Do not rotate the saved secret casually. Use the existing Supabase CAPTCHA enforcement.
4. Review Supabase Site URL/redirects for the account origin, email confirmation, OTP expiry/length, request/verification rate limits and session settings. The current app does not use email links. Disable unused authentication providers and review password authentication exposure separately; the breached-password advisor warning is still open. Do not assume hiding a password form disables its API.
5. Select and test a **receiving** support address for help/deletion requests. The sending-only `noreply@auth.outlierbaseline.com` address is not an inbox. Add the real support address to config and review the short account-data notice, retention, deletion procedure and recovery access with the owner.
6. Verify recovery coverage for **Auth users**, not just the football archive. Keep administrator MFA enabled and verify access to recovery methods. No administrator MFA or backup configuration was changed by this work.
7. Only after those settings are verified, enable the config and test from the real HTTPS account host: new-account registration, existing sign-in, resend/cooldown, wrong/reused/expired code rejection, blocked CAPTCHA and sign-out. Have the owner enter real codes privately; do not log them. Confirm inbox/Junk behavior and investigate failures in Supabase/Resend logs without exporting credentials.
8. Verify deployed security response headers and mobile layout. Then add the account link to the analytics site's navigation. Preview hosts remain disabled even when an enabled bundle is served there.

`enabled: false` is a **website launch gate**, not a backend signup switch. Supabase's public settings currently allow registration; server CAPTCHA was verified. If backend registration must be closed, change the Auth setting in Supabase explicitly. This package has not changed that setting, any existing account, DNS, SMTP templates, or production hosting.

## Sources

- [Supabase email-code authentication](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase CAPTCHA enforcement](https://supabase.com/docs/guides/auth/auth-captcha)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Cloudflare Pages response headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Turnstile hostname scope](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [GitHub Pages hosting limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
