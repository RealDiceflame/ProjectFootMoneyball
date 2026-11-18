# Ranking identity review — November 5, 2026

Review baseline: main `439f2c7d6c5b7ccf73b752a3f93f6d269f508882`, after MFL removal.
These are prepared rebuild results, not a claim of production publication.

## The original 94 unresolved ADP records

| Disposition | Records | Effect |
| --- | ---: | --- |
| Verified identity and usable scoring baseline | 1 | Travis Hunter enters all 60 boards as WR. |
| Verified identity, no usable scoring baseline | 15 | IDs established; no projection invented. |
| No nflverse name candidate | 67 | Preserve unresolved records; absence is not proof of retirement. |
| Candidate birth dates disagree | 6 | Leave unresolved, including Lane; some candidates are different people. |
| Candidate lacks a canonical `00-` GSIS identifier | 3 | Do not manufacture or substitute an identifier. |
| Explicit GSIS conflict | 1 | Ryan Izzo's Sleeper record conflicts with the nflverse/DynastyProcess GSIS. |
| Different reviewed Sleeper ID | 1 | Chase Cota's saved crosswalk uses `11347`; ADP supplies `11554`. |
| **Total** | **94** | **16 resolved; 78 remain unresolved.** |

The [row-level CSV](ranking-identity-review-2026-11-05.csv) retains all 94 records
and the newly admitted unresolved John Raine record. Candidate names/IDs are
investigation leads, not accepted identity matches. Team labels are provider
observations and do not establish current NFL roster membership.

## Six records with provider team labels

| Player | Finding | Ranking outcome |
| --- | --- | --- |
| Travis Hunter | NFL position CB; corroborated Sleeper ID `12530` permits DB and WR. Yahoo WR alias and Sleeper ADP now join GSIS `00-0040718`. | Added using existing 2025 offensive stats. |
| Ja'Kobi Lane | Sleeper birth date `2004-05-05` differs from nflverse/DynastyProcess `2004-08-05`. | Still unresolved; no broader date exception added. |
| Jalen Morton | No identity candidate in the downloaded nflverse registry. | Still unresolved; the provider's IND label is insufficient evidence. |
| Miller Moss | Unique full name, birth date, position and college agreement links Sleeper `13310` to GSIS `00-0041172`. | Identified; no usable scoring baseline. |
| Matthew Caldwell | Same evidence links Sleeper `13597` to GSIS `00-0041414`. | Identified; no usable scoring baseline. |
| Joseph Manjack | A new nflverse row plus the same evidence links Sleeper `13743` to GSIS `00-0041294`. | Identified; no usable scoring baseline. |

Other supplemental links: Connor Bazelak, Reggie Diggs, Tru Edwards, Jaelen Gill,
Jake Heaps, Cam Johnson, Andre Levrone, Tyjon Lindsey, La'Michael Pettway, Josiah
Price, Duece Watts and Ryan Willis. These names have no usable baseline in the
current projection pipeline; their IDs do not certify active roster membership.

Supporting explicit fantasy-position eligibility also admits Gabe Nabers (RB,
identified) and John Raine (TE, unresolved) to the ADP audit. Raine's primary
positions disagree across sources (Sleeper FB versus nflverse TE), and his ID was
not in the original reviewed ADP snapshot. Neither new record has a usable scoring
baseline. The rebuilt audit therefore has **422 records: 343 identified and 79
unresolved**. The current website refresh retains unresolved records for review.

## Rebuild and preservation checks

- 60 formats, each with 228 unique nonempty canonical player IDs.
- All 227 previously ranked players remain; 13,620 projected-point and
  scoring-coverage comparisons are unchanged.
- Hunter appears exactly once per board as WR. His 2025 source remains CB,
  seven games, 28 receptions, 298 receiving yards and one receiving touchdown.
  The pipeline applies its existing 17-game rate projection; it does not import
  Sleeper projected fantasy points or add defensive scoring.
- Hunter's ADP is `(126.3 + 193.9) / 2 = 160.1`, with two sources. Yahoo remains
  the labelled August 29 manual snapshot. Relative ranks and regression-based
  market comparisons can change when the comparison pool gains a player.
- No existing canonical ID or provider link is removed or reassigned. The registry
  adds four nflverse identities and 15 corroborated Sleeper links; all provider
  tokens remain uniquely owned. It records 100 offensive position alternatives.
- Source conflicts, unknown explicit IDs and ambiguous names stay unresolved.
  Missing statistical production remains unknown instead of becoming zero.

## Evidence and reproduction

Source URLs and SHA-256 digests are recorded in
[`data/identity/provenance.json`](../data/identity/provenance.json):

- [nflverse players](https://github.com/nflverse/nflverse-data/releases/download/players/players.csv)
- [DynastyProcess crosswalk](https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv)
- [Sleeper player metadata](https://api.sleeper.app/v1/players/nfl)

The ADP input that bounded supplemental matching is
[`data/ADP/combined_adp_2026.csv` at the review baseline](https://github.com/RealDiceflame/ProjectFootMoneyball/blob/439f2c7d6c5b7ccf73b752a3f93f6d269f508882/data/ADP/combined_adp_2026.csv).
The reviewed Sleeper projection response came from
`https://api.sleeper.com/projections/nfl/2026?season_type=regular&order_by=adp_half_ppr`
with SHA-256 `ddbf0d006f11edd421c43bcf1c53a689ac996e6eb087b90d6a513673fe316c12`.
These endpoints change over time; a future rebuild must review new differences.

Use the registry-build command in [player-identity.md](player-identity.md), passing
the reviewed ADP input through `--adp`. Then refresh the draft board with
`python refresh_draft_board.py --keep-stats --skip-workbook`. Compare all board IDs,
projected points and scoring coverage to the baseline. Current generated ADP and
ranking snapshots are excluded from the source change so scheduled updates do not
conflict; a release must separately verify the refresh, CI and publication.
