# Shared matchup simulation

The Matchup Lab (`docs/matchup.html`) and the optional **Play simulation** ranking model use `docs/matchup-simulation.mjs`. The original rankings remain the default. This is an experimental statistical game simulator; increased detail has not established improved prediction accuracy.

## Evidence and refresh

`update_simulation.py` builds dated sufficient statistics from validated completed games in the existing archive, nflverse play-by-play, the public FTN charting subset, and prior-season FTN participation. Game identities and final scores must agree with the validated box scores. Current-season charting may lag play-by-play; uncharted plays are counted as unknown, not false flags. Detailed coverage and participation are prior-season evidence, available after that season's postseason, not live coverage assignments.

`update_coaching.py` reads all 32 official staff pages at most once daily. It separately records HC, OC, DC and special-teams titles, observations and source links. A detected change is an observation date, not a fabricated appointment date. Verified actual play-callers live in `data/coaching_play_callers.json`, with dated source records; a job title never establishes calling responsibility. Most actual callers are presently unconfirmed. Staff refresh failure retains the dated prior observation and marks it retained. Missing titles remain missing.

The existing **Update original rankings** workflow runs after site/stat/snap-count collection and at 00:40, 06:40, 12:40 and 18:40 America/New_York. It now updates staff, simulation inputs and saved forecasts before committing a complete publication and requesting a Pages build. An error prevents that publication; the public last-good files remain available. Raw new downloads use the runner's temporary directory. No new paid data provider, database service or credentials are introduced. GitHub Actions runtime and repository storage still apply under the account's existing plan.

Open pages check for new publications automatically; direct data checks are a 15-minute fallback. The lab uses a browser worker, keeps scenario changes local, and supports cancellation. Visitors fetch saved site files, never upstream data APIs. Ranking pages download compact forecast statistics rather than the larger play distributions.

## Engine

Each simulation maintains shared possession, field position, down/distance, clock and score. The offense selects run/pass/punt/field goal/penalty from situation-specific historical counts, with head-coach/team tendencies shrunk toward league evidence. Pass types include depth/location, play action, screens and RPO where charting supports them; runs include direction. Blitz and historical coverage distributions affect the sampled outcome. Sacks and scrambles are separate dropback outcomes, without invented pass depth.

Recent observed offensive usage allocates carries and targets. A current matching-week Out report or a scenario exclusion removes a player. Unknown roles remain unrated; unsupported production is explicitly unassigned. Future return dates and injury probabilities are not invented. Defender rates and redistributed snaps supply 80% of a pressure/turnover rate adjustment relative to the historical unit, which supplies 20%; multipliers are capped at 0.5–1.5. Unfilled defensive workloads use explicit replacement groups. The same play credits offensive stats and defensive events; a passing TD contributes six scoreboard points while legitimately scoring both QB and receiver fantasy points.

Play durations are empirical with an explicit two-minute tempo heuristic. Regulation has two halves; tied games use one ten-minute regular-season overtime, with possession opportunities and ties subject to the clock. This is not an exact timeout, onside-kick or officiating simulator. It does not reproduce specific coverage responsibilities or blocking assignments.

Weather requires a recent forecast whose valid period includes the scheduled kickoff. Missing/stale weather is conditional. Closed roofs ignore exterior wind and temperature. Small historical mixtures describe roof, surface, stadium, wind and temperature conditions. These associations are not separately identified causal effects. Rain/snow, altitude and individual offensive-line matchups are not independently fitted.

## Projections and scoring

The lab runs 200, 1,000 or 3,000 seeded games and shows means and conditional 10th–90th percentiles. Ranges are not calibrated guarantees. Offensive scoring uses the existing canonical scoring function; kicker scoring is explicitly 3 per FG and 1 per XP. D/ST uses OB's existing full-scoreboard points-allowed convention. IDP tables show sacks, interceptions, opponent recoveries and defensive TDs without inventing an IDP points system. Tackles, assists and forced fumbles are not yet modeled. Shared blocked kicks, safeties and return scores remain unit events.

`scripts/record_simulation.mjs` runs 200 games per fixture. Weekly/ROS means use unstarted fixtures and current matching-week availability; the browser removes fixtures at kickoff even before the next publication. Draft is a current-role scenario across 17 scheduled games with neutral weather and conditional availability, not actual season-to-date production plus a remainder. Season ranges are not published. Ranking uses position replacement values; reception scoring and TE premium recompute from the same saved mean statistics. Unknown roles, byes and started games receive no invented rank. The existing draft marks, personal ADP and original model remain available.

## Verification and limitations

Tests reconcile individual passing/receiving and rushing totals, scoring, sacks, interceptions and lost fumbles against both teams; exercise overtime, reproducibility, roster exclusions, passing shifts, indoor-weather invariance, stale/future evidence and kickoff removal. Browser checks cover mobile layout, worker execution, navigation, scoring/horizon changes and saved draft marks. Collector tests cover malformed inputs, missing data, coaching changes and failed refresh retention.

No held-out player-forecast accuracy improvement is claimed. Historical injury/role vintages and verified coordinator/caller tenure history are incomplete. Before promoting this model to the default, evaluate frozen forecast vintages against future results and calibrate uncertainty, especially rare defensive events and touchdowns.

## Attribution

Public charting and participation: **FTN Data via nflverse**, with derived inputs/forecasts under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Sources and SHA-256 hashes are embedded in the input snapshot. See [FTN loader](https://nflreadr.nflverse.com/reference/load_ftn_charting.html), [participation availability](https://nflreadr.nflverse.com/reference/load_participation.html), [nflverse data](https://github.com/nflverse/nflverse-data), official team staff pages, and the National Weather Service. Coaching facts have separate dated source links.
