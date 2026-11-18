"""Shadow exports compare complete files and cannot overwrite website inputs."""
from contextlib import nullcontext
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import database_stats
from app import stats_access, stats_database, stats_export
from app.league_leaders import build_stats_summary
from app.stats_database import import_snapshots
from app.stats_import import load_saved_stats
from tests.test_stats_verification import ArchiveConnection, Result, postgres, snapshots


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def reference(tmp_path, snapshots):
    root = tmp_path / "reference"
    data = root / "docs/data"
    games = [item for item in snapshots if item.dataset == "game"]
    years = sorted({item.payload["season"] for item in games}, reverse=True)
    for item in snapshots:
        write_json(root / item.source_path, item.payload)
    checked = "2026-10-15T12:30:00+00:00"
    write_json(data / "game_stats/index.json", {"schema_version": 1, "seasons": years,
               "checked_at": checked, "current_season": max(years)})
    for year in years:
        selected = [item for item in games if item.payload["season"] == year]
        schedule = {item.object_key: item.payload["game"] for item in selected}
        # An upcoming game exists only in the website schedule, never in DB facts.
        future = f"{year}_03_NE_SEA"
        schedule[future] = {"game_id": future, "week": 3, "home": "SEA", "away": "NE",
                            "kickoff": f"{year}-11-15T12:00:00Z", "home_score": None, "away_score": None}
        entries = {item.object_key: {"week": item.payload["game"]["week"], "home": "SEA", "away": "NE",
                                    "updated_at": item.payload["updated_at"], "player_rows": 3}
                   for item in selected}
        write_json(data / f"game_stats/{year}/index.json", {"schema_version": 1, "season": year,
                   "checked_at": checked, "sources": {"players": {"retrieved_at": checked}}, "games": entries})
        players = {item.object_key: [dict(zip(item.payload["player_columns"], row))
                                    for row in item.payload["players"]] for item in selected}
        write_json(data / f"game_stats/{year}/summary.json",
                   build_stats_summary(year, schedule, players, entries, checked))
    return root


class ExportConnection(ArchiveConnection):
    def execute(self, query, params=()):
        if "SELECT version, checksum FROM ob_stats.schema_migrations" in query:
            return Result([(path.name, sha256(path.read_text(encoding="utf-8").encode()).hexdigest())
                           for path in sorted(stats_database.MIGRATIONS.glob("*.sql"))])
        if "s.source_path" in query:
            self.commands.append((" ".join(query.split()), params))
            sources = {(item.dataset, item.object_key): item.source_path for item in self.snapshots}
            return Result([(row[0], row[1], row[3], row[4], row[5], row[6], sources[row[0], row[1]])
                           for row in self.heads[:params[0]]])
        return super().execute(query, params)


def run_export(conn, root):
    return stats_export.export_and_compare(conn, root, root.parent / "export", root.parent / "comparison.json")


def test_complete_shadow_export_preserves_metadata_identities_and_all_artifacts(reference, snapshots):
    conn = ExportConnection(snapshots)
    before = stats_export._reference_files(reference)
    result = run_export(conn, reference)
    assert result["verified"] and result["database_verified"] and result["output_created"]
    assert result["artifacts_compared"] == result["artifacts_matched"] == 9
    assert not result["website_changed"] and not result["ready_for_cutover"]
    assert result["mismatches"] == result["metadata_vintage_gaps"] == []
    assert result["database_snapshot_counts"]["players"] == 2
    assert result["database_snapshot_counts"]["player_game_rows"] == 9
    assert len(result["companion_inputs"]) == 5
    assert sum(item.get("unarchived_schedule_games", 0) for item in result["companion_inputs"]) == 2
    assert all(item["origin"] == "reference_file" and len(item["sha256"]) == 64
               for item in result["companion_inputs"])
    assert any("projections" in item["reason"] for item in result["excluded_artifacts"])
    assert stats_export._reference_files(reference) == before
    for path, raw in before.items():
        assert json.loads((reference.parent / "export" / path).read_bytes()) == json.loads(raw)
    assert json.loads((reference.parent / "comparison.json").read_text()) == result
    assert all(cursor.closed for cursor in conn.cursors)
    assert ("SET LOCAL statement_timeout = '60s'", ()) in conn.commands
    assert all(query.startswith(("SELECT", "SET", "SHOW")) for query, _ in conn.commands)


@pytest.mark.parametrize("fault", ["leader", "extra_artifact", "observation_metadata"])
def test_parity_failure_reports_differences_without_accepting_partial_export(reference, snapshots, fault):
    conn = ExportConnection(snapshots)
    if fault == "leader":
        path = reference / "docs/data/game_stats/2025/summary.json"
        data = json.loads(path.read_bytes())
        data["periods"]["all"]["leaders"]["passing_yards"][0]["value"] += 1
        write_json(path, data)
    elif fault == "extra_artifact":
        write_json(reference / "docs/data/game_stats/unknown.json", {"extra": True})
    else:
        original = snapshots[0]
        later = original.source_updated_at + timedelta(days=1)
        data = deepcopy(original.payload)
        data["generated_at"] = later.isoformat()
        write_json(reference / original.source_path, data)
        conn.heads[0][3] = later
    result = run_export(conn, reference)
    assert result["database_verified"] and not result["verified"] and not result["output_created"]
    assert result["mismatches"] and not (reference.parent / "export").exists()
    assert (reference.parent / "comparison.json").is_file()
    assert not list(reference.parent.glob(".stats-shadow-*"))
    if fault == "observation_metadata":
        assert result["metadata_vintage_gaps"][0]["path"] == "player_history.json"
        assert result["database_verification"]["stored_payload_metadata_matches"] is False


def test_corrupt_database_fact_cannot_be_hidden_by_copying_reference_payload(reference, snapshots):
    conn = ExportConnection(snapshots)
    conn.player_games[-1][8]["receiving_yards"] = 999
    with pytest.raises(ValueError, match="fact mismatch"):
        run_export(conn, reference)
    assert not (reference.parent / "export").exists()
    assert not (reference.parent / "comparison.json").exists()


@pytest.mark.parametrize("destination", ["inside_reference", "existing_output", "existing_report", "nested_report"])
def test_destinations_refuse_reference_overwrite_and_existing_results(reference, destination):
    output, report = reference.parent / "export", reference.parent / "comparison.json"
    if destination == "inside_reference":
        output = reference / "docs/data/new-export"
    elif destination == "existing_output":
        output.mkdir()
    elif destination == "existing_report":
        report.write_text("existing result")
    else:
        report = output / "comparison.json"
    conn = Mock()
    with pytest.raises(ValueError):
        stats_export.export_and_compare(conn, reference, output, report)
    conn.transaction.assert_not_called()
    if destination == "existing_report":
        assert report.read_text() == "existing result"


def test_changed_reference_during_database_read_is_rejected(reference, snapshots, monkeypatch):
    original = stats_export._reference_files
    calls = []
    def changing(root):
        calls.append(True)
        result = original(root)
        if len(calls) == 2:
            result["game_stats/index.json"] += b"\n"
        return result
    monkeypatch.setattr(stats_export, "_reference_files", changing)
    with pytest.raises(ValueError, match="changed during export"):
        run_export(ExportConnection(snapshots), reference)
    assert not (reference.parent / "export").exists()


def test_alternate_reference_cannot_write_into_the_application_checkout(reference):
    with pytest.raises(ValueError, match="outside"):
        stats_export._destinations(reference, database_stats.ROOT / "docs/data/shadow-new",
                                   reference.parent / "comparison.json")


def test_staging_write_failure_never_accepts_partial_files(reference, snapshots, monkeypatch):
    original = Path.write_bytes
    writes = []
    def fail_second(path, data):
        writes.append(path)
        if len(writes) == 2:
            raise OSError("synthetic disk failure")
        return original(path, data)
    monkeypatch.setattr(Path, "write_bytes", fail_second)
    with pytest.raises(OSError, match="synthetic disk failure"):
        run_export(ExportConnection(snapshots), reference)
    assert len(writes) == 2
    assert not (reference.parent / "export").exists()
    assert not (reference.parent / "comparison.json").exists()
    assert not list(reference.parent.glob(".stats-shadow-*"))


def test_database_source_paths_cannot_escape_the_export(reference, snapshots):
    snapshots[0].source_path = "../../escape.json"
    with pytest.raises(ValueError, match="identity, path or payload"):
        run_export(ExportConnection(snapshots), reference)
    assert not (reference.parent / "export").exists()


@pytest.fixture
def cli(monkeypatch):
    monkeypatch.setenv("OUTLIER_DATABASE_URL", "postgresql://ob_stats_ingest.example:[YOUR-PASSWORD]@example.test/postgres")
    monkeypatch.setenv("OUTLIER_DATABASE_PASSWORD", "synthetic-private-password")
    monkeypatch.setenv("OUTLIER_DATABASE_SSLROOTCERT", __file__)
    conn = object()
    monkeypatch.setattr(stats_database, "connect_database", Mock(return_value=nullcontext(conn)))
    monkeypatch.setattr(stats_access, "require_ingest_connection", Mock())
    return conn


@pytest.mark.parametrize("verified", [True, False])
def test_export_cli_uses_restricted_readonly_export_and_returns_parity_status(cli, monkeypatch, tmp_path, verified):
    result = {"verified": verified, "database_verified": True, "artifacts_compared": 9,
              "artifacts_matched": 9 if verified else 8, "output_created": verified,
              "website_changed": False, "ready_for_cutover": False}
    exporter = Mock(return_value=result)
    monkeypatch.setattr(stats_export, "export_and_compare", exporter)
    monkeypatch.setattr(stats_database, "import_snapshots", Mock(side_effect=AssertionError("no import")))
    output, report = tmp_path / "output", tmp_path / "report.json"
    assert database_stats.main(["export-check", "--output-dir", str(output), "--report", str(report)]) == (0 if verified else 1)
    stats_access.require_ingest_connection.assert_called_once_with(cli)
    exporter.assert_called_once_with(cli, database_stats.ROOT, output, report)


@pytest.mark.parametrize("failure", [None, "sync", "report"])
def test_health_report_is_only_written_after_verified_sync(cli, monkeypatch, tmp_path, failure, capsys):
    sequence = []
    result = {"import": {}, "verification": {"verified": True}}
    def sync(conn, snapshots):
        sequence.append("sync")
        if failure == "sync":
            raise ValueError("synthetic-private-password")
        return result
    def write(conn, verified, destination):
        assert verified is result
        sequence.append("report")
        if failure == "report":
            raise RuntimeError("synthetic-private-password")
    monkeypatch.setattr(database_stats, "load_saved_stats", Mock(return_value=[]))
    monkeypatch.setattr(stats_access, "sync_database", sync)
    monkeypatch.setitem(sys.modules, "app.stats_monitor", SimpleNamespace(write_health_report=write))
    assert database_stats.main(["sync", "--health-report", str(tmp_path / "health.json")]) == (1 if failure else 0)
    assert sequence == (["sync"] if failure == "sync" else ["sync", "report"])
    assert "synthetic-private-password" not in capsys.readouterr().out


@pytest.mark.parametrize("args", [["export-check"], ["plan", "--health-report", "health.json"],
                                  ["verify", "--output-dir", "output"]])
def test_export_and_health_options_are_explicit(args):
    with pytest.raises(SystemExit) as error:
        database_stats.main(args)
    assert error.value.code == 2


def test_postgres_restricted_shadow_export_preserves_full_json(reference, postgres):
    import_snapshots(postgres, load_saved_stats(reference))
    postgres.execute("SET LOCAL ROLE ob_stats_ingest")
    result = run_export(postgres, reference)
    assert result["verified"] and result["artifacts_matched"] == 9
    assert postgres.execute("SHOW transaction_read_only").fetchone() == ("off",)
    assert postgres.execute("SELECT count(*) FROM pg_cursors WHERE name LIKE 'ob_stats_verify_%'").fetchone() == (0,)
