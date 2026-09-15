# Game statistics archive

Each score card opens `game.html?game=YYYY_WW_AWAY_HOME`. Available team stats are compared side by side; player stats are grouped by passing, rushing, receiving, defense, kicking, punting, returns, fantasy and other fields. All source statistical columns have a display group and remain available in the game JSON download.

The first archive covers the 16 played regular-season games of 2026 Week 1. Pending games show their schedule/score but do not invent box-score statistics. Archive links keep working across the season rollover.

## Data sources

- [nflverse week-level player stats](https://github.com/nflverse/nflverse-data/releases/tag/stats_player): 150 columns in the initial 2026 release.
- [nflverse week-level team stats](https://github.com/nflverse/nflverse-data/releases/tag/stats_team): 138 columns in the initial release.
- [CC BY 4.0 license](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md). OutlierBaseline groups regular-season rows by game, normalizes team aliases and converts empty cells to null while preserving raw sources.

These releases are not live. They normally update after game days, with additional game-day updates and subsequent corrections. The archive workflow collects at midnight, 6 a.m., noon and 6 p.m. America/New_York, on the same cadence as site data. GitHub scheduling and source availability are best effort. No paid API calls or credentials are introduced.

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
