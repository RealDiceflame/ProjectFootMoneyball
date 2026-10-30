# Player data and fantasy scoring audit — October 30, 2026

The audit found and corrected scoring and identity errors in the existing NFL
pipeline. It did not introduce a new forecasting model. The saved-source rebuild
used repository revision `33f67194e941a6c9e296f4dba0cbea12ab84a836` and the existing
2025 statistics/2026 ADP files, without fetching replacement provider data.

## Findings and fixes

| Finding | Why it matters | Correction and evidence |
| --- | --- | --- |
| Some Python and historical browser calculations deducted total fumbles. | A recovered fumble is not a lost-fumble turnover. | Use explicit lost fumbles, retain total fumbles separately, and include known two-point conversions and special-teams touchdowns. |
| Browser history scoring disagreed with the corrected rule on 1,748 of 5,050 saved player-seasons. | Projection inputs and historical comparisons could disagree with the Values model. | A shared browser scorer now handles these fields; nine cross-runtime examples agreed with Python across standard, half-PPR and full-PPR. |
| DJ Moore appeared twice on all 60 boards. | One athlete occupied two ranks and his providers were split across records. | Normalize dotted/spaced initials and combine compatible provider observations. The rebuilt boards contain one Moore with all three sources. |
| Category and ADP joins relied on player names. | Two people with the same name could share statistics; later name-based deduplication could hide it. | Use known player IDs first, validate one-to-one joins, and restrict ID-less matching to unambiguous name/position evidence. |
| Browser imports/reports could fall back to a name despite conflicting known IDs or positions. | A person could receive another player's ADP or biographical data. | Reject conflicting/ambiguous matches and ignore placeholder IDs. |
| Missing games could become an assumed 17-game denominator. | An unknown rate appeared to be a measured rate. | Keep unavailable rates/projections unknown and exclude them from replacement pools and regression fitting. |
| Rookie estimates could overwrite recorded zeroes. | An observation and a prediction became indistinguishable. | Keep projected rookie rows separate; do not overwrite historical observations. |
| Projection history could include its target year or a later year. | Future information could leak into a historical forecast. | Restrict evidence to seasons before the projection season. |

## Identity rules

The existing nflverse/GSIS `player_id` is the canonical identifier where supplied.
This change strengthens its use; it does not create a new database or complete
provider-ID crosswalk.

1. Two different known IDs remain separate, even when names and positions match.
2. One known ID remains one person when its display name, team or position changes.
3. An ID-less name/position can resolve to a known ID only when there is exactly one
   compatible candidate. Ambiguous records stay unmatched.
4. Duplicate conflicting source records fail validation instead of multiplying
   joined rows or silently selecting one.
5. A CSV placeholder such as `-` becomes JSON `null`, never a shared player ID.

A regression test explicitly uses two **Josh Allen** records: a quarterback and
a defensive end, with distinct synthetic IDs. Their passing/rushing statistics
remain separate even when source row order changes. Another test holds the ID
constant while changing name, team and position, preserving the person's identity.

## Scoring and missing-data rules

The audited rule awards 0.04 points per passing yard, four per passing touchdown,
minus two per interception, 0.1 per rushing/receiving yard, six per rushing/receiving
touchdown, and 0/0.5/1 per reception. Known lost fumbles deduct two; known conversion
events add two; known special-teams touchdowns add six. TE premium adds the selected
reception bonus for tight ends. Negative yardage remains valid.

An explicitly unknown or invalid core statistic makes its score unavailable.
Known optional adjustments are applied independently; missing optional adjustments
remain unknown in the data. Legacy/rookie partial subtotals carry `core_only`
coverage, and the board explains that some scoring adjustments may be missing.
Strict scoring requires complete optional evidence. Full coverage describes field
availability, not forecast accuracy.

## Saved-source reconciliation

- All 60 rebuilt boards contain **256 players**, down from 257 solely by combining
  the genuine Moore duplicate: **245 known IDs and 11 ID-less rookie estimates**.
- Each board has **245 full-coverage and 11 partial estimates**, with no duplicate
  known player IDs.
- Moore's combined ADP is **58.3633** before display rounding: Yahoo 61.3, Sleeper
  49.9, MFL 63.89. Provider dates remain August 29, October 30, and October 22.
- All **2,019 identifiable regular-season source players** reconcile exactly to an
  independent calculation from the raw columns in standard, half-PPR and full-PPR.
- One anonymous source aggregate with 272 games has no individual identity and is
  excluded from player calculations.
- The integration rebuild caught nine punctuation-related matching regressions
  before release. Apostrophes/hyphens now remain compatible with saved names;
  dedicated tests cover the affected names, including Chase and Smith-Njigba.

## Repeatable verification

```bash
python -m pytest tests/test_scoring_pipeline_audit.py tests/test_dataframe_integrity.py \
  tests/test_final_stat_builder.py tests/test_pipeline_cleaning.py tests/test_fantasy_points.py \
  tests/test_draft_rankings.py tests/test_regression_analysis.py tests/test_adp_importer.py \
  tests/test_web_exporter.py -q
node --test tests/*.test.mjs
python refresh_draft_board.py --saved-adp --keep-stats --skip-workbook
```

The final command rebuilds local artifacts from saved inputs. The regular website
workflow also runs these regression groups and the browser coverage-warning test.

## Remaining work

Provider freshness is separate from numerical correctness. Yahoo remains a manual
snapshot, and the saved MFL data is an older season aggregate. Neither becomes
current weekly evidence because the arithmetic is corrected. Eleven rookie
ranking records still lack verified IDs in that pipeline; a future provider-ID
crosswalk should resolve them using explicit identity evidence.

This audit does not establish the predictive accuracy of a weekly player outlook,
lineup optimizer or waiver recommendation system. Those remain later work.
