"""Safety checks for the private, non-administrator statistics updater."""
from hashlib import sha256

from app.stats_database import MIGRATIONS, begin_write

INGEST_ROLE = "ob_stats_ingest"


class DatabaseSafetyError(ValueError):
    """A fixed, user-safe diagnostic; never include connection/driver text."""


def require_current_migrations(conn):
    expected = {path.name: sha256(path.read_text(encoding="utf-8").encode("utf-8")).hexdigest()
                for path in sorted(MIGRATIONS.glob("*.sql"))}
    installed = dict(conn.execute("SELECT version, checksum FROM ob_stats.schema_migrations").fetchall())
    if installed != expected:
        raise DatabaseSafetyError("Database migrations need owner review before syncing. No automatic migrations were run.")


def ingest_role_state(conn):
    row = conn.execute("""SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=%s""",
        (INGEST_ROLE,)).fetchone()
    if not row or any(row[1:]):
        raise DatabaseSafetyError("The restricted updater role is missing or has unexpected privileges.")
    if conn.execute("""SELECT EXISTS (SELECT 1 FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=%s)""", (INGEST_ROLE,)).fetchone()[0]:
        raise DatabaseSafetyError("The updater role must not be a member of another database role.")
    if conn.execute("""SELECT EXISTS (SELECT 1 FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
        WHERE r.rolname=%s AND (
            m.member IS DISTINCT FROM (SELECT nspowner FROM pg_namespace WHERE nspname='ob_stats')
            OR NOT m.admin_option
            OR member.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')))""",
        (INGEST_ROLE,)).fetchone()[0]:
        raise DatabaseSafetyError("Only the archive owner may administer the updater role; unexpected membership needs owner review.")
    if conn.execute("""SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname=%s AND (
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba=r.oid)))""",
        (INGEST_ROLE,)).fetchone()[0]:
        raise DatabaseSafetyError("The updater role must not own database objects, schemas, or databases.")
    require_ingest_permissions(conn)
    return row[0]


def require_ingest_permissions(conn):
    """Check effective grants, including PUBLIC and column grants, without edits.

    Migration checksums establish the expected schema version, but cannot detect
    later manual privilege changes. Keep this allowlist aligned with reviewed
    migrations; unknown objects receive no implicit ingestion permissions.
    """
    schema = conn.execute("""SELECT
        has_schema_privilege(%(role)s, 'ob_stats', 'USAGE'),
        has_schema_privilege(%(role)s, 'ob_stats', 'USAGE WITH GRANT OPTION'),
        EXISTS (SELECT 1 FROM pg_namespace n
            WHERE has_schema_privilege(%(role)s, n.oid, 'CREATE')),
        EXISTS (SELECT 1 FROM pg_database d
            WHERE has_database_privilege(%(role)s, d.oid, 'CREATE')),
        EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
            WHERE n.nspname='ob_stats' AND a.grantee=0 AND a.privilege_type='USAGE'),
        EXISTS (SELECT 1 FROM pg_roles r
            WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
              AND has_schema_privilege(r.oid, 'ob_stats', 'USAGE')),
        EXISTS (SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
            WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=%(role)s)
               OR (a.grantee=0 AND d.defaclobjtype IN ('r','S')
                   AND d.defaclnamespace IN (0, (SELECT oid FROM pg_namespace WHERE nspname='ob_stats'))))
        """, {"role": INGEST_ROLE}).fetchone()
    if not schema or not schema[0] or any(schema[1:]):
        raise DatabaseSafetyError("Updater schema access, API isolation, or future grants changed; owner review is required.")

    append_tables = {"source_snapshots", "snapshot_observations", "games", "game_revisions",
                     "player_game_stats", "team_game_stats", "player_season_stats"}
    mutable_tables = {"players", "snapshot_heads"}
    read_tables = {"schema_migrations", "current_games", "current_player_game_stats",
                   "current_team_game_stats", "current_player_season_stats"}
    expected_tables = append_tables | mutable_tables | read_tables
    tables = conn.execute("""WITH table_privileges AS (
        SELECT ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
            || CASE WHEN current_setting('server_version_num')::integer >= 170000
                THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END AS names)
        SELECT c.relname,
        ARRAY(SELECT p FROM unnest(table_privileges.names) p
            WHERE has_table_privilege(%(role)s, c.oid, p)),
        ARRAY(SELECT p FROM unnest(table_privileges.names) p
            WHERE has_table_privilege(%(role)s, c.oid, p || ' WITH GRANT OPTION')),
        ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
            WHERE has_any_column_privilege(%(role)s, c.oid, p)),
        ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
            WHERE has_any_column_privilege(%(role)s, c.oid, p || ' WITH GRANT OPTION'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN table_privileges
        WHERE n.nspname='ob_stats' AND c.relkind IN ('r','p','v','m','f')
        """, {"role": INGEST_ROLE}).fetchall()
    if not expected_tables <= {table[0] for table in tables}:
        raise DatabaseSafetyError("The updater archive objects are missing; owner review is required.")
    for name, privileges, grantable, columns, grantable_columns in tables:
        expected = {"SELECT"} if name in expected_tables else set()
        if name in append_tables | mutable_tables:
            expected.add("INSERT")
        if name in mutable_tables:
            expected.add("UPDATE")
        if set(privileges) != expected or not set(columns) <= expected or grantable or grantable_columns:
            raise DatabaseSafetyError("Updater table or column permissions changed; owner review is required.")

    expected_sequences = {"source_snapshots_snapshot_id_seq", "snapshot_observations_observation_id_seq"}
    sequences = conn.execute("""SELECT c.relname,
        ARRAY(SELECT p FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p
            WHERE has_sequence_privilege(%(role)s, c.oid, p)),
        ARRAY(SELECT p FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p
            WHERE has_sequence_privilege(%(role)s, c.oid, p || ' WITH GRANT OPTION'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ob_stats' AND c.relkind='S'
        """, {"role": INGEST_ROLE}).fetchall()
    if not expected_sequences <= {sequence[0] for sequence in sequences}:
        raise DatabaseSafetyError("The updater archive sequences are missing; owner review is required.")
    for name, privileges, grantable in sequences:
        expected = {"USAGE"} if name in expected_sequences else set()
        if set(privileges) != expected or grantable:
            raise DatabaseSafetyError("Updater sequence permissions changed; owner review is required.")


def require_ingest_connection(conn):
    if conn.execute("SELECT current_user").fetchone()[0] != INGEST_ROLE:
        raise DatabaseSafetyError("Automatic sync requires the restricted updater account, not an administrator.")
    require_current_migrations(conn)
    if not ingest_role_state(conn):
        raise DatabaseSafetyError("The updater login has not been enabled yet.")


def configure_ingest_login(conn, password):
    """Enable only our new role; never silently rotate an existing login."""
    from psycopg import sql

    if not isinstance(password, str) or len(password) < 24 or "\x00" in password:
        raise DatabaseSafetyError("Use a new password-manager-generated updater password of at least 24 characters.")
    with conn.transaction():
        begin_write(conn)
        require_current_migrations(conn)
        if ingest_role_state(conn):
            raise DatabaseSafetyError("The updater login is already enabled. Its password was not changed.")
        # Encrypt locally before SQL so plaintext never appears in statement logs.
        verifier = conn.pgconn.encrypt_password(password.encode("utf-8"),
                                               INGEST_ROLE.encode("ascii"), b"scram-sha-256")
        if not verifier.startswith(b"SCRAM-SHA-256$"):
            raise DatabaseSafetyError("A SCRAM password verifier could not be created.")
        conn.execute(sql.SQL("ALTER ROLE {} LOGIN PASSWORD {}").format(
            sql.Identifier(INGEST_ROLE), sql.Literal(verifier.decode("ascii"))))


def sync_database(conn, snapshots):
    """Import an atomic batch, then independently verify it; never publish files."""
    from app.stats_database import import_snapshots
    from app.stats_verification import verify_database

    require_ingest_connection(conn)
    imported = import_snapshots(conn, snapshots)
    verified = verify_database(conn, snapshots)
    return {"import": imported, "verification": verified, "website_changed": False}
