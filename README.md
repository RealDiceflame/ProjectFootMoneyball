# Project Foot Moneyball

A fantasy-football draft-board application that combines NFL season stats, rookie betting-line projections, and Yahoo/Sleeper/NFL-ESPN ADP. It produces interactive rankings for 8–16 teams, 1QB/2QB, Standard/Half/Full PPR, and optional TE premium scoring.

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

A real macOS application must be built on macOS. The **Build desktop apps** workflow under GitHub Actions creates separate ZIPs for Apple Silicon and Intel Macs, plus the Windows ZIP. Run it manually for test builds. Pushing a version tag such as `v0.2.0` also creates a pre-release and attaches all three downloads automatically.

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
