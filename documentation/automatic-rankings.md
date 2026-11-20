# Original draft, weekly and rest-of-season rankings

`schedule-defense-v1` adds shared original player and team D/ST forecasts to the existing rankings page. ADP remains a separate market observation. No FantasyPros data, provider credentials, paid service, database migration or local Docker service is required.

## Evidence and publication

`python update_rankings.py` validates current player appearances using the existing archive/schedule exporter. It additionally validates checksums, identities, team pairs and source timestamps for current and prior-year defensive boxes before atomically writing `docs/data/ranking_inputs.json`. A missing position group is unknown, not a zero. Fractional sacks survive. Defensive interceptions, opponent fumble recoveries and lost fumbles retain distinct meanings.

`node scripts/record_rankings.mjs` calculates all three horizons in twelve scoring/QB combinations, with all 32 defenses, before atomically publishing `ranking_forecasts.json`. The browser uses the same module and allows 8/10/12/14/16-team scarcity settings. It re-evaluates started games as the clock moves; exports, search, draft marks and personal ADP remain available.

The **Update original rankings** workflow executes both steps after **Update site data** or **Update game stats**, and at 00:40, 06:40, 12:40 and 18:40 America/New_York. It runs independently of the older player-value recorder so draft forecasts can build before any current-season appearances exist. Only a successful complete build is committed. It explicitly requests GitHub Pages publication. The public website monitor checks the forecast publication and fails when it is incomplete or over 36 hours old. Workflow failures appear in GitHub Actions; no new external messaging channel is configured.

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

Run `python -m pytest tests/test_ranking_inputs.py tests/test_player_values.py -q`, `node --test tests/*.test.mjs`, and `node --test tests/rankings.browser.mjs`. Website CI includes the exporter, model and browser checks.

Reproduce the defensive component evaluation:

```text
python scripts/export_defense_evaluation.py --season 2025 --output /tmp/defense-evaluation.json
node scripts/evaluate_defense.mjs /tmp/defense-evaluation.json 2025 documentation/defense-evaluation-2025.json
```

The report uses all 544 validated 2024–2025 games. Each evaluation week freezes evidence before its earliest kickoff. All 2025 target games are held out of their own information set. No parameter was selected using the evaluation results. In half-PPR, position-total points-allowed MAE fell 0.45–0.67% versus league-average baselines; D/ST matchup MAE fell 1.83% versus team-only forecasts. Two TE positional groups are unavailable, so TE has 542 rather than 544 team-game targets. These are small component gains, not evidence of individual-player draft/weekly/ROS ranking accuracy. Corrected current archives are not original as-of data vintages. Future work should evaluate recorded prospective forecasts, availability and player-level error before tuning parameters.

Source definitions: [nflverse team statistics](https://nflreadr.nflverse.com/articles/dictionary_team_stats.html), [player statistics](https://nflreadr.nflverse.com/articles/dictionary_player_stats.html), [data update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).
