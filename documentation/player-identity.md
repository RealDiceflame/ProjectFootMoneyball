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
  --sleeper /path/to/sleeper-players.json
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
