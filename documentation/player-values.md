# Player values: production, not consensus

`docs/values.html` provides original **rest-of-season** and **dynasty** analytics for QB/RB/WR/TE. It does not ingest KeepTradeCut ratings or claim to reproduce market prices. The experimental 0–10,000 index measures positive modeled production above a fixed starter-replacement reference. A zero is not a claim that a player is worthless, and two indices cannot be added to price a trade.

## Inputs and identity

- `update_player_values.py` reads the saved current-season schedule and game-stat archive without calling any provider. GSIS IDs join observations; names do not establish identity.
- `docs/data/player_value_inputs.json` preserves nulls, game provenance, corrections, pending games and source timestamps. A missing player row does **not** establish that he was active and scored zero.
- A game is analysis-ready after archived statistics, a reported score pair and an eight-hour elapsed-kickoff check, unless an explicit final flag is present. The normal source lacks final flags; these records remain labeled provisional. This is not live scoring.
- Historical season exports append actual lost-fumble and two-point statistics. Older bundles without those optional columns produce explicitly labeled core-only priors, never total-fumble penalties masquerading as lost fumbles.
- News is joined by matching player ID and position. Current roster identity and independently dated injury context are required before applying current injury information.

## Reproducible model v1

All settings use a 12-team reference. Choose Standard, Half PPR or Full PPR; 1QB/2QB; and an additional 0.5 reception point for tight ends. Passing touchdowns are four points; interceptions and lost fumbles cost two; two-point conversions count two. Special-teams touchdowns credited to an offensive player count six. K/DST have their existing separate board.

1. Compute a prior PPG from the preceding three **calendar** seasons, weighted 5/3/2 and by `min(games/12, 1)`. Apply historical position/age transition factors across intervening years. Current/future season totals are excluded. More distant history informs the age curve, not the player's recency prior.
2. Blend archived current PPG with the prior: `prior + n/(n+8) × (current−prior)`. Eight prior-equivalent games is a transparent smoothing choice, not a fitted coefficient. With no prior, use current appearances and label the small sample. With neither, do not rank.
3. Multiply the nonnegative scoring rate by the player's actual upcoming regular-season fixtures. No byes, started games or postseason are counted. A current **Out** excludes only its matching upcoming fixture. Questionable/Probable do not reduce value. IR/Doubtful are flagged, but no recovery date is invented; the result is a conditional playing scenario.
4. Dynasty production is ROS plus `0.85 × next season + 0.85² × following season`. Both future seasons assume 17 playing games and age-adjusted scoring. Returning-player age curves are not retirement probabilities. This model does **not** forecast future depth-chart roles, team changes, injury recurrence or survival in the NFL.
5. Reference replacement PPG is QB13 (QB25 in 2QB), RB25, WR37 and TE13. If a position has too few usable players, the deepest available player is used and the limited population is exposed. No flex allocation is assumed. Hold this reference PPG fixed across the future horizon. Subtract replacement production and scale each horizon's largest positive surplus to 10,000. Rank by unrounded-to-index surplus; negative surplus remains visible even when the index floors to zero.

Targets, carries, weekly scores and recent PPG explain observed changes; they are not an additional arbitrary bonus on top of fantasy points. No opponent-strength, snap-share or medical prognosis is being claimed. Early-season observation selection can overstate per-game rates when zero-stat active players are absent from the source.

## Recording history

Run locally from the repository:

```powershell
.\.venv\Scripts\python.exe update_player_values.py
node scripts/record_player_values.mjs
```

The recorder runs the same browser model for all 12 supported formats. It stores the **latest actual calculation per UTC day**, model version, season, settings, replacement reference, source-file SHA-256 fingerprints, coverage, indices and raw projected points. `docs/data/player_values/index.json` lists dated files. Earlier dates are retained; backdated writes and malformed manifests fail rather than silently erasing history. Same-day refreshes replace that day's displayed point; this is not a tick-by-tick archive.

The “Update player values” workflow runs after the site-data and game-stat workflows complete, plus a six-hour fallback schedule. It reads committed snapshots, so provider fetches remain in their existing updaters. Values can still reflect last-good data after an upstream failure; source dates and missing box scores remain visible. The workflow publishes new data explicitly because automatic-token commits do not themselves trigger Pages builds.

Charts show only genuinely recorded snapshots matching the model version, season and scoring format. **History begins when recording begins.** Nothing is backfilled with today's knowledge and called a past value. A future retrospective backtest must be labeled separately and use as-of inputs. These saved predictions can later be compared with realized outcomes to tune and validate the model; they are not already validated forecasts.

Change `MODEL_VERSION` whenever scoring, weighting or replacement logic changes. Do not join incompatible model versions into a single apparent historical trend. Before this daily archive grows into multiple seasons, move durable captures into the private statistics database and publish compact chart extracts; the initial implementation records and serves the public JSON snapshots without introducing a database credential into the browser.

## Verification

`tests/test_player_values.py`, `tests/test_player_history.py`, `tests/player_values.test.mjs`, `tests/player_value_snapshots.test.mjs` and `tests/player_values.browser.mjs` cover collection, scoring, temporal boundaries, injuries, identity, recording and UI behavior. All data is served as static snapshots; visitors do not spend API credits or need accounts to use the value page.
