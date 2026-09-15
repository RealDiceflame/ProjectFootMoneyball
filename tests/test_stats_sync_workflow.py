"""Offline guards for the optional private database workflow; no YAML dependency."""
import ast
from pathlib import Path
import re
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "sync-stats-database.yml"
TEXT = WORKFLOW.read_text(encoding="utf-8")


def section(name):
    """Read an unindented workflow section without a general YAML parser."""
    match = re.search(rf"^{re.escape(name)}:\n((?:[ \t].*\n|\n)*)", TEXT, re.MULTILINE)
    assert match is not None, f"Missing workflow section: {name}"
    return match.group(1)


def gate_allows(**overrides):
    """Exercise the actual small Actions condition after substituting its inputs."""
    values = {
        "vars.STATS_DATABASE_SYNC_ENABLED": "true",
        "github.event_name": "workflow_run",
        "github.event.workflow_run.conclusion": "success",
        "github.event.workflow_run.head_branch": "main",
        "github.event.workflow_run.head_repository.full_name": "owner/repository",
        "github.repository": "owner/repository",
        "github.ref": "refs/heads/main",
    }
    values.update(overrides)
    match = re.search(r"^    if: >-\n(.*?)^    runs-on:", TEXT, re.MULTILINE | re.DOTALL)
    assert match is not None
    condition = " ".join(match.group(1).strip().removeprefix("${{").removesuffix("}}").split())
    condition = re.sub(r"\b(?:github|vars)\.[\w.]+", lambda item: repr(values[item.group()]), condition)
    condition = condition.replace("&&", " and ").replace("||", " or ")
    parsed = ast.parse(condition.strip(), mode="eval")
    allowed = (ast.Expression, ast.BoolOp, ast.Compare, ast.Constant, ast.And, ast.Or, ast.Eq)
    assert all(isinstance(node, allowed) for node in ast.walk(parsed))
    return eval(compile(parsed, "<workflow condition>", "eval"), {"__builtins__": {}})


def preparation_script():
    match = re.search(r"^          python - <<'PY'\n(.*?)^          PY\n", TEXT, re.MULTILINE | re.DOTALL)
    assert match is not None
    return compile(textwrap.dedent(match.group(1)), str(WORKFLOW), "exec")


def test_only_trusted_completed_upstream_and_manual_events():
    events = section("on")
    assert re.findall(r"^  ([\w_]+):", events, re.MULTILINE) == ["workflow_dispatch", "workflow_run"]
    assert 'workflows: ["Update site data", "Update game stats"]' in events
    assert "types: [completed]" in events
    assert "branches: [main]" in events
    assert gate_allows()
    assert gate_allows(**{"github.event_name": "workflow_dispatch"})


@pytest.mark.parametrize("overrides", [
    {"vars.STATS_DATABASE_SYNC_ENABLED": ""},
    {"vars.STATS_DATABASE_SYNC_ENABLED": "false"},
    {"vars.STATS_DATABASE_SYNC_ENABLED": "TRUE"},
    {"github.event.workflow_run.conclusion": "failure"},
    {"github.event.workflow_run.conclusion": "cancelled"},
    {"github.event.workflow_run.conclusion": "skipped"},
    {"github.event.workflow_run.head_repository.full_name": "fork/repository"},
    {"github.event.workflow_run.head_branch": "feature"},
    {"github.event_name": "pull_request"},
    {"github.event_name": "push"},
    {"github.event_name": "workflow_dispatch", "github.ref": "refs/heads/feature"},
    {"github.event_name": "workflow_dispatch", "vars.STATS_DATABASE_SYNC_ENABLED": "false"},
])
def test_untrusted_failed_or_disabled_runs_do_not_receive_credentials(overrides):
    assert not gate_allows(**overrides)


def test_bounded_permissions_checkout_runtime_and_dependencies():
    assert section("permissions").strip() == "contents: read"
    assert len(re.findall(r"^\s*permissions:", TEXT, re.MULTILINE)) == 1
    assert section("concurrency").strip().splitlines() == [
        "group: sync-private-stats-database", "  cancel-in-progress: false",
    ]
    assert "timeout-minutes: 15" in TEXT
    assert re.search(r"uses: actions/checkout@v4\n\s+with:\n\s+ref: main\n\s+persist-credentials: false", TEXT)
    assert 'python-version: "3.12"' in TEXT
    assert re.findall(r"^\s+run: python -m pip (.+)$", TEXT, re.MULTILINE) == [
        "install -r requirements-database.txt",
    ]
    assert re.findall(r"^\s+- uses: (.+)$", TEXT, re.MULTILINE) == [
        "actions/checkout@v4", "actions/setup-python@v5",
    ]


def test_database_credentials_are_step_scoped_and_only_sync_runs():
    assert re.findall(r"^\s+env:\s*$", TEXT, re.MULTILINE) == ["        env:"]
    assert "OUTLIER_DATABASE_URL: ${{ vars.OUTLIER_DATABASE_URL }}" in TEXT
    assert "OUTLIER_DATABASE_PASSWORD: ${{ secrets.OUTLIER_DATABASE_PASSWORD }}" in TEXT
    assert "OUTLIER_DATABASE_CA_CERT: ${{ vars.OUTLIER_DATABASE_CA_CERT }}" in TEXT
    assert "OUTLIER_DATABASE_SSLROOTCERT: ${{ runner.temp }}/outlier-database-ca.pem" in TEXT
    assert re.findall(r"secrets\.([A-Z_]+)", TEXT) == ["OUTLIER_DATABASE_PASSWORD"]
    assert re.findall(r"python database_stats\.py ([^\n]+)", TEXT) == ["sync"]
    assert len(re.findall(r"^\s*if:", TEXT, re.MULTILINE)) == 1
    assert "continue-on-error" not in TEXT
    for forbidden in ("migrate", "git push", "git commit", "git add", "publish_scoreboard",
                      "upload-artifact", "download-artifact", "deploy-pages", "docs/data", "GITHUB_TOKEN"):
        assert forbidden not in TEXT


@pytest.fixture
def configured_environment(monkeypatch, tmp_path):
    values = {
        "OUTLIER_DATABASE_URL": "postgresql://ob_stats_ingest.project:[YOUR-PASSWORD]@example.test/postgres",
        "OUTLIER_DATABASE_PASSWORD": "synthetic-private:@ value",
        "OUTLIER_DATABASE_CA_CERT": "synthetic-public-ca-certificate",
        "OUTLIER_DATABASE_SSLROOTCERT": str(tmp_path / "outlier-database-ca.pem"),
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return values


@pytest.mark.parametrize("name", ["OUTLIER_DATABASE_URL", "OUTLIER_DATABASE_PASSWORD", "OUTLIER_DATABASE_CA_CERT"])
@pytest.mark.parametrize("value", [None, "", " \n "])
def test_enabled_but_missing_configuration_fails_without_printing_values(
    name, value, configured_environment, monkeypatch, capsys,
):
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    with pytest.raises(SystemExit) as error:
        exec(preparation_script(), {})
    assert error.value.code == 1
    output = capsys.readouterr()
    assert f"{name} is missing" in output.err
    assert output.out == ""
    for private_value in configured_environment.values():
        assert private_value not in output.err
    assert not Path(configured_environment["OUTLIER_DATABASE_SSLROOTCERT"]).exists()


def test_preparation_writes_only_public_ca_and_prints_nothing(configured_environment, capsys):
    exec(preparation_script(), {})
    certificate = Path(configured_environment["OUTLIER_DATABASE_SSLROOTCERT"])
    assert certificate.read_text(encoding="utf-8") == configured_environment["OUTLIER_DATABASE_CA_CERT"]
    assert list(certificate.parent.iterdir()) == [certificate]
    assert capsys.readouterr() == ("", "")


def test_certificate_write_failure_is_sanitized(configured_environment, monkeypatch, capsys):
    def failed_write(*args, **kwargs):
        raise OSError(f"synthetic error containing {configured_environment['OUTLIER_DATABASE_PASSWORD']}")

    monkeypatch.setattr(Path, "write_text", failed_write)
    with pytest.raises(SystemExit) as error:
        exec(preparation_script(), {})
    assert error.value.code == 1
    assert capsys.readouterr() == ("", "Database sync could not prepare the CA certificate.\n")
