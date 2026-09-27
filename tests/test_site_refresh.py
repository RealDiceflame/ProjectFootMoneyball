import gzip
import json
from types import SimpleNamespace
import pytest
import scripts.refresh_site as refresh_site
from app.player_news import _download_csv
from scripts.refresh_site import refresh_stage, source_result


def response(text):
    return SimpleNamespace(status_code=200, content=gzip.compress(text.encode()), raise_for_status=lambda: None)


def test_optional_injury_columns_are_nullable_not_required():
    frame = _download_csv("https://example.com/data", ["name", "primary", "secondary"],
                          optional_columns=("secondary",), get=lambda *a, **k: response("name,primary\nPlayer,Ankle\n"))
    assert frame.iloc[0]["primary"] == "Ankle"
    assert frame["secondary"].isna().all()
    with pytest.raises(ValueError, match="required"):
        _download_csv("https://example.com/data", ["name", "primary"], get=lambda *a, **k: response("name\nPlayer\n"))


def test_stage_failure_and_invalid_json_preserve_last_good_snapshot(tmp_path):
    saved = tmp_path / "saved.json"; saved.write_text('{"good":true}')
    def failed(*args, **kwargs):
        saved.write_text('{"partial":true}')
        return SimpleNamespace(returncode=1)
    assert not refresh_stage(["example.py"], ["saved.json"], root=tmp_path, run=failed)
    assert json.loads(saved.read_text()) == {"good": True}
    def invalid(*args, **kwargs):
        saved.write_text("invalid")
        return SimpleNamespace(returncode=0)
    assert not refresh_stage(["example.py"], ["saved.json"], root=tmp_path, run=invalid)
    assert json.loads(saved.read_text()) == {"good": True}


def test_successful_retry_and_new_files(tmp_path):
    calls = []
    def retry(*args, **kwargs):
        calls.append(1)
        (tmp_path / "new.json").write_text('{"updated":true}')
        return SimpleNamespace(returncode=0 if len(calls) == 2 else 1)
    assert refresh_stage(["example.py"], ["new.json"], root=tmp_path, run=retry)
    assert len(calls) == 2


def test_completed_job_cannot_mark_cached_provider_data_fresh():
    result = source_result("rankings", True, {
        "generated_at": "2026-09-27T12:00:00Z",
        "source_health": {
            "Yahoo": {"status": "manual", "data_updated_at": "2026-08-29"},
            "Sleeper": {"status": "cached", "data_updated_at": "2026-09-20"},
            "MFL": {"status": "success", "data_updated_at": "2026-09-27"},
        },
    }, {"last_success": "2026-09-20T12:00:00Z"}, "2026-09-27T12:00:00Z")
    assert result["execution_status"] == "success"
    assert result["status"] == "partial_failure"
    assert result["last_success"] == "2026-09-20T12:00:00Z"
    assert result["providers"]["Yahoo"]["status"] == "manual"


def test_manual_and_historical_sources_do_not_count_as_refresh_failures():
    result = source_result("rankings", True, {"source_health": {
        "Yahoo": {"status": "manual", "data_updated_at": "2026-08-29"},
        "Sleeper": {"status": "success", "data_updated_at": "2026-09-27"},
        "stats": {"status": "historical", "season": 2025},
    }}, {}, "2026-09-27")
    assert result["status"] == "success"
    archive = source_result("draft_capital", True, {"generated_at": "2026-01-01"}, {}, "2026-09-27")
    assert archive["status"] == archive["freshness"] == "historical"
    assert archive["last_success"] == "2026-01-01"


def test_missing_provider_diagnostics_are_not_assumed_fresh():
    result = source_result("odds", True, {"generated_at": "2026-09-27"}, {"last_success": "2026-09-20"}, "2026-09-27")
    assert result["status"] == "unknown"
    assert result["data_updated_at"] is None
    assert result["last_success"] == "2026-09-20"


def test_public_manifest_records_successful_execution_with_source_failure(tmp_path, monkeypatch):
    destination = tmp_path / "status.json"
    destination.write_text(json.dumps({"sources": {"rankings": {"last_success": "2026-09-20"}}}))
    (tmp_path / "rankings.json").write_text(json.dumps({"source_health": {
        "Sleeper": {"status": "cached", "data_updated_at": "2026-09-20"},
        "Yahoo": {"status": "manual", "data_updated_at": "2026-08-29"},
    }}))
    monkeypatch.setattr(refresh_site, "ROOT", tmp_path)
    monkeypatch.setattr(refresh_site, "STATUS", destination)
    monkeypatch.setattr(refresh_site, "STAGES", [("rankings", ["fake.py"], ["rankings.json"])])
    monkeypatch.setattr(refresh_site, "refresh_stage", lambda *args: True)
    assert refresh_site.main() == 1
    payload = json.loads(destination.read_text())
    assert payload["status"] == "partial_failure"
    assert payload["execution_status"] == "success"
    assert payload["sources"]["rankings"]["last_success"] == "2026-09-20"


def test_injury_provider_manifest_retains_season_and_week_context(tmp_path, monkeypatch):
    destination = tmp_path / "status.json"
    (tmp_path / "news.json").write_text(json.dumps({"injury_context": {
        "status": "behind", "season": 2026, "expected_week": 4,
        "latest_report_season": 2025, "latest_report_week": 18,
        "checked_at": "2026-09-27", "data_updated_at": None,
    }}))
    monkeypatch.setattr(refresh_site, "ROOT", tmp_path)
    monkeypatch.setattr(refresh_site, "STATUS", destination)
    monkeypatch.setattr(refresh_site, "STAGES", [("news", ["fake.py"], ["news.json"])])
    monkeypatch.setattr(refresh_site, "refresh_stage", lambda *args: True)
    assert refresh_site.main() == 1
    injuries = json.loads(destination.read_text())["sources"]["news"]["providers"]["injuries"]
    assert injuries["season"] == 2026
    assert injuries["latest_report_season"] == 2025
    assert injuries["latest_report_week"] == 18
    assert injuries["data_updated_at"] is None
