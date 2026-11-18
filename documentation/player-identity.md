# NFL player identity

`player_id` is the NFL GSIS ID used by our existing game archive and rankings.
It belongs to a person, independent of display name, team or position. Provider
IDs are namespaced: Sleeper `123` and MFL `123` are different identifiers.

## Evidence and matching

The saved registry in `data/identity/player_ids.csv` contains NFL IDs, source
names/aliases and available Sleeper, MFL, ESPN, Yahoo and PFR identifiers.
`provenance.json` records source URLs, SHA-256 digests, capture time, omitted
links and corroborated source discrepancies. Missing provider IDs remain blank;
a mapping does not imply access to that provider's statistics or ADP.

The builder joins DynastyProcess to nflverse by GSIS ID, requiring agreement
on birth date or an independent ESPN/PFR identifier. Sleeper mappings additionally
require matching source name or GSIS and a corroborated birth date. A one-day
rookie birth-date discrepancy requires agreement on name, position, college,
draft team and rookie year; the discrepancy is retained in the evidence log.
This covers KC Concepcion's September 23/24 source disagreement without changing
either source date. Conflicting provider claims are omitted, never picked by
row order.

For provider IDs in an explicitly reviewed ADP snapshot, the builder can fill a
missing DynastyProcess crosswalk using an exact normalized full name, birth date,
position and college agreement between nflverse and Sleeper. It requires one
candidate, verifies any explicit Sleeper GSIS ID, and rejects provider collisions.
An existing rejected crosswalk claim cannot use this fallback. Supplemental links
and the reviewed ADP digest are recorded in `provenance.json`; normal refreshes
still use the saved registry without discovering new links.

`position` retains the NFL primary position. `position_aliases` records offensive
fantasy eligibility from a corroborated Sleeper ID. Name lookups index those
aliases without relaxing ambiguity checks. For an NFL position outside QB/RB/WR/TE,
the ranking pipeline uses an offensive alternative only when exactly one is
supported by that player's canonical ID. Stats totals and source files retain
their original meaning; this does not add defensive fantasy scoring.

At import time:

1. Preserve any existing canonical ID and resolve supplied provider IDs.
2. Reject a row if its known IDs point to different people.
3. If no ID is supplied, use a name/position alias only when the whole registry
   has exactly one candidate. For historical namesakes, an explicit snapshot year
   and team can narrow the candidates only if both agree with the registry’s
   last recorded season and team. Team is not part of the permanent key.
4. An unknown explicit provider ID or ambiguous name remains unresolved; it
   cannot regain a speculative name match in the stats join.
5. Merge compatible ADP observations by canonical ID and preserve provider IDs
   and source dates. Conflicting observations require review.

`identity_status` in the combined ADP and intermediate CSVs distinguishes source
IDs, provider IDs, unique-name matches, ambiguous names and unresolved provider
IDs. Those files remain the audit trail for records that cannot enter rankings.
The combined skill-player ADP CSV retains all validated candidates (ADP 1–400);
unresolved records do not consume a 350-row cutoff and displace identified players.
The scoring stage still requires usable statistics before publishing a ranking.
Unknown statistics remain unknown even when identity is established. The eleven
rookie projections still have `core_only` scoring coverage.

## Refreshing the mapping

Routine data refreshes use the saved registry; they do not silently replace it.
Download the three URLs recorded in `scripts/build_player_registry.py`, then run:

```sh
python scripts/build_player_registry.py \
  --nflverse /path/to/players.csv \
  --fantasy /path/to/db_playerids.csv \
  --sleeper /path/to/sleeper-players.json \
  --adp data/ADP/combined_adp_2026.csv
python -m pytest tests/test_player_identity.py tests/test_adp_importer.py tests/test_dataframe_integrity.py -q
```

Review the registry diff and evidence log before committing. Rebuild all ranking
formats and compare the player set and scoring values with the previous snapshot;
a passing small fixture alone is insufficient to establish complete coverage.
Yahoo snapshots can optionally include `Yahoo_ID` or `Yahoo Player ID`. Preserve
IDs as strings, including leading zeros. A Yahoo ID is not inferred for a rookie
when the source does not provide one.

This change is independent of the historical weekly importer. Provider identity
mapping does not add snap counts, play-by-play, postseason pages or a live feed.

## October 30, 2026 validation

The registry contains 18,784 NFL identities with 6,002 Sleeper, 7,939 MFL,
16,416 ESPN, 5,312 Yahoo and 16,988 PFR links. There are 161 omitted source
links in the evidence log. Registry coverage is broader than ranking coverage.

All 60 rebuilt boards contain 274 players with unique, nonempty GSIS IDs.
All original 256 players remain; removing the pre-scoring ADP cutoff admits 18
additional players with usable baseline statistics. An independent comparison
found no changes to projected points for any original player in any format.
All eleven rookie IDs resolve; their partial scoring flags remain intact.

The refresh retained the October 22 MFL snapshot after the MFL request failed.
Identity matching does not make that source current. Some name-only and unknown
provider records still require review and remain in the combined ADP audit data.

## November 5, 2026 integration review

Integrated the diagnostics release and current main, preserving the snap-count
and play-by-play checks alongside the new identity tests. Rebuilt from the current
2025 baseline and freshly retrieved November 5 Sleeper/MFL observations. Yahoo
remains the explicitly labelled August 29 manual snapshot. Generated ADP/ranking
files are excluded from this PR so it can merge alongside scheduled data updates.
The existing refresh workflow rebuilds and publishes them from current inputs
after merge. The counts below describe the reviewed local rebuild.

All 60 boards now contain 229 unique, identified players. Every one of the prior
219 players remains, with identical projected points and scoring-coverage labels
across all formats (13,140 player/format comparisons). Eleven existing rookie
estimates now have canonical IDs; ten additional players have usable baseline
statistics. Rankings and market-relative values can change with the current ADP.
The combined ADP audit retains 423 rows: 329 identified, 93 unresolved provider
IDs, and one unmatched name. Unknown provider IDs are not assigned by name.

The saved registry still contains 18,784 canonical IDs and 52,657 provider links;
every provider/ID pair has only one owner. Local validation passed 484 Python tests
(58 database-dependent skips) and 228 JavaScript tests. Browser CI and publication
are verified separately on the final PR revision.

## November 5 market-source removal

MFL market observations are no longer imported, averaged or published. Existing
MFL IDs in the reviewed registry remain static identity evidence; this does not
subscribe to or request MFL data. The earlier rebuild counts above describe those
release snapshots, not the reduced-source boards.

## November 5 ranking-coverage review

The prepared rebuild contains 228 identified players in each of 60 formats.
Travis Hunter is added as WR using GSIS `00-0040718`: nflverse lists CB, while
Sleeper `12530` explicitly lists DB and WR. His existing seven-game 2025 receiving
baseline supplies the same 17-game projection calculation as other players.
Yahoo's 126.3 and Sleeper's 193.9 ADP combine into 160.1; the Yahoo capture date
remains August 29. His NFL position, raw statistics and permanent ID are unchanged.

All 227 previously ranked players remain. Projected points and scoring coverage
are identical across all 13,620 prior player/format comparisons. Relative ranks,
replacement values and fitted market expectations may change when a player joins
the comparison pool. The new player has full scoring-field coverage; that label
does not promise a full season of observations or forecast accuracy.

Of the original 94 unresolved ADP records, 16 now resolve: Hunter through reviewed
position eligibility and 15 through corroborated missing crosswalk links. The 15
still lack a usable 2025 scoring baseline or existing approved rookie estimate;
establishing an identity does not invent a projection. The other 78 remain in the
audit. Supporting eligible positions also admits Gabe Nabers (identified) and
John Raine (unresolved) into the ADP audit; neither has a usable baseline. The
prepared refresh therefore retains 422 ADP rows: 343 identified and 79 unresolved.

The registry has 18,788 canonical identities, including four new nflverse rows.
All prior canonical IDs and provider links are preserved; 15 Sleeper links are
added and 100 rows have reviewed offensive position alternatives. The dated
[coverage review](ranking-identity-review-2026-11-05.md) and its CSV document the
unresolved cases. These are local validation results; CI and publication must be
verified on the final revision separately.
