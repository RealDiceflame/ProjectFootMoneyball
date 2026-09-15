"""Updater CLI checks never use real credentials or open an external database."""
from contextlib import nullcontext
import getpass
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlsplit

import pytest

import database_stats
from app import stats_access, stats_database


TEMPLATE = "postgresql://ob_stats_ingest.example:[YOUR-PASSWORD]@db.example.test:5432/postgres"


@pytest.fixture
def sync_env(monkeypatch):
    monkeypatch.setenv("OUTLIER_DATABASE_URL", TEMPLATE)
    monkeypatch.setenv("OUTLIER_DATABASE_PASSWORD", "synthetic :@secret[]")
    monkeypatch.setenv("OUTLIER_DATABASE_SSLROOTCERT", str(Path(__file__)))


def test_sync_separates_secret_from_public_template(sync_env):
    original = os.environ["OUTLIER_DATABASE_URL"]
    url = database_stats.sync_connection_url()
    assert "synthetic%20%3A%40secret%5B%5D" in url
    assert os.environ["OUTLIER_DATABASE_URL"] == original


@pytest.mark.parametrize("override", [
    {"OUTLIER_DATABASE_SSLROOTCERT": ""},
    {"OUTLIER_DATABASE_SSLROOTCERT": "/missing/outlier-certificate.pem"},
    {"OUTLIER_DATABASE_PASSWORD": ""},
    {"OUTLIER_DATABASE_URL": TEMPLATE.replace("ob_stats_ingest.example", "postgres.example")},
    {"OUTLIER_DATABASE_URL": TEMPLATE.replace("[YOUR-PASSWORD]", "inline-secret")},
])
def test_sync_rejects_missing_or_admin_credentials_before_connect(sync_env, monkeypatch, override):
    for key, value in override.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        database_stats.sync_connection_url()


def test_sync_cli_uses_only_sync_operation(sync_env, monkeypatch, capsys):
    snapshots = [object()]
    connection = object()
    monkeypatch.setattr(database_stats, "load_saved_stats", Mock(return_value=snapshots))
    connect = Mock(return_value=nullcontext(connection))
    monkeypatch.setattr(stats_database, "connect_database", connect)
    sync = Mock(return_value={"verified": True})
    monkeypatch.setattr(stats_access, "sync_database", sync)
    migrate = Mock(side_effect=AssertionError("sync cannot migrate"))
    monkeypatch.setattr(stats_database, "migrate", migrate)
    assert database_stats.main(["sync"]) == 0
    sync.assert_called_once_with(connection, snapshots)
    migrate.assert_not_called()
    output = capsys.readouterr().out
    assert "synthetic" not in output and "postgresql://" not in output


def test_role_check_precedes_all_sync_writes(monkeypatch):
    connection = object()
    monkeypatch.setattr(stats_access, "require_ingest_connection",
                        Mock(side_effect=stats_access.DatabaseSafetyError("Restricted role required.")))
    importer = Mock()
    monkeypatch.setattr(stats_database, "import_snapshots", importer)
    with pytest.raises(stats_access.DatabaseSafetyError):
        stats_access.sync_database(connection, [])
    importer.assert_not_called()


def test_configuration_sends_scram_verifier_not_plaintext(monkeypatch):
    connection = Mock()
    connection.transaction.return_value = nullcontext()
    verifier = b"SCRAM-SHA-256$synthetic-verifier"
    connection.pgconn.encrypt_password.return_value = verifier
    monkeypatch.setattr(stats_access, "begin_write", Mock())
    monkeypatch.setattr(stats_access, "require_current_migrations", Mock())
    monkeypatch.setattr(stats_access, "ingest_role_state", Mock(return_value=False))
    # Render composition without a driver connection; preserve visible statement structure.
    class SQL:
        def __init__(self, value):
            self.value = value
        def format(self, *args):
            return self.value.format(*args)
    fake_sql = SimpleNamespace(SQL=SQL, Identifier=lambda value: value, Literal=lambda value: repr(value))
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(sql=fake_sql))
    password = "synthetic-updater-secret-32chars"
    stats_access.configure_ingest_login(connection, password)
    statement = connection.execute.call_args.args[0]
    assert "SCRAM-SHA-256$" in statement and password not in statement
    assert statement.startswith("ALTER ROLE ob_stats_ingest LOGIN PASSWORD")


def test_existing_login_is_never_silently_rotated(monkeypatch):
    connection = Mock()
    connection.transaction.return_value = nullcontext()
    monkeypatch.setattr(stats_access, "begin_write", Mock())
    monkeypatch.setattr(stats_access, "require_current_migrations", Mock())
    monkeypatch.setattr(stats_access, "ingest_role_state", Mock(return_value=True))
    with pytest.raises(stats_access.DatabaseSafetyError, match="already enabled"):
        stats_access.configure_ingest_login(connection, "synthetic-updater-secret-32chars")
    connection.pgconn.encrypt_password.assert_not_called()


def test_prepare_sync_requires_verified_tls_before_password(monkeypatch, capsys):
    monkeypatch.delenv("OUTLIER_DATABASE_SSLROOTCERT", raising=False)
    prompt = Mock()
    monkeypatch.setattr(getpass, "getpass", prompt)
    assert database_stats.main(["prepare-sync", "--prompt-password"]) == 1
    prompt.assert_not_called()
    assert "CA certificate" in capsys.readouterr().out


@pytest.fixture
def real_conn():
    url = os.environ.get("OUTLIER_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Disposable PostgreSQL test database not configured")
    target = urlsplit(url)
    if target.hostname not in {"127.0.0.1", "localhost", "::1"} or target.path != "/outlier_test" or target.query:
        pytest.fail("Tests require a disposable loopback database named outlier_test")
    import psycopg
    with psycopg.connect(url, autocommit=True) as connection:
        with connection.transaction(force_rollback=True):
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            stats_database.migrate(connection)
            yield connection


def test_real_role_activation_and_restricted_verified_sync(real_conn):
    from app.stats_import import load_saved_stats

    password = "synthetic-ci-updater-not-a-production-secret"
    stats_access.configure_ingest_login(real_conn, password)
    record = real_conn.execute("SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname='ob_stats_ingest'").fetchone()
    assert record[0] and record[1].startswith("SCRAM-SHA-256$")
    assert password not in record[1]
    with pytest.raises(stats_access.DatabaseSafetyError, match="already enabled"):
        stats_access.configure_ingest_login(real_conn, password)
    real_conn.execute("SET LOCAL ROLE ob_stats_ingest")
    result = stats_access.sync_database(real_conn, load_saved_stats(Path(__file__).resolve().parents[1]))
    assert result["verification"]["verified"] is True
    assert result["website_changed"] is False
    assert result["import"]["inserted"] > 0
