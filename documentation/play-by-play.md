# 2025 play-by-play archive

The first release covers all 272 games of the 2025 regular season. It publishes 46,452 source events in separate per-game sidecars under `docs/data/play_by_play/2025/`. Events include plays, penalties, timeouts, and administrative markers; event totals are not snap totals. The original download also retains 2,319 postseason rows. Public postseason views and other seasons are future work.

Run `python update_play_by_play.py` to download, validate and prepare the season. `Import 2025 play-by-play` runs when its importer/workflow changes land on main and can be dispatched manually for source corrections. It validates before writing, commits the archive, and confirms Pages publication. It does not alter box-score files, current-season selection, fantasy calculations or database checksum contracts.

## Source and validation

Source: [nflverse/nflfastR play-by-play](https://github.com/nflverse/nflverse-data/releases/tag/pbp), [CC BY 4.0](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md). The importer selects and formats fields; all original source columns remain in the exact compressed download. The compressed schedule and play file are immutable, content-addressed files in `data/play_by_play/sources/`; provenance records URL, SHA-256, collection time and HTTP modification time when available. Unchanged source bytes keep their original provenance and generate no new commit.

Validation requires the complete scored schedule, matching season/week/teams and final scores on every row, unique `(game_id, play_id)`, unique source order, valid explicit GSIS IDs for the passer/rusher/receiver roles, bounded finite integers, coherent periods/drives and score progression, agreement between source scoring flags and score changes, and a terminal END GAME event matching the final score. Overtime can end with time remaining. Four missing clocks in the current source remain null. Missing values are not converted to zero. An existing published event cannot silently disappear; source removals fail for correction review.

`order_sequence` controls chronology. Sorting `play_id` would misorder source events: the current 2025 regular-season file has 1,943 adjacent ID reversals. Source `fixed_drive` groups the events. A defensive touchdown and the other team's extra-point attempt can share a corrected drive, so the summary labels **starting** possession and each event retains its own possession team. Original drive counts and time-of-possession fields sometimes disagree within corrected groups; this release displays the number of recorded events and the source corrected result, without inventing a consolidated snap count or possession duration.

## Public contract and UI

Each game JSON has schema_version 1, season/type, game identity and final score, coverage, plays, drives, content_sha256, updated_at and source provenance. Plays retain stable play ID and source order; period/clock; corrected drive; possession and defense; down/distance/field position; yards gained; running scores; source description/type; scoring, penalty, touchdown and safety flags; and explicit passer/rusher/receiver identities. These identities do not identify every player on the field. Raw downloads retain other event/player fields for future analytics.

The game page has drive, all-event and scoring views plus a period filter, including overtime. Score labels show the running total after each event. Drive results describe the full drive even when filtering to one period. Text is rendered as text, never source HTML. The independently refreshed viewer validates its payload and retains the last successful snapshot on failures, 404s, identity mismatches and disappearing events. Box scores and snap counts load independently.

These are corrected historical observations, not continuous live scoring or inputs known before kickoff. Future predictive backtests require point-in-time inputs. Advanced metrics and opponent-adjusted ratings are not implemented by this release.

## Checks

- `python -m pytest tests/test_play_by_play.py -q`
- `node --test tests/play_by_play.test.mjs`
- `BROWSER_CHANNEL=chromium node --test tests/play_by_play.browser.mjs`
- `BROWSER_ENGINE=webkit node --test tests/play_by_play.browser.mjs`

The initial source audit compared every published event identity, selected source field and principal player identity with the original CSV, every game final with its existing box score, and both immutable source hashes. All matched. The browser data validator also accepted every generated game payload.
