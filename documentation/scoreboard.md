# Homepage scoreboard

The homepage shows a selectable regular-season week, initially the current NFL week. The next week opens two days before its first kickoff. Cards scroll horizontally, including on phones. Times use the visitor's local time zone.

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
