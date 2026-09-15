# PostgreSQL statistics foundation

Status: **private shadow storage, not the live website's data source**. No
Supabase project, production credentials, or public database API is created
automatically. Scheduled sync is opt-in and disabled until its GitHub variable
and credentials are configured by the owner.

The current CSV/JSON collectors and website keep working unchanged. Phase one
imports the maintained 2016–2025 fantasy-player season archive and saved
regular-season game box scores. Initially this means 5,050 player-season rows,
16 games, 32 team-game rows, 1,118 player-game rows, and 2,063 known player IDs.
This is not every NFL player's complete ten-year career or historical game log.

## Prepare without an account

Run from the project folder:

```powershell
python database_stats.py plan
```

This validates all saved files and reports coverage without connecting to a
database, downloading data, or modifying the website.

## One-time Supabase setup

1. Sign in at https://supabase.com/dashboard and create an OutlierBaseline project.
2. Save its generated database password in a password manager. Choose a nearby
   region. The free tier can be used for initial testing; review current limits
   at https://supabase.com/pricing before enabling ongoing history collection.
3. Do not create tables manually or expose the `ob_stats` schema through the Data
   API. This first stage is private backend storage, not user accounts.
4. Use **Connect → Session pooler** for an IPv4-compatible PostgreSQL URI. Direct
   connections also work when the environment supports them. Use the real
   database password, not an anon/publishable API key. Passwords containing URI
   reserved characters must be percent-encoded.
5. Store the URI privately as the environment variable `OUTLIER_DATABASE_URL`.
   Never commit it, paste it into chat, embed it in JavaScript, or print it.
   The CLI does not automatically load a `.env` file. The existing `.env` ignore
   rules remain unchanged.
6. Remote connections require TLS. For certificate and hostname verification,
   download the database CA certificate and set
   `OUTLIER_DATABASE_SSLROOTCERT` to its local path. A URI's stronger
   `sslmode=verify-full` setting is preserved. Do not disable TLS.

For a local connection check, keep `[YOUR-PASSWORD]` in `OUTLIER_DATABASE_URL`
and run `python database_stats.py check --prompt-password` from a normal local
terminal. Password entry is hidden, URI reserved characters are encoded for you,
and the completed URI stays only in process memory, not the environment or a file.
The check uses a read-only transaction and does not require existing tables.
It refuses to fall back to visible password entry. The same flag can be used
with `migrate`, `import`, and `status` once those operations are approved.

After the connection has been stored securely, these are the separate,
explicit operations:

```powershell
python -m pip install -r requirements-database.txt
python database_stats.py migrate
python database_stats.py import
python database_stats.py status
```

`migrate` creates only the private `ob_stats` schema and tracks each migration's
checksum. It does not drop existing application tables or change `public` or
`auth`. Applied migrations must not be edited; add a new numbered file.
`import` requires those migrations to have been applied first. Both operations
must use the database owner during this first setup. No browser access is granted.

## Verification and restricted updater setup

`python database_stats.py verify --prompt-password` performs read-only checks
against the saved archive: current snapshot selection, source content hashes,
every normalized player/game/team/season row, all supported game sum/max metrics
for each season and week, and meaningful historical season totals. Failures
stop the process. Metadata limitations are reported separately: an old stored
payload may have an earlier collection clock than a later unchanged observation.
This is not evidence that an exact current website JSON export can be replayed.

Once the isolated PostgreSQL tests pass, the owner can run:

```powershell
python database_stats.py prepare-sync --prompt-password
```

Keep the owner URI **template** and certificate path in the same environment
used for initial setup. This command requires the certificate for verified TLS.
It applies additive migrations, brings the saved archive up to date, verifies
the database, and prompts for a **new, different updater password** twice. Use
a password manager to generate and save at least 24 characters. Nothing echoes
or writes the password to disk. PostgreSQL receives a client-generated SCRAM
verifier for account setup rather than a plaintext password in a SQL statement.

Migration `002_stats_ingest_role.sql` creates `ob_stats_ingest` with NOLOGIN.
Only the explicit setup command enables its login. Its grants/policies allow
reading the stats archive, appending new facts, and updating only player metadata
and current snapshot pointers. It cannot delete old facts, alter tables, update
past facts or migration records, create roles/databases, bypass RLS, or grant
those permissions to API roles. An existing role-name collision is rejected.
The setup command does not silently rotate an already-enabled password.

Earlier successful steps remain saved if a later setup step fails. No public
website content is written by setup or verification. Keep the original CSVs and
Git history and establish a separate database backup; snapshots are not backups.
No automatic history deletion is configured. Monitor database storage limits.

## Opt-in GitHub sync (no website cutover)

Configure **Settings → Secrets and variables → Actions** in the repository:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `OUTLIER_DATABASE_PASSWORD` | The new restricted updater password only; never the owner password |
| Variable | `OUTLIER_DATABASE_URL` | Session-pooler URI with username `ob_stats_ingest.<project-ref>` and literal `[YOUR-PASSWORD]` placeholder |
| Variable | `OUTLIER_DATABASE_CA_CERT` | Full downloaded CA certificate text, including BEGIN/END CERTIFICATE lines; this is public certificate data |
| Variable | `STATS_DATABASE_SYNC_ENABLED` | Leave unset/`false` while configuring; set `true` only when ready |

Copy the actual host, port, database, and project reference from the already
tested owner connection; change only the username to the new account and keep
the password placeholder. Do not guess the pooler host. The CLI safely encodes
the separate password in memory, including special characters.

When enabled, **Sync private stats database** runs after a successful main-branch
**Update site data** or **Update game stats** run. Those collectors already run
every six hours; this adds no competing timer. It can also be run manually on
main. It checks out current main, imports saved stats, then verifies facts and
SQL totals. Its token is read-only, its database identity must be the restricted
account, and certificate/hostname verification is mandatory. Missing configuration
fails visibly instead of pretending sync succeeded. Credentials are scoped to
the sync step and are never uploaded as workflow artifacts.

The upstream collectors and website publication remain independent. A sync
failure does not prevent the normal website files being published, and does not
replace them with unverified database output. An import is atomic, but a later
verification failure can occur after that complete import has committed; inspect
the failed run rather than assuming nothing was saved. Multiple sync requests
are serialized. Set `STATS_DATABASE_SYNC_ENABLED=false` to stop future sync jobs
(this does not cancel an already-running job). Password rotation is a separate,
explicit owner operation, followed by updating the GitHub secret.

After configuring the settings, manually run this workflow and confirm success
before relying on scheduled runs. The public frontend still reads existing JSON.
Database-backed JSON export and the website switch are a later stage, after the
metadata-vintage limitations and full artifact parity have been addressed.

## What is stored

- `players`: stable GSIS IDs and display metadata. Neither names nor
  name-plus-position are identities. Team/position belong to observations.
- `games`: stable game identity; `game_revisions` records changing metadata.
- `player_game_stats` and `team_game_stats`: every original statistical field,
  with original numeric/null/list values stored in PostgreSQL JSONB.
- `player_season_stats`: maintained historical seasons. `recent_team` describes
  the source's latest team, not proof every yearly statistic came on that team.
- `source_snapshots`: original parsed payload, exact-file hash, semantic content
  hash, source date, source path, and actual first database-import time.
- `snapshot_observations`: records subsequent source vintages, including a
  correction that returns to a previous content version.
- `snapshot_heads`: selects current versions without deleting older records.

The `current_*` views exclude superseded revisions and expose common yardage/TD
fields directly. Other fields remain queryable through `stats->>'field_name'`.
See `database/queries.sql` for read-only examples.

Unchanged data does not duplicate facts merely because a refresh timestamp
changes. Imports use parameters, foreign keys, uniqueness checks, a write lock,
and a single transaction for the whole batch. An invalid batch rolls back.
Older snapshots can be archived but cannot replace a newer current version.
Conflicting contents with identical source timestamps require review.
Corrected player credits replace the whole current game revision; stale
credited rows do not remain in current views.

Anonymous source events are preserved with a null player ID and a source-row
key. They are not fabricated players and must be excluded from player leaders.
Missing values stay null; a zero, a half-sack, negative yards, and kick-distance
lists retain their meanings. Do not sum percentages or longest-kick distances.

## Historical limits and next stage

The first import contains today's saved data vintage, not data as it was known
in 2016. Season is an event period; `source_updated_at` and `imported_at` are
different dates. Do not use these current corrected records for leakage-free
historical backtests without importing genuine earlier archived vintages.
Original CSV files and Git history remain intact. Database snapshots are not a
substitute for an independently restorable database backup.

Next: verify the real project's SQL totals, activate restricted sync, then build
a database-backed JSON exporter in parallel with the existing exporter. Only
switch website reads after full artifact parity checks pass. Injuries, ADP,
odds history, account permissions, and fantasy league storage are later phases,
not silently enabled by this importer.

## Tests

`python -m pytest tests/test_stats_import.py tests/test_stats_connection.py`
runs basic offline validation. Additional access, workflow and verification
tests cover secure setup and sync gating.
`Test stats database` on GitHub creates an isolated PostgreSQL 17 service and
checks real inserts, repeat imports, removed credits, retained revisions,
rollback, privacy, restricted-role permissions, fact parity and every supported
sum/max game metric against saved rows. This isolated CI never uses Supabase
credentials. The separate opt-in sync workflow is the only scheduled DB client.
Tests refuse a non-loopback URL or a database not named `outlier_test`.

References:
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/api/using-custom-schemas
- https://www.psycopg.org/psycopg3/docs/basic/params.html
- https://www.psycopg.org/psycopg3/docs/basic/transactions.html
