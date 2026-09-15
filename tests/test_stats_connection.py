"""Connection setup checks use a fake driver and never contact a database."""
from contextlib import contextmanager
import getpass
import os
import sys
from types import SimpleNamespace
from unittest.mock import Mock
import warnings

import pytest

import database_stats
from app import stats_database


TEMPLATE = "postgresql://postgres:[YOUR-PASSWORD]@db.example.com:5432/postgres"


class ReadOnlyConnection:
    def __init__(self):
        self.in_transaction = False
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    @contextmanager
    def transaction(self):
        self.in_transaction = True
        try:
            yield
        finally:
            self.in_transaction = False

    def execute(self, query):
        assert self.in_transaction, "Connection checks must use a transaction"
        self.queries.append(query)
        return SimpleNamespace(fetchone=lambda: (1,))


@pytest.fixture(autouse=True)
def fake_driver(monkeypatch):
    connection = ReadOnlyConnection()
    driver = SimpleNamespace(connect=Mock(return_value=connection))
    monkeypatch.setitem(sys.modules, "psycopg", driver)
    monkeypatch.setenv("OUTLIER_DATABASE_URL", TEMPLATE)
    monkeypatch.delenv("OUTLIER_DATABASE_SSLROOTCERT", raising=False)
    return driver


def test_prompt_encodes_password_in_memory_without_echoing(monkeypatch, capsys, fake_driver):
    # Deliberately synthetic text covers URI delimiters, Unicode, and whitespace.
    password = " test:@/?#%[] café "
    encoded = "%20test%3A%40%2F%3F%23%25%5B%5D%20caf%C3%A9%20"
    expected_url = TEMPLATE.replace("[YOUR-PASSWORD]", encoded)
    prompt = Mock(return_value=password)
    monkeypatch.setattr(getpass, "getpass", prompt)

    assert database_stats.main(["check", "--prompt-password"]) == 0

    prompt.assert_called_once()
    assert fake_driver.connect.call_args.args == (expected_url,)
    assert os.environ["OUTLIER_DATABASE_URL"] == TEMPLATE
    output = capsys.readouterr()
    for private_text in (password, encoded, expected_url):
        assert private_text not in output.out + output.err


def test_visible_password_fallback_fails_before_input_or_connection(monkeypatch, capsys, fake_driver):
    visible_input = Mock(return_value="synthetic-password")

    def unsupported_hidden_input(*args, **kwargs):
        warnings.warn("Echo cannot be disabled", getpass.GetPassWarning)
        return visible_input()

    monkeypatch.setattr(getpass, "getpass", unsupported_hidden_input)

    assert database_stats.main(["check", "--prompt-password"]) == 1

    visible_input.assert_not_called()
    fake_driver.connect.assert_not_called()
    assert "Hidden password entry is unavailable" in capsys.readouterr().out


@pytest.mark.parametrize("template", [
    "postgresql://postgres:synthetic-password@db.example.com/postgres",
    "postgresql://postgres@db.example.com/[YOUR-PASSWORD]",
    TEMPLATE + "?application_name=[YOUR-PASSWORD]",
    TEMPLATE + "?sslmode=disable",
])
def test_bad_templates_fail_before_prompting(monkeypatch, fake_driver, template):
    monkeypatch.setenv("OUTLIER_DATABASE_URL", template)
    prompt = Mock()
    monkeypatch.setattr(getpass, "getpass", prompt)

    assert database_stats.main(["check", "--prompt-password"]) == 1

    prompt.assert_not_called()
    fake_driver.connect.assert_not_called()


def test_driver_error_does_not_expose_credentials(monkeypatch, capsys, fake_driver):
    password = "synthetic-private-value!"
    expanded_url = TEMPLATE.replace("[YOUR-PASSWORD]", "synthetic-private-value%21")
    monkeypatch.setattr(getpass, "getpass", Mock(return_value=password))
    fake_driver.connect.side_effect = RuntimeError(f"Failed {expanded_url}; password={password}")

    assert database_stats.main(["check", "--prompt-password"]) == 1

    output = capsys.readouterr()
    assert "Database operation failed" in output.out
    assert "synthetic-private-value" not in output.out + output.err
    assert "postgresql://" not in output.out + output.err


def test_check_uses_read_only_queries_without_loading_or_importing(monkeypatch, fake_driver):
    url = TEMPLATE.replace("[YOUR-PASSWORD]", "synthetic-password")
    monkeypatch.setenv("OUTLIER_DATABASE_URL", url)
    unused_operations = []
    for module, names in [
        (database_stats, ["load_saved_stats"]),
        (stats_database, ["migrate", "import_snapshots", "database_counts"]),
    ]:
        for name in names:
            operation = Mock(side_effect=AssertionError(f"check must not call {name}"))
            monkeypatch.setattr(module, name, operation)
            unused_operations.append(operation)

    assert database_stats.main(["check"]) == 0

    assert fake_driver.connect.call_args.args == (url,)
    queries = fake_driver.connect.return_value.queries
    assert queries[0] == "SET TRANSACTION READ ONLY"
    assert queries[-1] == "SELECT 1"
    assert set(queries) <= {
        "SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '10s'", "SELECT 1",
    }
    assert not fake_driver.connect.return_value.in_transaction
    for operation in unused_operations:
        operation.assert_not_called()


def test_explicit_empty_url_does_not_fall_back_to_environment(monkeypatch, fake_driver):
    url = TEMPLATE.replace("[YOUR-PASSWORD]", "synthetic-password")
    monkeypatch.setenv("OUTLIER_DATABASE_URL", url)

    with pytest.raises(ValueError):
        stats_database.connect_database("")
    fake_driver.connect.assert_not_called()

    assert stats_database.connect_database() is fake_driver.connect.return_value
    assert fake_driver.connect.call_args.args == (url,)
