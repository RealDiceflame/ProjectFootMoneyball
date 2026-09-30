# Fantasy platform prototype archive

The local removal draft preserves the former Fantasy Leagues / My Leagues prototype here while the future platform is developed. This change has not been pushed or deployed. Only `docs/` is the public hosting root; keep this archive outside that root.

`web/` contains the unchanged `fantasy.html`, `fantasy.js`, `fantasy.css` and `fantasy-leagues.mjs` source. Its HTML still refers to the original shared site assets and URLs, so this is a source archive, not a standalone application. Do not copy it into `docs/` to preview the public site.

The prototype saves league setup preferences in browser storage using `outlierbaseline:fantasy-leagues:v1`. Moving the source does not delete this data or other saved preferences. There is no storage-clearing or migration script in this removal.

The prototype has no production accounts, shared leagues, player rosters, live drafts, scoring or lineup submission. Continue platform planning in [the roadmap](../../documentation/fantasy-platform-roadmap.md). The preserved module remains covered by `node --test tests/fantasy_leagues.test.mjs` from the repository root.
