# Homepage league feed

On the Field / Around the league is an automatically refreshed, scrollable
list of source links, not a manually selected highlight list. It uses the
existing ESPN NFL RSS source and six-hour `Update site data` workflow.
NFL and CBS hub links are navigation links, not additional automated sources.

The updater saves `league_news` in `docs/data/player_news.json`, including stories
without a ranked-player match. Original titles, URLs and publication times are
retained. The homepage shows up to 50 unique links from the past seven days,
newest first. Undated stories appear last with an explicit missing-time label.
This is scheduled league news, not live play-by-play or a highlights-only feed.

`docs/home-data.mjs` matches full names in titles (never surnames alone or URL
slugs). Players need stable IDs and a non-ambiguous name check supplied by
`app/player_news.py`. That check uses the full roster, including defenders who
are absent from the fantasy rankings. Missing checks and name collisions leave
the card without a player association, never hide the story. Multiple named
players can share a card.

`docs/home.js` adds roster portraits, names, teams and positions to source cards.
Injury details and badges appear only in the separate Injury watch section,
not on highlight or recent-headline cards. Portrait URLs are limited to the existing NFL image host;
missing or failed portraits use initials. Article links remain usable if the
snapshot cannot load. No article bodies, videos or publisher thumbnails are
scraped or rehosted for these cards, and no new API key is required.

In Injury watch, details belong to the saved snapshot. Preserve
the report week, snapshot timestamp and source link. No report means unknown,
not healthy. Questionable, Probable and practice participation alone do not earn
a Risk label; Out, Doubtful and injured-reserve statuses do.

The official NFL X timeline is independent of these cards and keeps its existing
privacy notice and fallback link. Photo and X requests can still reach their
respective hosts; page reloads do not fetch article feeds from publishers.

The feed region is keyboard focusable and supports touch, wheel and keyboard
scrolling. `league_news.updated_at` records its last successful refresh separately
from the injury snapshot timestamp. On source failure, the updater retains the
last good feed and its original timestamp. The homepage labels retained/overdue
data. HTML/non-RSS responses are failures; a valid empty feed is allowed.
Older snapshots can temporarily supply their saved player-news links during
deployment, without reintroducing hard-coded highlights.

After editing the homepage modules/styles, bump their query-string versions in
`docs/index.html` and the `home-data.mjs` import in `docs/home.js`. Refresh the
saved news through `update_player_news.py`, not by editing injury facts by hand.

Regression checks: `node --test tests/*.test.mjs`, player-news Python tests, and
the homepage tests in `tests/navigation_and_fantasy.browser.mjs`.
