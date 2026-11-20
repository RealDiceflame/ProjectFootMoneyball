# Original draft, weekly and rest-of-season rankings

`personnel-defense-v2` adds individual-defender contributions to the original draft, weekly and ROS forecasts. ADP remains a separate market observation. No FantasyPros data, provider credentials, paid service, database migration or local Docker service is required.

## Evidence and publication

`python update_rankings.py` validates current player appearances using the existing archive/schedule exporter. It additionally validates checksums, identities, team pairs and source timestamps for current and prior-year defensive boxes before atomically writing `docs/data/ranking_inputs.json`. A missing position group is unknown, not a zero. Fractional sacks survive. Defensive interceptions, opponent fumble recoveries and lost fumbles retain distinct meanings.

`node scripts/record_rankings.mjs` calculates all three horizons in twelve scoring/QB combinations, with all 32 defenses, before atomically publishing `ranking_forecasts.json`. The browser uses the same module and allows 8/10/12/14/16-team scarcity settings. It re-evaluates started games as the clock moves; exports, search, draft marks and personal ADP remain available.

The **Update original rankings** workflow first runs `python update_defender_status.py`, then the exporter and recorder after **Update site data**, **Update game stats** or **Update snap counts**, and at 00:40, 06:40, 12:40 and 18:40 America/New_York. It runs independently of the older player-value recorder so draft forecasts can build before any current-season appearances exist. Only a successful complete build is committed. It explicitly requests GitHub Pages publication. The public website monitor checks the forecast publication and fails when it is incomplete or over 36 hours old. Workflow failures appear in GitHub Actions; no new external messaging channel is configured.

The original production-value/dynasty lab and its recorded versioned history remain available as a separate model, with a link to the new ROS forecast.

Calculation timestamps are separate from archive and schedule source-check timestamps. The page warns about overdue source checks and missing reported-game boxes; the live monitor also rejects archive/schedule checks older than 36 hours. Rebuilding saved evidence cannot hide a stalled collector.

## Model

- Player rate reuses the production-value model: prior three calendar years, 5/3/2 weights with games reliability and observed historical age transitions. Current PPG receives `n/(n+8)` weight. No fabricated rookie prior; no ADP in the scoring forecast. Missing appearances are not inferred zero games.
- Draft is a full-season scenario at today's scoring rate times the existing historical expected-games estimate (17 when unavailable). It is not actual points already earned plus future points, or a future-year roster prediction.
- Weekly defaults to the earliest remaining NFL week, with an explicit week selector. Byes, canceled/postponed fixtures and started games have no weekly rank. ROS sums unstarted regular-season fixtures. Only a current Out report excludes its matching game; unknown return dates and future absences remain conditional scenarios.
- Defense versus position uses scoring-specific opponent player totals. Current-year games weight 1; prior-year games weight .35. Team rate shrinks toward twelve league-average games; relative adjustments cap at .90–1.10. Empty groups and incomplete scores are excluded, not zeroed. This profile is not strength-of-schedule-adjusted or calibrated to individual player outcomes.
- D/ST scores use 1/sack, 2/interception, 2/opponent fumble recovery, 2/safety, 2/blocked kick, 6/defensive or special-teams TD, 2/defensive conversion. Do not add `fumble_recovery_tds` again; touchdown categories already capture scoring. Full scoreboard points-allowed tiers: 0→10, 1–6→7, 7–13→4, 14–20→1, 21–27→0, 28–34→−1, 35+→−4. This intentionally documented OB scoring differs from platform rules that remove opponent defensive-return points. No claim of Yahoo/Sleeper parity.
- D/ST events shrink toward twelve league-average games, or 32 for touchdowns, conversions, safeties and blocks. Sacks/INT/recoveries average the smoothed defense rate and opponent offensive conceded rate. Expected points-allowed tier scores average team defense and opponent offense distributions; no nonlinear threshold is applied to a fractional expected scoreboard total.
- Overall rank is projected surplus over QB `teams × starters`, RB `round(teams × 2.5)`, WR `round(teams × 3.5)`, TE `teams`, D/ST `teams` starters. Within-position ranks order forecast points. This is a roster-building convention, not a fitted optimal strategy. Unrated entries have no numeric rank. Weekly/ROS market-value comparisons are cleared.

## Verification and evaluation

### Individual defenders in version 2

- Public nflverse roster and injury CSVs are saved with source URL, retrieval time, HTTP modification time and SHA-256. Roster coverage must include all 32 scheduled teams and at least 1,000 unique GSIS IDs. Injuries join by GSIS ID and current team only. A 404 for a not-yet-published injury season is explicit unknown availability; other download/validation failures preserve the last publication.
- Defensive box scores and snap sidecars join by game, team and GSIS ID. Both archives retain validated checksums. Unknown mappings remain unknown. An absent player box row can establish zero for an event only when every player credit is known and accounts for the authoritative team total. A null stat in a present player row is never inferred zero. Unmatched defenders are not assigned another person's statistics. Missing snap games are listed in coverage.
- Sacks, interceptions, opponent fumble recoveries and defensive TDs are modeled per defensive snap. Current-season exposures weight 1 and preceding-season exposures .35. Known exposures shrink toward the DL/LB/DB cohort with 500 prior snaps, or 2,000 for touchdowns. Unusual positions use the overall cohort when needed. These are explicit heuristic parameters, not fitted accuracy claims.
- The last three observed team games set the total and position-group workload. Total defender snaps divided by 11 is an estimated team-play count, not a measured play count. Recent participating players on the current roster receive inferred roles; individual workloads cannot exceed that estimate. Transfers carry their history to one current team only. Missing role identities and unfilled workload use a labeled replacement cohort.
- Current Out removes only its matching week. Fresh reserve/practice-squad/exempt status removes the current week's role; an inactive designation additionally needs the current roster week. Available observed teammates receive released snaps up to their caps, then the generic replacement fills any remaining budget. Questionable/Doubtful reports do not create invented absence probabilities. Later weeks and draft scenarios are conditional availability, not predicted recovery dates. A missing report is unknown health.
- Individual and replacement event estimates supply 80% of these four events. A smoothed team prior supplies 20%. The opponent's conceded sack/INT/fumble rates scale individual contributions between .75 and 1.25 relative to the league. This is separate from the ±10% offensive positional matchup adjustment. Tables show weighted event contributions, rather than labeling those as standalone IDP forecasts.
- Points-allowed distributions remain team/opponent estimates. Safeties, blocked kicks, special-teams TDs and defensive conversions remain shared components. Individual safety credits were not reliably attributable to the scoring defense in four archived games, so they are deliberately excluded from the individual component. Fumble-return touchdowns are not added again.
- Every team detail lists named defenders, replacement workload, the team prior, shared scoring and points allowed. Components reconcile before rounding; displayed horizon totals sum rounded fixture forecasts. Roster evidence older than 48 hours (or a roster source modified over seven days ago) uses an explicit browser team fallback. In-season participation over 21 days old also falls back. Automatic publication requires all 32 teams' applicable horizons to have player evidence; it never silently publishes fallback as player-based output.
- No evidence of improved v2 predictive accuracy is claimed. Scenario tests verify causal player contribution, week-limited absence, replacement workload, transfer identity, missingness, future-game exclusion and total reconciliation. The v1 evaluation below remains a comparison of the older team components only.

Definitions: [nflverse snap counts](https://nflreadr.nflverse.com/articles/dictionary_snap_counts.html), [rosters](https://nflreadr.nflverse.com/articles/dictionary_rosters.html), [injuries](https://nflreadr.nflverse.com/articles/dictionary_injuries.html).

Run `python -m pytest tests/test_defender_inputs.py tests/test_ranking_inputs.py tests/test_player_values.py -q`, `node --test tests/*.test.mjs`, and `node --test tests/rankings.browser.mjs tests/board_refresh.browser.mjs`. Website CI includes the exporter, model and browser checks.

Reproduce the **version 1 team component** evaluation (this does not evaluate the new personnel model):

```text
python scripts/export_defense_evaluation.py --season 2025 --output /tmp/defense-evaluation.json
node scripts/evaluate_defense.mjs /tmp/defense-evaluation.json 2025 documentation/defense-evaluation-2025.json
```

The report uses all 544 validated 2024–2025 games. Each evaluation week freezes evidence before its earliest kickoff. All 2025 target games are held out of their own information set. No parameter was selected using the evaluation results. In half-PPR, position-total points-allowed MAE fell 0.45–0.67% versus league-average baselines; D/ST matchup MAE fell 1.83% versus team-only forecasts. Two TE positional groups are unavailable, so TE has 542 rather than 544 team-game targets. These are small component gains, not evidence of individual-player draft/weekly/ROS ranking accuracy. Corrected current archives are not original as-of data vintages. Future work should evaluate recorded prospective forecasts, availability and player-level error before tuning parameters.

Source definitions: [nflverse team statistics](https://nflreadr.nflverse.com/articles/dictionary_team_stats.html), [player statistics](https://nflreadr.nflverse.com/articles/dictionary_player_stats.html), [data update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).
