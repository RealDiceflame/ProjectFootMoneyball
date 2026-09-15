"""Optional PostgreSQL shadow importer; never called by the public website."""
from hashlib import sha256
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from app.stats_import import canonical

MIGRATIONS = Path(__file__).resolve().parents[1] / "database/migrations"
LOCK_ID = 734829106  # Serializes only OutlierBaseline archive writes.


def connection_options(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.path.strip("/"):
            raise ValueError()
        query = parse_qs(parsed.query)
        if {"host", "hostaddr", "port", "dbname", "service", "servicefile"} & query.keys():
            raise ValueError()
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        sslmode = query.get("sslmode", ["disable" if local else "require"])[-1]
        if not local and sslmode not in {"require", "verify-ca", "verify-full"}:
            raise ValueError()
        # No passwords appear in options, diagnostics, or frontend files.
        return {"sslmode": sslmode, "connect_timeout": 10,
                "application_name": "outlierbaseline-stats-import"}
    except (ValueError, TypeError):
        raise ValueError("Set OUTLIER_DATABASE_URL to a PostgreSQL connection URI") from None


def connect_database(url=None):
    import psycopg

    if url is None:
        url = os.environ.get("OUTLIER_DATABASE_URL", "")
    options = connection_options(url)
    # A supplied CA lets libpq verify both certificate and hostname.
    certificate = os.environ.get("OUTLIER_DATABASE_SSLROOTCERT")
    if certificate:
        options.update(sslmode="verify-full", sslrootcert=certificate)
    return psycopg.connect(url, autocommit=True, **options)


def check_connection(conn):
    """Verify a new, even empty database without creating schema or loading data."""
    with conn.transaction():
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SET LOCAL statement_timeout = '10s'")
        if conn.execute("SELECT 1").fetchone() != (1,):
            raise ValueError("Database connection check failed")


def begin_write(conn):
    conn.execute("SET LOCAL lock_timeout = '10s'")
    conn.execute("SET LOCAL statement_timeout = '60s'")
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_ID,))


def migrate(conn):
    """Apply immutable, checked-in migrations in one transaction, without drops."""
    with conn.transaction():
        begin_write(conn)
        conn.execute("CREATE SCHEMA IF NOT EXISTS ob_stats")
        conn.execute("REVOKE ALL ON SCHEMA ob_stats FROM PUBLIC")
        conn.execute("""CREATE TABLE IF NOT EXISTS ob_stats.schema_migrations (
            version text PRIMARY KEY, checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp())""")
        installed = dict(conn.execute("SELECT version, checksum FROM ob_stats.schema_migrations").fetchall())
        files = sorted(MIGRATIONS.glob("*.sql"))
        if set(installed) - {path.name for path in files}:
            raise ValueError("Database has newer migrations than this checkout")
        applied = []
        for path in files:
            source = path.read_text(encoding="utf-8")
            checksum = sha256(source.encode("utf-8")).hexdigest()
            if path.name in installed:
                if installed[path.name] != checksum:
                    raise ValueError("An applied migration has changed; add a new migration instead")
                continue
            conn.execute(source)
            conn.execute("INSERT INTO ob_stats.schema_migrations (version, checksum) VALUES (%s, %s)", (path.name, checksum))
            applied.append(path.name)
        return applied


def insert_players(conn, snapshot):
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO ob_stats.players (player_id, display_name, birth_date, source_updated_at, birth_source_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (player_id) DO UPDATE SET
              display_name = CASE WHEN EXCLUDED.source_updated_at >= ob_stats.players.source_updated_at
                THEN EXCLUDED.display_name ELSE ob_stats.players.display_name END,
              birth_date = CASE WHEN EXCLUDED.birth_source_at IS NOT NULL AND
                (ob_stats.players.birth_source_at IS NULL OR EXCLUDED.birth_source_at >= ob_stats.players.birth_source_at)
                THEN EXCLUDED.birth_date ELSE ob_stats.players.birth_date END,
              birth_source_at = GREATEST(ob_stats.players.birth_source_at, EXCLUDED.birth_source_at),
              source_updated_at = GREATEST(ob_stats.players.source_updated_at, EXCLUDED.source_updated_at)""",
            [(p["player_id"], p["name"], p["birth_date"], snapshot.source_updated_at,
              snapshot.source_updated_at if p["birth_date"] else None) for p in snapshot.players])


def insert_facts(conn, snapshot_id, snapshot):
    with conn.cursor() as cur:
        if snapshot.dataset == "game":
            game = snapshot.payload["game"]
            identity = (snapshot.payload["season"], "REG", game["week"], game["home"], game["away"])
            cur.execute("""INSERT INTO ob_stats.games (game_id, season, season_type, week, home_team, away_team)
                VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (game_id) DO NOTHING""",
                (snapshot.object_key, *identity))
            current = cur.execute("""SELECT season, season_type, week, home_team, away_team
                FROM ob_stats.games WHERE game_id = %s""", (snapshot.object_key,)).fetchone()
            if tuple(current) != identity:
                raise ValueError("A game ID cannot change teams or season")
            cur.execute("INSERT INTO ob_stats.game_revisions (snapshot_id, game_id, metadata) VALUES (%s, %s, %s::jsonb)",
                        (snapshot_id, snapshot.object_key, canonical(game)))
            cur.executemany("""INSERT INTO ob_stats.player_game_stats
                (snapshot_id, game_id, row_key, player_id, player_name, team, opponent_team, position, stats)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
                [(snapshot_id, snapshot.object_key, p["row_key"], p["player_id"], p["player_name"],
                  p["team"], p["opponent_team"], p["position"], canonical(p["stats"])) for p in snapshot.player_games])
            cur.executemany("""INSERT INTO ob_stats.team_game_stats (snapshot_id, game_id, team, opponent_team, stats)
                VALUES (%s, %s, %s, %s, %s::jsonb)""",
                [(snapshot_id, snapshot.object_key, t["team"], t["opponent_team"], canonical(t["stats"])) for t in snapshot.team_games])
        else:
            cur.executemany("""INSERT INTO ob_stats.player_season_stats
                (snapshot_id, player_id, season, season_type, recent_team, position, stats)
                VALUES (%s, %s, %s, 'REG', %s, %s, %s::jsonb)""",
                [(snapshot_id, p["player_id"], p["season"], p["recent_team"], p["position"],
                  canonical(p["stats"])) for p in snapshot.player_seasons])


def import_snapshots(conn, snapshots):
    """One atomic batch; old vintages are archived but cannot replace newer heads."""
    counts = {"inserted": 0, "unchanged": 0, "older_archived": 0}
    with conn.transaction():
        begin_write(conn)
        for snapshot in snapshots:
            head = conn.execute("""SELECT h.snapshot_id, h.latest_source_at, s.content_sha256
                FROM ob_stats.snapshot_heads h JOIN ob_stats.source_snapshots s USING (snapshot_id)
                WHERE h.dataset = %s AND h.object_key = %s""", (snapshot.dataset, snapshot.object_key)).fetchone()
            conflict = conn.execute("""SELECT 1 FROM ob_stats.snapshot_observations o
                JOIN ob_stats.source_snapshots s USING (snapshot_id)
                WHERE s.dataset=%s AND s.object_key=%s AND o.source_updated_at=%s
                  AND s.content_sha256<>%s LIMIT 1""",
                (snapshot.dataset, snapshot.object_key, snapshot.source_updated_at, snapshot.content_hash)).fetchone()
            if conflict:
                raise ValueError("Conflicting contents share a source timestamp; review before importing")
            insert_players(conn, snapshot)
            result = conn.execute("""INSERT INTO ob_stats.source_snapshots
                (dataset, object_key, content_sha256, file_sha256, source_path, source_updated_at, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (dataset, object_key, content_sha256) DO NOTHING RETURNING snapshot_id""",
                (snapshot.dataset, snapshot.object_key, snapshot.content_hash, snapshot.file_hash,
                 snapshot.source_path, snapshot.source_updated_at, canonical(snapshot.payload))).fetchone()
            if result:
                snapshot_id = result[0]
                insert_facts(conn, snapshot_id, snapshot)
                counts["inserted"] += 1
            else:
                snapshot_id = conn.execute("""SELECT snapshot_id FROM ob_stats.source_snapshots
                    WHERE dataset = %s AND object_key = %s AND content_sha256 = %s""",
                    (snapshot.dataset, snapshot.object_key, snapshot.content_hash)).fetchone()[0]
                counts["unchanged"] += 1
            conn.execute("""INSERT INTO ob_stats.snapshot_observations
                (snapshot_id, source_updated_at, file_sha256) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                (snapshot_id, snapshot.source_updated_at, snapshot.file_hash))
            if head and head[1] > snapshot.source_updated_at:
                counts["older_archived"] += 1
                continue
            conn.execute("""INSERT INTO ob_stats.snapshot_heads (dataset, object_key, snapshot_id, latest_source_at)
                VALUES (%s, %s, %s, %s) ON CONFLICT (dataset, object_key) DO UPDATE
                SET snapshot_id = EXCLUDED.snapshot_id, latest_source_at = EXCLUDED.latest_source_at""",
                (snapshot.dataset, snapshot.object_key, snapshot_id, snapshot.source_updated_at))
    return counts


def database_counts(conn):
    # Fixed table names, never user-controlled SQL identifiers.
    return {name: conn.execute(query).fetchone()[0] for name, query in {
        "snapshots": "SELECT count(*) FROM ob_stats.source_snapshots",
        "players": "SELECT count(*) FROM ob_stats.players",
        "games": "SELECT count(*) FROM ob_stats.current_games",
        "player_game_rows": "SELECT count(*) FROM ob_stats.current_player_game_stats",
        "team_game_rows": "SELECT count(*) FROM ob_stats.current_team_game_stats",
        "player_season_rows": "SELECT count(*) FROM ob_stats.current_player_season_stats",
    }.items()}


def game_stat_totals(conn, season, metric, week=None):
    """Query SQL totals with allowlisted sum/max rules, preserving null and zero."""
    from app.league_leaders import MAXIMUM_STATS, STAT_GROUPS

    if metric not in {key for group in STAT_GROUPS.values() for key in group}:
        raise ValueError("Unsupported total statistic")
    # The only substituted SQL token is an internal choice, never supplied text.
    reducer = "MAX" if metric in MAXIMUM_STATS else "SUM"
    query = """SELECT player_id, """ + reducer + """((stats->>%s)::numeric)
        FROM ob_stats.current_player_game_stats
        WHERE season = %s AND player_id IS NOT NULL AND (%s::integer IS NULL OR week = %s)
        GROUP BY player_id ORDER BY player_id"""
    return {player_id: float(value) if value is not None else None
            for player_id, value in conn.execute(query, (metric, season, week, week)).fetchall()}
