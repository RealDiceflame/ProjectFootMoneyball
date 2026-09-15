# Homepage scoreboard

The homepage shows a compact single-row score ticker above its headline, with a selectable regular-season week. The next week opens exactly 24 hours before its first kickoff. A manually selected week remains selected. All games remain accessible with swipe/scroll, keyboard focus or Previous/Next buttons; the ticker never moves automatically. Compact cards show team logos/names, reported scores and kickoff times in the visitor's local time zone. City/weather remain in the card description and hover text and are fully visible on the linked game-stat page. Snapshot refreshes preserve ticker position and focused games; changing weeks resets the strip.

## Venue and kickoff weather

The schedule supplies stadium ID/name, roof, temperature (°F) and wind (mph). City is keyed to the actual stadium, not the nominal home franchise, including international games. Unknown stadium IDs display the venue name without guessing a city. Representative venue references: [SoFi/Inglewood](https://www.sofistadium.com/connect), [MetLife/East Rutherford](https://www.metlifestadium.com/a-z-guide), [Levi's/Santa Clara](https://levisstadium.com/contact-us/), [Stade de France/Saint-Denis](https://www.stadefrance.com/fr/credits). International roof overrides are shared with the odds board.

Reported schedule conditions take priority. Otherwise the score publisher reuses the six-hour odds snapshot's [National Weather Service](https://www.weather.gov/documentation/services-web-api) kickoff-hour forecast, matching game ID, teams, stadium ID and kickoff instant. Scoreboard polling makes no extra weather-provider requests. Weather failure never blocks scores. Forecast collection times stay unchanged on reuse; old forecasts are labeled earlier forecasts and past-game forecasts remain explicitly pre-game forecasts, never observations.

Closed/domed venues are identified separately (SoFi is labeled covered/open-sided); a retractable roof with unknown status is not assumed closed. Missing conditions remain unavailable. Future weather generally appears within seven days for supported US venues; no international forecast provider is added. Conditions are kept with scores and flow into the existing per-game archive for later research.

## Source and meaning

`update_scores.py` downloads the public `games.csv.gz` schedule release from [nflverse-data](https://github.com/nflverse/nflverse-data/releases/tag/schedules), attributed to Lee Sharpe / nflverse under [CC BY 4.0](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md). OutlierBaseline selects the requested regular season and formats the fields. The homepage includes attribution in Sources & privacy.

The [documented upstream schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html#nflverse-gameschedule-data) updates frequently in season, but has no authoritative game clock or final/live indicator. Cards therefore say **Reported score**, not Final or Live. A missing score is a dash, not zero. Future games show scheduled times, not scores. There are no new provider keys, paid odds calls, or direct browser calls to providers.

## Refresh behavior

- The Update scoreboard workflow wakes at minutes 7, 22, 37 and 52 of each hour. It fetches on every run from two hours before through ten hours after a known kickoff. Outside those windows, it fetches when the snapshot is at least six hours old.
- Each visitor rereads only our published snapshot every 60 seconds while the page is visible. This does not cause an upstream download or a full rankings refresh.
- The short Checked timestamp is our successful fetch time, not a guarantee of the source's latest play. A delayed-update indicator appears after 45 minutes near games, or seven hours otherwise.
- GitHub scheduling, source updates and Pages publication are best effort; 15 minutes is a target, not a latency guarantee. Rankings and other site data keep their separate six-hour workflow.
- Invalid/incomplete downloads or disappearing previously reported scores leave the complete last-good file and its original timestamp intact. Numeric score corrections are allowed.
- Publication is checked independently of refreshes so a failed deployment can be retried without waiting six hours or downloading the source again.

## Maintenance

Run `python update_scores.py` at the repository root, or use Actions → Update scoreboard → Run workflow. `--season YEAR` selects another supported 17-game regular season; `--scheduled` applies the window/age gate. Python 3.12 on Linux needs no extra packages for the score fetch; Windows also needs `tzdata` for Eastern kickoff conversion.

The integrity check currently expects 272 games, 32 teams and 18 weeks. Postseason, preseason and older 16-game schedules are not included. A new season without a complete published schedule keeps the last-good snapshot rather than producing an empty board.

Tests: `python -m pytest tests/test_scoreboard.py` and `node --test tests/scores_data.test.mjs`.

## News and game details

The homepage now rereads its own saved news/injury snapshot every minute while visible, and checks on returning to the tab. A failed request keeps visible reports, controls and the previous timestamp. The underlying source collection still runs every six hours. ESPN RSS gets two bounded attempts, then the openly syndicated Yahoo Sports NFL News RSS is tried. Access denials/rate limits are not retried. Each article retains the real publisher and original link. An empty or malformed feed cannot become a new successful snapshot. Headline failures are recorded separately from roster/injury success in the site refresh status.

See [the game-stat archive](game-stats.md) for box-score coverage and future model inputs.
