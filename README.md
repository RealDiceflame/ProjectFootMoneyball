# OutlierBaseline

## Use the web draft board

Open <https://outlierbaseline.com/> in any modern browser. The website supports every team-count, QB, PPR, and TE-premium ranking combination, persistent drafted-player markers, column filters, sorting, CSV export, rookie and current-injury labels, source-linked player intel, and up to ten completed seasons of year-by-year player stats. Click a player name to see current roster status, depth position, material arrivals/departures, injury data, matched ESPN RSS headlines, format-aware scoring charts, an age-adjusted season projection, and historical performance. The Projection Lab plots every qualifying player-season by age and position, overlays the selected player, summarizes positional scoring standard deviation, and maps expected season points by position and ADP round. Age Curve v1 uses the full 2016–2025 history for position aging and uncertainty, while weighting each player's latest three seasons 5:3:2 so old production does not overpower recent form. It learns bounded position-specific age changes from consecutive seasons, estimates games from recent availability, and displays a one-standard-deviation range. Historical fantasy points recalculate for the selected PPR and TE-premium settings. Public ADP is limited to the supported Sleeper and MyFantasyLeague feeds plus the manually maintained Yahoo snapshot. Every available provider value remains visible on every board; only a provider that lacks a player is blank. Sources and ADP SD show evidence count and standard deviation. A filterable 0–100 volatility index combines season-to-season scoring variation (70%) with relative ADP disagreement (30%), using only the available component when the other lacks enough evidence. Imported data stays in that browser, works across league settings, and is never uploaded. Separate Kicker & D/ST and Weekly Odds pages cover special-teams ADP and upcoming NFL game markets. Desktop downloads remain available under GitHub Releases.

## Automatic site updates (no API key)

The 2016–2025 player archive includes the current board plus historical QB/RB/WR/TE players with regular-season stats since 2020. This covers recent career endings, including a final 2020 season followed by departure in 2021. Each selected player's available seasons back to 2016 are retained. Historical entries are labeled by last recorded season, not presumed retirement status; they include retired players, free agents, and other players outside the board. nflverse's player identity file supplies birth dates through stable GSIS IDs. Position changes retain the position for each recorded season. Unknown birth dates are excluded from age curves but their statistics remain available.

In the Projection Lab player selector, **Historical players** highlights archived seasons and displays past production instead of a future projection. The model learns from the expanded archive independently of who is on today's board. Historical players never enter current rankings, VORP replacement pools, or ADP rounds. Age curves require at least four games; year-over-year aging changes require six games in both consecutive seasons. The model still conditions on players who appeared in those seasons: missing seasons after retirement are not invented as zero-point results, and the displayed range is not a calibrated probability interval. Personal projections retain the latest-three-season 5:3:2 weighting.

`python update_player_history.py --historical-lookback 5` maintains this recent historical pool on the normal schedule. The cutoff is `end_season - historical_lookback`, and source-download failures leave the previously published archive intact.

The factual timeline uses public nflverse roster, depth-chart, and weekly injury releases plus matched headlines from ESPN's official NFL RSS feed. Players are joined by stable NFL ID when available, with name plus position as the fallback; ambiguous same-name headlines are skipped instead of guessed. All current primary and secondary injuries appear in the rankings. Questionable and probable designations remain visible without changing the market-based draft tag, while Out, Doubtful, injured-reserve, suspension, and exempt-list situations become RISK. It does not call ESPN's undocumented injury endpoint, copy Rotoworld blurbs, or require an AI key.

Rotoworld/NBC does not publish a documented public API for third-party republication. Yahoo documents RotoWire—not Rotoworld—as a fantasy data partner. RotoWire has a licensed API for news and injuries, but its key must stay in a private server or GitHub Actions secret and must never be embedded in this public GitHub Pages site. The current feed therefore keeps using source-linked public factual data unless an authorized content license is added.

The website refreshes Sleeper half-PPR and MyFantasyLeague recent-redraft ADP, the separate Kicker & D/ST market, all 60 rankings, the factual player-news timeline, ten-season player history, and the weekly NFL odds board every day at midnight, 6 a.m., noon, and 6 p.m. Eastern time. Yahoo's official developer access requires approval and OAuth, so the updater keeps the manually maintained Yahoo snapshot instead of scraping a protected page or erasing that column. ESPN ADP is not published until explicit API access is in place. The freshness line above the board shows the date for each source.

Run the complete update locally:

```powershell
python refresh_draft_board.py --keep-stats
python update_player_history.py
```

You can also open **Actions → Update site data → Run workflow** on GitHub at any time. The scheduled workflow handles daylight-saving changes automatically and publishes changed ADP, rankings, and news files to the website.

## Weekly odds board

`odds.html` starts with upcoming nflverse schedules and consensus reference lines, public NFL contracts from Kalshi and Polymarket, and source-linked team logos. Polymarket's public Gamma API supplies the prediction-market panel and each matchup's main moneyline, spread, and total. It does not scrape DraftKings, FanDuel, or another sportsbook website.

To add licensed comparisons from DraftKings, FanDuel, BetMGM, Caesars, and other supported books:

1. Create a key at <https://the-odds-api.com/>.
2. In GitHub, open **Settings → Secrets and variables → Actions**.
3. Create a repository secret named `ODDS_API_KEY`.
4. Open **Actions → Update site data → Run workflow**.

The Odds API is the primary licensed feed. For automatic backup coverage, create a SportsGameOdds key at <https://sportsgameodds.com/> and add it as a second repository secret named `SPORTSGAMEODDS_API_KEY`. The updater calls the backup only when the primary key is absent, the primary request fails, or it returns no events.

Both keys stay in GitHub Actions and are never published to the browser. Best-line badges compare only the licensed sportsbook rows. Kalshi, Polymarket, and nflverse consensus remain clearly labeled as different product types. Do not resell the raw feeds, and keep the responsible-gambling notice on the page.

To refresh locally after setting `ODDS_API_KEY` as an environment variable:

```powershell
python update_odds_board.py
```

## Update AI player intel

The public website never receives an OpenAI API key. A private GitHub Action researches the latest role changes, arrivals, departures, injuries, and value-changing news, then publishes date-stamped reports to `docs/data/player_intel.json`.

One-time setup:

1. Create an OpenAI API key with API billing enabled.
2. In this GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Choose **New repository secret**, name it `OPENAI_API_KEY`, and paste the key there.
4. Open **Actions → Update player intel → Run workflow**.
5. Start with 50 players. Run it again for the next stale group, or enter one exact player name for a focused update.

The action commits successful reports back to the website automatically. OpenAI API usage is billed separately from a ChatGPT subscription, and web searches can add tool-call costs. Reports include clickable sources and should be checked before making a draft decision.

To update locally after setting `OPENAI_API_KEY` as an environment variable:

```powershell
python update_player_intel.py --limit 50
python update_player_intel.py --player "Josh Allen"
```

A football-intelligence application that combines NFL season stats, position-specific aging, expected availability, rookie betting-line projections, and three-source market ADP. It produces interactive rankings for 8–16 teams, 1QB/2QB, Standard/Half/Full PPR, and optional TE premium scoring. Market +/- shows projected fantasy points above or below the same-position regression expectation at a player's consensus ADP; VORP remains the separate comparison with the replacement player. Sources counts the available ADP feeds and Spread measures their disagreement. Draft tags use Market +/-: TARGET is +50 points, VALUE is +25 to +49.9, FAIR is -19.9 to +24.9, and REACH is -20 or worse. A current risk signal overrides the market tier with RISK; a team change with no other material update becomes NEW TEAM.

## Run the desktop application

```powershell
python -m app.desktop
```

The application displays the rankings directly. It supports drafted-player tracking, reversible column filtering, header sorting, live league-format changes, data refreshes, and Excel export. Type a filter, then press Enter or click **Apply**. **Show All** always restores the complete player pool.

## Refresh from the command line

Reuse the saved stats while refreshing the supported ADP feeds:

```powershell
python refresh_draft_board.py --keep-stats
```

When the refresh runs from the source repository, it also updates `docs/data/rankings.json` for the website. Pass `--saved-adp` only when you are offline and want to reuse every saved ADP value. Pass `--skip-workbook` for a faster website-only refresh.

The legacy manual-table importer remains available for a page or saved HTML file you are authorized to use:

```powershell
python refresh_draft_board.py --adp-source "URL-OR-PATH"
```

To promote a user-downloaded Yahoo snapshot into the site-wide default, use a CSV containing `Player` or `Name`, `Position` or `Pos`, and `Yahoo` or `Y!`. The updater replaces only Yahoo, preserves the direct public feeds, rebuilds every board, and writes the new source date:

```powershell
python refresh_draft_board.py --yahoo-snapshot "PATH-TO-FILE.csv" --keep-stats --skip-workbook
```

The workbook is written to `output/<projection season>_preseason/ProjectFootMoneyball_Draft_Board.xlsx`.

## Build the standalone Windows release

```powershell
.\scripts\build_windows.ps1
```

The script creates `releases/current/ProjectFootMoneyball-Windows.zip`. Recipients extract the complete folder and run `Project Foot Moneyball.exe`; Python is not required on their computer.

## Build the standalone macOS release

A real macOS application must be built on macOS. The **Build desktop apps** workflow under GitHub Actions creates separate ZIPs for Apple Silicon and Intel Macs, plus the Windows ZIP. Run it manually for test builds. Pushing a test tag such as `v0.2.0-beta.2` creates a pre-release. Pushing a final tag such as `v0.2.0` creates a normal release. Both attach all four downloads automatically.

The workflow also creates `ProjectFootMoneyball-All-Platforms.zip`. This is the easiest download to share: it contains all three applications and a short **START HERE** guide so the recipient can choose after downloading.

On a Mac, the same build can be run locally:

```bash
bash scripts/build_macos.sh
```

Generated spreadsheets and saved draft state are stored under `Documents/Project Foot Moneyball` on macOS.

## Active project layout

```text
config.py                         Season, league, and folder settings
main.py                           Compatibility command-line entry point
refresh_draft_board.py            Stats/ADP refresh command
update_player_intel.py             Source-linked AI player news updater
update_player_news.py              No-key roster, depth-chart, injury, and headline updater
update_odds_board.py               Weekly schedule, exchange, and licensed sportsbook updater
app/                              Desktop UI, board service, workbook export
pipeline/                         Pipeline orchestration
data_fetcher/                     Active ADP and rookie projection importers
resources/                        Column-cleaning configuration
scripts/                          Windows and macOS build tooling
.github/workflows/                Automated Windows/macOS release builds
releases/current/                 Current packaged desktop releases
stat_utils/pipeline_cleaning.py    Final dataset cleaning policy
stat_utils/data_analytics/         Fantasy scoring, regression, and rankings
tests/                            Active automated tests
archive/                          Superseded, recoverable versions
```

## Tests

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

Pytest is configured to ignore archived copies and generated build folders.

## Data sources

- NFL season totals: nflverse player-stat releases
- ADP: supported Sleeper and MyFantasyLeague feeds, plus the manually maintained Yahoo snapshot; each provider stays visible when it has a value and the consensus uses all available values
- Rookie projections: betting-line inputs blended with historical position profiles

Review each provider's usage and redistribution terms before distributing refreshed source data.
