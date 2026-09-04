# OutlierBaseline

## Use the web draft board

Open <https://outlierbaseline.com/> in any modern browser. The website supports every team-count, QB, PPR, and TE-premium ranking combination, persistent drafted-player markers, column filters, sorting, CSV export, rookie and current-injury labels, and source-linked player intel. Click a player name to see current roster status, depth position, material arrivals/departures, injury data, and matched ESPN headlines. Desktop downloads remain available under GitHub Releases.

## Update factual player news (no API key)

The factual timeline uses public nflverse roster, depth-chart, and injury releases plus matched ESPN NFL RSS headlines. Players are joined by stable NFL ID when available, with name plus position as the fallback; ambiguous same-name headlines are skipped instead of guessed. It does not copy Rotoworld blurbs or require an AI key.

Run it locally:

```powershell
python update_player_news.py
```

Or open **Actions → Update factual player news → Run workflow** on GitHub. The workflow rebuilds `docs/data/player_news.json`, commits changed data, and publishes it to the website.

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

A fantasy-football draft-board application that combines NFL season stats, rookie betting-line projections, and Yahoo/Sleeper/NFL-ESPN ADP. It produces interactive rankings for 8–16 teams, 1QB/2QB, Standard/Half/Full PPR, and optional TE premium scoring. Market +/- shows projected fantasy points above or below the same-position regression expectation at a player's composite ADP; VORP remains the separate comparison with the replacement player. Draft tags use Market +/-: TARGET is +50 points, VALUE is +25 to +49.9, FAIR is -19.9 to +24.9, and REACH is -20 or worse. A current risk signal overrides the market tier with RISK; a team change with no other material update becomes NEW TEAM.

## Run the desktop application

```powershell
python -m app.desktop
```

The application displays the rankings directly. It supports drafted-player tracking, reversible column filtering, header sorting, live league-format changes, data refreshes, and Excel export. Type a filter, then press Enter or click **Apply**. **Show All** always restores the complete player pool.

## Refresh from the command line

Reuse the saved stats and ADP:

```powershell
python refresh_draft_board.py --keep-stats
```

When the refresh runs from the source repository, it also updates `docs/data/rankings.json` for the website. Commit and push that generated file to publish the refreshed rankings.

Refresh ADP from a comparison page URL or saved HTML file:

```powershell
python refresh_draft_board.py --adp-source "URL-OR-PATH"
```

The workbook is written to `output/<projection season>_preseason/ProjectFootMoneyball_Draft_Board.xlsx`.

## Build the standalone Windows release

```powershell
.\scripts\build_windows.ps1
```

The script creates `releases/current/ProjectFootMoneyball-Windows.zip`. Recipients extract the complete folder and run `Project Foot Moneyball.exe`; Python is not required on their computer.

## Build the standalone macOS release

A real macOS application must be built on macOS. The **Build desktop apps** workflow under GitHub Actions creates separate ZIPs for Apple Silicon and Intel Macs, plus the Windows ZIP. Run it manually for test builds. Pushing a version tag such as `v0.2.0` also creates a pre-release and attaches all four downloads automatically.

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
- ADP: normalized Yahoo, Sleeper, and NFL/ESPN comparison data
- Rookie projections: betting-line inputs blended with historical position profiles

Review each provider's usage and redistribution terms before distributing refreshed source data.
