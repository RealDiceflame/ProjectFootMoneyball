# Game statistics archive

Each score card opens `game.html?game=YYYY_WW_AWAY_HOME`. Available team stats are compared side by side; player stats are grouped by passing, rushing, receiving, defense, kicking, punting, returns, fantasy and other fields. Every player category shows away players on the left and home players on the right, with team headers repeated for clarity; narrow screens stack away then home. Stats sections stay expanded, including the complete team comparison below the player groups. Tables have no capped internal vertical scroll; wide tables retain horizontal scrolling with the player name pinned. All source statistical columns have a display group and remain available in the game JSON download.

The archive supports the current season and completed regular seasons from 2016–2025. Pending games show their schedule/score but do not invent box-score statistics. Archive links keep working across the season rollover. Historical seasons are labelled as corrected archives, and their collection date is not presented as the date the statistics became available.

## Data sources

- [nflverse week-level player stats](https://github.com/nflverse/nflverse-data/releases/tag/stats_player): 150 columns in the initial 2026 release.
- [nflverse week-level team stats](https://github.com/nflverse/nflverse-data/releases/tag/stats_team): 138 columns in the initial release.
- [CC BY 4.0 license](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md). OutlierBaseline groups regular-season rows by game, normalizes team aliases and converts empty cells to null while preserving raw sources.

These releases are not live. The [maintainer’s update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) describes nightly updates after game days, selected game-day updates, and subsequent corrections. The archive workflow collects at midnight, 6 a.m., noon and 6 p.m. America/New_York, on the same cadence as site data. GitHub scheduling and source availability are best effort. No paid API calls or credentials are introduced.

Possession time, third/fourth-down conversions, snap counts and play-by-play are absent from these releases. We do not substitute estimates for those fields. Player records describe recorded statistics, not every active player. Anonymous events are explicitly labeled; they are not assigned invented player IDs or added to team totals.

## Durable storage and corrections

- `data/game_stats/YEAR/players.csv` and `teams.csv` retain complete original responses, including all fields. Git retains prior committed versions; these are not temporary files or browser storage.
- `provenance.json` records source URLs, retrieval times, HTTP last-modified values (when supplied), and SHA-256 content hashes. Git attributes preserve the exact downloaded CSV bytes.
- `docs/data/game_stats/YEAR/GAME_ID.json` contains compact typed rows plus source provenance, first collection time, latest changed time and a content hash. Unchanged games are not rewritten just to appear fresh.
- A yearly index lists archived games; the top-level catalogue retains prior seasons. Refreshes do not delete historical years.
- Games join directly by game ID, with season, season type, week, team and opponent checked. Named players retain their source GSIS identifiers; duplicate names are never used as join keys.
- Empty/invalid responses, unknown fixtures, incomplete team pairs, lost games, dropped columns or malformed numeric values stop publication. Zero, negative yards, half-sacks, nulls and distance lists remain distinct.
- Legitimate player-credit corrections are accepted and changes to credited IDs are recorded. Earlier rows remain recoverable through Git history.

For future predictions, simulations and fantasy research, use the archived observed stats as inputs only after adding and testing the desired model features. Existing models are not automatically retrained by this feature. Avoid look-ahead bias: the current corrected archive was not known before `first_collected_at`; use the appropriate committed data vintage for historical backtests. The archive begins with this implementation, not with invented earlier collection dates.

## Refresh and validation

Run `python update_game_stats.py`, or Actions → Update game stats → Run workflow. The Python collector needs no extra packages. It requires the saved scoreboard for the same regular season, and validates all downloaded rows before writing. CI commits files only after successful collection; it separately checks publication so a previously failed deployment can be retried.

Tests: `python -m pytest tests/test_game_stats.py` and `node --test tests/game_data.test.mjs`.


## Historical weekly backfill

Run `python backfill_game_stats.py --start-season 2016 --end-season 2025`, or use
Actions → **Backfill historical weekly stats**. The workflow seeds the ten seasons
when installed and otherwise supports explicit bounded reruns. Current-season
collection remains on its existing schedule.

The importer fetches one historical schedule and the complete weekly player/team
files for each requested year. It validates every requested season before writing
any new archive files, writes the catalogue last, and preserves the current
scoreboard and current-season selection. All offensive, defensive, kicking,
punting and return fields supplied by the source are retained. Raw CSVs retain
regular-season and postseason records; the public box scores and league leaders
currently expose regular-season games only. Postseason views need a separate
season-type contract before they can be published or imported into the database.

Completeness requires 256 games for 2016–2020, 272 for 2021 and 2023–2025, and 271
for 2022. The cancelled `2022_17_BUF_CIN` fixture is the sole explicit no-contest
exception; arbitrary missing games or scores fail validation. The data includes
reported historical venue, roof, weather, surface and head-coach fields when
provided by the schedule. Missing fields stay unknown.

The statistical source sometimes uses modern LV/LAC franchise codes for games
whose IDs still use OAK/SD. An explicit franchise mapping resolves each side to
its verified game fixture; the historical game ID remains unchanged. A missing
opponent can be recovered only from an exact game and one of its valid teams.
The original downloaded bytes preserve those source conventions and omissions.
Known player IDs must be valid and unique per game; anonymous events stay
team-scoped. No name-based player matching is used.

`historical: true` distinguishes completed archives from the periodically
refreshed current-season feed. Old archive check times are not reported as live
feed outages. Historical pages retain their season/week when navigating between
results, league leaders and individual box scores. Recollecting unchanged games
preserves their original collection/update timestamps.

Weekly box scores are the first data layer. Snap-count/participation joins and
play-by-play features are separate follow-up layers; no snap counts, routes,
blocking/coverage grades or continuous live scoring are claimed by this import.
Backtesting must distinguish today’s corrected historical records from the
information that was available before each game.
