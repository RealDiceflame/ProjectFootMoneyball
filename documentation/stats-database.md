# PostgreSQL statistics foundation

Status: **shadow importer, not the live website's data source**. No Supabase
project, hosted database, production credentials, scheduled database sync, or
public database API is created by this code.

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

Do not add a scheduled production importer yet. Before doing so, create a
dedicated least-privilege ingest role, configure protected server-side secrets,
agree on retention/backups, and verify database output against the website.
If GitHub Actions is chosen later, use repository Actions secrets rather than
workflow literals. The current database workflow uses only a disposable test
database, never Supabase or a production secret.

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

Next: connect a project with explicit approval, import, verify counts and SQL
totals, then build a database-backed JSON exporter in parallel with the existing
exporter. Only switch website reads after parity checks pass. Injuries, ADP,
odds history, account permissions, and fantasy league storage are later phases,
not silently enabled by this importer.

## Tests

`python -m pytest tests/test_stats_import.py` runs offline validation.
`Test stats database` on GitHub creates an isolated PostgreSQL 17 service and
checks real inserts, repeat imports, removed credits, retained revisions,
rollback, privacy and every supported sum/max game metric against saved rows.
Tests refuse a non-loopback URL or a database not named `outlier_test`.

References:
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/api/using-custom-schemas
- https://www.psycopg.org/psycopg3/docs/basic/params.html
- https://www.psycopg.org/psycopg3/docs/basic/transactions.html
