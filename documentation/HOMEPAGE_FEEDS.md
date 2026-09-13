# Homepage source cards

The homepage has two distinct sources of preview cards:

- **Selected clips and analysis** in `docs/index.html`: manually selected NFL.com,
  ESPN and CBS Sports links. Keep the selection date accurate. The title link
  goes to the original story or clip, not a publisher homepage or our own page.
- **Recent player headlines**: up to four source-linked ESPN headlines from
  `docs/data/player_news.json`, using the existing six-hour data workflow. Only
  dated headlines from the past seven days with a full-name player match appear.
  This is not an automatic big-play or live game feed.

`docs/home-data.mjs` matches full names in titles (never surnames alone or URL
slugs). Players need stable IDs and a non-ambiguous name check supplied by
`app/player_news.py`. That check uses the full roster, including defenders who
are absent from the fantasy rankings. Missing checks and name collisions leave
the card without a player association. Multiple named players can share a card.

`docs/home.js` adds roster portraits and saved injury details to source cards
and the injury list. Portrait URLs are limited to the existing NFL image host;
missing or failed portraits use initials. Article links remain usable if the
snapshot cannot load. No article bodies, videos or publisher thumbnails are
scraped or rehosted for these cards, and no new API key is required.

Injury details belong to the saved snapshot, not to the linked article. Preserve
the report week, snapshot timestamp and source link. No report means unknown,
not healthy. Questionable, Probable and practice participation alone do not earn
a Risk label; Out, Doubtful and injured-reserve statuses do.

The official NFL X timeline is independent of these cards and keeps its existing
privacy notice and fallback link. Photo and X requests can still reach their
respective hosts; page reloads do not fetch article feeds from publishers.

After editing the homepage modules/styles, bump their query-string versions in
`docs/index.html` and the `home-data.mjs` import in `docs/home.js`. Refresh the
saved news through `update_player_news.py`, not by editing injury facts by hand.

Regression checks: `node --test tests/*.test.mjs`, player-news Python tests, and
the homepage tests in `tests/navigation_and_fantasy.browser.mjs`.
