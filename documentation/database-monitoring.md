# Private database monitoring

For the everyday workflow and recovery steps, see [Database operations](database-operations.md).

The saved-data collectors remain the clock for database updates. Successful
`Update site data` and `Update game stats` runs trigger `Sync private stats
database`. There is no second database-sync timer.

After importing and verifying the archive, sync saves a small `stats-sync-health`
artifact containing only counts, completion time, the triggering run ID, and
database/application byte sizes. The later shadow-export check has a separate
report; its failure does not falsely claim the already-verified import failed.
Neither exported records nor credentials are uploaded.

`Monitor private database sync` runs hourly and when a sync finishes. It reads
GitHub run metadata and the aggregate health artifacts. It has no database
password or database connection. Its permissions are `contents: read`,
`actions: read`, and `issues: write`.

## Activation and thresholds

Set `STATS_MONITOR_ACTIVE_SINCE` to the UTC deployment timestamp, for example an
ISO timestamp ending in `Z`. This is required: missing/invalid activation time
creates a monitoring incident rather than silently treating health as known.
Legacy successful runs beginning before activation may supply a temporary
freshness heartbeat. Every successful run starting after activation must have
valid health evidence. Artifact identities, repository, workflow, run attempt,
and completion times are checked against the actual workflow run.

The existing `STATS_DATABASE_SYNC_ENABLED=true` flag enables both sync and its
monitor. Optional repository variables override these defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATS_MONITOR_STALE_HOURS` | `10` | No successful verification within ten hours needs attention. |
| `STATS_MONITOR_WARN_BYTES` | `1073741824` | Review storage when the database reaches 1 GiB. |
| `STATS_MONITOR_GROWTH_BYTES` | `262144000` | Growth must be at least 250 MiB within 24 hours. |
| `STATS_MONITOR_GROWTH_RATIO` | `0.25` | Growth must also be at least 25% within the same window. |

Collector-to-sync delay and queued/running sync grace are three hours. Normal
collector schedules are six hours apart. Later automatic syncs use current main
and can cover coalesced earlier collector events; a manual run is not proof of
the automatic chain.

Database byte size is **not** total allocated disk usage, WAL size, free disk
space, or a billing forecast. The 1 GiB level is a review warning, not a charge
threshold. Storage growth checks begin once at least two valid samples exist.

## Alerts and recovery

The monitor maintains one issue for each active category: sync, scheduled
collectors, storage, shadow export, or unavailable monitoring evidence. New and
reopened issues are assigned to repository owner `RealDiceflame`. Actual email
or push delivery follows that account's GitHub notification settings; this
workflow does not configure or guarantee a delivery channel.

Unchanged incidents create no comments or duplicate issues. Fresh recovery
evidence closes the existing issue; recurrence reopens it. An API or malformed
evidence failure preserves other incidents and reports monitoring as unknown.
A disabled sync flag leaves existing issues unchanged, rather than claiming
recovery. No test issue is needed for activation: offline tests exercise alert,
deduplication, assignment, and recovery paths.

Health artifacts are retained for 14 days. The monitor reads at most 32 recent
completed syncs; this covers several days at the normal cadence. The monitor
itself relies on GitHub Actions availability and scheduling, so its own failure
notifications should remain enabled in GitHub.
