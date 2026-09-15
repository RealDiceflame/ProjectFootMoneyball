"""Permission checks on an explicitly configured disposable, local PostgreSQL DB.

Role creation, grants, schema creation, imports and denial probes are all rolled
back. These tests never enable LOGIN, set a password, or contact a remote DB.
"""
from copy import deepcopy
from datetime import timedelta
import os
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from app.stats_database import database_counts, import_snapshots, migrate
from app.stats_import import load_saved_stats, prepare_snapshot

ROOT = Path(__file__).resolve().parents[1]
ROLE = "ob_stats_ingest"
APPEND_TABLES = (
    "source_snapshots", "snapshot_observations", "games", "game_revisions",
    "player_game_stats", "team_game_stats", "player_season_stats",
)
MUTABLE_TABLES = ("players", "snapshot_heads")
TABLES = ("schema_migrations",) + APPEND_TABLES + MUTABLE_TABLES
VIEWS = ("current_games", "current_player_game_stats", "current_team_game_stats",
         "current_player_season_stats")
API_ROLES = ("anon", "authenticated", "service_role", "authenticator")


@pytest.fixture
def owner():
    url = os.environ.get("OUTLIER_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Real PostgreSQL test database not configured")
    target = urlsplit(url)
    if (target.hostname not in {"127.0.0.1", "localhost", "::1"}
            or target.path != "/outlier_test" or target.query):
        pytest.fail("Tests require a disposable loopback database named outlier_test")
    import psycopg

    with psycopg.connect(url, autocommit=True) as connection:
        with connection.transaction(force_rollback=True):
            yield connection


@pytest.fixture
def conn(owner):
    migrate(owner)
    yield owner


@pytest.fixture(scope="module")
def snapshots():
    return load_saved_stats(ROOT)


def denied(conn, statement):
    import psycopg

    # Each failing SQL statement gets a savepoint so the enclosing test and its
    # final rollback stay usable. Require permission denial, not a syntax error.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            conn.execute(statement)


def test_role_attributes_memberships_and_exact_permissions(conn):
    assert conn.execute("""SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolinherit FROM pg_roles
        WHERE rolname = %s""", (ROLE,)).fetchone() == (False,) * 7
    assert conn.execute("""SELECT count(*) FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=%s""", (ROLE,)).fetchone() == (0,)
    assert conn.execute("""SELECT count(*) FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
        WHERE r.rolname=%s AND (member.rolname<>current_user OR NOT m.admin_option)""",
        (ROLE,)).fetchone() == (0,)
    assert conn.execute("SELECT has_schema_privilege(%s, 'ob_stats', 'USAGE')", (ROLE,)).fetchone() == (True,)
    assert conn.execute("SELECT has_schema_privilege(%s, 'ob_stats', 'CREATE')", (ROLE,)).fetchone() == (False,)
    assert conn.execute("SELECT has_database_privilege(%s, current_database(), 'CREATE')", (ROLE,)).fetchone() == (False,)
    for table in TABLES + VIEWS:
        allowed = {"SELECT"}
        if table in APPEND_TABLES + MUTABLE_TABLES:
            allowed.add("INSERT")
        if table in MUTABLE_TABLES:
            allowed.add("UPDATE")
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            actual = conn.execute("SELECT has_table_privilege(%s, %s, %s)",
                                  (ROLE, "ob_stats." + table, privilege)).fetchone()[0]
            assert actual == (privilege in allowed), (table, privilege)
            assert not conn.execute("SELECT has_table_privilege(%s, %s, %s)",
                                    (ROLE, "ob_stats." + table, privilege + " WITH GRANT OPTION")).fetchone()[0]
    for sequence in ("source_snapshots_snapshot_id_seq", "snapshot_observations_observation_id_seq"):
        for privilege in ("USAGE", "SELECT", "UPDATE"):
            assert conn.execute("SELECT has_sequence_privilege(%s, %s, %s)",
                                (ROLE, "ob_stats." + sequence, privilege)).fetchone()[0] == (privilege == "USAGE")
    assert conn.execute("""SELECT count(*) FROM pg_default_acl d,
        LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee
        WHERE r.rolname=%s""", (ROLE,)).fetchone() == (0,)


def test_rls_policies_are_action_specific_and_only_for_ingestion(conn):
    role_oid = conn.execute("SELECT oid FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone()[0]
    policies = conn.execute("""SELECT c.relname, c.relrowsecurity, p.polcmd, p.polroles
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname='ob_stats'""").fetchall()
    expected = {(table, "r") for table in TABLES}
    expected |= {(table, "a") for table in APPEND_TABLES + MUTABLE_TABLES}
    expected |= {(table, "w") for table in MUTABLE_TABLES}
    assert {(table, command) for table, _, command, _ in policies} == expected
    assert all(enabled and roles == [role_oid] for _, enabled, _, roles in policies)


def test_restricted_import_repeat_correction_and_identity_update(conn, snapshots):
    conn.execute("SET LOCAL ROLE ob_stats_ingest")
    assert conn.execute("SELECT count(*) FROM ob_stats.schema_migrations").fetchone()[0] >= 2
    assert import_snapshots(conn, snapshots)["inserted"] == len(snapshots)
    before = database_counts(conn)
    assert import_snapshots(conn, snapshots)["unchanged"] == len(snapshots)
    assert database_counts(conn) == before

    original = next(s for s in snapshots if s.dataset == "game" and len(s.player_games) > 1)
    payload = deepcopy(original.payload)
    removed = payload["players"].pop(0)
    removed_id = removed[payload["player_columns"].index("player_id")]
    payload["updated_at"] = (original.source_updated_at + timedelta(days=1)).isoformat()
    correction = prepare_snapshot(payload, original.source_path)
    assert import_snapshots(conn, [correction])["inserted"] == 1
    assert conn.execute("""SELECT count(*) FROM ob_stats.player_game_stats
        WHERE game_id=%s AND player_id IS NOT DISTINCT FROM %s""",
        (original.object_key, removed_id)).fetchone()[0] >= 1
    assert conn.execute("""SELECT count(*) FROM ob_stats.current_player_game_stats
        WHERE game_id=%s AND player_id IS NOT DISTINCT FROM %s""",
        (original.object_key, removed_id)).fetchone() == (0,)
    assert import_snapshots(conn, [original])["older_archived"] == 1

    history = next(s for s in snapshots if s.dataset == "player_history")
    payload = deepcopy(history.payload)
    player = next(iter(payload["players"].values()))
    player["player"] = "Permission Test Correction"
    player["birth_date"] = "1997-01-02"
    # Ensure this identity correction is newer than both game and history data.
    payload["generated_at"] = (max(s.source_updated_at for s in snapshots) + timedelta(days=3)).isoformat()
    import_snapshots(conn, [prepare_snapshot(payload, history.source_path)])
    assert conn.execute("SELECT display_name, birth_date::text FROM ob_stats.players WHERE player_id=%s",
                        (player["player_id"],)).fetchone() == ("Permission Test Correction", "1997-01-02")


def test_restricted_role_cannot_rewrite_archive_or_manage_schema(conn, snapshots):
    conn.execute("SET LOCAL ROLE ob_stats_ingest")
    import_snapshots(conn, [next(s for s in snapshots if s.dataset == "game")])
    before = database_counts(conn)
    for table in APPEND_TABLES + ("schema_migrations",):
        denied(conn, f"UPDATE ob_stats.{table} SET " + {
            "schema_migrations": "checksum=checksum", "source_snapshots": "source_path=source_path",
            "snapshot_observations": "file_sha256=file_sha256", "games": "home_team=home_team",
            "game_revisions": "metadata=metadata", "player_game_stats": "stats=stats",
            "team_game_stats": "stats=stats", "player_season_stats": "stats=stats",
        }[table])
    for table in TABLES:
        denied(conn, f"DELETE FROM ob_stats.{table}")
        denied(conn, f"TRUNCATE ob_stats.{table} CASCADE")
    for statement in (
        "INSERT INTO ob_stats.schema_migrations (version,checksum) VALUES ('permission-test','x')",
        "CREATE SCHEMA ob_stats_permission_test",
        "CREATE TABLE ob_stats.permission_test (id int)",
        "ALTER TABLE ob_stats.players ADD COLUMN permission_test int",
        "DROP TABLE ob_stats.player_game_stats",
        "DROP SCHEMA ob_stats CASCADE",
        "ALTER TABLE ob_stats.players DISABLE ROW LEVEL SECURITY",
        "CREATE POLICY permission_test ON ob_stats.players USING (true)",
        "SELECT setval('ob_stats.source_snapshots_snapshot_id_seq', 1)",
        "CREATE ROLE ob_stats_permission_test",
        "ALTER ROLE ob_stats_ingest CREATEROLE",
    ):
        denied(conn, statement)
    assert database_counts(conn) == before


def test_future_tables_receive_no_implicit_ingestion_access(conn):
    conn.execute("CREATE TABLE ob_stats.permission_future (id integer)")
    conn.execute("CREATE SEQUENCE ob_stats.permission_future_seq")
    conn.execute("SET LOCAL ROLE ob_stats_ingest")
    denied(conn, "SELECT * FROM ob_stats.permission_future")
    denied(conn, "INSERT INTO ob_stats.permission_future VALUES (1)")
    denied(conn, "SELECT nextval('ob_stats.permission_future_seq')")


@pytest.mark.parametrize("api_role", API_ROLES)
def test_api_roles_cannot_access_private_archive(owner, api_role):
    from psycopg import sql

    exists = owner.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (api_role,)).fetchone()
    if not exists:
        # Simulate Supabase roles inside the same rollback-only transaction.
        suffix = " BYPASSRLS" if api_role == "service_role" else ""
        owner.execute(sql.SQL("CREATE ROLE {} NOLOGIN" + suffix).format(sql.Identifier(api_role)))
    migrate(owner)
    assert not owner.execute("SELECT pg_has_role(%s, %s, 'MEMBER')", (api_role, ROLE)).fetchone()[0]
    assert not owner.execute("SELECT has_schema_privilege(%s, 'ob_stats', 'USAGE')", (api_role,)).fetchone()[0]
    owner.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(api_role)))
    for table in TABLES + VIEWS:
        denied(owner, f"SELECT * FROM ob_stats.{table}")
    denied(owner, "INSERT INTO ob_stats.players (player_id,display_name,source_updated_at) VALUES ('00-1234567','Test',now())")


@pytest.mark.parametrize("attributes", ["NOLOGIN", "LOGIN", "CREATEROLE", "BYPASSRLS", "SUPERUSER"])
def test_migration_refuses_any_preexisting_role(owner, attributes):
    from psycopg import errors, sql

    owner.execute(sql.SQL("CREATE ROLE ob_stats_ingest " + attributes))
    with pytest.raises(errors.RaiseException, match="already exists"):
        with owner.transaction():
            migrate(owner)
    # Refusal did not change that existing role or leave partial schema writes.
    assert owner.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone() == (1,)
    assert owner.execute("SELECT to_regnamespace('ob_stats')").fetchone() == (None,)


def test_migration_refuses_preexisting_role_with_membership(owner):
    from psycopg import errors

    owner.execute("CREATE ROLE ob_stats_ingest NOLOGIN NOINHERIT")
    owner.execute("CREATE ROLE ob_stats_permission_parent NOLOGIN")
    owner.execute("GRANT ob_stats_permission_parent TO ob_stats_ingest")
    with pytest.raises(errors.RaiseException, match="already exists"):
        with owner.transaction():
            migrate(owner)
    assert owner.execute("SELECT pg_has_role('ob_stats_ingest', 'ob_stats_permission_parent', 'MEMBER')").fetchone() == (True,)


def test_migration_refuses_inherited_public_database_create(owner):
    from psycopg import errors, sql

    database = owner.execute("SELECT current_database()").fetchone()[0]
    owner.execute(sql.SQL("GRANT CREATE ON DATABASE {} TO PUBLIC").format(sql.Identifier(database)))
    with pytest.raises(errors.RaiseException, match="PUBLIC database CREATE"):
        with owner.transaction():
            migrate(owner)
    assert owner.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone() is None


def test_migration_refuses_api_access_inherited_from_owner(owner):
    from psycopg import errors

    if owner.execute("SELECT 1 FROM pg_roles WHERE rolname='anon'").fetchone():
        pytest.skip("Simulated inherited API membership requires an unused anon role")
    owner.execute("CREATE ROLE anon NOLOGIN INHERIT")
    # A separate role owns the test schema; the migration runner still has the
    # local fixture's superuser privileges. Do not alter a real API role.
    owner.execute("CREATE ROLE ob_stats_permission_owner NOLOGIN")
    owner.execute("CREATE SCHEMA ob_stats AUTHORIZATION ob_stats_permission_owner")
    owner.execute("GRANT ob_stats_permission_owner TO anon")
    with pytest.raises(errors.RaiseException, match="API role retains"):
        with owner.transaction():
            migrate(owner)
    assert owner.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone() is None


def test_role_state_accepts_expected_permissions_and_owner_admin_grant(conn):
    from psycopg import sql
    from app.stats_access import ingest_role_state

    assert ingest_role_state(conn) is False
    owner_name = conn.execute("SELECT current_user").fetchone()[0]
    conn.execute(sql.SQL("GRANT ob_stats_ingest TO {} WITH ADMIN OPTION").format(sql.Identifier(owner_name)))
    assert ingest_role_state(conn) is False
    conn.execute("SET LOCAL ROLE ob_stats_ingest")
    assert ingest_role_state(conn) is False


@pytest.mark.parametrize("grant", [
    "GRANT UPDATE ON ob_stats.source_snapshots TO ob_stats_ingest",
    "GRANT UPDATE (source_path) ON ob_stats.source_snapshots TO ob_stats_ingest",
    "GRANT INSERT (version) ON ob_stats.schema_migrations TO ob_stats_ingest",
    "GRANT DELETE ON ob_stats.players TO ob_stats_ingest",
    "GRANT TRUNCATE ON ob_stats.players TO ob_stats_ingest",
    "GRANT SELECT ON ob_stats.current_games TO ob_stats_ingest WITH GRANT OPTION",
    "GRANT SELECT (display_name) ON ob_stats.players TO ob_stats_ingest WITH GRANT OPTION",
    "GRANT SELECT ON SEQUENCE ob_stats.source_snapshots_snapshot_id_seq TO ob_stats_ingest",
    "GRANT UPDATE ON SEQUENCE ob_stats.source_snapshots_snapshot_id_seq TO ob_stats_ingest",
    "GRANT USAGE ON SEQUENCE ob_stats.source_snapshots_snapshot_id_seq TO ob_stats_ingest WITH GRANT OPTION",
    "GRANT CREATE ON SCHEMA ob_stats TO ob_stats_ingest",
    "GRANT CREATE ON SCHEMA public TO ob_stats_ingest",
    "GRANT CREATE ON DATABASE outlier_test TO PUBLIC",
    "GRANT USAGE ON SCHEMA ob_stats TO ob_stats_ingest WITH GRANT OPTION",
    "GRANT USAGE ON SCHEMA ob_stats TO PUBLIC",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA ob_stats GRANT SELECT ON TABLES TO ob_stats_ingest",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA ob_stats GRANT SELECT ON TABLES TO PUBLIC",
    "REVOKE INSERT ON ob_stats.source_snapshots FROM ob_stats_ingest",
])
def test_role_state_rejects_privilege_drift(conn, grant):
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    conn.execute(grant)
    with pytest.raises(DatabaseSafetyError, match="owner review"):
        ingest_role_state(conn)
    assert not conn.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone()[0]


def test_role_state_rejects_maintenance_privilege_on_postgres_17_plus(conn):
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    if int(conn.execute("SHOW server_version_num").fetchone()[0]) < 170000:
        pytest.skip("MAINTAIN privilege was added in PostgreSQL 17")
    conn.execute("GRANT MAINTAIN ON ob_stats.players TO ob_stats_ingest")
    with pytest.raises(DatabaseSafetyError, match="table or column permissions"):
        ingest_role_state(conn)


@pytest.mark.parametrize("statement", [
    "CREATE SCHEMA ob_stats_permission_owned AUTHORIZATION ob_stats_ingest",
    "ALTER DATABASE outlier_test OWNER TO ob_stats_ingest",
    "ALTER TABLE ob_stats.players OWNER TO ob_stats_ingest",
])
def test_role_state_rejects_object_schema_or_database_ownership(conn, statement):
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    conn.execute(statement)
    with pytest.raises(DatabaseSafetyError, match="must not own"):
        ingest_role_state(conn)


@pytest.mark.parametrize("role_name", ["anon", "authenticated", "service_role", "authenticator", "ob_stats_permission_other"])
def test_role_state_rejects_unexpected_members_even_with_admin_option(conn, role_name):
    from psycopg import sql
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role_name,)).fetchone():
        conn.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role_name)))
    conn.execute(sql.SQL("GRANT ob_stats_ingest TO {} WITH ADMIN OPTION").format(sql.Identifier(role_name)))
    with pytest.raises(DatabaseSafetyError, match="unexpected membership"):
        ingest_role_state(conn)


def test_role_state_rejects_api_schema_access_without_membership(conn):
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname='anon'").fetchone():
        conn.execute("CREATE ROLE anon NOLOGIN")
    conn.execute("GRANT USAGE ON SCHEMA ob_stats TO anon")
    with pytest.raises(DatabaseSafetyError, match="API isolation"):
        ingest_role_state(conn)


def test_role_state_allows_new_ungranted_objects_and_rejects_future_object_grants(conn):
    from app.stats_access import DatabaseSafetyError, ingest_role_state

    conn.execute("CREATE TABLE ob_stats.permission_future (id integer)")
    conn.execute("CREATE SEQUENCE ob_stats.permission_future_seq")
    assert ingest_role_state(conn) is False
    with conn.transaction(force_rollback=True):
        conn.execute("GRANT SELECT ON ob_stats.permission_future TO ob_stats_ingest")
        with pytest.raises(DatabaseSafetyError, match="table or column permissions"):
            ingest_role_state(conn)
    conn.execute("GRANT USAGE ON SEQUENCE ob_stats.permission_future_seq TO ob_stats_ingest")
    with pytest.raises(DatabaseSafetyError, match="sequence permissions"):
        ingest_role_state(conn)
