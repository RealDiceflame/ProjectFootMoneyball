# Source access and remaining limitations

Reviewed 2026-09-28. A successful collection job does not prove that every provider is current. Read the provider entries in `docs/data/update_status.json`, including the sampling window and capture date.

## Yahoo ADP: owner approval and authorization required

Yahoo's current [access application](https://sports.yahoo.com/developer/access/) requires a reviewed use case and currently offers read-only access. The owner must submit the application, describe this public website and its intended data display, and accept Yahoo's terms themselves. Approval is not assumed.

The official [Fantasy API documentation](https://sports.yahoo.com/developer/docs/) describes OAuth 2.0 and a player `draft_analysis` resource with average pick, average round, and percent drafted. An approved application and user authorization are needed before an authenticated adapter can be exercised. The existing site does not contain that adapter or a Yahoo OAuth token-storage flow; adding a generic API-key secret would not enable it.

Until access is approved and a secure server-side OAuth integration is built and tested, use the existing authorized CSV import:

```powershell
python refresh_draft_board.py --yahoo-snapshot "PATH-TO-FILE.csv" --keep-stats --skip-workbook
```

The CSV must contain Player/Name, Position/Pos, and Yahoo/Y! columns. Import dates are snapshot capture dates, not Yahoo publication timestamps. The scheduled job intentionally retains this manual snapshot. Do not work around authorization by scraping protected pages or copying browser tokens.

## MyFantasyLeague: recent drafts and season aggregates differ

The official [MFL API reference](https://api.myfantasyleague.com/2026/api_info?STATE=details) documents `PERIOD=RECENT` and `PERIOD=ALL` as distinct current-season ADP windows. `PERIOD` does not apply to previous seasons. This adapter requests 12-team PPR redraft leagues, actual plus mock drafts, and a 5% draft-selection cutoff. These filters do not establish a specific starting-QB count, PPR amount, or TE premium.

A valid recent response with no player entries and `totalDrafts=0` means no recent qualifying drafts, not a broken HTTP endpoint. Only that case triggers one `ALL` request with identical league filters. A valid, sufficiently complete aggregate is labeled `status=fallback`, `freshness=season_aggregate`, and `actual_period=ALL`; CSVs preserve `MFL_Period` and `MFL_Source`. The capture date records the new download, not new recent draft activity or the provider's publication time.

Transport errors, malformed recent responses, or insufficient samples never trigger a broader window. If either attempted window fails validation, the existing per-provider fallback retains its last-good values, original capture date, and sampling window. Both skill-position and K/DST refreshes follow this rule. A legacy CSV without window evidence is labeled unknown, not guessed. Manual Yahoo imports and skipped ADP refreshes preserve MFL's saved window. Neither MFL window is guaranteed to be a preseason-only snapshot, so a model must not silently treat the season aggregate as recent market evidence or a leakage-free preseason baseline.

## Licensed sportsbooks: existing adapters need owner-supplied keys

The published health report completed at `2026-09-28T04:26:10+00:00` reported both licensed providers as `not_configured`. This describes the scheduled job's environment, not a search of anyone's local secrets. Kalshi, Polymarket, and nflverse reference lines remain separate products, not substitutes labeled as licensed sportsbook quotes.

The GitHub workflow already passes these repository secrets to the private updater:

| Provider | GitHub Actions secret | Existing behavior |
| --- | --- | --- |
| The Odds API | `ODDS_API_KEY` | Primary NFL moneyline, spread, and total comparisons |
| SportsGameOdds | `SPORTSGAMEODDS_API_KEY` | Backup when the primary is absent, fails, or has no matching upcoming markets |

The owner must choose a plan, confirm NFL/bookmaker coverage and public-display rights, and store the key through **Settings → Secrets and variables → Actions**. Never paste keys into chat, commit them, or place them under `docs/`. The empty names in `.env.example` are documentation; the updater reads environment variables and does not automatically load that file. No Yahoo, sportsbook, or AI account is created by the updater.

[The Odds API v4 guide](https://the-odds-api.com/liveapi/guides/v4/) requires a subscription key and charges quota by market and region. This adapter requests three markets in one region: up to three credits per normal odds request, about 360 credits over 30 days at four runs daily, before retries or manual runs. Empty-market requests and provider billing rules may reduce that amount. Check the current plan and quota before enabling the secret.

[SportsGameOdds setup](https://sportsgameodds.com/docs/basics/setup) requires a key and currently advertises an Amateur free plan; its signup may still request payment details. The owner must complete any signup and decide whether its coverage and terms are suitable. The adapter sends its key in a private header. The documented [response envelope](https://sportsgameodds.com/docs/basics/cheat-sheet) must report `success: true` before data is accepted. Rejected or malformed responses retain last-good upcoming rows with their original timestamps; a successful empty result is labeled as no upcoming markets instead.

After owner setup, an authorized normal refresh can verify the published provider status. `not_configured` should change to a completed check, a working backup, no upcoming markets, or an explicit failure. Merely storing a key does not guarantee permission, coverage, available markets, or a successful connection.
