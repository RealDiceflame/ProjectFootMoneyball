# Website data reliability

There are two different updates: collecting data on the server, and showing that
published data in an already-open browser. Neither means every upstream source
has produced new information.

## Collection and publishing

The existing GitHub schedule attempts a site-data refresh at midnight, 6 a.m.,
noon and 6 p.m. America/New_York. The score feed has its own faster game-window
schedule. GitHub schedules and provider availability are best effort.

Each collection stage keeps its last good files when a refresh fails. Public
`data/update_status.json` separates execution status from source health:

- **Success**: a successful request/check, not a guarantee of a newly published
  statistic. A source's own data timestamp remains separate.
- **Manual**: Yahoo ADP requires an intentional import.
- **Historical**: a completed-season archive, not a live feed.
- **Not configured / not needed / no upcoming markets**: an intentional
  unavailable feed, an unused backup, or an empty successful market response.
- **Fallback**: a working backup supplied the saved data.
- **Cached / failed / behind / unavailable / unknown**: the source needs
  attention or freshness cannot be confirmed. Previous dates are not replaced
  with the time of a failed request.

Provider diagnostics are visible in the existing collapsed **Data refresh**
section. They contain no credentials or raw request exceptions.

## Already-open pages

Rankings, Kicker & D/ST, odds and the labs check the small publication manifest
once a minute while visible. They download their larger files after a new
publication and at least every 15 minutes as a fallback for manually changed
snapshots. A missing manifest falls back to direct snapshot checks. Requests
have a timeout, do not overlap, and retry after failure.

Updates preserve filters, sorting, drafted players, imported ADP and league
settings. An open rankings dialog defers its update. Lab updates preserve picks,
seeds and existing simulation results; they label older results and require an
explicit rerun instead of silently changing the simulated outcome. Survivor
season changes require a reload to avoid carrying picks into a new season.

Malformed snapshots do not replace the last working display. Score, game,
stats and homepage feeds retain their existing independent polling.
Browsers request saved public files, never private provider APIs.

## Injury reports

A latest-ever report is not necessarily a current report. Current status
requires a matching season and schedule-derived NFL report week, a valid report
window, and a sufficiently recent successful snapshot. Carried-forward reports,
older weeks and unavailable context are history or unknown current health.
An absent report never proves that a player is healthy.

Only current Out, Doubtful or injured-reserve designations can create injury
risk. Questionable, Probable and practice participation alone cannot. Other
non-injury news can still identify risk. Existing reports remain visible with
their season/week and historical label.

## Checks before publishing

`Test website reliability` runs unit tests, provider failure-path tests, browser
refresh tests and mobile navigation checks on website code changes and pull
requests. Tests use local fixtures and do not consume paid provider requests.

```sh
python -m pytest tests/test_player_news.py tests/test_site_refresh.py tests/test_adp_importer.py tests/test_odds_board.py tests/test_web_exporter.py tests/test_publish_scoreboard.py -q
node --test tests/*.test.mjs
BROWSER_CHANNEL=chromium node --test tests/*.browser.mjs
```

Browser tests require Playwright with Chromium installed. WebKit touch-navigation
checks run separately in CI. This workflow reports failures; it does not configure
GitHub branch protection or make Pages deployment wait for a passing test run.

This is a reliability foundation, not a production account system. Private
database activation, authenticated hosted leagues, provider licenses and game-day
collection changes are separate work.
