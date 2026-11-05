# Weekly snap participation

Snap counts are a separate, source-attributed participation dataset. They do not change a player's box-score totals, fantasy scoring, or the database checksum contract. The browser loads `docs/data/snap_counts/{season}/{game_id}.json` alongside the existing box score.

## Source and identity

- nflverse's `snap_counts/snap_counts_{season}.csv` release contains PFR offensive, defensive and special-teams snaps and fractions (0–1).
- The nflverse `players/players.csv` file provides explicit PFR-to-GSIS links. No name-only join is used. Ambiguous or missing links keep `player_id: null` and a `mapping_status`; the original PFR identity and participation remain available.
- NFL game IDs are checked against the schedule's exact PFR game ID, season, week, team and opponent. Modern franchise labels resolve to the historical game sides, such as Oakland and San Diego.
- Players who recorded snaps but no box-score statistics remain visible, including offensive linemen. A missing snap row means unknown participation. It must never be interpreted as DNP, inactive, or zero.

## Import and validation

```sh
python update_snap_counts.py --start-season 2025 --end-season 2025
python update_snap_counts.py --start-season 2016 --end-season 2026
python update_snap_counts.py  # Current season from scores.json
```

The importer supports 2016–2026. Every requested season is downloaded and validated before any publication writes. Historical seasons require all completed regular-season games; 2022 excludes the officially cancelled BUF–CIN game. Current-season coverage is measured against scored, past fixtures, and missing games are explicitly listed. Each reported game requires both teams. Previously published games or participants cannot silently disappear; a removal fails the import for correction review. Invalid schema, duplicate players, conflicting game identity, invalid numbers, fractional counts and out-of-range percentages fail validation.

A complete game-coverage report means source rows exist for all expected games, **not** that every rostered player's participation or identity is known. Null numbers remain null; an explicit source zero remains zero. Percentages use the source's rounded fractions and are not recomputed from box scores.

Each season's `index.json` records expected/reported games, missing game IDs, source and mapped row counts, and the number of unmatched player identities. `unmatched.json` retains each unresolved PFR ID and its game appearances for review. The JSON sidecar includes `schema_version`, `season`, `game_id`, `players`, `coverage`, `content_sha256`, `updated_at`, and `sources`. Per-player fields are:

`pfr_player_id`, `player_id`, `player_name`, `position`, `team`, `mapping_status`, `offense_snaps`, `offense_pct`, `defense_snaps`, `defense_pct`, `st_snaps`, `st_pct`.

## Provenance and limits

Original CSV and compressed schedule bytes are saved under content-addressed paths in `data/snap_counts/sources/`. Each season's provenance records SHA-256, URL, HTTP modification time and collection time. Original files retain postseason records, while public sidecars expose **regular season only**. Separate postseason views remain future work. Rerunning unchanged source bytes leaves the output stable. Changed source bytes keep their own immutable files; Git records prior artifact versions.

The data represents corrected historical or delayed participation. It is not a continuous live scoring feed and must not be described as information available before kickoff. Historical projections/backtests require independently preserved point-in-time inputs. Snap counts alone do not establish injury, inactive status, routes, blocking quality, coverage assignments or player performance.

Run `python -m pytest tests/test_snap_counts.py -q` for identity, coverage, provenance and failure-retention regressions.

### Reviewed source corrections

The 2021 download reports a special-teams percentage of `1.01` (101%) for A.J. Moore and Tremon Smith in `2021_13_IND_HOU`, and Michael Hoecht in `2021_15_SEA_LA`. These three exact `(season, game, PFR player, field, source value)` exceptions retain their valid snap counts but publish `st_pct: null`, with a `data_issues` entry carrying the original value and reason. Their raw CSV bytes remain unchanged. A season-level `source_issues.json` and issue counts in the game/season coverage summaries make the omissions inspectable. These values are not clamped or recalculated. Any other out-of-range percentage still fails validation; an upstream corrected percentage will import normally.
