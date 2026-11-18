# Database operations

The statistics database is a private copy of the saved sports archive. The
public website still receives its existing JSON files. This separation lets us
check database-generated files before making visitors depend on them.

## The update chain

1. **Collect:** `Update site data` and `Update game stats` refresh saved source
   files on main. Their regular schedule is every six hours in America/New_York.
2. **Store and check:** a successful collector triggers `Sync private stats
   database`. It imports new or corrected snapshots and verifies the statistics,
   player identities and totals against that checkout.
3. **Compare website files:** the same job builds a separate set of statistics
   files from the database and compares every covered JSON value with the files
   already used by the website. This is a shadow export: it does not publish.
4. **Watch:** `Monitor private database sync` checks the completed workflow and
   also runs hourly to detect a schedule that stops producing updates.

A successful request to a data provider does not guarantee the provider has new
statistics. The source's own timestamp and the time our job completed are
different facts. GitHub schedules are best effort, not exact appointment times.

## What the monitoring means

The monitor uses GitHub workflow results and a small health report. It does not
receive the database password or connect to Supabase. The health report contains
counts, byte sizes, verification time and the triggering workflow identity; it
contains no player rows, connection strings or credentials.

Default warnings cover:

- A failed database sync or a separate failure after the database was verified.
- No successful verification for ten hours, an overdue scheduled collector, or
  an update chain stalled for more than three hours.
- Database size of at least 1 GiB, or growth of at least 250 MiB **and** 25% within
  the available twenty-four-hour observation window.

Storage warnings ask for review. They do not predict an invoice: PostgreSQL
database size excludes other provisioned-disk usage such as transaction logs.
Growth comparison needs at least two valid observations. A first report
establishes the baseline, not a growth trend.

Problems appear as owner-assigned GitHub issues titled `[Database monitor] ...`.
The monitor reuses one issue for each category, stays quiet when the state is
unchanged, and closes the issue when fresh evidence shows recovery. Email and
push delivery depend on the owner's GitHub notification settings. If the
monitor cannot read its evidence, it preserves existing incidents and reports
that monitoring itself needs attention.

Repository variables can adjust the limits:

| Variable | Default / purpose |
| --- | --- |
| `STATS_DATABASE_SYNC_ENABLED` | Existing switch; must be `true` for sync and monitoring |
| `STATS_MONITOR_ACTIVE_SINCE` | Required ISO UTC activation time; distinguishes old runs without health reports from instrumented runs |
| `STATS_MONITOR_STALE_HOURS` | `10` |
| `STATS_MONITOR_WARN_BYTES` | `1073741824` (1 GiB) |
| `STATS_MONITOR_GROWTH_BYTES` | `262144000` (250 MiB) |
| `STATS_MONITOR_GROWTH_RATIO` | `0.25` (25%) |

Do not reset the activation time to hide missing reports. An enabled monitor
with missing or invalid configuration must report unknown health, not success.

## What the website comparison proves

The exporter rebuilds `player_history.json` and all JSON files under
`game_stats/`, including individual box scores, season indexes and leader
summaries. Stored database payloads supply the sports statistics. The verifier
also compares the normalized database tables and supported totals with those
payloads, so a preserved JSON payload does not conceal damaged table rows.

Some companion information is not yet in the database: collection timestamps,
coverage declarations and upcoming schedule entries without saved box scores.
The exporter uses those specific fields from the reference files and records
their source, hash and purpose in its comparison report. It rebuilds leader
values and archived game entries from database records rather than copying the
reference results.

Rankings, projections, ADP, odds, news, live scores, snap counts and play-by-play
are outside this statistics export. They have additional inputs that this
database does not store. Passing the statistics comparison does not establish
that every website page can be rebuilt from the database alone.

For an independent comparison using the existing restricted connection and CA
certificate:

```sh
python database_stats.py export-check --output-dir /new/private/stats-output --report /new/private/stats-report.json
```

Use new output/report paths outside the checkout, with existing parent folders.
The export is read-only at the database. It accepts an output folder only when
every included artifact matches. JSON content and ordered rows must match;
differences in whitespace and file formatting are reported separately. Missing
newer source metadata is reported rather than invented.

The workflow uploads comparison evidence, not the generated website files.
`ready_for_cutover` remains false. Changing the live website's data source is a
separate reviewed release after deciding how all companion inputs are stored
and refreshed.

## Recovery: backup versus restore test

A backup is a saved copy. A restore test opens that copy in a separate database
and proves that its structure and data can be read again. Archive snapshots in
application tables are useful history, but are not an independent backup.

Use an isolated compatible Supabase/PostgreSQL environment for a downloaded
platform backup. Pin the source PostgreSQL image version, check the backup's
checksum, and never point a drill at the production connection. Keep backups
outside this public repository: they may contain authentication records and
other private data.

Check the restored table inventory, all saved row fingerprints, constraints,
indexes, policies, grants and sequence state. Compare the restored backup with
its own date's expected state; an older backup is not expected to contain newer
imports. Restoring the public archive into an ordinary local PostgreSQL server
is a useful separate test, but does not prove a full Supabase backup restores.

Stop the test environment when finished. Do not treat a successful database
restore as proof that external files, API settings, OAuth providers or website
hosting have also been recovered.

References:
- [Supabase: restore a downloaded backup locally](https://supabase.com/docs/guides/local-development/restoring-downloaded-backup)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [GitHub notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-your-personal-notifications/configuring-notifications)
