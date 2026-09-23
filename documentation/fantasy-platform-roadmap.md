# OutlierBaseline fantasy platform

## Product direction

One **My Leagues** hub supports two eventual modes:

- **Hosted leagues:** people create and play their leagues on OutlierBaseline.
- **Connected leagues:** people view existing outside leagues and use OutlierBaseline for draft preparation, draft assistance and lineup recommendations.

Do not describe a local setup or external league import as a shared/hosted league. Do not promise automated lineup submission for a read-only integration.

## Implemented foundation

`docs/fantasy.html` is an explicitly labeled local prototype. It supports multiple saved league setups, 8/10/12/14/16 teams, team names, PPR, additive TE premium, passing-TD preferences, and QB/RB/WR/TE/FLEX/superflex/K/DST/bench/IR slot counts. Settings do not yet change the rankings board, calculate scores, or assign players.

`docs/fantasy-leagues.mjs` owns the versioned schema, validation, setup creation, edits and backup import. The page handles forms and persistence, not the rules. League and team IDs are stable through edits; importing a backup creates independent IDs. Unknown properties are discarded, malformed/future-version data is not silently overwritten, and a stale browser tab cannot overwrite another tab's saved changes. Draft markers and other existing browser storage are untouched.

This is not account security: local storage is editable and visible to users of that browser profile. No passwords, tokens, payment details or real account ownership should be stored here. There are no external connections or write calls in this prototype.

## Next useful milestone: accounts and read-only league hub

1. Choose a backend hosting/database/authentication setup before deploying shared features or buying services. Keep the current analytics site and domain; a private API can be separate from the static frontend.
2. Add users, memberships, leagues, seasons, teams, scoring rules and roster-slot definitions. Validate on the server, not only in browser forms. A user must only access private leagues they belong to.
3. Add provider connections behind capability flags: `read_leagues`, `read_rosters`, `read_draft`, `read_scores`, `write_lineup`. Deny unsupported capabilities rather than displaying nonfunctional controls. Do not infer commercial licensing from technical access.
4. Start with authorized, read-only imports. Show provider, last successful sync, stale-data warnings, actual scoring/eligibility settings and all owned teams in one dashboard. Keep the last-good snapshot on failures; obey rate limits and cache data.
5. Map provider player IDs to stable canonical NFL player IDs. Keep `(provider, provider_player_id)` mappings separate from names; reject ambiguous same-name matches. Unmatched IDs stay explicitly unmatched.
6. Use actual rosters, eligibility, scoring and roster needs for draft/lineup assistance. Upcoming weekly player projections and reliable game/lock timestamps are prerequisites; season averages are not a production weekly lineup model.

## Hosted league progression

After accounts and permissions: commissioner creation and invitations → authoritative shared draft room → roster/lineup management → scored weekly matchups/standings → waivers/trades/playoffs.

- Draft picks and roster changes need database transactions, idempotency and a server-side clock; two users cannot draft the same available player.
- Enforce commissioner/member permissions, lineup eligibility, per-game locks and roster ownership on every write.
- Scoring needs versioned stat inputs, complete rules (including K/DST if enabled), correction handling and auditable recalculation. Do not advertise live scoring from six-hour snapshots.
- Dynasty/keepers, auction drafts, public matchmaking and payments are later scope, not implied by this prototype.

## Provider access checkpoints (reviewed 2026-09-13)

- [Sleeper official API](https://docs.sleeper.com/): read-only league, draft and roster access; no lineup submission. Documentation describes free non-commercial use and asks commercial applications to discuss licensing. Confirm intended usage before adding a commercial connection.
- [Yahoo API overview](https://developer.yahoo.com/api/) and [server-side OAuth guide](https://developer.yahoo.com/oauth2/guide/flows_authcode/): protected access through OAuth. Obtain application access and verify permitted fantasy operations/scopes before implementing an adapter. A write capability is **not yet verified for this application**. The detailed fantasy guide could not be fetched during this review, so no lineup-write support is assumed.
- Other providers: no undocumented endpoint scraping or password/session-cookie collection as an integration shortcut. Add only after the permitted use and capabilities are established.

For any future permitted lineup write: request the minimum permissions, store encrypted refresh credentials server-side, re-fetch roster/locks before submission, show the proposed changes for confirmation, log the result without tokens, and support disconnect/revocation. Do not silently enable recurring lineup changes.

## Checks

`node --test tests/fantasy_leagues.test.mjs` tests validation and persistence payloads. `node --test tests/navigation_and_fantasy.browser.mjs` uses Playwright for desktop hover, keyboard, mobile tap, create/edit/reload, backup round-trip, invalid data and stale-tab behavior. Navigation checks cover all 13 destinations, touch focus loss, category switching, phone menu dismissal and responsive resizing. Install Playwright for browser checks or provide its module through `PLAYWRIGHT_MODULE`; `BROWSER_CHANNEL` defaults to `msedge` (`chromium` uses the bundled Chromium build). Set `BROWSER_ENGINE=webkit` to run the same checks with Playwright's installed WebKit engine; this is browser emulation, not a physical iPhone test. Use `--test-name-pattern="desktop hover|keyboard links|mobile navigation"` to run just navigation checks.

Windows Playwright WebKit skips ordinary links with Tab even without navigation code. Its focus-management checks explicitly focus the first link, then verify Escape and Tab exit; Chromium checks the actual Tab entry order. Touch checks use real browser taps in both engines.
